-- ─────────────────────────────────────────────────────────────
-- Phase 2: 给 app.albums 加 Spotify 相关字段
--
-- 这一步加完后 schema 兼容下一步的 Spotify ETL 写入。
-- 全部 IF NOT EXISTS,可重复跑。
-- ─────────────────────────────────────────────────────────────

ALTER TABLE app.albums
    ADD COLUMN IF NOT EXISTS spotify_id          TEXT,          -- Spotify album ID (22 位 base62)
    ADD COLUMN IF NOT EXISTS spotify_popularity  SMALLINT,      -- 0..100
    ADD COLUMN IF NOT EXISTS spotify_image_url   TEXT,          -- 640x640 cover URL on i.scdn.co
    ADD COLUMN IF NOT EXISTS spotify_match_score REAL,          -- 自定义匹配度(0..1),用于诊断
    ADD COLUMN IF NOT EXISTS spotify_status      TEXT DEFAULT 'unknown';
    -- spotify_status:
    --   'unknown'    - 还没查
    --   'matched'    - 找到了 Spotify 上对应专辑
    --   'no_match'   - 搜了没找到匹配
    --   'error'      - API/网络错(可重试)

CREATE INDEX IF NOT EXISTS idx_albums_spotify_popularity
    ON app.albums(spotify_popularity DESC NULLS LAST)
    WHERE spotify_status = 'matched';

CREATE INDEX IF NOT EXISTS idx_albums_spotify_status
    ON app.albums(spotify_status);

\echo 'Spotify 列已添加。'
SELECT
    column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'albums' AND column_name LIKE 'spotify_%'
ORDER BY column_name;
