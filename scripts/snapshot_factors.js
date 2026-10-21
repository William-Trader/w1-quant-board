'use strict';
// ═══════════════════════════════════════════════════════════
// 实盘因子快照采集器（2026-08-21）
// 每 5 分钟把实盘实时指标存入 tianji_full.sqlite.factor_snapshots：
//   oi_chg_24h（Coinglass markets OI 24h 变化，实盘 fund 同源）
//   funding（avg_funding_rate_by_oi，百分数）
//   lsr（LSR rankings trader 散户账户比）
//   qibao_raw / qibao_score（qibao7 实时输出，实盘 qibao 同源）
// 用途：未来回测直接用真实指标复现实盘单（qibao/fund 历史重建不准的根治）
// 安全：独立进程，只读 w1.db，只写 tianji_full.sqlite；5min 一次极轻
// ═══════════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const W1 = path.join(ROOT, 'data', 'w1.db');
const FULL = path.join(ROOT, 'data', 'tianji_full.sqlite');
const SYMS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'ADA', 'XAU'];

const db = new Database(W1, { readonly: true });
const out = new Database(FULL);
out.pragma('journal_mode = WAL');
out.exec(`CREATE TABLE IF NOT EXISTS factor_snapshots (
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  oi_chg_24h REAL,
  funding REAL,
  lsr REAL,
  qibao_raw REAL,
  qibao_score REAL,
  PRIMARY KEY(ts, symbol)
)`);

const { store } = require('../lib/store');
const now = Math.floor(Date.now() / 1000);
let inserted = 0;

try {
  // 1) Coinglass markets 指标（实盘 fundScore 数据源，store 解析）
  const mMap = {};
  try {
    const fut = store.latestFutures(db);
    const coins = (fut && fut.data && fut.data.data) || [];
    for (const c of coins) {
      if (!SYMS.includes(c.symbol)) continue;
      mMap[c.symbol] = {
        oi: c.open_interest_change_percent_24h != null ? +c.open_interest_change_percent_24h : null,
        fund: c.avg_funding_rate_by_oi != null ? +c.avg_funding_rate_by_oi : null,
      };
    }
  } catch (e) {}
  // 2) LSR trader 散户账户比（实盘 fundScore 数据源，payload.data 直接是数组）
  const lsrMap = {};
  try {
    const row = db.prepare('SELECT payload FROM lsr_rankings WHERE mode=? ORDER BY ts DESC LIMIT 1').get('trader');
    if (row && row.payload) {
      const p = JSON.parse(row.payload);
      const rows = (p && p.data) || [];
      for (const r of rows) {
        const sym = String(r.symbol || '').replace(/USDT$/, '');
        if (SYMS.includes(sym) && r.ratio != null) lsrMap[sym] = +r.ratio;
      }
    }
  } catch (e) {}
  // 3) qibao7 实时输出（实盘 qibaoScore 数据源）
  const qibMap = {};
  try {
    const qibao = require('../lib/qibao7');
    const r = qibao.listReport(db);
    for (const row of (r.rows || [])) {
      if (SYMS.includes(row.symbol)) {
        qibMap[row.symbol] = { raw: row.score != null ? +row.score : null, label: row.label || '' };
      }
    }
  } catch (e) {}

  const ins = out.prepare('INSERT OR REPLACE INTO factor_snapshots VALUES (?,?,?,?,?,?,?)');
  const tx = out.transaction(() => {
    for (const s of SYMS) {
      const m = mMap[s] || {}, lsr = lsrMap[s], q = qibMap[s];
      ins.run(now, s, m.oi != null ? m.oi : null, m.fund != null ? m.fund : null,
        lsr != null ? lsr : null, q && q.raw != null ? q.raw : null,
        q && q.label ? q.label : null);
      inserted++;
    }
  });
  tx();
  console.log(`[snapshot] ${new Date(now * 1000).toISOString()} 写入 ${inserted} 币快照（oi=${Object.keys(mMap).length} lsr=${Object.keys(lsrMap).length} qibao=${Object.keys(qibMap).length}）`);
} catch (e) {
  console.error('[snapshot] 异常:', e.message);
  process.exit(1);
} finally {
  db.close();
  out.close();
}
