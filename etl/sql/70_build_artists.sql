-- ─────────────────────────────────────────────────────────────
-- app.artists 维度表 — 一个艺人一行,2010-2025 范围内的专辑主艺人
--   * 从 mb_raw.artist 拿元数据(type/gender/begin_date/area)
--   * 从 app.albums 聚合统计(album_count/first/last_release_year)
--   * 国家从 albums.artist_country_iso 取众数(已是 ISO 两字符代码)
--   * 预留 Deezer 字段(后续 phase3 脚本填)
-- ─────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS app.artists CASCADE;

CREATE TABLE app.artists (
    mbid                uuid        PRIMARY KEY,
    name                text        NOT NULL,
    sort_name           text,

    -- ── MusicBrainz 人物元数据(从 mb_raw.artist)
    artist_type         text,       -- Person/Group/Other/Character/Orchestra/Choir
    gender              text,       -- Male/Female/Other/NotApplicable/NonBinary
    begin_date_year     smallint,   -- Person=出生年, Group=成团年
    begin_date_month    smallint,
    begin_date_day      smallint,
    end_date_year       smallint,   -- Person=去世年, Group=解散年
    end_date_month      smallint,
    end_date_day        smallint,
    ended               boolean,
    begin_area_name     text,       -- 已 resolve 的地名

    -- ── 国家(沿用 albums 那套 ISO 两字符)
    country_iso         char(2),

    -- ── 从 albums 聚合的便利冗余(只统计 2010-2025 子集内)
    album_count         int         NOT NULL DEFAULT 0,
    first_release_year  smallint,
    last_release_year   smallint,

    -- ── Deezer 字段(phase3 写入)
    deezer_id           bigint,
    deezer_name         text,
    deezer_image_url    text,
    deezer_fans         int,
    deezer_status       text        NOT NULL DEFAULT 'unknown',

    imported_at         timestamptz DEFAULT now()
);

CREATE INDEX idx_artists_name           ON app.artists(name);
CREATE INDEX idx_artists_country        ON app.artists(country_iso);
CREATE INDEX idx_artists_type           ON app.artists(artist_type);
CREATE INDEX idx_artists_begin_year     ON app.artists(begin_date_year);
CREATE INDEX idx_artists_deezer_status  ON app.artists(deezer_status);

-- ── 灌数据 ─────────────────────────────────────────────────
INSERT INTO app.artists (
    mbid, name, sort_name,
    artist_type, gender,
    begin_date_year, begin_date_month, begin_date_day,
    end_date_year, end_date_month, end_date_day, ended,
    begin_area_name,
    country_iso,
    album_count, first_release_year, last_release_year
)
WITH stats AS (
    SELECT primary_artist_mbid AS mbid,
           MODE() WITHIN GROUP (ORDER BY primary_artist_name) AS common_name,
           MODE() WITHIN GROUP (ORDER BY artist_country_iso)  AS country_iso,
           COUNT(*)            AS album_count,
           MIN(release_year)   AS first_y,
           MAX(release_year)   AS last_y
    FROM app.albums
    WHERE release_year BETWEEN 2010 AND 2025
    GROUP BY primary_artist_mbid
)
SELECT
    s.mbid,
    s.common_name,
    a.sort_name,
    CASE a.type
        WHEN 1 THEN 'Person' WHEN 2 THEN 'Group' WHEN 3 THEN 'Other'
        WHEN 4 THEN 'Character' WHEN 5 THEN 'Orchestra' WHEN 6 THEN 'Choir'
    END,
    CASE a.gender
        WHEN 1 THEN 'Male' WHEN 2 THEN 'Female' WHEN 3 THEN 'Other'
        WHEN 4 THEN 'NotApplicable' WHEN 5 THEN 'NonBinary'
    END,
    a.begin_date_year, a.begin_date_month, a.begin_date_day,
    a.end_date_year,   a.end_date_month,   a.end_date_day,
    a.ended,
    ba.name,
    s.country_iso,
    s.album_count, s.first_y, s.last_y
FROM stats s
LEFT JOIN mb_raw.artist a ON s.mbid = a.gid
LEFT JOIN mb_raw.area   ba ON a.begin_area = ba.id;

-- ── 验证 ──────────────────────────────────────────────────
SELECT 'rows'              AS metric, COUNT(*)::text AS v FROM app.artists
UNION ALL SELECT 'with begin_date_year', COUNT(*)::text FROM app.artists WHERE begin_date_year IS NOT NULL
UNION ALL SELECT 'Person',               COUNT(*)::text FROM app.artists WHERE artist_type='Person'
UNION ALL SELECT 'Group',                COUNT(*)::text FROM app.artists WHERE artist_type='Group'
UNION ALL SELECT 'with begin_area_name', COUNT(*)::text FROM app.artists WHERE begin_area_name IS NOT NULL
UNION ALL SELECT 'with country_iso',     COUNT(*)::text FROM app.artists WHERE country_iso IS NOT NULL;
