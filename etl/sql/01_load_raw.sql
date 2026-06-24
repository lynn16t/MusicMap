-- ─────────────────────────────────────────────────────────────
-- Phase 1 / Step 2: 把 12 张 TSV dump 文件 \copy 进 mb_raw.*
--
-- 前置:
--   - 00_raw_schema.sql 已跑完 (空表已存在)
--   - dump 目录已 mount 到容器内 /mb
--
-- 说明:
--   - psql 元命令 \copy 走客户端->服务器的 STDIN 路径,不需要超级权限
--     但因为我们在容器内执行 (docker exec psql),客户端=服务器=同一进程,
--     直接走文件 IO,速度等价于 SQL 的 COPY FROM '/mb/xxx'
--   - 我们用更直接的 COPY FROM '/mb/xxx' 写法,要求 PG 进程对该路径有读权限
--     (mount 时设了 :ro,所以没问题)
--   - 加载顺序:先小表后大表,出错时上下文清晰
--
-- 预估耗时:总计 5-10 分钟,主要花在 release / artist_credit_name 上
-- ─────────────────────────────────────────────────────────────

-- 先清空(允许重跑)
TRUNCATE
    mb_raw.area,
    mb_raw.iso_3166_1,
    mb_raw.country_area,
    mb_raw.artist,
    mb_raw.artist_credit,
    mb_raw.artist_credit_name,
    mb_raw.release_group,
    mb_raw.release_group_primary_type,
    mb_raw.release,
    mb_raw.release_country,
    mb_raw.medium,
    mb_raw.language;

\echo '[1/12] loading area...'
COPY mb_raw.area FROM '/mb/area' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[2/12] loading iso_3166_1...'
COPY mb_raw.iso_3166_1 FROM '/mb/iso_3166_1' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[3/12] loading country_area...'
COPY mb_raw.country_area FROM '/mb/country_area' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[4/12] loading language...'
COPY mb_raw.language FROM '/mb/language' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[5/12] loading release_group_primary_type...'
COPY mb_raw.release_group_primary_type FROM '/mb/release_group_primary_type' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[6/12] loading artist (2.8M rows, 几十秒)...'
COPY mb_raw.artist FROM '/mb/artist' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[7/12] loading artist_credit (3.6M rows)...'
COPY mb_raw.artist_credit FROM '/mb/artist_credit' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[8/12] loading artist_credit_name (6.7M rows, ~1分钟)...'
COPY mb_raw.artist_credit_name FROM '/mb/artist_credit_name' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[9/12] loading release_group (4.2M rows)...'
COPY mb_raw.release_group FROM '/mb/release_group' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[10/12] loading release (5.4M rows, ~1-2分钟)...'
COPY mb_raw.release FROM '/mb/release' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[11/12] loading release_country (13M rows, ~2-3分钟)...'
COPY mb_raw.release_country FROM '/mb/release_country' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[12/12] loading medium (~5M rows)...'
COPY mb_raw.medium FROM '/mb/medium' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo ''
\echo '─── 加载完成,各表行数 ───'
SELECT 'area' AS table_name, count(*) AS rows FROM mb_raw.area
UNION ALL SELECT 'iso_3166_1', count(*) FROM mb_raw.iso_3166_1
UNION ALL SELECT 'country_area', count(*) FROM mb_raw.country_area
UNION ALL SELECT 'language', count(*) FROM mb_raw.language
UNION ALL SELECT 'release_group_primary_type', count(*) FROM mb_raw.release_group_primary_type
UNION ALL SELECT 'artist', count(*) FROM mb_raw.artist
UNION ALL SELECT 'artist_credit', count(*) FROM mb_raw.artist_credit
UNION ALL SELECT 'artist_credit_name', count(*) FROM mb_raw.artist_credit_name
UNION ALL SELECT 'release_group', count(*) FROM mb_raw.release_group
UNION ALL SELECT 'release', count(*) FROM mb_raw.release
UNION ALL SELECT 'release_country', count(*) FROM mb_raw.release_country
UNION ALL SELECT 'medium', count(*) FROM mb_raw.medium
ORDER BY rows DESC;

-- ─── 给最重要的几列加索引 (后续 JOIN 用) ──────────────────
\echo ''
\echo '建索引(JOIN 加速用)...'
CREATE INDEX ON mb_raw.release_country(release);
CREATE INDEX ON mb_raw.release_country(country);
CREATE INDEX ON mb_raw.release(release_group);
CREATE INDEX ON mb_raw.release(artist_credit);
CREATE INDEX ON mb_raw.release_group(artist_credit);
CREATE INDEX ON mb_raw.release_group(type);
CREATE INDEX ON mb_raw.artist_credit_name(artist_credit);
CREATE INDEX ON mb_raw.artist_credit_name(artist);
CREATE INDEX ON mb_raw.artist(area);
CREATE INDEX ON mb_raw.iso_3166_1(area);

\echo '索引完成。'
