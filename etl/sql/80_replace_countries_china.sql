-- 80_replace_countries_china.sql
-- 用「中国标准世界地图」(data/世界国家.shp)替换 app.countries 的几何。
--
-- 背景:原 app.countries 来自 Natural Earth。新图含符合中国国家规范的边界(台湾属中国、
--       南海、藏南等)。新图字段 soc 是「非标准 alpha-3」(Romania=ROM 而非 ROU 等),
--       直接代码 join 会漏一批;故改用「空间 join」:新要素内点落在旧国家里 → 继承旧 iso
--       (绕开代码不一致,且旧 iso 与 albums/country_grids 严格一致)。
-- 港澳台并入 CN:聚合成一个 MultiPolygon,无内部国界,符合规范。
-- 新图没覆盖到的「有专辑国家」(法属小岛、Israel、Maldives 等粒度差异)回退用旧 NE 几何,
--       保证一个专辑国家都不丢。
-- 依赖:app.world_cn_stage(新图 shp2pgsql 灌入,SRID 4326)。可重复运行(备份只建一次,
--       空间 join 始终基于原始备份,结果确定)。

BEGIN;

-- 1) 一次性备份原始 NE 表(再次运行不会覆盖备份 → 始终保留最初的 NE 作为 iso/属性来源)
CREATE TABLE IF NOT EXISTS app.countries_backup_ne AS TABLE app.countries;

-- 2) 新图按「继承 iso」聚合(港澳台→CN);iso 来自原始 NE 备份的空间包含
DROP TABLE IF EXISTS app.countries_new;
CREATE TABLE app.countries_new AS
WITH labeled AS (
  SELECT w.geom,
         (SELECT CASE WHEN oc.iso IN ('HK','MO','TW') THEN 'CN' ELSE oc.iso END
          FROM app.countries_backup_ne oc
          WHERE ST_Contains(oc.geom, ST_PointOnSurface(w.geom))
          LIMIT 1) AS iso
  FROM app.world_cn_stage w
)
SELECT iso, ST_Multi(ST_UnaryUnion(ST_Collect(geom))) AS geom
FROM labeled
WHERE iso IS NOT NULL
GROUP BY iso;

-- 3) 重建 app.countries:每个旧 iso 都保留(不丢专辑国家);几何优先用新图,没有则回退旧 NE
--    港澳台不单独成行 —— 它们的区域已并入 CN 的几何(无独立边界/标注/极光,符合规范)
TRUNCATE app.countries;
INSERT INTO app.countries (iso, country_name, country_name_long, continent, geom, area_km2)
SELECT b.iso, b.country_name, b.country_name_long, b.continent,
       COALESCE(n.geom, b.geom) AS geom,
       ST_Area(COALESCE(n.geom, b.geom)::geography) / 1e6 AS area_km2
FROM app.countries_backup_ne b
LEFT JOIN app.countries_new n ON n.iso = b.iso
WHERE b.iso NOT IN ('HK', 'MO', 'TW');

COMMIT;

-- 4) 等面积网格表基于 app.countries 几何,几何变了 → 删掉(用到时按 README 重建)
DROP TABLE IF EXISTS app.country_grids_ea;
