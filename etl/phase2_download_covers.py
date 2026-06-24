"""
Phase 2 / Cover Art ETL
═════════════════════════════════════════════════════════════════

读 app.albums.cover_status='unknown' 的行,从 Cover Art Archive 拉封面,
resize 到 500×500,上传到 MinIO bucket `musicmap-covers`,更新状态。

可断点续跑:重启时自动跳过 cover_status != 'unknown' 的行。

用法(在 backend 容器内):
    docker compose exec backend python /etl/phase2_download_covers.py --limit 100
    docker compose exec backend python /etl/phase2_download_covers.py            # 全量
    docker compose exec backend python /etl/phase2_download_covers.py --retry-errors   # 只重试 error
    docker compose exec backend python /etl/phase2_download_covers.py --where "artist_country_iso IN ('CN','TW','HK')"
"""
import argparse
import asyncio
import io
import os
import signal
import sys
import time
from typing import Optional

import asyncpg
import httpx
from minio import Minio
from minio.error import S3Error
from PIL import Image, ImageOps

# ─── 配置 ────────────────────────────────────────────────────
def _db_dsn() -> str:
    # backend 容器里 DATABASE_URL 是 SQLAlchemy 形式("postgresql+asyncpg://...")
    # asyncpg 要标准 PG URL,把 +asyncpg 去掉
    url = os.getenv("DATABASE_URL", "postgresql://musicmap:change_me_in_real_env@postgis:5432/musicmap")
    return url.replace("postgresql+asyncpg://", "postgresql://")

DB_DSN = _db_dsn()
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "musicmap")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "change_me_in_real_env")
BUCKET = "musicmap-covers"

CAA_URL = "https://coverartarchive.org/release-group/{mbid}/front"
USER_AGENT = "MusicMap/0.2 ( https://github.com/user/musicmap )"
TIMEOUT = httpx.Timeout(30.0, connect=10.0)

THUMB_SIZE = (640, 640)    # 跟 Spotify CDN 的 images[0] 对齐,后续两个源画质一致
JPEG_QUALITY = 85
MAX_PIXELS = 50_000_000    # 超 5000 万像素的"炸弹图"直接拒,避免 PIL 吃 GB 级内存触发 OOM

# ─── 全局信号(Ctrl-C 优雅退出) ────────────────────────────
shutdown_flag = False
def _on_sigint(*_):
    global shutdown_flag
    shutdown_flag = True
    print("\n[!] Ctrl-C received, finishing inflight downloads then exit...", flush=True)
signal.signal(signal.SIGINT, _on_sigint)
signal.signal(signal.SIGTERM, _on_sigint)


# ─── 看门狗:stats[processed] N 秒不涨就硬退出 ─────────────
# (asyncpg pool 死锁 / CAA 限流后 httpx 卡死时主循环看不出来,这是兜底)
async def watchdog(stats: dict, idle_threshold: int = 300, check_interval: int = 60):
    """
    每 check_interval 秒看一眼 processed 计数,>idle_threshold 秒没涨就 os._exit(2)。
    收到 shutdown_flag 后阈值降到 30s(防止 pool.close() 也卡住)。
    冷启动给 90s 宽限期。
    """
    await asyncio.sleep(90)
    last_count = stats["processed"]
    last_advance = time.time()
    while True:
        await asyncio.sleep(check_interval)
        now = stats["processed"]
        if now > last_count:
            last_count = now
            last_advance = time.time()
            continue
        idle = time.time() - last_advance
        threshold = 30 if shutdown_flag else idle_threshold
        if idle >= threshold:
            print(
                f"\n[WATCHDOG] {idle:.0f}s no progress (threshold={threshold}s, "
                f"shutdown={shutdown_flag}), force exit",
                flush=True,
            )
            os._exit(2)
        else:
            print(
                f"[WATCHDOG] {idle:.0f}s no progress, will kill at {threshold}s",
                flush=True,
            )


# ─── MinIO helpers ─────────────────────────────────────────
def _make_minio() -> Minio:
    return Minio(
        MINIO_ENDPOINT,
        access_key=MINIO_ACCESS_KEY,
        secret_key=MINIO_SECRET_KEY,
        secure=False,
    )

def ensure_bucket(client: Minio):
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)
        print(f"[+] created bucket: {BUCKET}")
    else:
        print(f"[=] bucket exists: {BUCKET}")


# ─── 图片处理 ──────────────────────────────────────────────
def resize_to_jpeg(raw: bytes) -> bytes:
    """
    把任意输入图片(JPG/PNG/WebP) → 640×640 居中缩放 + 白底填充 → JPEG q85 字节
    保留长宽比,不变形;长边对齐 640,短边补白。
    """
    img = Image.open(io.BytesIO(raw))
    # 炸弹图检测:超 MAX_PIXELS 直接拒,避免 PIL 把 1 亿+ 像素的 PNG 解到内存
    # 触发 OOM(WSL 限了 6GB 但单张大图就能吃几个 GB)
    if img.width * img.height > MAX_PIXELS:
        raise ValueError(f"image too large: {img.width}x{img.height} = {img.width*img.height} px > {MAX_PIXELS}")
    # 转 RGB(去掉 alpha,JPEG 不支持)
    if img.mode in ("RGBA", "P", "LA"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode in ("RGBA", "LA"):
            bg.paste(img, mask=img.split()[-1])
        else:
            bg.paste(img.convert("RGBA"))
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")

    # 等比缩到适应 500×500,然后居中粘到白底
    img.thumbnail(THUMB_SIZE, Image.LANCZOS)
    canvas = Image.new("RGB", THUMB_SIZE, (255, 255, 255))
    off = ((THUMB_SIZE[0] - img.width) // 2, (THUMB_SIZE[1] - img.height) // 2)
    canvas.paste(img, off)

    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue()


def object_key(mbid: str) -> str:
    """分桶:用 mbid 前 2 字符做子目录,避免一个目录堆 100w 文件"""
    return f"{mbid[:2]}/{mbid}.jpg"


# ─── 单张下载 + 处理 ──────────────────────────────────────
async def process_one(
    client_http: httpx.AsyncClient,
    client_minio: Minio,
    sem: asyncio.Semaphore,
    pool: asyncpg.Pool,
    mbid: str,
    stats: dict,
):
    """
    返回 status: 'downloaded' | 'missing' | 'error'
    并更新 app.albums.cover_status
    """
    async with sem:
        if shutdown_flag:
            return
        url = CAA_URL.format(mbid=mbid)
        status = "error"
        try:
            r = await client_http.get(url, follow_redirects=True)
            if r.status_code == 200:
                try:
                    # resize 是 CPU 密集,丢线程池避免阻塞 event loop
                    # (碰到 1 亿+ 像素的炸弹图能拖垮整个并发批次)
                    jpeg = await asyncio.to_thread(resize_to_jpeg, r.content)
                except Exception as e:
                    stats["resize_errors"] += 1
                    status = "error"
                else:
                    # 上传 MinIO(同步 SDK,但放在 to_thread 避免阻塞事件循环)
                    await asyncio.to_thread(
                        client_minio.put_object,
                        BUCKET,
                        object_key(mbid),
                        io.BytesIO(jpeg),
                        len(jpeg),
                        content_type="image/jpeg",
                    )
                    status = "downloaded"
                    stats["downloaded"] += 1
                    stats["bytes_stored"] += len(jpeg)
            elif r.status_code == 404:
                status = "missing"
                stats["missing"] += 1
            elif r.status_code in (429, 503):
                # 限速/暂时不可用 → error,稍后用 --retry-errors 再试
                status = "error"
                stats["rate_limited"] += 1
            else:
                status = "error"
                stats["http_errors"] += 1
        except httpx.RequestError:
            status = "error"
            stats["network_errors"] += 1
        except Exception:
            status = "error"
            stats["other_errors"] += 1

        # 更新数据库 — pool 和 execute 双层超时,防 PG 静默断连导致协程卡死
        try:
            async with pool.acquire(timeout=10) as conn:
                await asyncio.wait_for(
                    conn.execute(
                        "UPDATE app.albums SET cover_status=$1 WHERE mbid=$2",
                        status, mbid,
                    ),
                    timeout=10,
                )
        except (asyncio.TimeoutError, Exception) as e:
            print(f"[!] DB update failed for {mbid}: {type(e).__name__}: {e}", flush=True)

        stats["processed"] += 1
        if stats["processed"] % 100 == 0:
            _print_progress(stats)


def _print_progress(stats: dict):
    elapsed = time.time() - stats["t0"]
    rate = stats["processed"] / max(elapsed, 0.01)
    pct = stats["processed"] * 100 / max(stats["total"], 1)
    mb_stored = stats["bytes_stored"] / 1024 / 1024
    eta_s = (stats["total"] - stats["processed"]) / max(rate, 0.01)
    print(
        f"  {stats['processed']:>7}/{stats['total']} ({pct:5.1f}%) | "
        f"OK={stats['downloaded']} 404={stats['missing']} ERR={stats['processed']-stats['downloaded']-stats['missing']} | "
        f"{rate:5.1f}/s | "
        f"stored {mb_stored:6.1f} MB | "
        f"ETA {eta_s/60:.0f} min",
        flush=True,
    )


# ─── 主流程 ───────────────────────────────────────────────
async def main(args):
    minio_client = _make_minio()
    ensure_bucket(minio_client)

    # 构造 SELECT 条件
    if args.retry_errors:
        cond = "cover_status = 'error'"
    else:
        cond = "cover_status = 'unknown'"
    if args.where:
        cond = f"({cond}) AND ({args.where})"
    limit_clause = f"LIMIT {args.limit}" if args.limit else ""

    pool = await asyncpg.create_pool(DB_DSN, min_size=2, max_size=10)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT mbid::text FROM app.albums WHERE {cond} ORDER BY mbid {limit_clause}"
        )
    mbids = [r["mbid"] for r in rows]
    total = len(mbids)
    print(f"[i] {total} albums to process (concurrency={args.concurrency})")
    if total == 0:
        return

    stats = {
        "total": total, "processed": 0,
        "downloaded": 0, "missing": 0,
        "http_errors": 0, "network_errors": 0,
        "resize_errors": 0, "rate_limited": 0, "other_errors": 0,
        "bytes_stored": 0, "t0": time.time(),
    }
    sem = asyncio.Semaphore(args.concurrency)

    headers = {"User-Agent": USER_AGENT}
    limits = httpx.Limits(max_connections=args.concurrency * 2, max_keepalive_connections=args.concurrency)
    async with httpx.AsyncClient(headers=headers, timeout=TIMEOUT, limits=limits, http2=False) as http_client:
        # 看门狗后台跑:processed 计数 5 分钟不涨就自杀,让外部 supervisor 重启
        asyncio.create_task(watchdog(stats))
        tasks = [
            asyncio.create_task(
                process_one(http_client, minio_client, sem, pool, mbid, stats)
            )
            for mbid in mbids
        ]
        for t in asyncio.as_completed(tasks):
            await t
            if shutdown_flag:
                # 取消未启动的任务
                for tt in tasks:
                    if not tt.done():
                        tt.cancel()
                break

    print("\n─── 完成 ──────────────────────────────────")
    _print_progress(stats)
    print(f"  下载成功率: {stats['downloaded']*100/max(stats['processed'],1):.1f}%")
    print(f"  存储总量:   {stats['bytes_stored']/1024/1024:.1f} MB")
    await pool.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="处理上限(用于测试)")
    parser.add_argument("--concurrency", type=int, default=5, help="并发数,默认 5")
    parser.add_argument("--retry-errors", action="store_true", help="只重试 cover_status='error' 的")
    parser.add_argument("--where", type=str, default=None, help="额外 WHERE 条件(SQL 片段)")
    args = parser.parse_args()
    asyncio.run(main(args))
