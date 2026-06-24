#requires -Version 5.1
# ─────────────────────────────────────────────────────────────
# MusicMap — Docker Desktop 周期性强制重启 + 任务恢复
#
# 用途:Docker Desktop on Windows 跑 30-40 分钟 daemon 会 500 死锁,
#       这个脚本一次性走完:wsl shutdown → kill GUI → 启 Docker → 等
#       engine → compose up → 重新拉起 supervisor。
#
# 用法(手动单次):
#   PowerShell.exe -NoProfile -ExecutionPolicy Bypass `
#     -File "d:\Make_shit\Node\MusicMap\restart_docker.ps1"
#
# 用法(Task Scheduler 自动):见同目录 register_restart_task.ps1
# ─────────────────────────────────────────────────────────────

$ErrorActionPreference = "Continue"   # 中间步失败也要继续往下走
$projectDir = "d:\Make_shit\Node\MusicMap"
$logFile    = Join-Path $projectDir "restart_docker.log"

function Log {
    param([string]$Msg)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $Msg"
    Add-Content -Path $logFile -Value $line
    Write-Output $line
}

Log "=== restart cycle BEGIN ==="

# 1. WSL --shutdown — 最猛但最可靠的方式杀掉 Docker 引擎和所有容器
Log "step 1: wsl --shutdown"
wsl --shutdown 2>&1 | Out-Null
Start-Sleep -Seconds 5

# 2. 把 Docker Desktop 的 GUI 进程也清掉(避免它和新启动的实例打架)
Log "step 2: kill lingering Docker Desktop processes"
Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.ProcessName -like "com.docker.*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# 3. 重新启动 Docker Desktop GUI
Log "step 3: launching Docker Desktop"
$dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (-not (Test-Path $dockerExe)) {
    Log "FATAL: Docker Desktop.exe not found at $dockerExe — aborting"
    exit 1
}
Start-Process $dockerExe

# 4. 等 Docker engine 起来(最多 240 秒,Docker Desktop 冷启偶尔超过 2 分钟)
Log "step 4: waiting for docker engine (timeout 240s)..."
$timeout = 240
$elapsed = 0
$ready = $false
while ($elapsed -lt $timeout) {
    Start-Sleep -Seconds 5
    $elapsed += 5
    docker ps 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $ready = $true
        Log "step 4: docker engine ready after ${elapsed}s"
        break
    }
    # 每 30 秒打个心跳,方便日志追踪
    if (($elapsed % 30) -eq 0) {
        Log "step 4: still waiting... ${elapsed}s elapsed"
    }
}
if (-not $ready) {
    Log "FATAL: docker engine did not become ready within ${timeout}s"
    Log "  current wsl state:"
    wsl --list --verbose 2>&1 | ForEach-Object { Log "    $_" }
    Log "  Docker Desktop process:"
    Get-Process "Docker Desktop" -ErrorAction SilentlyContinue | ForEach-Object { Log "    PID=$($_.Id)" }
    exit 2
}

# 5. 起容器(compose up)
Log "step 5: docker compose up -d"
Set-Location $projectDir
docker compose up -d 2>&1 | ForEach-Object { Log "  $_" }
Start-Sleep -Seconds 10

# 6a. 清掉容器内的旧 supervisor/python 残留(WSL shutdown 已经把容器内进程一锅端,这步
#     主要应对"WSL 还活着但 Task Scheduler 触发"的边角场景)
#     用独立的 cleanup_etl.sh 避免在 PowerShell 里嵌入复杂 sh 语法(单引号穿透多层会损坏)
Log "step 6a: clean leftover supervisor/python (if any survived)"
docker compose exec -T backend sh //etl/cleanup_etl.sh 2>&1 | ForEach-Object { Log "  $_" }

# 6b. 重新拉起 Deezer 艺人头像 supervisor(并发 7)→ /tmp/deezer.log
#     run_supervised.sh 内部自己 exec >> 重定向(外层在 PowerShell + docker.exe + sh 三层间会丢失)
Log "step 6b: relaunching Deezer artist supervisor (concurrency 10, retry-errors)"
docker compose exec -d backend nohup sh //etl/run_supervised.sh phase3_deezer_artists.py --concurrency 10 --retry-errors 2>&1 | ForEach-Object { Log "  $_" }

Log "=== restart cycle END ==="
exit 0
