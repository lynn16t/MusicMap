-- ─────────────────────────────────────────────────────────────
-- Phase 1 / Step 4: 验收 SQL
--
-- 跑通这个文件 = Phase 1 完成。每段都有期望值或合理范围。
-- 不通过的项会用 RAISE NOTICE 标 ❌,通过的标 ✓。
-- ─────────────────────────────────────────────────────────────

\echo ''
\echo '════════════════════════════════════════════════════════'
\echo '          Phase 1 验收报告 (MusicMap)'
\echo '════════════════════════════════════════════════════════'

-- ─── A. 原始数据完整性 ────────────────────────────────────
\echo ''
\echo '── A. mb_raw 加载完整性 ─────────────────────────────'

DO $$
DECLARE
    n_release         BIGINT;
    n_release_country BIGINT;
    n_release_group   BIGINT;
    n_artist          BIGINT;
    n_artist_credit_name BIGINT;
    n_area            BIGINT;
BEGIN
    SELECT count(*) INTO n_release         FROM mb_raw.release;
    SELECT count(*) INTO n_release_country FROM mb_raw.release_country;
    SELECT count(*) INTO n_release_group   FROM mb_raw.release_group;
    SELECT count(*) INTO n_artist          FROM mb_raw.artist;
    SELECT count(*) INTO n_artist_credit_name FROM mb_raw.artist_credit_name;
    SELECT count(*) INTO n_area            FROM mb_raw.area;

    RAISE NOTICE '  release            = %  (期望 5,397,401)', n_release;
    RAISE NOTICE '  release_country    = %  (期望 13,075,153)', n_release_country;
    RAISE NOTICE '  release_group      = %  (期望 4,215,752)', n_release_group;
    RAISE NOTICE '  artist             = %  (期望 2,836,059)', n_artist;
    RAISE NOTICE '  artist_credit_name = %  (期望 6,748,418)', n_artist_credit_name;
    RAISE NOTICE '  area               = %  (期望 119,882)', n_area;

    IF n_release       <> 5397401 THEN RAISE WARNING '❌ release 行数不对';     ELSE RAISE NOTICE '  ✓ release 行数匹配'; END IF;
    IF n_release_group <> 4215752 THEN RAISE WARNING '❌ release_group 行数不对'; ELSE RAISE NOTICE '  ✓ release_group 行数匹配'; END IF;
    IF n_area          <> 119882  THEN RAISE WARNING '❌ area 行数不对';        ELSE RAISE NOTICE '  ✓ area 行数匹配'; END IF;
END $$;

-- ─── B. app.albums 总量 ──────────────────────────────────
\echo ''
\echo '── B. app.albums 规模 ───────────────────────────────'

DO $$
DECLARE
    n BIGINT;
BEGIN
    SELECT count(*) INTO n FROM app.albums;
    RAISE NOTICE '  app.albums 总行数 = %  (合理范围 80万-150万)', n;
    IF n < 500000 OR n > 2000000 THEN
        RAISE WARNING '❌ 行数超出合理范围,JOIN/过滤可能有问题';
    ELSE
        RAISE NOTICE '  ✓ 行数在合理范围';
    END IF;
END $$;

-- ─── C. 数据卫生:无 NULL/越界/重复 ──────────────────────
\echo ''
\echo '── C. 数据卫生 ──────────────────────────────────────'

DO $$
DECLARE
    bad BIGINT;
BEGIN
    SELECT count(*) INTO bad FROM app.albums WHERE release_year < 1950 OR release_year > 2026;
    RAISE NOTICE '  越界年份行数 = %  (期望 0)', bad;
    IF bad <> 0 THEN RAISE WARNING '❌'; ELSE RAISE NOTICE '  ✓'; END IF;

    SELECT count(*) INTO bad FROM app.albums WHERE artist_country_iso IS NULL;
    RAISE NOTICE '  缺艺人国籍行数 = %  (期望 0)', bad;
    IF bad <> 0 THEN RAISE WARNING '❌'; ELSE RAISE NOTICE '  ✓'; END IF;

    SELECT count(*) - count(DISTINCT mbid) INTO bad FROM app.albums;
    RAISE NOTICE '  重复 mbid 数  = %  (期望 0)', bad;
    IF bad <> 0 THEN RAISE WARNING '❌'; ELSE RAISE NOTICE '  ✓'; END IF;
END $$;

-- ─── D. 标杆专辑 smoke test ──────────────────────────────
\echo ''
\echo '── D. 标杆专辑能否查到 ──────────────────────────────'

\echo '   D1. Thriller (Michael Jackson, 1982)'
SELECT title, primary_artist_name, artist_country_iso, release_country_iso, release_year
FROM app.albums
WHERE primary_artist_name ILIKE 'Michael Jackson'
  AND title ILIKE 'Thriller'
  AND release_year BETWEEN 1980 AND 1985
ORDER BY release_year
LIMIT 3;

\echo '   D2. The Dark Side of the Moon (Pink Floyd, 1973)'
SELECT title, primary_artist_name, artist_country_iso, release_country_iso, release_year
FROM app.albums
WHERE primary_artist_name ILIKE 'Pink Floyd'
  AND title ILIKE 'The Dark Side of the Moon%'
LIMIT 3;

\echo '   D3. Kind of Blue (Miles Davis, 1959)'
SELECT title, primary_artist_name, artist_country_iso, release_country_iso, release_year
FROM app.albums
WHERE primary_artist_name ILIKE 'Miles Davis'
  AND title ILIKE 'Kind of Blue%'
LIMIT 3;

\echo '   D4. 范特西 (周杰倫 Jay Chou, 2001 TW) — 非英语国家 + sub-area 资源映射测试'
-- MB 里艺人名是繁体 "周杰倫",MBID 固定不会变
SELECT title, primary_artist_name, artist_country_iso, release_country_iso, release_year
FROM app.albums
WHERE primary_artist_mbid = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
  AND title ILIKE '%范特西%'
LIMIT 3;

-- ─── E. 分布合理性 ───────────────────────────────────────
\echo ''
\echo '── E. 国家 / 年份分布(肉眼审查) ────────────────────'

\echo '   E1. 艺人国籍 Top 10 (应该 US/GB/JP/DE/FR 居前)'
SELECT artist_country_iso, count(*) AS n
FROM app.albums
GROUP BY artist_country_iso
ORDER BY n DESC
LIMIT 10;

\echo '   E2. 按十年的发行量 (峰值应在 1990s-2010s)'
SELECT
    (release_year / 10 * 10)::int AS decade,
    count(*) AS n
FROM app.albums
GROUP BY decade
ORDER BY decade;

\echo '   E3. 艺人国籍 vs 发行国 不一致的比例 (合理: 20-40%)'
SELECT
    count(*) FILTER (
        WHERE release_country_iso IS NOT NULL
          AND artist_country_iso <> release_country_iso
    ) * 100.0
    / NULLIF(count(*) FILTER (WHERE release_country_iso IS NOT NULL), 0) AS pct_mismatch
FROM app.albums;

-- ─── F. 性能基准 ─────────────────────────────────────────
\echo ''
\echo '── F. 性能基准 (规划要求 US 1980 < 100ms) ──────────'

\timing on
SELECT count(*) FROM app.albums
WHERE artist_country_iso = 'US' AND release_year = 1980;
\timing off

\echo ''
\echo '════════════════════════════════════════════════════════'
\echo '  审查完毕。如所有 ✓ 都齐,Phase 1 可视为完成。'
\echo '════════════════════════════════════════════════════════'
