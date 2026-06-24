#!/usr/bin/env bash
# Phase 2 sample: 下载 _sample_list.txt 里列出的 ~30 张专辑封面
# 来源: Cover Art Archive /release-group/{mbid}/front
#
# 输出: data/covers-sample/<idx>_<artist>_<title>_<year>.jpg
# 失败的会写到 _failures.log

set -u

SAMPLE_DIR="d:/Make_shit/Node/MusicMap/data/covers-sample"
LIST_FILE="$SAMPLE_DIR/_sample_list.txt"
FAILURE_LOG="$SAMPLE_DIR/_failures.log"

# 清空旧失败日志
: > "$FAILURE_LOG"

idx=0
ok=0
fail=0

while IFS='|' read -r mbid artist title year country; do
    # 跳过空行或非数据行
    [[ -z "${mbid:-}" || "${mbid:0:1}" != [0-9a-f] ]] && continue
    idx=$((idx+1))

    # 文件名:替换斜杠/冒号/空格等不安全字符
    safe_artist=$(echo "$artist" | tr '/\\:*?"<>|' '_' | tr ' ' '_')
    safe_title=$(echo "$title"  | tr '/\\:*?"<>|' '_' | tr ' ' '_')
    fname=$(printf "%02d_%s_%s_%s.jpg" "$idx" "$safe_artist" "$safe_title" "$year")
    out="$SAMPLE_DIR/$fname"

    printf "[%02d] %s - %s (%s) ... " "$idx" "$artist" "$title" "$year"

    # CAA endpoint - 跟随 307 重定向到 archive.org
    http=$(curl -L -s -o "$out" -w "%{http_code}" --max-time 30 \
        -A "MusicMap/0.1 (https://github.com/user/musicmap)" \
        "https://coverartarchive.org/release-group/$mbid/front")

    size=$(stat -c%s "$out" 2>/dev/null || echo 0)

    if [[ "$http" == "200" && "$size" -gt 1000 ]]; then
        echo "OK ${size}B"
        ok=$((ok+1))
    else
        echo "FAIL http=$http size=${size}B"
        echo "$mbid|$artist|$title|$year|http=$http|size=$size" >> "$FAILURE_LOG"
        rm -f "$out"  # 删掉空/坏文件
        fail=$((fail+1))
    fi

    sleep 0.6   # CAA 限速:每秒不超过 2 个请求
done < "$LIST_FILE"

echo ""
echo "─────────────────────────────────────"
echo "  完成: $ok 张成功 / $fail 张失败 (总 $idx)"
echo "  成功率: $(awk "BEGIN{printf \"%.1f\", $ok*100/$idx}")%"
echo "  目录: $SAMPLE_DIR"
echo "  失败日志: $FAILURE_LOG"
echo "─────────────────────────────────────"
