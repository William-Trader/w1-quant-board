#!/usr/bin/env bash
# deploy.sh — 在 Mac 上运行，一键部署 William 量化看板 W1 到腾讯云轻量
# 用法: ./deploy.sh
set -euo pipefail

REMOTE_HOST="49.232.251.21"
REMOTE_USER="ubuntu"
REMOTE_DIR="~/w1-board"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- 0. sshpass 检测 ----
if ! command -v sshpass >/dev/null 2>&1; then
  echo "✗ 未找到 sshpass。请先安装："
  echo "    brew install hudochenkov/sshpass/sshpass"
  exit 3
fi

# ---- 1. SSH 密码：优先环境变量 W1_SSH_PASS，回退脚本内默认值 ----
if [ -z "${W1_SSH_PASS:-}" ]; then
  W1_SSH_PASS='CHANGE_ME'
  echo "⚠ 安全提醒：正在使用脚本内默认 SSH 密码。建议改用环境变量："
  echo "    export W1_SSH_PASS='CHANGE_ME' && ./deploy.sh"
fi
export SSHPASS="$W1_SSH_PASS"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no"
SCP_RSYNC="sshpass -e rsync -avz --delete -e \"ssh -o StrictHostKeyChecking=no\""

echo "== W1 部署 → ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR} =="

# ---- 2. 同步代码（排除 node_modules / data / .env / logs）----
echo "-- 同步文件…"
eval rsync -avz --delete \
  -e "\"sshpass -e ssh -o StrictHostKeyChecking=no\"" \
  --exclude 'node_modules/' \
  --exclude 'data/*.db' --exclude 'data/*.db-wal' --exclude 'data/*.db-shm' \
  --exclude '.env' \
  --exclude 'logs/*.log' --exclude 'logs/watchdog-alert.txt' \
  --exclude '.DS_Store' --exclude '*.tar.gz' \
  "$LOCAL_DIR/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

# ---- 3. 远端生成 .env（若不存在则从 .env.example 拷贝）----
echo "-- 确保远端 .env…"
$SSH "${REMOTE_USER}@${REMOTE_HOST}" "cd ${REMOTE_DIR} && [ -f .env ] || cp .env.example .env; mkdir -p data logs"

# ---- 4. 远端安装依赖（生产）----
echo "-- npm install --omit=dev…"
$SSH "${REMOTE_USER}@${REMOTE_HOST}" "cd ${REMOTE_DIR} && npm install --omit=dev --no-audit --no-fund"

# ---- 5. pm2 startOrRestart ----
echo "-- pm2 startOrRestart w1-board…"
$SSH "${REMOTE_USER}@${REMOTE_HOST}" "cd ${REMOTE_DIR} && (pm2 describe w1-board >/dev/null 2>&1 && pm2 restart ecosystem.config.js --update-env || pm2 start ecosystem.config.js) && pm2 save"

# ---- 6. 验收：/api/version 且 is_full_terminal=true ----
echo "-- 验证 /api/version…"
sleep 4
RESP="$($SSH "${REMOTE_USER}@${REMOTE_HOST}" "curl -s --max-time 10 http://127.0.0.1:3300/api/version")"
echo "   响应: $RESP"
echo "$RESP" | grep -q '"ok":true' || { echo "✗ /api/version 未返回 ok"; exit 1; }
echo "$RESP" | grep -q '"is_full_terminal":true' || { echo "✗ is_full_terminal != true（前端可能被精简）"; exit 1; }
echo "$RESP" | grep -q 'william-quant-board-w1' || { echo "✗ 指纹 name 不匹配"; exit 1; }

echo "== ✓ 部署完成，验收通过 =="
echo "   看板: http://${REMOTE_HOST}/  (nginx 80→3300)"
echo "   注意: 首次部署请登录服务器确认 ${REMOTE_DIR}/.env 内容（密钥从 .env.example 拷贝，含真实 key）"
