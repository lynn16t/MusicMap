#!/bin/sh
# ─────────────────────────────────────────────────────────────
# Supervisor 包装器:用法
#   sh run_supervised.sh <script_name.py> [args...]
#
# 行为:
#   - 反复跑 python /etl/<script_name.py> <args>
#   - 异常退出(rc != 0) → 等 10 秒重启
#   - 正常退出(rc == 0,如 unknown 跑完)→ 不再重启,本身退出
#   - 检测到 /tmp/stop_etl 文件 → 不再重启,删掉 stop_etl 然后退出
#
# 启动:
#   docker compose exec -d backend sh -c \
#     'nohup sh //etl/run_supervised.sh phase2_spotify.py --concurrency 3 > //tmp/spotify.log 2>&1 &'
#
# 优雅停止:
#   docker compose exec backend sh -c 'touch //tmp/stop_etl'
#   (当前 python 跑完后,supervisor 看到 stop 文件不重启)
#
# 强制停止(立刻):
#   docker compose exec backend sh -c 'touch //tmp/stop_etl'
#   docker compose exec backend sh -c \
#     'for d in /proc/[0-9]*; do pid=$(basename "$d");
#      grep -q "[p]hase2_" "$d/cmdline" 2>/dev/null && kill -INT "$pid"; done'
# ─────────────────────────────────────────────────────────────

SCRIPT="$1"
if [ -z "$SCRIPT" ]; then
    echo "usage: sh run_supervised.sh <script.py> [args...]"
    exit 1
fi
shift  # 剩下都是传给 python 脚本的参数

# 把自己的 stdout/stderr 重定向到固定日志文件(防外层 shell 重定向被层层穿透时丢掉)
# 命名规则:phase2_download_covers.py → /tmp/covers.log;phase2_spotify.py → /tmp/spotify.log
case "$SCRIPT" in
    *download_covers*)  LOG=/tmp/covers.log;;
    *spotify*)          LOG=/tmp/spotify.log;;
    *deezer_artists*)   LOG=/tmp/deezer.log;;
    *)                  LOG=/tmp/etl.log;;
esac
# 每次启动 truncate(等同 `> $LOG`),避免无穷增长
: > "$LOG"
exec >>"$LOG" 2>&1

# 清掉上次残留的 stop 文件,避免一启动就退出
rm -f /tmp/stop_etl

iter=0
while true; do
    iter=$((iter + 1))

    if [ -f /tmp/stop_etl ]; then
        echo "[supervisor $(date -Iseconds)] stop_etl found, exiting after $((iter - 1)) iters"
        rm -f /tmp/stop_etl
        exit 0
    fi

    echo ""
    echo "==================================================================="
    echo "[supervisor $(date -Iseconds)] iter #$iter starting"
    echo "  cmd: python /etl/$SCRIPT $*"
    echo "==================================================================="

    python "/etl/$SCRIPT" "$@"
    rc=$?

    echo ""
    echo "[supervisor $(date -Iseconds)] iter #$iter exited rc=$rc"

    if [ "$rc" = "0" ]; then
        echo "[supervisor $(date -Iseconds)] rc=0 (normal completion) → done, exiting"
        exit 0
    fi

    if [ -f /tmp/stop_etl ]; then
        echo "[supervisor $(date -Iseconds)] stop_etl found post-exit, not restarting"
        rm -f /tmp/stop_etl
        exit 0
    fi

    echo "[supervisor $(date -Iseconds)] sleep 10s then restart..."
    sleep 10
done
