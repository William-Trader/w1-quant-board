// W1 系统健康检查 + 群推送告警 (2026-08-12)
// 检查: PM2 4服务 / w1-board API / 实盘心跳 / 磁盘
// 用法: node scripts/health_check.js
const { loadEnv } = require('../lib/env');
const { openDb } = require('../lib/db');
const { pushToGroup } = require('../lib/qqbot');

const { execSync } = require('child_process');

function sh(cmd) {
  try { return execSync(cmd, { timeout: 20000, shell: '/bin/bash' }).toString(); }
  catch (e) { return ''; }
}

async function main() {
  const env = loadEnv();
  const db = openDb(env);
  const problems = [];

  // 1. PM2 服务状态
  const pm = sh('pm2 jlist 2>/dev/null');
  let pm2ok = false;
  try {
    const list = JSON.parse(pm);
    const down = list.filter(p => p.pm2_env.status !== 'online');
    if (down.length) problems.push(`PM2服务离线: ${down.map(p => p.name).join(',')}`);
    else pm2ok = true;
  } catch (e) { problems.push('PM2状态解析失败'); }

  // 2. w1-board API
  try {
    const r = await fetch('http://127.0.0.1:3300/health', { signal: AbortSignal.timeout(5000) });
    if (!r.ok && r.status !== 401) problems.push(`w1-board API 异常 HTTP ${r.status}`);
  } catch (e) { problems.push('w1-board API 无响应'); }

  // 3. 实盘心跳检查已停用(2026-08-13 William老板指令: 停掉实盘心跳告警)

  // 4. 磁盘
  try {
    const df = sh("df -h / | tail -1");
    const pct = parseInt(df.split(/\s+/)[4]);
    if (pct > 85) problems.push(`磁盘占用 ${pct}%`);
  } catch (e) {}

  const status = problems.length ? '🔴 ' + problems.join(' | ') : '🟢 W1 系统健康: 4服务在线/API正常/实盘心跳检查已停用磁盘OK';
  console.log(new Date().toISOString(), status);

  // 有异常才推群，正常静默
  if (problems.length) {
    // 去重防刷屏：同类告警 30 分钟内只推一次（2026-08-13 凌晨刷屏修复）
    const sig = problems.join('|');
    const now = Date.now();
    const lastRow = db.prepare("SELECT value FROM kv WHERE key='health:last_push'").get();
    let dup = false;
    if (lastRow) {
      try {
        const p = JSON.parse(lastRow.value);
        if (p.sig === sig && now - p.ts < 30 * 60 * 1000) dup = true;
      } catch (e) {}
    }
    if (!dup) {
      db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('health:last_push',?)").run(JSON.stringify({ sig, ts: now }));
      await pushToGroup(env, db, `⚠️【系统告警 ${new Date().toLocaleString('zh-CN')}】\n` + problems.join('\n'));
      console.log(new Date().toISOString(), '已推送告警（30分钟内同类不再重复）');
    } else {
      console.log(new Date().toISOString(), '同类告警重复，30分钟内不重复推送');
    }
  }
  db.close();
}

main().catch(e => { console.error('health_check 异常:', e.message); process.exit(1); });
