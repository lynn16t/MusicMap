"""
预烤封面图集(方案 B):把全部已下载封面一次性拼成若干张图集 + 一份 manifest。

为什么:全量模式下前端要逐张拉 48.9 万张 640px 原图(~24GB)才能在浏览器里拼图集,
量级远超浏览器缓存配额 → 关机后被清掉 → 无法秒开。这里把"拼图"挪到服务端跑一次,
产出 8 张小图集(~100MB)+ manifest,前端只下这 9 个文件 → 任何浏览器/机器/重启后都秒开。

产物(写到 ATLAS_DIR,默认 app/_atlas/,经 bind mount 持久在 host):
  - atlas_0.jpg .. atlas_{N-1}.jpg   每张 8192×8192,内含 256×256 个 32px 封面格
  - manifest.json   { version, cell, atlas_px, grid_a, n_atlas, count, counts, pool }
        pool: { iso: [[year, mbid], ...] }  —— 顺序即图集格子顺序(前端按此顺序还原 mbid→格)
        counts: { "year": { iso: n } }      —— 动画节奏(= 该国该年已烤入的封面数)

跑法(在 backend 容器内,能访问 postgis/minio):
  docker exec musicmap-backend python -m app.bake_atlas
封面库以后更新了,重跑一次即可(version 会变,前端 immutable 缓存自动失效)。
"""
import asyncio
import io
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

import asyncpg
from minio import Minio
from PIL import Image

# 与前端 MapGlobe3D 全量参数保持一致
CELL = 32
ATLAS_PX = 8192
GRID_A = ATLAS_PX // CELL          # 256
PER_ATLAS = GRID_A * GRID_A        # 65536
BG = (34, 34, 34)                  # 空格背景(与前端 canvas 填充一致)

YEAR_START, YEAR_END = 2010, 2025
COVER_BUCKET = "musicmap-covers"
ATLAS_DIR = os.getenv("ATLAS_DIR", os.path.join(os.path.dirname(__file__), "_atlas"))
WORKERS = int(os.getenv("BAKE_WORKERS", "32"))


def _pg_dsn() -> str:
    # main.py 用的是 postgresql+asyncpg://...,asyncpg.connect 要纯 postgresql://
    url = os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://musicmap:change_me_in_real_env@localhost:5432/musicmap",
    )
    return url.replace("+asyncpg", "")


def _minio() -> Minio:
    return Minio(
        os.getenv("MINIO_ENDPOINT", "minio:9000"),
        access_key=os.getenv("MINIO_ACCESS_KEY", "musicmap"),
        secret_key=os.getenv("MINIO_SECRET_KEY", "change_me_in_real_env"),
        secure=False,
    )


async def fetch_candidates() -> list[tuple[str, int, str, str, str]]:
    """全部已下载封面 (iso, year, mbid, fine_genre, bucket),按 国→年→mbid 确定性排序(港澳台并入 CN)。
    LEFT JOIN 曲风(album_genre 主键 mbid,1:1),不改行集/顺序 → 与已烤图集格子严格对齐。"""
    conn = await asyncpg.connect(_pg_dsn())
    try:
        rows = await conn.fetch(
            """
            SELECT CASE WHEN artist_country_iso IN ('HK','MO','TW') THEN 'CN' ELSE artist_country_iso END AS iso,
                   release_year AS y, a.mbid::text AS mbid,
                   ag.fine_genre AS fine, gb.bucket AS bucket
            FROM app.albums a
            LEFT JOIN app.album_genre ag ON ag.mbid = a.mbid
            LEFT JOIN app.genre_bucket gb ON gb.fine_genre = ag.fine_genre
            WHERE release_year BETWEEN $1 AND $2 AND artist_country_iso IS NOT NULL
              AND cover_status = 'downloaded'
            ORDER BY 1, release_year, mbid
            """,
            YEAR_START, YEAR_END,
        )
    finally:
        await conn.close()
    return [(r["iso"], r["y"], r["mbid"], r["fine"], r["bucket"]) for r in rows]


def bake() -> None:
    """
    断点续烤:格子号 = 候选序号(确定性,ORDER BY iso,year,mbid),所以第 g 张图集固定装
    候选 [g*PER_ATLAS, (g+1)*PER_ATLAS)。已存在的图集直接跳过 → 被 Docker 重启掐断后重跑只补缺的。
    封面库缺图为 0,故 manifest 保留全部候选(格子=序号,与图集严格对齐;偶发缺图只留一格背景,无碍)。
    """
    os.makedirs(ATLAS_DIR, exist_ok=True)
    resume = os.getenv("BAKE_RESUME", "1") != "0"
    print(f"[bake] 输出目录 {ATLAS_DIR}  CELL={CELL} GRID_A={GRID_A} PER_ATLAS={PER_ATLAS} WORKERS={WORKERS} RESUME={resume}", flush=True)

    candidates = asyncio.run(fetch_candidates())
    limit = int(os.getenv("BAKE_LIMIT", "0"))   # >0 时只烤前 N 张,用于冒烟测试
    if limit > 0:
        candidates = candidates[:limit]
        print(f"[bake] BAKE_LIMIT={limit},只烤前 {limit} 张(冒烟测试)", flush=True)
    total = len(candidates)
    n_atlas = (-(-total // PER_ATLAS)) if total else 0
    print(f"[bake] 候选封面 {total} 张,需要 {n_atlas} 张图集", flush=True)

    client = _minio()

    def work(i: int):
        _iso, _y, mbid, _f, _b = candidates[i]
        key = f"{mbid[:2]}/{mbid}.jpg"
        try:
            resp = client.get_object(COVER_BUCKET, key)
            try:
                data = resp.read()
            finally:
                resp.close()
                resp.release_conn()
            return i, Image.open(io.BytesIO(data)).convert("RGB").resize((CELL, CELL))
        except Exception:
            return i, None

    # ── 逐张图集烤;已落盘的跳过(续烤) ──
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for g in range(n_atlas):
            path = os.path.join(ATLAS_DIR, f"atlas_{g}.jpg")
            if resume and os.path.exists(path):
                print(f"[bake] 跳过已存在 {path}", flush=True)
                continue
            lo, hi = g * PER_ATLAS, min((g + 1) * PER_ATLAS, total)
            atlas = Image.new("RGB", (ATLAS_PX, ATLAS_PX), BG)
            miss = 0
            for i, im in ex.map(work, range(lo, hi)):
                if im is None:
                    miss += 1
                    continue
                j = i % PER_ATLAS
                atlas.paste(im, ((j % GRID_A) * CELL, (j // GRID_A) * CELL))
            atlas.save(path, "JPEG", quality=85, optimize=True)
            print(f"[bake] 写出 {path}  ({hi - lo} 格,缺图 {miss})", flush=True)

    # ── manifest:全部候选,pool 按 iso 分组(顺序=候选顺序=格子顺序);counts 即各国各年封面数 ──
    # 曲风:pool 每条带细分码 gc(-1=未知);genreFine[码]=细分名,genreBucket[桶码]=桶名,fineBucket[细分码]=桶码
    fine_list: list[str] = []
    fine_idx: dict[str, int] = {}
    bucket_list: list[str] = []
    bucket_idx: dict[str, int] = {}
    fine_bucket: list[int] = []

    def gcode(fine, bucket) -> int:
        if not fine:
            return -1
        if fine not in fine_idx:
            bk = bucket or "Other"
            if bk not in bucket_idx:
                bucket_idx[bk] = len(bucket_list)
                bucket_list.append(bk)
            fine_idx[fine] = len(fine_list)
            fine_list.append(fine)
            fine_bucket.append(bucket_idx[bk])
        return fine_idx[fine]

    pool: dict[str, list] = {}
    counts: dict[str, dict[str, int]] = {}
    for iso, y, mbid, fine, bucket in candidates:
        pool.setdefault(iso, []).append([y, mbid, gcode(fine, bucket)])
        yc = counts.setdefault(str(y), {})
        yc[iso] = yc.get(iso, 0) + 1
    manifest = {
        "version": int(time.time()),
        "cell": CELL, "atlas_px": ATLAS_PX, "grid_a": GRID_A,
        "n_atlas": n_atlas, "count": total,
        "counts": counts, "pool": pool,
        "genreFine": fine_list, "genreBucket": bucket_list, "fineBucket": fine_bucket,
    }
    mpath = os.path.join(ATLAS_DIR, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[bake] 写出 {mpath}  count={total} / {n_atlas} 图集", flush=True)
    print("[bake] 完成。前端访问 /api/atlas/manifest.json 即走预烤路径。", flush=True)


if __name__ == "__main__":
    bake()
