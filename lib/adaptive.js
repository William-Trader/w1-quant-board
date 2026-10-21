'use strict';
// 自适应阈值（2026-10-21 v7）：用历史分布替代固定阈值，带回退与滞回。
const CACHE = new Map();
function pct(arr, p) {
  if (!arr || !arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))));
  return a[i];
}
function std(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1));
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function klineReturns(db, symbol, opts = {}) {
  const interval = opts.interval || '5m';
  const days = opts.days || 30;
  const bars = opts.bars || 3; // 3×5m = 15m
  const key = symbol + ':' + interval + ':' + days + ':' + bars;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.v;
  const since = Date.now() - days * 86400e3;
  let rows = [];
  try { rows = db.prepare('SELECT ts,c FROM klines WHERE symbol=? AND interval=? AND ts>=? ORDER BY ts').all(symbol, interval, since); } catch (e) { return []; }
  const rets = [];
  for (let i = bars; i < rows.length; i++) {
    const a = Number(rows[i - bars].c), b = Number(rows[i].c);
    if (a > 0 && b > 0) rets.push((b - a) / a * 100);
  }
  CACHE.set(key, { ts: Date.now(), v: rets });
  return rets;
}

function priceMoveThreshold(db, symbol, base = 2.0) {
  const rets = klineReturns(db, symbol, { bars: 3, days: 30 });
  if (rets.length < 30) return { threshold: base, source: 'fallback', samples: rets.length };
  const s = std(rets);
  const p95 = pct(rets.map(Math.abs), 0.95);
  const th = clamp(Math.max(base, 2.5 * s, p95 * 0.9), 1.0, 5.0);
  return { threshold: +th.toFixed(2), sigma: +s.toFixed(3), p95: +p95.toFixed(2), samples: rets.length, source: 'adaptive' };
}

function fundingThreshold(db, symbol, base = 0.0015) {
  const since = Math.floor(Date.now() / 1000) - 90 * 86400;
  let rows = [];
  try { rows = db.prepare('SELECT funding_rate FROM funding_history WHERE symbol=? AND ts>=?').all(symbol, since); } catch (e) { return { threshold: base, source: 'fallback', samples: 0 }; }
  const abs = rows.map(r => Math.abs(Number(r.funding_rate) || 0)).filter(v => v > 0);
  if (abs.length < 50) return { threshold: base, source: 'fallback', samples: abs.length };
  const p95 = pct(abs, 0.95);
  const th = clamp(Math.max(base, p95 * 0.9), base, 0.02);
  return { threshold: +th.toFixed(5), p95: +p95.toFixed(5), samples: abs.length, source: 'adaptive' };
}

// 滞回：value >= enter 置位；value <= exit 复位；状态存 kv
function hysteresis(db, key, value, enter, exit) {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key);
  let on = !!(row && String(row.value) === '1');
  if (!on && value >= enter) on = true;
  else if (on && value <= exit) on = false;
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, on ? '1' : '0');
  return on;
}

module.exports = { pct, std, clamp, klineReturns, priceMoveThreshold, fundingThreshold, hysteresis };
