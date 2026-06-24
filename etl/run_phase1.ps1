# ─────────────────────────────────────────────────────────────
# Phase 1 一键执行脚本 (Windows PowerShell)
#
# 前置:
#   1. docker compose up -d 已起来 (postgis 容器健康)
#   2. data/musicbrainz-sample/mbdump/ 已解压好
#   3. docker-compose.yml 里 postgis 服务已挂载 ./data/.../mbdump -> /mb
#
# 用法:
#   cd <项目根>
#   .\etl\run_phase1.ps1
#
# 跑完后:
#   - mb_raw.* 存放 MusicBrainz 原始 12 张表
#   - app.albums 存放精筛后的专辑(80-150万行,主键是 release_group MBID)
# ─────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$env:MSYS_NO_PATHCONV = "1"   # Git Bash 兼容

function Invoke-Step {
    param([string]$Label, [string]$SqlFile)
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════"
    Write-Host "  $Label"
    Write-Host "═══════════════════════════════════════════════════════════"
    $start = Get-Date
    docker compose exec -T postgis psql -U musicmap -d musicmap -v ON_ERROR_STOP=1 -f $SqlFile
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Label"
    }
    $elapsed = (Get-Date) - $start
    Write-Host ("[完成] {0:F1} 秒" -f $elapsed.TotalSeconds)
}

# 健康检查:postgis 是否在跑
$ps = docker compose ps postgis --status running --format json 2>$null
if (-not $ps) {
    Write-Error "postgis 容器没在跑。先 docker compose up -d"
    exit 1
}

Invoke-Step "Step 1: 建 mb_raw schema + 15 张空表" "/etl/sql/00_raw_schema.sql"
Invoke-Step "Step 2: \copy 12 张主表 TSV 进 mb_raw (5-10 分钟)" "/etl/sql/01_load_raw.sql"
Invoke-Step "Step 3: 加载区域关系表 + 构造 area_to_country 映射" "/etl/sql/02_load_area_links.sql"
Invoke-Step "Step 4: 生成 app.albums (JOIN + 过滤,1-2 分钟)" "/etl/sql/10_build_curated.sql"
Invoke-Step "Step 5: 验收检查" "/etl/sql/20_verify.sql"

Write-Host ""
Write-Host "Phase 1 全部完成。"
Write-Host "可以打开 http://localhost:8000/docs 看 API 文档。"
Write-Host "也可以用 DBeaver 连上去 SELECT * FROM app.albums LIMIT 100;"
