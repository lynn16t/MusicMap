# ─────────────────────────────────────────────────────────────
# Cover Art Archive 下载速度测试
#
# 在不同梯子状态/节点下分别跑一遍这个脚本,看哪种最快。
# 每次只下 5 张封面 (~500 KB 流量),20-60 秒就完。
#
# 用法 (PowerShell):
#   d:
#   cd \Make_shit\Node\MusicMap
#   .\etl\test_speed.ps1
# ─────────────────────────────────────────────────────────────

$mbids = @(
    "732b78cb-9f7d-383d-86cc-5cf7e43c9658",  # 范特西
    "877e9870-1b55-3153-8875-139cfe468679",  # 周杰倫 Jay
    "f234ba1e-7da5-3b89-89cd-e3f7eb46e9d2",  # 一个 US 专辑
    "188ec628-086e-48fa-a225-86bafd5e41bd",  # 崔健 浪子歸
    "598cb702-851e-3923-b30e-1b614fd60120"   # 羅大佑 之乎者也
)

$tmpDir = "$env:TEMP\caa_speed_test"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

Write-Host ""
Write-Host "═══════════════════════════════════════════════"
Write-Host "  Cover Art Archive 下载速度测试 (5 张样本)"
Write-Host "═══════════════════════════════════════════════"
Write-Host "当前时间: $(Get-Date -Format 'HH:mm:ss')"
Write-Host ""

$totalBytes = 0
$totalSeconds = 0
$ok = 0

for ($i = 0; $i -lt $mbids.Count; $i++) {
    $mbid = $mbids[$i]
    $out = "$tmpDir\$($i+1).jpg"
    $url = "https://coverartarchive.org/release-group/$mbid/front"

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $resp = Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 30 -ErrorAction Stop
        $sw.Stop()
        $size = (Get-Item $out).Length
        $secs = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        $kbs  = [math]::Round($size / 1024 / $sw.Elapsed.TotalSeconds, 1)
        Write-Host ("  [{0}] {1}KB  {2}s  =>  {3} KB/s" -f ($i+1), [math]::Round($size/1024,0), $secs, $kbs)
        $totalBytes += $size
        $totalSeconds += $sw.Elapsed.TotalSeconds
        $ok++
    } catch {
        $sw.Stop()
        Write-Host ("  [{0}] FAIL ({1}s): {2}" -f ($i+1), [math]::Round($sw.Elapsed.TotalSeconds,1), $_.Exception.Message)
    }
}

Write-Host ""
Write-Host "─── 汇总 ──────────────────────────────────────"
if ($ok -gt 0) {
    $avgKbs = [math]::Round($totalBytes / 1024 / $totalSeconds, 1)
    $totalMb = [math]::Round($totalBytes / 1024 / 1024, 2)
    Write-Host "  成功: $ok / $($mbids.Count)"
    Write-Host "  总下载: $totalMb MB / $([math]::Round($totalSeconds,1)) 秒"
    Write-Host "  **平均速度: $avgKbs KB/s**"
    Write-Host ""
    # 估算全量耗时(125万张 × 平均原图 200KB)
    $totalGb = (1250000 * 200) / 1024 / 1024   # GB
    $eta_h = ($totalGb * 1024 * 1024 / $avgKbs / 5) / 3600    # 并发 5
    Write-Host ("  ➜ 按此速度全量 125 万张 (并发5) 预计 {0:N0} 小时 = {1:N1} 天" -f $eta_h, ($eta_h/24))
} else {
    Write-Host "  全部失败 - 检查网络/梯子"
}
Write-Host ""

Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
