# ─────────────────────────────────────────────────────────────
# Phase 3 一键执行脚本(Windows PowerShell)
#
# 前置:
#   1. docker compose up -d 已起来(postgis 容器健康)
#   2. data/natural-earth/ne_50m_admin_0_countries.shp 已存在
#   3. docker-compose.yml 里已挂载 ./data/natural-earth -> /ne
#
# 用法:
#   cd <项目根>
#   .\etl\run_phase3.ps1
#
# 跑完后:
#   - public.ne_countries   原始 NE 表(258 行,所有国家边界)
#   - app.countries         整理过的国家边界(iso + name + geom + area_km2)
#   - app.country_grids     全球网格(前后端桥接表,~3-5 万行)
# ─────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$env:MSYS_NO_PATHCONV = "1"   # Git Bash 兼容

function Invoke-Step {
    param([string]$Label, [scriptblock]$Action)
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════"
    Write-Host "  $Label"
    Write-Host "═══════════════════════════════════════════════════════════"
    $start = Get-Date
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Label"
    }
    $elapsed = (Get-Date) - $start
    Write-Host ("  ✓ 完成,用时 {0:N1} 秒" -f $elapsed.TotalSeconds)
}

# ── Step 1: 用 shp2pgsql 导入 Natural Earth 到 public.ne_countries ──
Invoke-Step "Step 1a / DROP 旧的 ne_countries 表(如果存在)" {
    # shp2pgsql -d 在新版 PostGIS 上 dropgeometrycolumn 会报错,所以手动 DROP
    docker compose exec -T postgis psql -U musicmap -d musicmap -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS public.ne_countries CASCADE;"
}

Invoke-Step "Step 1b / shp2pgsql 导入 Natural Earth" {
    # -I 建空间索引  -c 创建表  -s 指 SRID  -W 指 DBF 编码
    docker compose exec -T postgis bash -c "shp2pgsql -I -s 4326 -c -W UTF-8 /ne/ne_50m_admin_0_countries.shp public.ne_countries | psql -U musicmap -d musicmap -v ON_ERROR_STOP=1 -q"
}

# ── Step 2: 网格生成 SQL ─────────────────────────────────────
Invoke-Step "Step 2 / 生成 app.countries + app.country_grids" {
    docker compose exec -T postgis psql -U musicmap -d musicmap -v ON_ERROR_STOP=1 -f /etl/sql/50_country_grids.sql
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════"
Write-Host "  ✓ Phase 3 Step 1 全部完成"
Write-Host "═══════════════════════════════════════════════════════════"
