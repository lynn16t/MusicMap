-- ─────────────────────────────────────────────────────────────
-- Phase 3 / Step 1: 国家边界 + 全球均匀网格
--
-- 输入:public.ne_countries (由 shp2pgsql 从 Natural Earth shp 导入)
-- 输出:
--   app.countries       — 整理过的国家边界(iso, name, geom, area_km2)
--   app.country_grids   — 全球均匀方格,按格子中心归属国家
--
-- 策略(参考 MIT《世界动画地图》):
--   1) 在全球 bbox 上生成统一 cell_deg 的方格
--   2) 每格取中心点,ST_Within 找它落在哪个国家
--   3) 没有归属的格子 = 海洋 / 无主之地 → 丢弃
--   4) 大国自然格子多,小国自然格子少 — 不再做 per-country cap 或 bbox 兜底
--   5) 对 cell 数 = 0 的国家(梵蒂冈等),在国家形心处放一个兜底格
--
-- 视觉显示需要配合球面投影(MapLibre globe),这样
-- 高纬度国家的"高瘦"格子在球面上是合理的。
-- ─────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on

\echo ''
\echo '════════════════════════════════════════════════════════'
\echo '  Phase 3 Step 1: 国家边界与全球均匀网格'
\echo '════════════════════════════════════════════════════════'

-- ─── A. 整理 app.countries(从 public.ne_countries) ──────
\echo ''
\echo '── A. app.countries 整理 ──────────────────────────────'

DROP TABLE IF EXISTS app.countries CASCADE;

CREATE TABLE app.countries AS
WITH iso_resolved AS (
    SELECT
        COALESCE(NULLIF(iso_a2, '-99'), NULLIF(iso_a2_eh, '-99'))::char(2) AS iso,
        name, name_long, continent, geom
    FROM public.ne_countries
    WHERE COALESCE(NULLIF(iso_a2, '-99'), NULLIF(iso_a2_eh, '-99')) IS NOT NULL
)
SELECT
    iso,
    (array_agg(name        ORDER BY ST_Area(geom) DESC))[1] AS country_name,
    (array_agg(name_long   ORDER BY ST_Area(geom) DESC))[1] AS country_name_long,
    (array_agg(continent   ORDER BY ST_Area(geom) DESC))[1] AS continent,
    ST_Multi(ST_MakeValid(ST_Union(geom)))::geometry(MultiPolygon, 4326) AS geom,
    SUM(ST_Area(geom::geography)) / 1e6 AS area_km2
FROM iso_resolved
GROUP BY iso;

CREATE UNIQUE INDEX countries_iso_uidx ON app.countries(iso);
CREATE INDEX countries_geom_gix ON app.countries USING GIST(geom);
ANALYZE app.countries;

SELECT count(*) AS country_count FROM app.countries;

-- ─── B. country_grids 表结构 ──────────────────────────────
\echo ''
\echo '── B. country_grids 表重建 ────────────────────────────'

DROP TABLE IF EXISTS app.country_grids CASCADE;

-- iso / country_name 允许 NULL:海洋格子归属为空
CREATE TABLE app.country_grids (
    gid          BIGSERIAL PRIMARY KEY,
    iso          CHAR(2),
    country_name TEXT,
    geom         GEOMETRY(Polygon, 4326) NOT NULL,
    centroid_lng DOUBLE PRECISION NOT NULL,
    centroid_lat DOUBLE PRECISION NOT NULL,
    grid_index   INT              NOT NULL
);

-- ─── C. 全球均匀网格(陆地 + 海洋全部入表) ───────────────
\echo ''
\echo '── C. 全球 2° 方格(海洋也切,iso=NULL) ─────────────'

INSERT INTO app.country_grids (iso, country_name, geom, centroid_lng, centroid_lat, grid_index)
WITH params AS (
    -- ⬇⬇⬇  调参在这里  ⬇⬇⬇
    SELECT 1.0::float AS cell_deg   -- 全球统一网格边长(度);切 1/4 → 2.0 改 1.0
),
world_cells AS (
    SELECT cell.geom AS cell_geom
    FROM ST_SquareGrid(
        (SELECT cell_deg FROM params),
        ST_MakeEnvelope(-180, -90, 180, 90, 4326)
    ) AS cell
),
cell_with_center AS (
    SELECT cell_geom, ST_Centroid(cell_geom) AS center
    FROM world_cells
),
assigned AS (
    -- LEFT JOIN:海洋 cell 在 country 表里找不到匹配,iso 保留 NULL
    -- DISTINCT ON 防止某 cell 中心刚好压国界时出双份(取面积大的国家)
    SELECT DISTINCT ON (c.cell_geom)
           c.cell_geom, c.center, co.iso, co.country_name
    FROM cell_with_center c
    LEFT JOIN app.countries co
      ON ST_Within(c.center, co.geom)
    ORDER BY c.cell_geom, co.area_km2 DESC NULLS LAST
),
indexed AS (
    SELECT iso, country_name, cell_geom AS geom, center,
           ROW_NUMBER() OVER (
               PARTITION BY iso
               ORDER BY ST_Y(center) DESC, ST_X(center)
           ) AS rn
    FROM assigned
)
SELECT iso, country_name, geom,
       ST_X(center), ST_Y(center), rn::int
FROM indexed;

\echo '  ✓ 全球网格归属完成(陆地有 iso,海洋 iso=NULL)'

-- ─── E. 索引 + ANALYZE ────────────────────────────────────
CREATE INDEX country_grids_iso_idx  ON app.country_grids(iso);
CREATE INDEX country_grids_geom_gix ON app.country_grids USING GIST(geom);
ANALYZE app.country_grids;

-- ─── F. 统计 ──────────────────────────────────────────────
\echo ''
\echo '── F. 统计 ────────────────────────────────────────────'

\echo ''
\echo '  全局合计:'
SELECT
    count(*) AS total_grids,
    count(*) FILTER (WHERE iso IS NOT NULL) AS land_grids,
    count(*) FILTER (WHERE iso IS NULL)     AS ocean_grids,
    count(DISTINCT iso) FILTER (WHERE iso IS NOT NULL) AS country_count
FROM app.country_grids;

\echo ''
\echo '  Top 15 大国(格子数):'
SELECT iso, country_name, count(*) AS n
FROM app.country_grids
GROUP BY iso, country_name
ORDER BY n DESC
LIMIT 15;

\echo ''
\echo '  Bottom 10(格子数最少):'
SELECT iso, country_name, count(*) AS n
FROM app.country_grids
GROUP BY iso, country_name
ORDER BY n ASC, iso
LIMIT 10;

\echo ''
\echo '════════════════════════════════════════════════════════'
\echo '  ✓ Phase 3 Step 1 完成。'
\echo '════════════════════════════════════════════════════════'
