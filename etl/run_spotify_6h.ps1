# ─────────────────────────────────────────────────────────────
# Spotify ETL — 一次跑 6 小时,跑完自动停
#
# 用法:
#   .\etl\run_spotify_6h.ps1
#
# 想随时停? 直接关 PowerShell 窗口或 Ctrl-C, DB 是连续写入的, 数据安全。
# 下次运行自动从断点续跑(只查 spotify_status='unknown' 的)。
#
# 自定义:
#   .\etl\run_spotify_6h.ps1 -Hours 3 -Concurrency 8
# ─────────────────────────────────────────────────────────────

param(
    [double]$Hours = 6,
    [int]$Concurrency = 10
)

$env:MSYS_NO_PATHCONV = "1"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════"
Write-Host "  Spotify ETL — $Hours 小时 @ 并发 $Concurrency"
Write-Host "  开始: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "═══════════════════════════════════════════════════════════"

# 健康检查 backend 容器在跑
$ps = docker compose ps backend --status running --format json 2>$null
if (-not $ps) {
    Write-Host "[!] backend 容器没在跑。先 docker compose up -d" -ForegroundColor Red
    exit 1
}

# 跑(stdout/stderr 直接看见)
docker compose exec backend python /etl/phase2_spotify.py `
    --concurrency $Concurrency `
    --max-hours $Hours

$exitCode = $LASTEXITCODE

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════"
Write-Host "  结束: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  exit=$exitCode"

# 报告进度
Write-Host ""
Write-Host "─── 当前 Spotify 状态分布 ────────────────────────────────"
docker compose exec postgis psql -U musicmap -d musicmap -c "
SELECT spotify_status, count(*)
FROM app.albums
WHERE release_year BETWEEN 2010 AND 2025
GROUP BY spotify_status
ORDER BY count(*) DESC;
"

Write-Host ""
Write-Host "下次想接着跑? 再执行一次本脚本就行,自动从断点续。"
