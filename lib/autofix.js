'use strict';
// lib/autofix.js — W1 告警自动修复引擎 v1（2026-11-06）
// 目标：把「已知可自愈」的系统告警在 2 分钟内闭环，未知问题留给云端智能体。
// 设计原则：
//  - 只做安全、可回滚的动作：重启挂掉的进程 / 补采断供数据源 / 收敛过期事件告警；
//  - 每个动作独立冷却，避免修复风暴；单轮最多触发 3 个采集任务；
//  - 全部动作落 alert_remediations，可审计、可在 /api/alerts/autofix 查看。
const { execFileSync } = require('child_process');
const alertsLib = require('./alerts');
const { kvGet, kvSet } = require('./db');
const { WATCH } = require('./health_guard');

const REPAIR = {
  prices:           { job: 'gate-prices',       cd: 300 },
  futures_markets:  { job: 'futures-markets',   cd: 300 },
  fear_greed:       { job: 'fear-greed',        cd: 1800 },
  liquidation:      { job: 'liquidation',       cd: 600 },
  lsr_history:      { job: 'lsr-signals',       cd: 600 },
  funding_arb:      { job: 'funding-arb',       cd: 600 },
  consensus:        { job: 'consensus',         cd: 1800 },
  market_structure: { job: 'market-structure',  cd: 1800 },
  altseason_daily:  { job: 'altseason',         cd: 3600 },
  // news / klines 由 w1-board 进程内调度，无独立 JOBS：断供时直接重启 board
  news:             { restartBoard: true,       cd: 1800 },
  klines:           { restartBoard: true,       cd: 1800 }
};

const PM2_APPS = ['w1-board', 'cloud-lobster', 'search-server', 'btc-oracle'];

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS alert_remediations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    target TEXT,
    action TEXT,
    status TEXT,
    detail TEXT,
    alert_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_alert_rem_ts ON alert_remediations(ts);`);
}

function rec(db, target, action, status, detail, alertId) {
  try {
    db.prepare('INSERT INTO alert_remediations(ts,target,action,status,detail,alert_id) VALUES(?,?,?,?,?,?)')
      .run(Math.floor(Date.now() / 1000), target || null, action, status, detail == null ? null : String(detail).slice(0, 500), alertId || null);
  } catch (e) {}
}

function cooled(db, key, sec) {
  const last = Number(kvGet(db, key, 0) || 0);
  return Date.now() - last < sec * 1000;
}

function markCooled(db, key) { kvSet(db, key, Date.now()); }

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { timeout: 20000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return ''; }
}

function pm2State() {
  const out = sh('pm2', ['jlist']);
  if (!out) return null;
  try {
    const list = JSON.parse(out);
    return list.map(p => ({
      name: p.name,
      status: p.pm2_env && p.pm2_env.status,
      restarts: p.pm2_env && p.pm2_env.restart_time,
      uptime_ms: p.pm2_env && p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0
    }));
  } catch (e) { return null; }
}

function staleSources(db, now) {
  const out = [];
  for (const w of WATCH) {
    try {
      const ex = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(w.table);
      if (!ex) continue;
      const r = db.prepare(`SELECT MAX(${w.col}) m FROM ${w.table}`).get();
      const v = r && r.m != null ? Number(r.m) : null;
      if (v == null) { out.push({ table: w.table, zh: w.zh, age_sec: null, limit: w.secs, empty: true }); continue; }
      const sec = String(Math.floor(v)).length > 10 ? Math.floor(v / 1000) : v;
      const age = now - sec;
      if (age > w.secs) out.push({ table: w.table, zh: w.zh, age_sec: age, limit: w.secs, empty: false });
    } catch (e) {}
  }
  return out;
}

async function run(ctx, opts = {}) {
  const { db, env } = ctx;
  ensureTable(db);
  const now = Math.floor(Date.now() / 1000);
  const result = {
    ts: new Date().toISOString(),
    pm2: [],
    api_ok: null,
    stale: [],
    repairs: [],
    swept: 0,
    unresolved: []
  };

  // ── 1. 进程存活：挂掉就拉起（单应用 15 分钟冷却）────────────────
  const procs = pm2State();
  if (procs) {
    for (const p of procs) {
      if (!PM2_APPS.includes(p.name)) continue;
      if (p.status === 'online') continue;
      const key = 'autofix:pm2:' + p.name;
      if (cooled(db, key, 900)) {
        result.pm2.push({ name: p.name, status: p.status, action: 'skipped_cooldown' });
        continue;
      }
      markCooled(db, key);
      sh('pm2', ['restart', p.name, '--update-env']);
      rec(db, p.name, 'pm2_restart', 'done', 'status=' + p.status);
      result.pm2.push({ name: p.name, status: p.status, action: 'restarted' });
    }
  } else {
    result.pm2.push({ error: 'pm2_jlist_failed' });
  }

  // ── 2. 站点自检：API 不通则重启 board（10 分钟冷却）──────────────
  try {
    const r = await fetch('http://127.0.0.1:3300/healthz', { signal: AbortSignal.timeout(5000) });
    result.api_ok = r.ok || r.status === 401;
    if (!result.api_ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    result.api_ok = false;
    const key = 'autofix:api:restart';
    if (cooled(db, key, 600)) {
      result.repairs.push({ target: 'w1-board', action: 'restart_for_api', status: 'skipped_cooldown' });
    } else {
      markCooled(db, key);
      sh('pm2', ['restart', 'w1-board', '--update-env']);
      rec(db, 'w1-board', 'restart_for_api', 'done', e.message);
      result.repairs.push({ target: 'w1-board', action: 'restart_for_api', status: 'done', detail: e.message });
    }
    // API 刚重启，后续采集交给下一轮
    result.stale = staleSources(db, now);
    result.unresolved = activeAlerts(db);
    return result;
  }

  // ── 3. 断供补采：按表映射到采集任务，逐项冷却，单轮最多 3 个 ──────
  result.stale = staleSources(db, now);
  if (Array.isArray(opts.simulate) && opts.simulate.length) {
    const known = new Set(result.stale.map(s => s.table));
    for (const t of opts.simulate) {
      if (known.has(t)) continue;
      const w = WATCH.find(x => x.table === t);
      if (w) result.stale.push({ table: t, zh: w.zh, age_sec: w.secs + 60, limit: w.secs, empty: false, simulated: true });
    }
  }
  const jobs = [];
  for (const s of result.stale) {
    const rule = REPAIR[s.table];
    if (!rule) continue;
    const key = 'autofix:collect:' + s.table;
    // 模拟测试不使用冷却，确保每次都能验证真实采集链路
    if (!s.simulated && cooled(db, key, rule.cd)) {
      result.repairs.push({ target: s.table, action: 'collect', status: 'skipped_cooldown', detail: rule.job });
      continue;
    }
    jobs.push({ s, rule, key });
  }
  let executed = 0;
  for (const { s, rule, key } of jobs) {
    if (executed >= 3) break;
    executed++;
    if (!s.simulated) markCooled(db, key);
    if (rule.restartBoard) {
      sh('pm2', ['restart', 'w1-board', '--update-env']);
      rec(db, s.table, 'restart_board_for_source', 'done', 'stale ' + s.age_sec + 's');
      result.repairs.push({ target: s.table, action: 'restart_board', status: 'done' });
      continue;
    }
    try {
      const collectors = require('./collectors');
      const job = collectors.JOBS[rule.job];
      if (!job) throw new Error('job_not_found:' + rule.job);
      const r = await job(ctx);
      rec(db, s.table, 'collect', 'done', rule.job + ' → ' + (r == null ? 'ok' : String(r)).slice(0, 200));
      result.repairs.push({ target: s.table, action: 'collect', status: 'done', detail: rule.job, result: r == null ? null : String(r).slice(0, 120) });
    } catch (e) {
      rec(db, s.table, 'collect', 'failed', rule.job + ': ' + e.message);
      result.repairs.push({ target: s.table, action: 'collect', status: 'failed', detail: e.message });
    }
  }

  // ── 4. 事件型告警收敛：skyeye/alt_radar/market_watch 过期自动 resolved ──
  try { result.swept = alertsLib.sweep(db); } catch (e) {}

  // ── 5. 汇总仍未闭环的告警，交给云端智能体 ─────────────────────────
  result.unresolved = activeAlerts(db);
  const failed = result.repairs.filter(x => x.status === 'failed');
  if (failed.length) {
    rec(db, 'system', 'autofix_round', 'partial', JSON.stringify(failed));
    // 修复失败才通知，30 分钟冷却，避免重复刷屏
    if (!cooled(db, 'autofix:last_push', 1800)) {
      try {
        const { pushToGroup } = require('./qqbot');
        const lines = failed.map(f => `• ${f.target || '—'} ${f.action}: ${f.detail || '失败'}`).join('\n');
        const ok = await pushToGroup(env, db, `🛠️【W1 自动修复未成功】\n${lines}\n已记录到 alert_remediations，云端智能体将接手诊断。`, 'monitor');
        if (ok) markCooled(db, 'autofix:last_push');
      } catch (e) {}
    }
  }
  return result;
}

function activeAlerts(db) {
  try {
    return db.prepare(`SELECT id,rule,severity,title,state,last_seen,count FROM alerts
      WHERE state IN ('open','ack') ORDER BY severity,last_seen DESC LIMIT 50`).all()
      .map(r => Object.assign({}, r, { age_sec: Math.max(0, Math.floor(Date.now() / 1000) - r.last_seen) }));
  } catch (e) { return []; }
}

function recent(db, limit) {
  ensureTable(db);
  return db.prepare('SELECT * FROM alert_remediations ORDER BY id DESC LIMIT ?').all(Math.min(200, Math.max(1, Number(limit) || 20)));
}

module.exports = { run, staleSources, activeAlerts, recent, ensureTable, REPAIR, PM2_APPS };
