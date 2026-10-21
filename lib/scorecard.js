'use strict';
// 告警评分卡：记录每条告警在 15m/1h/4h/24h 的远期收益、MFE/MAE，并按规则汇总命中率。
const HORIZONS = [900, 3600, 14400, 86400];

function series(db, symbol, fromSec, toSec) {
  return db.prepare("SELECT ts,o,h,l,c FROM klines WHERE symbol=? AND interval='5m' AND ts BETWEEN ? AND ? ORDER BY ts")
    .all(symbol, fromSec * 1000, toSec * 1000);
}

function directionOf(row) {
  try {
    const p = row.payload ? JSON.parse(row.payload) : null;
    const d = p && (p.direction || p.dir || p.bias);
    if (['long', 'bullish', 'up'].includes(String(d))) return 'long';
    if (['short', 'bearish', 'down'].includes(String(d))) return 'short';
  } catch (e) {}
  return null;
}

function evaluate(db, opts = {}) {
  const days = opts.days || 90;
  const limit = Math.min(1000, Math.max(1, opts.limit || 500));
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare("SELECT id,rule,severity,symbol,first_seen,payload FROM alerts WHERE symbol IS NOT NULL AND symbol!='' AND first_seen>=? AND rule NOT LIKE 'health%' ORDER BY id DESC LIMIT ?").all(since, limit);
  const ins = db.prepare('INSERT OR REPLACE INTO alert_outcomes(alert_id,horizon_sec,ret_pct,mfe_pct,mae_pct,evaluated_at) VALUES(?,?,?,?,?,?)');
  let n = 0;
  for (const a of rows) {
    const from = a.first_seen;
    for (const h of HORIZONS) {
      const has = db.prepare('SELECT 1 FROM alert_outcomes WHERE alert_id=? AND horizon_sec=?').get(a.id, h);
      if (has) continue;
      const bars = series(db, a.symbol, from - 300, from + h + 600);
      if (bars.length < 2) continue;
      const entryBar = bars.find(b => b.ts >= from * 1000) || bars[0];
      const entry = Number(entryBar.c);
      if (!(entry > 0)) continue;
      const window = bars.filter(b => b.ts >= from * 1000 && b.ts <= (from + h) * 1000);
      if (!window.length) continue;
      const last = Number(window[window.length - 1].c);
      const hi = Math.max(...window.map(b => Number(b.h)));
      const lo = Math.min(...window.map(b => Number(b.l)));
      const ret = (last - entry) / entry * 100;
      const mfe = (hi - entry) / entry * 100;
      const mae = (lo - entry) / entry * 100;
      ins.run(a.id, h, +ret.toFixed(3), +mfe.toFixed(3), +mae.toFixed(3), Math.floor(Date.now() / 1000));
      n++;
    }
  }
  return n;
}

function summary(db, opts = {}) {
  const days = opts.days || 90;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare("SELECT a.id,a.rule,a.severity,a.symbol,a.payload,o.horizon_sec,o.ret_pct,o.mfe_pct,o.mae_pct FROM alerts a JOIN alert_outcomes o ON o.alert_id=a.id WHERE a.first_seen>=?").all(since);
  const map = new Map();
  for (const r of rows) {
    const key = r.rule + '|' + r.severity + '|' + r.horizon_sec;
    if (!map.has(key)) map.set(key, { rule: r.rule, severity: r.severity, horizon_sec: r.horizon_sec, n: 0, hit: 0, ret_sum: 0, mfe_sum: 0, mae_sum: 0 });
    const m = map.get(key);
    m.n++;
    m.ret_sum += Number(r.ret_pct) || 0;
    m.mfe_sum += Number(r.mfe_pct) || 0;
    m.mae_sum += Number(r.mae_pct) || 0;
    const d = directionOf(r);
    const ret = Number(r.ret_pct) || 0;
    if (d === 'long' ? ret > 0 : d === 'short' ? ret < 0 : Math.abs(ret) >= 0.5) m.hit++;
  }
  return Array.from(map.values()).map(m => ({
    rule: m.rule, severity: m.severity, horizon_sec: m.horizon_sec, samples: m.n,
    hit_rate_pct: m.n ? +(100 * m.hit / m.n).toFixed(1) : null,
    avg_ret_pct: m.n ? +(m.ret_sum / m.n).toFixed(3) : null,
    avg_mfe_pct: m.n ? +(m.mfe_sum / m.n).toFixed(3) : null,
    avg_mae_pct: m.n ? +(m.mae_sum / m.n).toFixed(3) : null
  })).sort((a, b) => a.rule.localeCompare(b.rule) || a.horizon_sec - b.horizon_sec);
}

module.exports = { HORIZONS, evaluate, summary };
