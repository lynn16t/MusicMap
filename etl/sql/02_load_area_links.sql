-- ─────────────────────────────────────────────────────────────
-- Phase 1 / 补丁: 加载区域关系链 + 构造 area -> country 映射
--
-- 背景:
--   原本只 JOIN iso_3166_1.area = artist.area 会过滤掉 Pink Floyd 这种
--   artist.area = England (sub-area) 而非 UK (country) 的艺人。
--   通过 l_area_area 'part of' 关系,沿祖先链上溯到国家级 area,即可修复。
--
-- 输出:
--   mb_raw.area_to_country  -- 每个 area_id 对应一个 ISO 国家码
-- ─────────────────────────────────────────────────────────────

-- 1) 建 3 张关系表 (CREATE IF NOT EXISTS 等价,先 DROP 防止重跑出错)
DROP TABLE IF EXISTS mb_raw.l_area_area CASCADE;
DROP TABLE IF EXISTS mb_raw.link        CASCADE;
DROP TABLE IF EXISTS mb_raw.link_type   CASCADE;

CREATE TABLE mb_raw.l_area_area (
    id              INTEGER PRIMARY KEY,
    link            INTEGER,
    entity0         INTEGER,   -- 父 area (UK)
    entity1         INTEGER,   -- 子 area (England)
    edits_pending   INTEGER,
    last_updated    TIMESTAMP WITH TIME ZONE,
    link_order      INTEGER,
    entity0_credit  TEXT,
    entity1_credit  TEXT
);

CREATE TABLE mb_raw.link (
    id            INTEGER PRIMARY KEY,
    link_type     INTEGER,
    begin_date_year   SMALLINT,
    begin_date_month  SMALLINT,
    begin_date_day    SMALLINT,
    end_date_year     SMALLINT,
    end_date_month    SMALLINT,
    end_date_day      SMALLINT,
    attribute_count   INTEGER,
    created           TIMESTAMP WITH TIME ZONE,
    ended             BOOLEAN
);

CREATE TABLE mb_raw.link_type (
    id              INTEGER PRIMARY KEY,
    parent          INTEGER,
    child_order     INTEGER,
    gid             UUID,
    entity_type0    TEXT,
    entity_type1    TEXT,
    name            TEXT,
    description     TEXT,
    link_phrase     TEXT,
    reverse_link_phrase TEXT,
    long_link_phrase    TEXT,
    last_updated    TIMESTAMP WITH TIME ZONE,
    is_deprecated   BOOLEAN,
    has_dates       BOOLEAN,
    entity0_cardinality INTEGER,
    entity1_cardinality INTEGER
);

-- 2) 加载
\echo '[1/3] loading link_type...'
COPY mb_raw.link_type FROM '/mb/link_type' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[2/3] loading link...'
COPY mb_raw.link FROM '/mb/link' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

\echo '[3/3] loading l_area_area...'
COPY mb_raw.l_area_area FROM '/mb/l_area_area' WITH (FORMAT text, DELIMITER E'\t', NULL '\N', ENCODING 'UTF8');

-- 3) 找到 "part of" 这条 link_type 的 id
\echo ''
\echo '查找 area "part of" 关系的 link_type id...'
SELECT id, name, entity_type0, entity_type1
FROM mb_raw.link_type
WHERE entity_type0 = 'area' AND entity_type1 = 'area';

-- 4) 建索引方便后续 JOIN
CREATE INDEX ON mb_raw.l_area_area(entity0);
CREATE INDEX ON mb_raw.l_area_area(entity1);
CREATE INDEX ON mb_raw.l_area_area(link);

-- 5) 构造 area_to_country 映射 (递归向上找祖先)
--
-- 算法:
--   起点 = 所有有 ISO 码的 area (即国家自身)
--   递归 = 沿 l_area_area "part of" 链向下找 (entity1 是 entity0 的"子"区域)
--   每个 area 最终映射到第一个找到的祖先国家
\echo ''
\echo '构造 area_to_country 映射...'

DROP TABLE IF EXISTS mb_raw.area_to_country;
CREATE TABLE mb_raw.area_to_country (
    area_id  INTEGER PRIMARY KEY,
    iso_code CHAR(2) NOT NULL
);

-- 先把 area "part of" 关系筛出来 (只要国家级以下的 part-of)
-- link_type.name = 'part of' AND entity_type0='area' AND entity_type1='area'
WITH RECURSIVE
part_of_link_type AS (
    SELECT id FROM mb_raw.link_type
    WHERE entity_type0 = 'area' AND entity_type1 = 'area'
      AND name = 'part of'
),
area_part_of AS (
    -- 每行: child_area_id -> parent_area_id
    SELECT laa.entity1 AS child, laa.entity0 AS parent
    FROM mb_raw.l_area_area laa
    JOIN mb_raw.link l       ON l.id = laa.link
    JOIN part_of_link_type t ON t.id = l.link_type
),
walker AS (
    -- 基础:国家自身映射到自己的 ISO 码
    SELECT a.id AS area_id, iso.code AS iso_code, 0 AS depth
    FROM mb_raw.area a
    JOIN mb_raw.iso_3166_1 iso ON iso.area = a.id

    UNION ALL

    -- 递归:已知 parent 的 iso_code,所有 child(part of 它)继承
    SELECT po.child, w.iso_code, w.depth + 1
    FROM area_part_of po
    JOIN walker w ON w.area_id = po.parent
    WHERE w.depth < 8   -- 防御循环 (最多 8 层)
)
INSERT INTO mb_raw.area_to_country (area_id, iso_code)
SELECT DISTINCT ON (area_id) area_id, iso_code
FROM walker
ORDER BY area_id, depth ASC;   -- 同 area 多次出现取最浅(最直接的祖先)

\echo ''
\echo '映射构造完毕,统计:'
SELECT
    (SELECT count(*) FROM mb_raw.area_to_country) AS total_areas_mapped,
    (SELECT count(*) FROM mb_raw.iso_3166_1)      AS country_level_areas;

\echo ''
\echo 'Pink Floyd 验证 (artist.area=432=England 应该映射到 GB):'
SELECT * FROM mb_raw.area_to_country WHERE area_id = 432;

\echo ''
\echo 'Jay Chou / 周杰倫 area 验证 (台湾):'
SELECT a.id, a.name, atc.iso_code
FROM mb_raw.area a
LEFT JOIN mb_raw.area_to_country atc ON atc.area_id = a.id
WHERE a.id IN (
    SELECT area FROM mb_raw.artist WHERE name IN ('Jay Chou', '周杰倫', '周杰伦')
);
