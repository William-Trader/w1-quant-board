#!/usr/bin/env bash
# 数据库紧凑化（VACUUM INTO + 原子替换）。仅在明确维护窗口运行。
# 前置：已完成 payload 压缩；脚本自带一致性备份与失败回滚。
set -euo pipefail
cd /home/ubuntu/w1-board
TS=$(date +%Y%m%d-%H%M%S)
DB=data/w1.db
COMPACT=data/w1.compact.$TS.db
BACKUP=/home/ubuntu/backups/db/w1-precompact-$TS.db
OLD=data/w1.db.precompact-$TS

echo "== w1 compact $TS =="
df -h / | tail -1
[ -f "$DB" ] || { echo "missing $DB"; exit 1; }
mkdir -p /home/ubuntu/backups/db

rollback() {
  echo "!! rollback"
  if [ ! -f "$DB" ] && [ -f "$OLD" ]; then mv "$OLD" "$DB"; fi
  rm -f "$DB-wal" "$DB-shm"
  pm2 restart w1-board >/dev/null 2>&1 || true
  sudo systemctl start cron >/dev/null 2>&1 || true
  echo "!! rolled back (backup: $BACKUP)"
}
trap rollback ERR

echo "-- consistent backup -> $BACKUP"
sqlite3 "$DB" ".backup '$BACKUP'"

echo "-- stop writers (cron + w1-board)"
sudo systemctl stop cron
pm2 stop w1-board >/dev/null

echo "-- vacuum into $COMPACT"
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE); VACUUM INTO '$COMPACT';"

echo "-- integrity + row-count checks"
sqlite3 "$COMPACT" "PRAGMA integrity_check;" | grep -qx ok
for t in liquidation futures_markets economic_calendar cgpro_history openclue_archive lsr_signals source_health asset_prices; do
  A=$(sqlite3 "$DB" "SELECT COUNT(*) FROM $t")
  B=$(sqlite3 "$COMPACT" "SELECT COUNT(*) FROM $t")
  [ "$A" = "$B" ] || { echo "count mismatch $t old=$A new=$B"; exit 1; }
  echo "   $t $B"
done

echo "-- swap"
mv "$DB" "$OLD"
mv "$COMPACT" "$DB"
rm -f "$DB-wal" "$DB-shm"
chmod 644 "$DB"

echo "-- restart"
pm2 restart w1-board >/dev/null
sudo systemctl start cron
trap - ERR

echo "-- result"
ls -lh "$DB" "$OLD" "$BACKUP"
pm2 list --no-color | grep w1-board || true
echo "== compact done =="
