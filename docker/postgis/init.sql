-- ─────────────────────────────────────────────────────
-- PostGIS 初始化脚本
-- 容器首次启动 PostgreSQL 时会自动执行这里的 SQL
-- ─────────────────────────────────────────────────────

-- 核心空间扩展:提供 geometry/geography 类型、ST_* 函数
CREATE EXTENSION IF NOT EXISTS postgis;

-- 拓扑支持(暂时用不到,但启用了未来更灵活)
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- 给后续脚本用的版本信息表(也是一种 sanity check)
DO $$
BEGIN
    RAISE NOTICE 'PostgreSQL version: %', version();
    RAISE NOTICE 'PostGIS version: %',   postgis_version();
    RAISE NOTICE 'PostGIS full version: %', postgis_full_version();
END $$;
