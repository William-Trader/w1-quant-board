'use strict';
// 跨源一致性 + 冻结行情检测（2026-10-21 v7）
const SYMS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK'];
const BASIS_LIMIT = 2.5; // %
const FROZEN_BARS = 10;
const FROZEN_MIN_SEC = 1800;
function latestSpot(db, sym) {
  return db.prepare('SELECT price,ts FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT 1').get(sym);
}
function futuresMap(db) {
  const row = db.prepare('SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 1').get();
  if (!row) return {};
  try {
    const p = JSON.parse(row.payload);
    const arr = (p && p.data) || [];
    const m = {};
    for (const c of arr) if (c && c.symbol) m[c.symbol] = Number(c.current_price);
    return m;
  } catch (e) { return {}; }
}
function compute(db) {
  const fut = futuresMap(db);
  const checks = [];
  for (const sym of SYMS) {
    const spot = latestSpot(db, sym);
    const fp = fut[sym];
    if (!spot || !fp || !spot.price) continue;
    const basis = (fp - Number(spot.price)) / Number(spot.price) * 100;
    const rows = db.prepare('SELECT price,ts FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT ?').all(sym, FROZEN_BARS);
    let frozen = false;
    if (rows.length >= FROZEN_BARS) {
      const vals = rows.map(r => Number(r.price));
      const span = Number(rows[0].ts) - Number(rows[rows.length - 1].ts);
      frozen = Math.max(...vals) === Math.min(...vals) && span >= FROZEN_MIN_SEC;
    }
    checks.push({ symbol: sym, spot: Number(spot.price), futures: fp, basis_pct: +basis.toFixed(3), frozen, spot_age_sec: Math.max(0, Math.floor(Date.now() / 1000) - Number(spot.ts)) });
  }
  return checks;
}
async function run(ctx) {
  const { db, env } = ctx;
  const alerts = require('./alerts');
  const checks = compute(db);
  let n = 0;
  for (const c of checks) {
    if (Math.abs(c.basis_pct) > BASIS_LIMIT) {
      await alerts.emit(db, env, {
        dedup_key: 'consistency:basis:' + c.symbol, rule: 'consistency:basis', severity: 'P1', symbol: c.symbol,
        title: c.symbol + ' 期现基差异常 ' + c.basis_pct + '%',
        detail: '现货 $' + c.spot + ' / 永续 $' + c.futures + '，基差 ' + c.basis_pct + '%（阈值 ' + BASIS_LIMIT + '%）',
        payload: { direction: c.basis_pct > 0 ? 'short' : 'long', basis_pct: c.basis_pct }
      }, { cooldownSec: 1800 });
      n++;
    } else {
      alerts.resolve(db, 'consistency:basis:' + c.symbol, '基差回归 ' + c.basis_pct + '%');
    }
    if (c.frozen) {
      await alerts.emit(db, env, {
        dedup_key: 'consistency:frozen:' + c.symbol, rule: 'consistency:frozen', severity: 'P2', symbol: c.symbol,
        title: c.symbol + ' 现货行情疑似冻结',
        detail: '最近 ' + FROZEN_BARS + ' 笔价格完全相同，跨度≥' + Math.round(FROZEN_MIN_SEC / 60) + ' 分钟',
        payload: { price: c.spot }
      }, { cooldownSec: 3600 });
      n++;
    } else {
      alerts.resolve(db, 'consistency:frozen:' + c.symbol, '行情恢复变化');
    }
  }
  return { checks, emitted: n };
}
function summary(db) { return compute(db); }
module.exports = { run, summary, compute, BASIS_LIMIT };
