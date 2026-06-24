"""
Phase 3 / Deezer Artist Image ETL
═════════════════════════════════════════════════════════════════

读 app.artists.deezer_status='unknown' 的行,从 Deezer API search/artist 拉
头像(picture_xl, 1000×1000),resize 到 640×640(跟封面对齐),上传到
MinIO bucket `musicmap-artists`,更新状态。

可断点续跑:重启时自动跳过 deezer_status != 'unknown' 的行。

Deezer API:
    https://api.deezer.com/search/artist?q=<urlencoded-name>
    → data[0].picture_xl  (CDN: cdn-images.dzcdn.net,无 token)
免费,无 OAuth。官方限流 50 req/5s per IP(=600/min)。

状态语义:
    unknown   - 还没试
    matched   - search 命中 + 图下载成功
    no_match  - search 返回 0 个结果
    error     - HTTP/network/资源错误,可用 --retry-errors 重跑

用法:
    docker compose exec backend python /etl/phase3_deezer_artists.py --concurrency 7
"""
import argparse
import asyncio
import io
import os
import signal
import sys
import time
import urllib.parse
from typing import Optional

import asyncpg
import httpx
from minio import Minio
from PIL import Image

# ─── 配置 ────────────────────────────────────────────────────
def _db_dsn() -> str:
    url = os.getenv("DATABASE_URL", "postgresql://musicmap:change_me_in_real_env@postgis:5432/musicmap")
    return url.replace("postgresql+asyncpg://", "postgresql://")

DB_DSN = _db_dsn()
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "minio:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "musicmap")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "change_me_in_real_env")
BUCKET = "musicmap-artists"

DEEZER_SEARCH = "https://api.deezer.com/search/artist?q={q}&limit=1"
TIMEOUT = httpx.Timeout(20.0, connect=8.0)

THUMB_SIZE = (640, 640)
JPEG_QUALITY = 85
MAX_PIXELS = 50_000_000

# ─── 信号 ────────────────────────────────────────────────────
shutdown_flag = False
def _on_sigint(*_):
    global shutdown_flag
    shutdown_flag = True
    print("\n[!] Ctrl-C received, finishing inflight downloads then exit...", flush=True)
signal.signal(signal.SIGINT, _on_sigint)
signal.signal(signal.SIGTERM, _on_sigint)


# ─── 看门狗 ─────────────────────────────────────────────────
async def watchdog(stats: dict, idle_threshold: int = 300, check_interval: int = 60):
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
            print(f"\n[WATCHDOG] {idle:.0f}s no progress (threshold={threshold}s, "
                  f"shutdown={shutdown_flag}), force exit", flush=True)
            os._exit(2)
        else:
            print(f"[WATCHDOG] {idle:.0f}s no progress, will kill at {threshold}s", flush=True)


# ─── MinIO ─────────────────────────────────────────────────
def _make_minio() -> Minio:
    return Minio(MINIO_ENDPOINT, access_key=MINIO_ACCESS_KEY,
                 secret_key=MINIO_SECRET_KEY, secure=False)

def ensure_bucket(client: Minio):
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)
        print(f"[+] created bucket: {BUCKET}")
    else:
        print(f"[=] bucket exists: {BUCKET}")


# ─── 图片处理 ──────────────────────────────────────────────
def resize_to_jpeg(raw: bytes) -> bytes:
    img = Image.open(io.BytesIO(raw))
    if img.width * img.height > MAX_PIXELS:
        raise ValueError(f"image too large: {img.width}x{img.height}")
    if img.mode in ("RGBA", "P", "LA"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode in ("RGBA", "LA"):
            bg.paste(img, mask=img.split()[-1])
        else:
            bg.paste(img.convert("RGBA"))
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")
    img.thumbnail(THUMB_SIZE, Image.LANCZOS)
    canvas = Image.new("RGB", THUMB_SIZE, (255, 255, 255))
    off = ((THUMB_SIZE[0] - img.width) // 2, (THUMB_SIZE[1] - img.height) // 2)
    canvas.paste(img, off)
    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue()


def object_key(mbid: str) -> str:
    return f"{mbid[:2]}/{mbid}.jpg"


# ─── 单个艺人 ──────────────────────────────────────────────
async def process_one(
    http: httpx.AsyncClient,
    s3: Minio,
    sem: asyncio.Semaphore,
    pool: asyncpg.Pool,
    mbid: str,
    name: str,
    stats: dict,
):
    """
    1) 搜索 Deezer
    2) 取 data[0] 的 picture_xl
    3) 下图 + resize + 上传 MinIO
    4) UPDATE app.artists SET deezer_id=, deezer_name=, deezer_image_url=,
                              deezer_fans=, deezer_status=
    """
    async with sem:
        if shutdown_flag:
            return

        status = "error"
        deezer_id: Optional[int] = None
        deezer_name: Optional[str] = None
        deezer_image_url: Optional[str] = None
        deezer_fans: Optional[int] = None

        try:
            q = urllib.parse.quote(name)
            r = await http.get(DEEZER_SEARCH.format(q=q))

            if r.status_code == 429:
                stats["rate_limited"] += 1
                status = "error"
            elif r.status_code != 200:
                stats["http_errors"] += 1
                status = "error"
            else:
                data = r.json().get("data") or []
                if not data:
                    status = "no_match"
                    stats["no_match"] += 1
                else:
                    hit = data[0]
                    deezer_id = hit.get("id")
                    deezer_name = hit.get("name")
                    deezer_fans = hit.get("nb_fan")
                    deezer_image_url = hit.get("picture_xl")

                    if not deezer_image_url:
                        status = "no_match"
                        stats["no_match"] += 1
                    else:
                        # 下图
                        img_r = await http.get(deezer_image_url)
                        if img_r.status_code != 200:
                            stats["http_errors"] += 1
                            status = "error"
                        else:
                            try:
                                jpeg = await asyncio.to_thread(resize_to_jpeg, img_r.content)
                            except Exception:
                                stats["resize_errors"] += 1
                                status = "error"
                            else:
                                await asyncio.to_thread(
                                    s3.put_object, BUCKET, object_key(mbid),
                                    io.BytesIO(jpeg), len(jpeg),
                                    content_type="image/jpeg",
                                )
                                status = "matched"
                                stats["matched"] += 1
                                stats["bytes_stored"] += len(jpeg)
        except httpx.RequestError:
            stats["network_errors"] += 1
            status = "error"
        except Exception:
            stats["other_errors"] += 1
            status = "error"

        # DB 更新(双层超时)
        try:
            async with pool.acquire(timeout=10) as conn:
                await asyncio.wait_for(
                    conn.execute(
                        """
                        UPDATE app.artists
                        SET deezer_id        = $1,
                            deezer_name      = $2,
                            deezer_image_url = $3,
                            deezer_fans      = $4,
                            deezer_status    = $5
                        WHERE mbid = $6
                        """,
                        deezer_id, deezer_name, deezer_image_url,
                        deezer_fans, status, mbid,
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
    err = stats["processed"] - stats["matched"] - stats["no_match"]
    print(
        f"  {stats['processed']:>7}/{stats['total']} ({pct:5.1f}%) | "
        f"OK={stats['matched']} NM={stats['no_match']} ERR={err} | "
        f"{rate:5.1f}/s | stored {mb_stored:6.1f} MB | "
        f"ETA {eta_s/60:.0f} min",
        flush=True,
    )


# ─── 主流程 ───────────────────────────────────────────────
async def main(args):
    s3 = _make_minio()
    ensure_bucket(s3)

    if args.retry_errors:
        cond = "deezer_status = 'error'"
    else:
        cond = "deezer_status = 'unknown'"
    if args.where:
        cond = f"({cond}) AND ({args.where})"
    limit_clause = f"LIMIT {args.limit}" if args.limit else ""

    pool = await asyncpg.create_pool(DB_DSN, min_size=2, max_size=10)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT mbid::text AS mbid, name FROM app.artists "
            f"WHERE {cond} ORDER BY mbid {limit_clause}"
        )
    total = len(rows)
    print(f"[i] {total} artists to query Deezer (concurrency={args.concurrency})")
    if total == 0:
        return

    stats = {
        "total": total, "processed": 0,
        "matched": 0, "no_match": 0,
        "http_errors": 0, "network_errors": 0,
        "resize_errors": 0, "rate_limited": 0, "other_errors": 0,
        "bytes_stored": 0, "t0": time.time(),
    }
    sem = asyncio.Semaphore(args.concurrency)

    limits = httpx.Limits(max_connections=args.concurrency * 2,
                          max_keepalive_connections=args.concurrency)
    async with httpx.AsyncClient(timeout=TIMEOUT, limits=limits) as http:
        asyncio.create_task(watchdog(stats))
        tasks = [
            asyncio.create_task(process_one(http, s3, sem, pool,
                                            r["mbid"], r["name"], stats))
            for r in rows
        ]
        for t in asyncio.as_completed(tasks):
            await t
            if shutdown_flag:
                for tt in tasks:
                    if not tt.done():
                        tt.cancel()
                break

    print("\n─── 完成 ──────────────────────────────────")
    _print_progress(stats)
    print(f"  匹配成功率: {stats['matched']*100/max(stats['processed'],1):.1f}%")
    print(f"  存储总量:   {stats['bytes_stored']/1024/1024:.1f} MB")
    await pool.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--concurrency", type=int, default=7)
    p.add_argument("--retry-errors", action="store_true")
    p.add_argument("--where", type=str, default=None, help="额外 WHERE 条件(AND)")
    args = p.parse_args()
    asyncio.run(main(args))
