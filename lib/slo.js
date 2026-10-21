'use strict';
// 数据源 SLO：成功率 / p95 延迟 / 错误预算燃烧率（基于 source_health）
function pct(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}
function targetOf(source) {
  return String(source).startsWith('news_') ? 0.95 : 0.99;
}
function summarize(db, opts = {}) {
  const hours = Math.min(24 * 30, Math.max(1, Number(opts.hours) || 24));
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = db.prepare('SELECT source,ok,ms,ts FROM source_health WHERE ts>=?').all(since);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.source)) map.set(r.source, { source: r.source, total: 0, ok: 0, ms: [], last_ts: 0 });
    const m = map.get(r.source);
    m.total++; if (Number(r.ok)) m.ok++;
    if (r.ms != null) m.ms.push(Number(r.ms));
    if (Number(r.ts) > m.last_ts) m.last_ts = Number(r.ts);
  }
  return Array.from(map.values()).map(m => {
    const success = m.total ? m.ok / m.total : 0;
    const target = targetOf(m.source);
    const burn = target < 1 ? Math.max(0, (1 - success) / (1 - target)) : 0;
    return {
      source: m.source, total: m.total, ok: m.ok,
      success_pct: +(100 * success).toFixed(2),
      target_pct: +(100 * target).toFixed(1),
      error_budget_pct: +(100 * (1 - target)).toFixed(1),
      burn_rate: +burn.toFixed(2),
      p95_ms: m.ms.length ? +pct(m.ms, 0.95).toFixed(0) : null,
      avg_ms: m.ms.length ? +(m.ms.reduce((s, x) => s + x, 0) / m.ms.length).toFixed(0) : null,
      last_ok_age_sec: m.last_ts ? Math.max(0, Math.floor(Date.now() / 1000) - m.last_ts) : null,
      status: burn > 2 ? 'critical' : burn > 1 ? 'warning' : 'ok'
    };
  }).sort((a, b) => b.burn_rate - a.burn_rate || a.source.localeCompare(b.source));
}
function rollup(db, opts = {}) {
  const days = Math.min(90, Math.max(1, Number(opts.days) || 30));
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare("SELECT source, date(ts,'unixepoch','localtime') d, ok, ms FROM source_health WHERE ts>=?").all(since);
  const map = new Map();
  for (const r of rows) {
    const k = r.source + '|' + r.d;
    if (!map.has(k)) map.set(k, { source: r.source, date: r.d, total: 0, ok: 0, ms: [] });
    const m = map.get(k);
    m.total++; if (Number(r.ok)) m.ok++;
    if (r.ms != null) m.ms.push(Number(r.ms));
  }
  const ins = db.prepare('INSERT INTO slo_daily(source,date,total,ok,p95_ms,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source,date) DO UPDATE SET total=excluded.total,ok=excluded.ok,p95_ms=excluded.p95_ms,updated_at=excluded.updated_at');
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  const tx = db.transaction(() => {
    for (const m of map.values()) {
      ins.run(m.source, m.date, m.total, m.ok, m.ms.length ? pct(m.ms, 0.95) : null, now);
      n++;
    }
  });
  tx();
  return n;
}
module.exports = { summarize, rollup, targetOf };
