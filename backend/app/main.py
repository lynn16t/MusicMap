"""
MusicMap Backend - Phase 0 骨架

目前只做一件事:启动 FastAPI,提供一个 /health 端点
该端点会真的去查一下 PostGIS,把版本号返回给你
这就证明了:容器之间网络通、数据库 ready、PostGIS 扩展加载成功
"""
import asyncio
import base64
import os
import random
import re
import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from minio import Minio
from minio.error import S3Error
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError, InterfaceError
from sqlalchemy.ext.asyncio import create_async_engine, AsyncEngine


# ─── 数据库连接配置 ───────────────────────────────────────
# 容器内的 DATABASE_URL 由 docker-compose 注入
# 本地直接 python 跑也能 work(走 localhost)
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://musicmap:change_me_in_real_env@localhost:5432/musicmap",
)

engine: AsyncEngine | None = None


# ─── 生命周期管理:启动时建连接池,关闭时释放 ───────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    engine = create_async_engine(
        DATABASE_URL,
        echo=False,
        pool_pre_ping=True,
        # 保持更大的热连接池,减少"新建连接"的次数 —— 新建连接才会触发
        # 容器间 DNS 解析,而 Docker 内置 DNS 在并发下偶发 gaierror。
        pool_size=10,
        max_overflow=20,
        pool_recycle=1800,
    )
    yield
    await engine.dispose()


# ─── 数据库重试:对付 Docker 内置 DNS 偶发的 name resolution 失败 ───
@asynccontextmanager
async def db_conn(attempts: int = 3, base_delay: float = 0.3):
    """
    建立连接的上下文管理器;若遇到连接/DNS 类瞬时错误,退避重试。
    asyncpg 的 socket.gaierror 会被 SQLAlchemy 包成 OperationalError/InterfaceError。
    用法:async with db_conn() as conn: ...
    """
    last_err: Exception | None = None
    conn = None
    for i in range(attempts):
        try:
            conn = await engine.connect()
            break
        except (OperationalError, InterfaceError, DBAPIError, OSError) as e:
            last_err = e
            if i < attempts - 1:
                await asyncio.sleep(base_delay * (2 ** i))  # 0.3s, 0.6s, 1.2s …
    if conn is None:
        raise last_err
    try:
        yield conn
    finally:
        await conn.close()


# ─── FastAPI 应用 ─────────────────────────────────────────
app = FastAPI(
    title="MusicMap API",
    description="世界音乐地图 - 按国家与时间可视化全球专辑",
    version="0.0.1-phase0",
    lifespan=lifespan,
)

# 网格检查器 HTML 可能从 file:// 或别的端口访问,放开 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)
# 专辑池/网格 JSON 体积大(十几 MB)且高度可压缩,启用 gzip(压完约 1/8)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.get("/")
async def root():
    return {
        "name": "MusicMap API",
        "phase": "3 - grid inspector",
        "docs": "/docs",
        "inspector": "/inspector",
    }


@app.get("/inspector")
async def inspector():
    """网格检查器静态页面(从 /frontend 挂载读取)。"""
    return FileResponse("/frontend/grid-inspector.html", media_type="text/html")


@app.get("/health")
async def health():
    """检查后端 + 数据库 + PostGIS 是否都活着"""
    async with db_conn() as conn:
        pg_version = (await conn.execute(text("SELECT version()"))).scalar()
        postgis_version = (await conn.execute(text("SELECT postgis_full_version()"))).scalar()

    return {
        "status": "ok",
        "postgres": pg_version,
        "postgis": postgis_version,
    }


# ─── Phase 3 端点:网格检查 ───────────────────────────────
@app.get("/api/grids/geojson")
async def grids_geojson():
    """
    返回 app.country_grids 全表作为 GeoJSON FeatureCollection。
    用于网格视觉检查器(参数调试用,~5-8 万格,~10 MB JSON)。
    """
    sql = text("""
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(feat), '[]'::json)
        ) AS fc
        FROM (
            SELECT json_build_object(
                'type', 'Feature',
                'id', gid,
                'geometry', ST_AsGeoJSON(geom, 5)::json,
                'properties', json_build_object(
                    'iso', iso,
                    'country', country_name,
                    'idx', grid_index
                )
            ) AS feat
            FROM app.country_grids
        ) sub
    """)
    async with db_conn() as conn:
        result = (await conn.execute(sql)).scalar()
    return result


@app.get("/api/grids/stats")
async def grids_stats():
    """网格统计:总数、国家数、Top 大国、最少格国家。"""
    async with db_conn() as conn:
        total = (await conn.execute(text(
            "SELECT count(*) FROM app.country_grids"
        ))).scalar()
        countries = (await conn.execute(text(
            "SELECT count(DISTINCT iso) FROM app.country_grids"
        ))).scalar()
        top = (await conn.execute(text("""
            SELECT iso, country_name, count(*) AS n
            FROM app.country_grids
            GROUP BY iso, country_name ORDER BY n DESC LIMIT 15
        """))).mappings().all()
        bottom = (await conn.execute(text("""
            SELECT iso, country_name, count(*) AS n
            FROM app.country_grids
            GROUP BY iso, country_name ORDER BY n ASC, iso LIMIT 15
        """))).mappings().all()
    return {
        "total_grids": total,
        "country_count": countries,
        "top_big": [dict(r) for r in top],
        "bottom_small": [dict(r) for r in bottom],
    }


# ─── 国家矢量边界(平滑陆地填充 + 国界线 + 标注) ───────────
@app.get("/api/countries/geojson")
async def countries_geojson():
    """
    app.countries 的真实国界(平滑 MultiPolygon),给 three 版地球画矢量陆地/国界。
    properties 里带 iso/名字/大洲/质心(cx,cy 标注用)/面积(标注取舍用)。
    几何用 ST_SimplifyPreserveTopology 适度简化压体积(~精度足够看)。
    """
    sql = text("""
        SELECT json_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(json_agg(feat), '[]'::json)
        ) AS fc
        FROM (
            SELECT json_build_object(
                'type', 'Feature',
                'properties', json_build_object(
                    'iso', c.iso, 'name', c.country_name, 'continent', c.continent,
                    'cx', round(ST_X(ST_PointOnSurface(c.geom))::numeric, 3),
                    'cy', round(ST_Y(ST_PointOnSurface(c.geom))::numeric, 3),
                    'area', round(c.area_km2::numeric, 0),
                    'covers', COALESCE(ac.n, 0)      -- 该国已下载封面数(港澳台并入 CN),给前端做加密
                ),
                'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(c.geom, 0.08), 4)::json
            ) AS feat
            FROM app.countries c
            LEFT JOIN (
                SELECT CASE WHEN artist_country_iso IN ('HK','MO','TW') THEN 'CN' ELSE artist_country_iso END AS iso,
                       count(*) AS n
                FROM app.albums WHERE cover_status = 'downloaded' AND artist_country_iso IS NOT NULL
                GROUP BY 1
            ) ac ON ac.iso = c.iso
            WHERE c.geom IS NOT NULL
        ) s
    """)
    async with db_conn() as conn:
        result = (await conn.execute(sql)).scalar()
    return result


# ─── 演示动画端点 ─────────────────────────────────────────
@app.get("/api/grids/centroids")
async def grids_centroids():
    """
    每个陆地网格格子的中心点(轻量版,只回 iso/idx/lng/lat)。
    前端用它当"封面能冒出来的坑位",按 iso 分组。
    ~5-6 万点,坐标取 4 位小数压体积(~精度 11m,足够)。
    """
    sql = text("""
        SELECT COALESCE(json_agg(json_build_object(
            'iso', iso,
            'idx', grid_index,
            'lng', round(ST_X(c)::numeric, 4),
            'lat', round(ST_Y(c)::numeric, 4)
        )), '[]'::json) AS pts
        FROM (
            SELECT CASE WHEN iso IN ('HK','MO','TW') THEN 'CN' ELSE iso END AS iso,
                   grid_index, ST_Centroid(geom) AS c
            FROM app.country_grids
            WHERE iso IS NOT NULL
        ) s
    """)
    async with db_conn() as conn:
        result = (await conn.execute(sql)).scalar()
    return result


@app.get("/api/grids/centroids-ea")
async def grids_centroids_ea():
    """
    等面积网格中心点(预生成表 app.country_grids_ea)。每条纬度带的经度点数 ∝ cos(lat),
    所以高纬天生更稀、球面物理密度均匀 → 高纬封面不再挤。与 /api/grids/centroids 同形状。
    没建表则 404(前端回退普通网格)。重建见 README(改 step 即改疏密)。
    """
    async with db_conn() as conn:
        exists = (await conn.execute(text("SELECT to_regclass('app.country_grids_ea')"))).scalar()
        if not exists:
            return Response(status_code=404)
        result = (await conn.execute(text(
            "SELECT COALESCE(json_agg(json_build_object('iso', iso, 'lng', lng, 'lat', lat)), '[]'::json)"
            " FROM app.country_grids_ea"
        ))).scalar()
    return result


@app.get("/api/timeline/yearly-counts")
async def timeline_yearly_counts(start: int = 2010, end: int = 2025):
    """
    指定年份区间内,每年每国发行的专辑数。
    返回 { "2010": { "US": 1234, ... }, ... },前端一次性拉取后本地驱动动画。
    """
    sql = text("""
        SELECT release_year AS y, artist_country_iso AS iso, count(*) AS n
        FROM app.albums
        WHERE release_year BETWEEN :start AND :end
          AND artist_country_iso IS NOT NULL
        GROUP BY release_year, artist_country_iso
        ORDER BY release_year, artist_country_iso
    """)
    async with db_conn() as conn:
        rows = (await conn.execute(sql, {"start": start, "end": end})).mappings().all()

    out: dict[str, dict[str, int]] = {}
    for r in rows:
        out.setdefault(str(r["y"]), {})[r["iso"]] = r["n"]
    return {"start": start, "end": end, "counts": out}


@app.get("/api/timeline/albums")
async def timeline_albums(start: int = 2010, end: int = 2025, per: int = 500):
    """
    驱动封面动画 + 点击身份:
      - counts:每年每国专辑数(精确,用于动画节奏)
      - pool  :每(国,年)的专辑;按年份排序,使"出现年份=专辑年份"
                per>0 :每(国,年)随机抽 per 张(默认 500,中小国近全量,只截极少数巨头)
                per<=0:全量模式 —— 不截断,返回每国每年「全部」已下载封面,
                        且 pool 每条只回 {y,c}(砍掉 t/a 省体积,~50MB→~20MB),
                        点击封面时再用 /api/album/{mbid} 取标题/艺术家。
    """
    # 港澳台并入中国(CN):它们没有独立网格,专辑归到 CN 才有格子可落
    # 只统计/抽取"封面已下载"的专辑:没有封面的不显示,动画节奏也据此对齐
    counts_sql = text("""
        SELECT release_year AS y,
               CASE WHEN artist_country_iso IN ('HK','MO','TW') THEN 'CN' ELSE artist_country_iso END AS iso,
               count(*) AS n
        FROM app.albums
        WHERE release_year BETWEEN :start AND :end AND artist_country_iso IS NOT NULL
          AND cover_status = 'downloaded'
        GROUP BY 1, 2
    """)
    full = per <= 0
    if full:
        # 全量:不开窗截断,只回 {iso, mbid, y};按 iso,y 排序便于前端按(国,年)分桶
        pool_sql = text("""
            SELECT CASE WHEN artist_country_iso IN ('HK','MO','TW') THEN 'CN' ELSE artist_country_iso END AS iso,
                   mbid::text AS mbid, release_year AS y
            FROM app.albums
            WHERE release_year BETWEEN :start AND :end AND artist_country_iso IS NOT NULL
              AND cover_status = 'downloaded'
            ORDER BY 1, release_year
        """)
        pool_params = {"start": start, "end": end}
    else:
        pool_sql = text("""
            WITH base AS (
                SELECT CASE WHEN artist_country_iso IN ('HK','MO','TW') THEN 'CN' ELSE artist_country_iso END AS iso,
                       mbid::text AS mbid, title, primary_artist_name AS artist, release_year AS y
                FROM app.albums
                WHERE release_year BETWEEN :start AND :end AND artist_country_iso IS NOT NULL
                  AND cover_status = 'downloaded'
            ), r AS (
                SELECT iso, mbid, title, artist, y,
                       row_number() OVER (PARTITION BY iso, y ORDER BY random()) AS rn
                FROM base
            )
            SELECT iso, mbid, title, artist, y FROM r WHERE rn <= :per ORDER BY iso, y, rn
        """)
        pool_params = {"start": start, "end": end, "per": per}

    async with db_conn() as conn:
        crows = (await conn.execute(counts_sql, {"start": start, "end": end})).mappings().all()
        prows = (await conn.execute(pool_sql, pool_params)).mappings().all()

    counts: dict[str, dict[str, int]] = {}
    for r in crows:
        counts.setdefault(str(r["y"]), {})[r["iso"]] = r["n"]
    pool: dict[str, list] = {}
    if full:
        for r in prows:
            pool.setdefault(r["iso"], []).append({"y": r["y"], "c": r["mbid"]})
    else:
        for r in prows:
            pool.setdefault(r["iso"], []).append(
                {"t": r["title"], "a": r["artist"], "y": r["y"], "c": r["mbid"]}
            )
    return {"start": start, "end": end, "counts": counts, "pool": pool}


@app.get("/api/album/{mbid}")
async def album_meta(mbid: str):
    """
    单条专辑元数据(标题/艺术家/年份)。全量模式下 pool 不带 t/a,
    点击封面时用它按 mbid 主键取一行,localhost 几毫秒。
    """
    if not _UUID_RE.match(mbid):
        return Response(status_code=400)
    sql = text("""
        SELECT title AS t, primary_artist_name AS a, release_year AS y
        FROM app.albums WHERE mbid = CAST(:mbid AS uuid) LIMIT 1
    """)
    async with db_conn() as conn:
        row = (await conn.execute(sql, {"mbid": mbid})).mappings().first()
    if not row:
        return Response(status_code=404)
    return {"t": row["t"], "a": row["a"], "y": row["y"], "c": mbid}


@app.get("/api/story/sample")
async def story_sample(n: int = 300, cn_ratio: float = 0.12):
    """
    scroll story 第 3-5 页用的专辑抽样。
      - 按真实「每年发行量」比例分配名额 → 年份块高度反映真实多寡
      - 每年内国家随机(自然偏美/英),但保底一部分中国(cn_ratio)→ 有认识的封面
    返回:
      yearCounts: 每年真实专辑数(前端据此算每段总量,显示 71K/130K 等)
      albums    : [{c: 专辑mbid, y: 年, a: 艺术家名, am: 艺术家mbid, iso}]
    """
    n = max(1, min(n, 2000))
    base_where = ("release_year BETWEEN 2011 AND 2025 AND cover_status='downloaded' "
                  "AND artist_country_iso IS NOT NULL")
    yc_sql = text(f"SELECT release_year AS y, count(*) AS n FROM app.albums "
                  f"WHERE {base_where} GROUP BY 1 ORDER BY 1")
    async with db_conn() as conn:
        yc_rows = (await conn.execute(yc_sql)).mappings().all()
        year_counts = {int(r["y"]): int(r["n"]) for r in yc_rows}
        total = sum(year_counts.values()) or 1
        alloc = {y: max(0, round(n * c / total)) for y, c in year_counts.items()}
        cn_take = {y: (min(alloc[y], max(1, round(alloc[y] * cn_ratio))) if alloc[y] else 0)
                   for y in alloc}
        cap = max(60, (max(alloc.values()) if alloc else 0) + 5)
        sample_sql = text(f"""
            WITH pool AS (
                SELECT mbid::text AS c, release_year AS y, title AS t,
                       primary_artist_name AS a, primary_artist_mbid::text AS am,
                       CASE WHEN artist_country_iso IN ('HK','MO','TW') THEN 'CN'
                            ELSE artist_country_iso END AS iso
                FROM app.albums WHERE {base_where}
            ), ranked AS (
                SELECT c, y, t, a, am, iso,
                       row_number() OVER (PARTITION BY y, (iso = 'CN') ORDER BY random()) AS rn
                FROM pool
            )
            SELECT c, y, t, a, am, iso, (iso = 'CN') AS is_cn, rn
            FROM ranked WHERE rn <= :cap
        """)
        rows = (await conn.execute(sample_sql, {"cap": cap})).mappings().all()

    by_year_cn: dict[int, list] = {}
    by_year_other: dict[int, list] = {}
    for r in rows:
        d = by_year_cn if r["is_cn"] else by_year_other
        d.setdefault(int(r["y"]), []).append(r)
    albums: list[dict] = []
    for y in sorted(alloc):
        a = alloc[y]
        if a <= 0:
            continue
        cn_list = sorted(by_year_cn.get(y, []), key=lambda r: r["rn"])[:cn_take[y]]
        need_other = max(0, a - len(cn_list))
        other_list = sorted(by_year_other.get(y, []), key=lambda r: r["rn"])[:need_other]
        for r in cn_list + other_list:
            albums.append({"c": r["c"], "y": int(r["y"]), "t": r["t"], "a": r["a"],
                           "am": r["am"], "iso": r["iso"]})
    return {"n": len(albums),
            "yearCounts": {str(k): v for k, v in year_counts.items()},
            "albums": albums}


AGE_BINS = ["18-24", "25-29", "30-34", "35-39", "40-44", "45-49", "50-54", "55-59", "60+"]


# 点名的"跨年龄段"作者(一定出现在第 5 页,带金线串联):周杰伦 / 方大同 / 宇多田光
NAMED_FEATURED = [
    "a223958d-5c56-4b2c-a30a-87e357bc121b",
    "081f97c3-2ae9-4698-aa43-88ccb58af4d5",
    "b539e453-c4fe-47e3-8a07-8517eac74429",
]


def _uuid_arr(items) -> str:
    """把 mbid 列表拼成安全的 Postgres text[] 字面量(已用正则校验,无注入)。"""
    safe = [m for m in items if _UUID_RE.match(m)]
    return ("ARRAY[" + ",".join(f"'{m}'" for m in safe) + "]::text[]") if safe else "ARRAY[]::text[]"


@app.get("/api/story/age-sample")
async def story_age_sample(n: int = 300, cn_ratio: float = 0.12,
                           max_multi: int = 10, per_artist_cap: int = 16):
    """
    第 5 页(ALBUMS / AGE)· 保持年龄段比例 + 作者优先:
      1) 每年龄段按真实占比定额 quota[bin]=round(n×占比) → 决定上排堆叠高度(比例正确)。
      2) 随机选最多 max_multi 位跨段作者(跨 ≥2 个年龄段,点名 3 位优先):把其专辑往对应年龄段放,
         每放一张扣该段配额;某段配额用完就不再往该段放(故高产作者在拥挤段可能被截断)。
         实际落在 ≥2 段者带 group=艺术家mbid → 点击金线串联。
      3) 各段剩余配额用「其余作者各 1 张」补满,中国作者保底 cn_ratio。
    """
    n = max(1, min(n, 3000))
    cr = max(0.0, min(0.9, cn_ratio))
    mm = max(0, min(max_multi, 40))
    pcap = max(1, min(per_artist_cap, 60))
    age = "(al.release_year - ar.begin_date_year)"
    base = (f"al.release_year BETWEEN 2011 AND 2025 AND al.cover_status='downloaded' "
            f"AND ar.artist_type='Person' AND ar.begin_date_year IS NOT NULL "
            f"AND ar.deezer_status='matched' AND {age} BETWEEN 10 AND 90")
    bin_expr = (f"CASE WHEN {age} < 25 THEN '18-24' WHEN {age} >= 60 THEN '60+' "
                f"ELSE (({age}/5)*5)::text || '-' || (({age}/5)*5 + 4)::text END")
    named_arr = _uuid_arr(NAMED_FEATURED)

    def mk_album(r, feat):
        return {"c": r["c"], "am": r["am"], "t": r["t"], "a": r["a"], "y": int(r["y"]),
                "age": int(r["age"]), "bin": r["bin"], "iso": r["iso"], "feat": feat}

    async with db_conn() as conn:
        # 1) 配额:各年龄段真实专辑占比 → 上排堆叠高度(GROUP BY bin,廉价)
        bc = (await conn.execute(text(f"""
            SELECT bin, count(*) AS n FROM (
                SELECT {bin_expr} AS bin
                FROM app.albums al JOIN app.artists ar ON ar.mbid = al.primary_artist_mbid
                WHERE {base}
            ) s GROUP BY bin
        """))).mappings().all()
        bin_counts = {r["bin"]: int(r["n"]) for r in bc}
        total = sum(bin_counts.values()) or 1
        quota = {b: max(0, round(n * bin_counts.get(b, 0) / total)) for b in AGE_BINS}
        remaining = dict(quota)

        # 2) 选 ≤ mm 位多产作者(≥2 张,点名优先 + 随机) —— 只取作者 id,不在 SQL 里 JOIN 回全表
        ca = (await conn.execute(text(f"""
            WITH ac AS (
                SELECT al.primary_artist_mbid::text AS am, count(DISTINCT {bin_expr}) AS nb
                FROM app.albums al JOIN app.artists ar ON ar.mbid = al.primary_artist_mbid
                WHERE {base} GROUP BY 1
            )
            SELECT am FROM ac WHERE nb >= 2 AND am = ANY({named_arr})
            UNION
            SELECT am FROM (
                SELECT am FROM ac WHERE nb >= 2 AND NOT (am = ANY({named_arr}))
                ORDER BY random() LIMIT :k
            ) z
        """), {"k": mm})).mappings().all()
        all_am = [r["am"] for r in ca]
        named_in = [a for a in all_am if a in NAMED_FEATURED]
        other_in = [a for a in all_am if a not in NAMED_FEATURED]
        chosen = named_in + other_in[:max(0, mm - len(named_in))]

        # 多产作者的全部专辑(= ANY 少量 id,走索引,廉价)
        crows: list = []
        if chosen:
            crows = (await conn.execute(text(f"""
                SELECT al.mbid::text AS c, al.primary_artist_mbid::text AS am, al.title AS t,
                       al.primary_artist_name AS a, al.release_year AS y, {age}::int AS age,
                       {bin_expr} AS bin,
                       CASE WHEN al.artist_country_iso IN ('HK','MO','TW') THEN 'CN'
                            ELSE al.artist_country_iso END AS iso
                FROM app.albums al JOIN app.artists ar ON ar.mbid = al.primary_artist_mbid
                WHERE {base} AND al.primary_artist_mbid::text = ANY({_uuid_arr(chosen)})
            """))).mappings().all()

        albums: list[dict] = []
        artists: list[dict] = []
        by_art: dict[str, list] = {}
        for r in crows:
            by_art.setdefault(r["am"], []).append(r)
        # 点名优先放置:逐位把专辑往对应段放,扣配额;配额满则该段截断
        for am in sorted(by_art, key=lambda a: (a not in NAMED_FEATURED)):
            named = am in NAMED_FEATURED
            rs = sorted(by_art[am], key=lambda r: (r["age"], r["y"]))[:pcap]
            placed: list[str] = []
            for r in rs:
                b = r["bin"]
                if remaining.get(b, 0) <= 0:
                    continue
                remaining[b] -= 1
                albums.append(mk_album(r, named))
                if b not in placed:
                    placed.append(b)
            placed.sort(key=AGE_BINS.index)
            grp = am if len(placed) >= 2 else None       # 实际落到 ≥2 段才串联
            for b in placed:                              # 每个实际落到的段一个头像(10 位跨段作者都发光标记)
                r0 = min((r for r in rs if r["bin"] == b), key=lambda r: r["age"])
                artists.append({"id": f"m_{am}_{b}", "am": am, "a": r0["a"],
                                "age": int(r0["age"]), "bin": b, "feat": True, "group": grp})

        # 3) 各段剩余配额用「其余作者各 1 张」补满(单次窗口扫描)
        excl_arr = _uuid_arr(chosen)
        cap = (max(remaining.values()) if remaining else 0) + 60
        brows = (await conn.execute(text(f"""
            WITH pool AS (
                SELECT al.mbid::text AS c, al.primary_artist_mbid::text AS am, al.title AS t,
                       al.primary_artist_name AS a, al.release_year AS y, {age}::int AS age,
                       {bin_expr} AS bin,
                       CASE WHEN al.artist_country_iso IN ('HK','MO','TW') THEN 'CN'
                            ELSE al.artist_country_iso END AS iso
                FROM app.albums al JOIN app.artists ar ON ar.mbid = al.primary_artist_mbid
                WHERE {base} AND al.primary_artist_mbid::text <> ALL({excl_arr})
            ), ranked AS (
                SELECT c, am, t, a, y, age, bin, iso,
                       row_number() OVER (PARTITION BY bin, (iso = 'CN') ORDER BY random()) AS rn
                FROM pool
            )
            SELECT c, am, t, a, y, age, bin, iso, (iso = 'CN') AS is_cn, rn
            FROM ranked WHERE rn <= :cap
        """), {"cap": cap})).mappings().all()

    # 各段补尾:其余作者每人 1 张(全局按作者去重),中国保底
    by_cn: dict[str, list] = {}
    by_ot: dict[str, list] = {}
    for r in brows:
        (by_cn if r["is_cn"] else by_ot).setdefault(r["bin"], []).append(r)
    used: set = set(chosen)
    for b in AGE_BINS:
        need = max(0, remaining.get(b, 0))
        if need <= 0:
            continue
        cn_b = [r for r in sorted(by_cn.get(b, []), key=lambda r: r["rn"]) if r["am"] not in used]
        ot_b = [r for r in sorted(by_ot.get(b, []), key=lambda r: r["rn"]) if r["am"] not in used]
        cn_take = min(len(cn_b), max(1, round(need * cr)))
        fill = cn_b[:cn_take] + ot_b[:max(0, need - cn_take)]
        for r in fill:
            if r["am"] in used:
                continue
            used.add(r["am"])
            albums.append(mk_album(r, False))
            artists.append({"id": f"s_{r['am']}_{b}", "am": r["am"], "a": r["a"],
                            "age": int(r["age"]), "bin": b, "feat": False, "group": None})

    random.shuffle(albums)
    random.shuffle(artists)
    return {"n": len(artists), "multiArtists": len(chosen), "quota": quota,
            "albums": albums, "artists": artists}


# ─── 预烤封面图集(方案 B):后端 app.bake_atlas 烤出,前端只下 8 图+manifest 即秒开 ───
ATLAS_DIR = os.getenv("ATLAS_DIR", os.path.join(os.path.dirname(__file__), "_atlas"))


@app.get("/api/atlas/manifest.json")
async def atlas_manifest():
    """预烤清单(counts + pool,pool 顺序即图集格子顺序)。没烤过则 404,前端回退实时拼图。"""
    p = os.path.join(ATLAS_DIR, "manifest.json")
    if not os.path.exists(p):
        return Response(status_code=404)
    # 重烤后内容会变 → 用协商缓存(FileResponse 自带 etag/last-modified,未变则 304)
    return FileResponse(p, media_type="application/json", headers={"Cache-Control": "no-cache"})


@app.get("/api/atlas/{g}.jpg")
async def atlas_image(g: int):
    """第 g 张图集 JPEG。前端 URL 带 ?v={manifest.version},重烤后 version 变 → 缓存自动失效。"""
    if not (0 <= g < 64):
        return Response(status_code=404)
    p = os.path.join(ATLAS_DIR, f"atlas_{g}.jpg")
    if not os.path.exists(p):
        return Response(status_code=404)
    return FileResponse(p, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ─── 专辑封面图片(从 MinIO 取,前端按 mbid 拉) ────────────
COVER_BUCKET = "musicmap-covers"
ARTIST_BUCKET = "musicmap-artists"   # 艺术家头像(phase3 deezer 采集,640×640)
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                      r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_minio_client: Minio | None = None


def _get_minio() -> Minio:
    """懒加载 MinIO 客户端(连接配置由 docker-compose 注入)。"""
    global _minio_client
    if _minio_client is None:
        _minio_client = Minio(
            os.getenv("MINIO_ENDPOINT", "minio:9000"),
            access_key=os.getenv("MINIO_ACCESS_KEY", "musicmap"),
            secret_key=os.getenv("MINIO_SECRET_KEY", "change_me_in_real_env"),
            secure=False,
        )
    return _minio_client


@app.get("/api/covers/{mbid}")
async def cover(mbid: str):
    """
    按 mbid 返回该专辑封面 JPEG(640×640)。
    object key 与 ETL 一致:{mbid[:2]}/{mbid}.jpg。
    没有封面(404)时返回 404,前端会回退到占位图/不显示。
    """
    if not _UUID_RE.match(mbid):
        return Response(status_code=400)
    key = f"{mbid[:2]}/{mbid}.jpg"

    def _read() -> bytes:
        resp = _get_minio().get_object(COVER_BUCKET, key)
        try:
            return resp.read()
        finally:
            resp.close()
            resp.release_conn()

    try:
        data = await asyncio.to_thread(_read)
    except S3Error:
        return Response(status_code=404)
    # 封面内容不变 → 让浏览器长期缓存,避免重复拉
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.get("/api/artists/{mbid}")
async def artist_image(mbid: str):
    """按艺术家 mbid 返回头像 JPEG(640×640,musicmap-artists 桶)。没有则 404。"""
    if not _UUID_RE.match(mbid):
        return Response(status_code=400)
    key = f"{mbid[:2]}/{mbid}.jpg"

    def _read() -> bytes:
        resp = _get_minio().get_object(ARTIST_BUCKET, key)
        try:
            return resp.read()
        finally:
            resp.close()
            resp.release_conn()

    try:
        data = await asyncio.to_thread(_read)
    except S3Error:
        return Response(status_code=404)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# ─── Spotify 实时搜索(Client Credentials) ─────────────────
_spotify_token = {"value": None, "exp": 0.0}


async def _get_spotify_token() -> str | None:
    now = time.time()
    if _spotify_token["value"] and _spotify_token["exp"] > now + 30:
        return _spotify_token["value"]
    cid = os.getenv("SPOTIFY_CLIENT_ID")
    sec = os.getenv("SPOTIFY_CLIENT_SECRET")
    if not cid or not sec:
        return None
    auth = base64.b64encode(f"{cid}:{sec}".encode()).decode()
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            "https://accounts.spotify.com/api/token",
            data={"grant_type": "client_credentials"},
            headers={"Authorization": f"Basic {auth}"},
        )
        r.raise_for_status()
        j = r.json()
    _spotify_token["value"] = j["access_token"]
    _spotify_token["exp"] = now + j.get("expires_in", 3600)
    return _spotify_token["value"]


@app.get("/api/spotify/search")
async def spotify_search(artist: str = "", title: str = ""):
    """按 艺人+专辑名 实时搜 Spotify,返回最匹配专辑(给前端开嵌入播放器)。"""
    token = await _get_spotify_token()
    if not token:
        return {"ok": False, "reason": "no_credentials"}
    q = f"album:{title} artist:{artist}".strip()
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            "https://api.spotify.com/v1/search",
            params={"q": q, "type": "album", "limit": 1},
            headers={"Authorization": f"Bearer {token}"},
        )
    if r.status_code != 200:
        return {"ok": False, "reason": f"spotify_{r.status_code}"}
    items = r.json().get("albums", {}).get("items", [])
    if not items:
        return {"ok": False, "reason": "no_match"}
    a = items[0]
    return {
        "ok": True,
        "id": a["id"],
        "name": a["name"],
        "artist": a["artists"][0]["name"] if a.get("artists") else "",
        "image": a["images"][0]["url"] if a.get("images") else None,
        "url": a["external_urls"]["spotify"],
    }
