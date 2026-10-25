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
    const r = await fetch('http://127.0.0.1:3300/healthz', { signal: AbortSignal.timeout(5000) });
    if (!r.ok && r.status !== 401) problems.push(`w1-board API 异常 HTTP ${r.status}`);
  } catch (e) { problems.push('w1-board API 无响应'); }

  // 3. 实盘心跳检查已停用(2026-08-13 William老板指令: 停掉实盘心跳告警)

  // 4. 磁盘
  try {
    const df = sh("df -h / | tail -1");
    const pct = parseInt(df.split(/\s+/)[4]);
    if (pct > 85) problems.push(`磁盘占用 ${pct}%`);
  } catch (e) {}

  // 5) 每部分数据新鲜度（2026-10-01 底座级：健康日志体现「每个部分的反馈」）
  const sections = [];
  try {
    const { WATCH } = require('../lib/health_guard');
    const nowS = Math.floor(Date.now() / 1000);
    for (const w of WATCH) {
      try {
        const ex = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(w.table);
        if (!ex) { sections.push(w.zh + ':无表'); continue; }
        const r = db.prepare("SELECT MAX(" + w.col + ") m FROM " + w.table).get();
        const v = r && r.m != null ? Number(r.m) : null;
        if (v == null) { sections.push(w.zh + ':空'); continue; }
        const sec = String(Math.floor(v)).length > 10 ? Math.floor(v / 1000) : v;
        const age = nowS - sec;
        if (age > w.secs) { sections.push(w.zh + ':断供' + Math.floor(age / 60) + '分'); problems.push(w.zh + ' 断供' + Math.floor(age / 60) + '分'); }
        else sections.push(w.zh + ':正常');
      } catch (e) { sections.push(w.zh + ':查询失败'); }
    }
  } catch (e) { sections.push('分段巡检不可用'); }
  // 6) 死手开关（2026-10-25）：进程内 */30 调度器死亡时，外部 cron 兜底自动重启 board
  //    触发条件：清算表超 50min + 近 50min 无采集尝试(source_health 无记录，排除上游故障) + 冷却 30min
  try {
    const nowS2 = Math.floor(Date.now() / 1000);
    const liq = db.prepare("SELECT MAX(ts) m FROM liquidation").get();
    const liqAge = liq && liq.m != null ? nowS2 - Number(liq.m) : 1e9;
    const HARD = 3000;
    if (liqAge > HARD) {
      const att = db.prepare("SELECT COUNT(*) n FROM source_health WHERE source LIKE 'cg_liquidation%' AND ts >= ?").get(nowS2 - HARD);
      if (!(att && att.n > 0)) {
        const cd = db.prepare("SELECT value FROM kv WHERE key='deadman:last_restart'").get();
        let lastTs = 0;
        try { lastTs = JSON.parse(cd.value).ts || 0; } catch (e) {}
        if (Date.now() - lastTs > 30 * 60 * 1000) {
          db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('deadman:last_restart',?)").run(JSON.stringify({ ts: Date.now() }));
          sh('pm2 restart w1-board --update-env 2>&1');
          problems.push('爆仓清算采集停摆(调度器死亡)，已自动重启 w1-board');
          console.log(new Date().toISOString(), '[deadman] 清算断供' + Math.floor(liqAge / 60) + '分且无采集尝试 → 自动重启 board');
        }
      }
    }
  } catch (e) { console.log(new Date().toISOString(), '[deadman] error:', e.message); }
  const status = problems.length
    ? '🔴 ' + problems.join(' | ') + ' ｜分区: ' + sections.join(' ')
    : '🟢 W1 系统健康: 4服务在线/API正常/磁盘OK ｜分区: ' + sections.join(' ');
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
