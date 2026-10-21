'use strict';
// Prometheus 文本指标：监测系统自身可观测
const fs = require('fs');
const path = require('path');
const { WATCH } = require('./health_guard');
function pct(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}
function ageOf(db, table, col) {
  try {
    const row = db.prepare('SELECT MAX(' + (col || 'ts') + ') m FROM ' + table).get();
    if (!row || row.m == null) return null;
    const v = Number(row.m);
    const sec = String(Math.floor(v)).length > 10 ? Math.floor(v / 1000) : v;
    return Math.max(0, Math.floor(Date.now() / 1000) - sec);
  } catch (e) { return null; }
}
function render(db) {
  const out = [];
  const now = Math.floor(Date.now() / 1000);
  out.push('# HELP w1_up Process is up'); out.push('# TYPE w1_up gauge'); out.push('w1_up 1');
  out.push('# HELP w1_uptime_seconds Process uptime'); out.push('# TYPE w1_uptime_seconds gauge'); out.push('w1_uptime_seconds ' + Math.floor(process.uptime()));
  const mem = process.memoryUsage();
  out.push('# TYPE w1_memory_rss_bytes gauge'); out.push('w1_memory_rss_bytes ' + mem.rss);
  out.push('# TYPE w1_memory_heap_used_bytes gauge'); out.push('w1_memory_heap_used_bytes ' + mem.heapUsed);
  try { out.push('# TYPE w1_db_size_bytes gauge'); out.push('w1_db_size_bytes ' + fs.statSync(path.join(__dirname, '..', 'data', 'w1.db')).size); } catch (e) {}
  try {
    const bySev = db.prepare("SELECT severity, COUNT(*) n FROM alerts WHERE state IN ('open','ack','silenced') GROUP BY severity").all();
    out.push('# TYPE w1_alerts_open gauge');
    for (const r of bySev) out.push('w1_alerts_open{severity="' + r.severity + '"} ' + r.n);
  } catch (e) {}
  try {
    const rows = db.prepare('SELECT source,ok,ms FROM source_health WHERE ts>=?').all(now - 3600);
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.source)) map.set(r.source, { total: 0, ok: 0, ms: [] });
      const m = map.get(r.source); m.total++; if (Number(r.ok)) m.ok++; if (r.ms != null) m.ms.push(Number(r.ms));
    }
    out.push('# TYPE w1_source_success_ratio gauge');
    out.push('# TYPE w1_source_latency_p95_ms gauge');
    for (const [source, m] of map) {
      out.push('w1_source_success_ratio{source="' + source + '"} ' + (m.total ? (m.ok / m.total).toFixed(4) : 0));
      if (m.ms.length) out.push('w1_source_latency_p95_ms{source="' + source + '"} ' + pct(m.ms, 0.95));
    }
  } catch (e) {}
  out.push('# TYPE w1_table_age_seconds gauge');
  for (const w of WATCH) {
    const age = ageOf(db, w.table, w.col);
    if (age != null) out.push('w1_table_age_seconds{table="' + w.table + '"} ' + age);
  }
  return out.join('\n') + '\n';
}
module.exports = { render };
