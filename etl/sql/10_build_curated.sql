-- ─────────────────────────────────────────────────────────────
-- Phase 1 / Step 3: 从 mb_raw.* 生成业务表 app.albums
--
-- 这是 Phase 1 的"核心 SQL",决定了我们整个项目能查到什么数据。
-- 规则严格按你定的:
--   1. 国家归属用艺人国籍 (artist.area -> iso_3166_1.code)
--   2. 全量精筛 = Album 类型 + 年份>=1950 + 必须有艺人国籍
--   3. 每个 release_group 只保留一行 (取最早 release 的那一次发行)
--
-- 输出:app.albums 表,大概 80-150 万行
-- ─────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS app;

DROP TABLE IF EXISTS app.albums CASCADE;
CREATE TABLE app.albums (
    -- 主键:用 release_group 的 MBID,因为一张专辑对应一个 release_group
    mbid                  UUID PRIMARY KEY,

    -- 显示字段
    title                 TEXT NOT NULL,
    primary_artist_name   TEXT NOT NULL,
    primary_artist_mbid   UUID,

    -- 国家归属(关键!按规划方案 B = 艺人国籍)
    artist_country_iso    CHAR(2) NOT NULL,

    -- 同时保留发行国,前端将来可以做 A/B 视图切换
    release_country_iso   CHAR(2),

    -- 时间
    release_year          SMALLINT NOT NULL,
    release_month         SMALLINT,
    release_day           SMALLINT,

    -- 类型(目前都是 'Album',留字段方便以后扩 'EP' 'Soundtrack')
    type                  TEXT NOT NULL DEFAULT 'Album',

    -- Phase 2 会回填的字段(先占位)
    cover_status          TEXT NOT NULL DEFAULT 'unknown',   -- unknown | downloaded | missing
    popularity_score      REAL,                              -- 0..1,Phase 2 用 Last.fm 算

    -- 元数据
    imported_at           TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- 构造主体:CTE 链路一步步过滤
--
-- earliest_release_per_group:每个 release_group 的"最早一次有日期+国家的发行"
--   - 用 release_country 拿到 (release, country, year, month, day)
--   - JOIN release 拿到 release_group
--   - JOIN release_group 过滤 type=Album (id=1)
--   - 用 DISTINCT ON 在每个 release_group 里只保留 year 最小的那一行
-- ─────────────────────────────────────────────────────────────
\echo '构造 app.albums (一次完成 JOIN + 过滤 + 去重)...'

INSERT INTO app.albums (
    mbid, title,
    primary_artist_name, primary_artist_mbid,
    artist_country_iso, release_country_iso,
    release_year, release_month, release_day,
    type
)
WITH
-- 1) 每个 release_group 取最早一次有 country 和 year 的 release_country 行
earliest AS (
    SELECT DISTINCT ON (rg.id)
        rg.id            AS rg_id,
        rg.gid           AS rg_gid,
        rg.name          AS rg_name,
        rg.artist_credit AS rg_artist_credit,
        rc.country       AS rc_area_id,
        rc.date_year     AS year,
        rc.date_month    AS month,
        rc.date_day      AS day
    FROM mb_raw.release_group rg
    JOIN mb_raw.release       r  ON r.release_group = rg.id
    JOIN mb_raw.release_country rc ON rc.release = r.id
    WHERE rg.type = 1                    -- Album only
      AND rc.date_year IS NOT NULL
      AND rc.date_year >= 1950
      AND rc.date_year <= 2026
      AND rc.country IS NOT NULL
    ORDER BY rg.id,
             rc.date_year ASC NULLS LAST,
             rc.date_month ASC NULLS LAST,
             rc.date_day   ASC NULLS LAST
),
-- 2) 拿到每个 artist_credit 的第一署名艺人 (position = 0)
primary_artist AS (
    SELECT
        acn.artist_credit AS ac_id,
        acn.artist        AS artist_id
    FROM mb_raw.artist_credit_name acn
    WHERE acn.position = 0
)
SELECT
    e.rg_gid                                AS mbid,
    e.rg_name                               AS title,
    a.name                                  AS primary_artist_name,
    a.gid                                   AS primary_artist_mbid,
    iso_artist.iso_code                     AS artist_country_iso,
    iso_release.iso_code                    AS release_country_iso,
    e.year                                  AS release_year,
    e.month                                 AS release_month,
    e.day                                   AS release_day,
    'Album'                                 AS type
FROM earliest e
JOIN primary_artist pa     ON pa.ac_id = e.rg_artist_credit
JOIN mb_raw.artist a       ON a.id = pa.artist_id
-- 艺人国籍解析 (递归映射,sub-area 如 England 也能正确归到 GB)
JOIN mb_raw.area_to_country iso_artist  ON iso_artist.area_id = a.area
-- 发行国解析 (同样走递归映射,LEFT JOIN 允许为空)
LEFT JOIN mb_raw.area_to_country iso_release ON iso_release.area_id = e.rc_area_id
WHERE a.area IS NOT NULL;

\echo '─── 索引 ───'
CREATE INDEX idx_albums_country_year ON app.albums(artist_country_iso, release_year);
CREATE INDEX idx_albums_release_country_year ON app.albums(release_country_iso, release_year);
CREATE INDEX idx_albums_year ON app.albums(release_year);
CREATE INDEX idx_albums_artist ON app.albums(primary_artist_mbid);

\echo '─── 完成,样本 ───'
SELECT
    'app.albums 总行数' AS metric,
    count(*)::text       AS value
FROM app.albums;
