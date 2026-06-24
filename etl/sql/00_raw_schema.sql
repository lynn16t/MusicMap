-- ─────────────────────────────────────────────────────────────
-- Phase 1 / Step 1: 创建 mb_raw schema 和 12 张原始表
--
-- 这 12 张表完全对应 MusicBrainz dump schema 30 的列结构。
-- 字段类型选用与 dump COPY 协议兼容的最小子集 (INTEGER / UUID / TEXT / TIMESTAMP)。
-- 这一步只创建空表,真正的数据由 01_load_raw.sql 用 \copy 灌入。
--
-- 为什么 schema 叫 mb_raw:
--   - "raw" 表示这是 MusicBrainz 原始结构的直接镜像,不做任何过滤/转换
--   - 业务用的精简表在 app.* schema (Step 3 生成)
-- ─────────────────────────────────────────────────────────────

DROP SCHEMA IF EXISTS mb_raw CASCADE;
CREATE SCHEMA mb_raw;

-- ─── 地理/国家相关 ──────────────────────────────────────────
-- area: MusicBrainz 的所有地理实体 (国家/省/市) 都是一行
CREATE TABLE mb_raw.area (
    id                INTEGER PRIMARY KEY,
    gid               UUID,
    name              TEXT,
    type              INTEGER,
    edits_pending     INTEGER,
    last_updated      TIMESTAMP WITH TIME ZONE,
    begin_date_year   SMALLINT,
    begin_date_month  SMALLINT,
    begin_date_day    SMALLINT,
    end_date_year     SMALLINT,
    end_date_month    SMALLINT,
    end_date_day      SMALLINT,
    ended             BOOLEAN,
    comment           TEXT
);

-- iso_3166_1: area -> ISO 2字母国家码 (US, GB, JP, ...)
CREATE TABLE mb_raw.iso_3166_1 (
    area  INTEGER,
    code  CHAR(2)
);

-- country_area: 标记哪些 area 是"国家级"(单列表,只是一个 ID 白名单)
CREATE TABLE mb_raw.country_area (
    area  INTEGER PRIMARY KEY
);

-- ─── 艺人相关 ────────────────────────────────────────────────
CREATE TABLE mb_raw.artist (
    id                INTEGER PRIMARY KEY,
    gid               UUID,
    name              TEXT,
    sort_name         TEXT,
    begin_date_year   SMALLINT,
    begin_date_month  SMALLINT,
    begin_date_day    SMALLINT,
    end_date_year     SMALLINT,
    end_date_month    SMALLINT,
    end_date_day      SMALLINT,
    type              INTEGER,
    area              INTEGER,   -- 关键字段:艺人国籍(指向 area.id)
    gender            INTEGER,
    comment           TEXT,
    edits_pending     INTEGER,
    last_updated      TIMESTAMP WITH TIME ZONE,
    ended             BOOLEAN,
    begin_area        INTEGER,
    end_area          INTEGER
);

-- artist_credit: 一个"署名"(可以是单人也可以是合作组合)
CREATE TABLE mb_raw.artist_credit (
    id             INTEGER PRIMARY KEY,
    name           TEXT,
    artist_count   SMALLINT,
    ref_count      INTEGER,
    created        TIMESTAMP WITH TIME ZONE,
    edits_pending  INTEGER,
    gid            UUID
);

-- artist_credit_name: artist_credit -> 单个 artist 的多对多桥表
CREATE TABLE mb_raw.artist_credit_name (
    artist_credit  INTEGER,
    position       SMALLINT,
    artist         INTEGER,
    name           TEXT,
    join_phrase    TEXT
);

-- ─── 专辑/发行相关 ─────────────────────────────────────────
-- release_group: 逻辑专辑 (一张专辑可能有多个 release 发行版本)
CREATE TABLE mb_raw.release_group (
    id              INTEGER PRIMARY KEY,
    gid             UUID,
    name            TEXT,
    artist_credit   INTEGER,
    type            INTEGER,   -- 指向 release_group_primary_type.id
    comment         TEXT,
    edits_pending   INTEGER,
    last_updated    TIMESTAMP WITH TIME ZONE
);

-- release_group_primary_type: Album/Single/EP/Broadcast/Other 的字典
CREATE TABLE mb_raw.release_group_primary_type (
    id           INTEGER PRIMARY KEY,
    name         TEXT,
    parent       INTEGER,
    child_order  INTEGER,
    description  TEXT,
    gid          UUID
);

-- release: 一次具体的发行 (CD/黑胶/数字版本各算一行)
CREATE TABLE mb_raw.release (
    id              INTEGER PRIMARY KEY,
    gid             UUID,
    name            TEXT,
    artist_credit   INTEGER,
    release_group   INTEGER,
    status          INTEGER,
    packaging       INTEGER,
    language        INTEGER,
    script          INTEGER,
    barcode         TEXT,
    comment         TEXT,
    edits_pending   INTEGER,
    quality         SMALLINT,
    last_updated    TIMESTAMP WITH TIME ZONE
);

-- release_country: 一个 release 在哪些国家、哪天发行的
CREATE TABLE mb_raw.release_country (
    release     INTEGER,
    country     INTEGER,    -- 指向 area.id (而非 ISO 码)
    date_year   SMALLINT,
    date_month  SMALLINT,
    date_day    SMALLINT
);

-- medium: 一个 release 的物理介质(CD1/CD2/黑胶 A 面...)
-- 用途:过滤掉完全没有 medium 的 release (通常是数据脏)
CREATE TABLE mb_raw.medium (
    id            INTEGER PRIMARY KEY,
    release       INTEGER,
    position      INTEGER,
    format        INTEGER,
    name          TEXT,
    edits_pending INTEGER,
    last_updated  TIMESTAMP WITH TIME ZONE,
    track_count   INTEGER,
    gid           UUID
);

-- language: release 的语种 (Phase 1 暂不强用,先存着)
CREATE TABLE mb_raw.language (
    id           INTEGER PRIMARY KEY,
    iso_code_2t  CHAR(3),
    iso_code_2b  CHAR(3),
    iso_code_1   CHAR(2),
    name         TEXT,
    frequency    INTEGER,
    iso_code_3   CHAR(3)
);

-- ─── 区域关系链 (用于 sub-area -> 国家 的递归映射) ─────────
-- MusicBrainz 用 link / link_type / l_area_area 三张表表达
-- "England 是 United Kingdom 的一部分" 这种关系
CREATE TABLE mb_raw.l_area_area (
    id              INTEGER PRIMARY KEY,
    link            INTEGER,   -- 指向 mb_raw.link.id
    entity0         INTEGER,   -- "父" area (例如 UK)
    entity1         INTEGER,   -- "子" area (例如 England)
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

-- ─── 完成提示 ────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'mb_raw schema created with 12 tables (empty).';
END $$;
