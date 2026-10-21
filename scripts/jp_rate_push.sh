#!/bin/bash
# 日本央行/议息快讯 - 收集+行情解读推送（William老板 2026-08-31 指令 v2）
DB=/home/ubuntu/w1-board/data/w1.db
# 收集最近24h日本央行/议息相关快讯
sqlite3 "$DB" "SELECT '🕐 '||datetime(ts,'unixepoch','+8 hours')||' '||content FROM jin10_flash_cache WHERE (content LIKE '%日本央行%' OR content LIKE '%日央行%' OR content LIKE '%BOJ%' OR content LIKE '%议息%' OR (content LIKE '%日本%' AND (content LIKE '%利率%' OR content LIKE '%加息%' OR content LIKE '%降息%' OR content LIKE '%日元%' OR content LIKE '%国债%' OR content LIKE '%收益率%')) OR (content LIKE '%日元%' AND (content LIKE '%央行%' OR content LIKE '%加息%' OR content LIKE '%降息%'))) AND ts >= strftime('%s','now')-86400 ORDER BY ts DESC LIMIT 10;" > /tmp/jp_rate_feed.txt
