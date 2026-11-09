'use strict';
// scripts/alert_autofix.js — 告警自动修复巡检（cron 每 2 分钟）
// 用法: node scripts/alert_autofix.js [--json]
// 退出码: 0=正常；1=本轮有修复失败（供外部监控消费）
const { loadEnv } = require('../lib/env');
const { openDb } = require('../lib/db');
const { CoinglassClient } = require('../lib/coinglass');
const autofix = require('../lib/autofix');

(async () => {
  const env = loadEnv();
  const db = openDb(env);
  const cg = new CoinglassClient(env, db);
  const ctx = { env, db, cg };
  const simIdx = process.argv.indexOf('--simulate');
  const simulate = simIdx > -1 && process.argv[simIdx + 1] ? [process.argv[simIdx + 1]] : [];
  const out = await autofix.run(ctx, { simulate });
  const failed = (out.repairs || []).filter(r => r.status === 'failed');
  const summary = {
    ts: out.ts,
    api_ok: out.api_ok,
    stale: (out.stale || []).map(s => s.table + (s.age_sec == null ? '(empty)' : '(' + Math.round(s.age_sec / 60) + 'm)')),
    repairs: out.repairs,
    swept: out.swept,
    open_alerts: (out.unresolved || []).length
  };
  console.log(JSON.stringify(summary));
  db.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('[alert_autofix] fatal: ' + e.message); process.exit(1); });
