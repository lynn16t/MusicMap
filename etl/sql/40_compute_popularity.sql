-- ─────────────────────────────────────────────────────────────
-- Phase 2 / Popularity 代理
--
-- 背景:
--   Spotify 2024 年下线了 album/track/artist 的 popularity 字段,免费 API 拿不到。
--   作为替代,我们用 MusicBrainz 自带的"release 数量"做 popularity 代理:
--
--   一张专辑(release_group)被发行的版本数(CD/黑胶/数字/各国版/重制版...)
--   通常跟它的"商业重要程度"成正比 — 热门作品 IT 厂牌会反复发行。
--
-- 输出:
--   app.albums.release_count          (整数)
--   app.albums.popularity_score       (0-1 浮点,log 归一化)
-- ─────────────────────────────────────────────────────────────

-- 1. 加字段
ALTER TABLE app.albums
    ADD COLUMN IF NOT EXISTS release_count INTEGER;

-- popularity_score 已经在 schema 里,这里不重新加

\echo '[1/3] 计算每个 release_group 的 release 数...'

WITH counts AS (
    SELECT rg.gid AS mbid, count(r.id) AS n
    FROM mb_raw.release_group rg
    JOIN mb_raw.release r ON r.release_group = rg.id
    GROUP BY rg.gid
)
UPDATE app.albums a
SET release_count = c.n
FROM counts c
WHERE a.mbid = c.mbid;

\echo '[2/3] 归一化成 0-1 的 popularity_score(用 log 压缩长尾)...'

-- log(release_count) / log(max) 得到 0-1
-- 这样 1 个 release → 0, 10 个 → 中等, 100+ → 接近 1
WITH stats AS (
    SELECT max(release_count) AS max_rc FROM app.albums
)
UPDATE app.albums
SET popularity_score =
    LEAST(1.0, ln(release_count + 1) / ln((SELECT max_rc FROM stats) + 1))
WHERE release_count IS NOT NULL;

\echo '[3/3] 加索引方便后面查 top N...'
CREATE INDEX IF NOT EXISTS idx_albums_popularity
    ON app.albums(popularity_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_albums_popularity_year_country
    ON app.albums(artist_country_iso, release_year, popularity_score DESC);

\echo ''
\echo '─── 结果统计 ─────────────────────────────────'
SELECT
    'min release_count' AS metric, min(release_count)::text AS value FROM app.albums
UNION ALL SELECT 'max release_count', max(release_count)::text FROM app.albums
UNION ALL SELECT 'avg release_count', round(avg(release_count)::numeric, 2)::text FROM app.albums
UNION ALL SELECT 'p50 release_count', percentile_cont(0.5) WITHIN GROUP (ORDER BY release_count)::text FROM app.albums
UNION ALL SELECT 'p90 release_count', percentile_cont(0.9) WITHIN GROUP (ORDER BY release_count)::text FROM app.albums
UNION ALL SELECT 'p99 release_count', percentile_cont(0.99) WITHIN GROUP (ORDER BY release_count)::text FROM app.albums;

\echo ''
\echo '─── Top 20 (按 release_count 排) ─────────────'
SELECT
    LEFT(title, 35) AS title,
    LEFT(primary_artist_name, 20) AS artist,
    artist_country_iso AS cc,
    release_year AS yr,
    release_count AS rc,
    popularity_score::numeric(4,3) AS score
FROM app.albums
ORDER BY release_count DESC NULLS LAST
LIMIT 20;
