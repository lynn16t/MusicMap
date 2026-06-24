#!/bin/sh
# 容器内清理工具 — 干掉残留的 supervisor/python ETL 进程,删 stop 文件
# 用法:docker compose exec -T backend sh //etl/cleanup_etl.sh

for d in /proc/[0-9]*; do
    pid=$(basename "$d")
    cmd=$(cat "$d/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$cmd" in
        *run_supervised*|*phase2_download*|*phase2_spotify*|*phase3_deezer*)
            if [ "$pid" != "$$" ]; then
                kill -9 "$pid" 2>/dev/null && echo "killed $pid"
            fi
            ;;
    esac
done

rm -f /tmp/stop_etl
echo "cleanup-done"
