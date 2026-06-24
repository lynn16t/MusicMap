-- ─────────────────────────────────────────────────────────────
-- Phase 1.5 / 数据清洗:按 secondary_type 收缩 app.albums
--
-- 策略 E:只保留 pure Album + Soundtrack。删除以下 secondary type
-- 中任意一个命中的行:
--   Live, Compilation, Remix, DJ-mix, Mixtape/Street, Demo,
--   Spokenword, Interview, Audiobook, Audio drama, Field recording
-- 同一行可能有多个 secondary type,只要命中黑名单任一个就删。
--
-- 同时新增 secondary_types TEXT[] 列,保留剩下行的 Soundtrack
-- 标记,方便下游区分 Album / OST。
--
-- 应用范围:整张 app.albums(不止 2010-2025),保持口径一致。
-- ─────────────────────────────────────────────────────────────

\echo '─── Step 1: 新增 secondary_types 列 ───'
ALTER TABLE app.albums
    ADD COLUMN IF NOT EXISTS secondary_types TEXT[];

\echo '─── Step 2: 回填 secondary_types(只对有 secondary type 的行) ───'
WITH agg AS (
    SELECT rg.gid                              AS mbid,
           array_agg(st.name ORDER BY st.name) AS types
    FROM mb_raw.release_group rg
    JOIN mb_raw.release_group_secondary_type_join j ON j.release_group = rg.id
    JOIN mb_raw.release_group_secondary_type      st ON st.id = j.secondary_type
    GROUP BY rg.gid
)
UPDATE app.albums a
SET secondary_types = agg.types
FROM agg
WHERE a.mbid = agg.mbid;

\echo '─── Step 3: 删除前快照 ───'
SELECT count(*) AS total_before,
       count(*) FILTER (WHERE release_year BETWEEN 2010 AND 2025) AS in_2010_2025_before
FROM app.albums;

\echo '─── Step 4: 执行删除(策略 E) ───'
DELETE FROM app.albums
WHERE secondary_types && ARRAY[
    'Live', 'Compilation', 'Remix', 'DJ-mix', 'Mixtape/Street', 'Demo',
    'Spokenword', 'Interview', 'Audiobook', 'Audio drama', 'Field recording'
]::TEXT[];

\echo '─── Step 5: 删除后快照 ───'
SELECT count(*) AS total_after,
       count(*) FILTER (WHERE release_year BETWEEN 2010 AND 2025) AS in_2010_2025_after,
       count(*) FILTER (WHERE 'Soundtrack' = ANY(secondary_types)) AS soundtrack_kept,
       count(*) FILTER (WHERE secondary_types IS NULL)             AS pure_album_kept
FROM app.albums;

\echo '─── Step 6: 2010-2025 各年保留量 ───'
SELECT release_year,
       count(*)                                                              AS n,
       count(*) FILTER (WHERE 'Soundtrack' = ANY(secondary_types))           AS soundtracks
FROM app.albums
WHERE release_year BETWEEN 2010 AND 2025
GROUP BY release_year
ORDER BY release_year;
