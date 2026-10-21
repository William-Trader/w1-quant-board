'use strict';
// 数据质量评分（Data Quality Score）
// - 新鲜度：每个关键数据源相对阈值是否 ok/stale/empty
// - 体量：payload 表总字节、已压缩行占比、DB 可回收页
// - 结果缓存 60s，避免频繁扫描大表
const fs = require('fs');
const path = require('path');
const { WATCH } = require('./health_guard');

const PAYLOAD_TABLES = [
  'liquidation', 'futures_markets', 'economic_calendar', 'cgpro_history',
  'openclue_archive', 'lsr_signals', 'news', 'fear_greed'
];

let cache = { ts: 0, data: null };

function tableInfo(db, name, tsCol) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!exists) return { table: name, exists: false, rows: 0, latest_ts: null, age_sec: null, payload_mb: null, compressed_rows: 0, payload_rows: 0 };
  let rows = 0, latest = null, payloadBytes = null, compressed = 0, payloadRows = 0;
  try { rows = db.prepare('SELECT COUNT(*) c FROM "' + name + '"').get().c; } catch (e) {}
  try { const r = db.prepare('SELECT MAX(' + (tsCol || 'ts') + ') m FROM "' + name + '"').get(); latest = r && r.m != null ? Number(r.m) : null; } catch (e) {}
  try {
    const cols = db.prepare('PRAGMA table_info("' + name + '")').all().map(c => c.name);
    if (cols.includes('payload')) {
      if (rows > 50000) {
        // 大表采样估算，避免每次扫描数 GB 载荷（首调用从 ~20s 降到 ms 级）
        const s = db.prepare('SELECT AVG(LENGTH(payload)) a, SUM(CASE WHEN typeof(payload)=\'blob\' THEN 1 ELSE 0 END) c, COUNT(*) n FROM (SELECT payload FROM "' + name + '" LIMIT 500)').get();
        payloadBytes = s && s.a != null ? Math.round(Number(s.a) * rows) : null;
        compressed = s && s.c != null ? Math.round(Number(s.c) / Math.max(1, Number(s.n)) * rows) : 0;
        payloadRows = rows;
      } else {
        const s = db.prepare('SELECT SUM(LENGTH(payload)) b, SUM(CASE WHEN typeof(payload)=\'blob\' THEN 1 ELSE 0 END) c, COUNT(payload) n FROM "' + name + '"').get();
        payloadBytes = s && s.b != null ? Number(s.b) : null;
        compressed = s && s.c != null ? Number(s.c) : 0;
        payloadRows = s && s.n != null ? Number(s.n) : 0;
      }
    }
  } catch (e) {}
  const sec = latest == null ? null : (String(Math.floor(latest)).length > 10 ? Math.floor(latest / 1000) : latest);
  return {
    table: name, exists: true, rows, latest_ts: sec,
    age_sec: sec == null ? null : Math.max(0, Math.floor(Date.now() / 1000) - sec),
    payload_mb: payloadBytes == null ? null : +(payloadBytes / 1048576).toFixed(2),
    compressed_rows: compressed, payload_rows: payloadRows
  };
}

function collect(db, opts = {}) {
  const ttl = opts.ttlMs == null ? 60000 : opts.ttlMs;
  if (!opts.force && cache.data && Date.now() - cache.ts < ttl) return cache.data;
  const now = Math.floor(Date.now() / 1000);
  const watchMap = new Map(WATCH.map(w => [w.table, w]));
  const names = Array.from(new Set([...WATCH.map(w => w.table), ...PAYLOAD_TABLES]));
  const tables = names.map(name => {
    const w = watchMap.get(name) || {};
    const info = tableInfo(db, name, w.col || 'ts');
    const threshold = w.secs || null;
    let status = 'ok';
    if (!info.exists || info.rows === 0) status = 'empty';
    else if (threshold && info.age_sec != null && info.age_sec > threshold) status = 'stale';
    return Object.assign(info, { zh: w.zh || name, threshold, status });
  });
  const ok = tables.filter(t => t.status === 'ok').length;
  const stale = tables.filter(t => t.status === 'stale').length;
  const empty = tables.filter(t => t.status === 'empty').length;
  const scored = tables.filter(t => t.threshold); // 仅对有关键阈值的数据源评分
  const scoredOk = scored.filter(t => t.status === 'ok').length;
  const coverage = scored.length ? Math.round(scoredOk / scored.length * 100) : 100;

  let pageCount = 0, freelist = 0, pageSize = 4096;
  try { pageCount = Number(db.pragma('page_count', { simple: true })); } catch (e) {}
  try { freelist = Number(db.pragma('freelist_count', { simple: true })); } catch (e) {}
  try { pageSize = Number(db.pragma('page_size', { simple: true })) || 4096; } catch (e) {}
  let fileMb = null;
  try { fileMb = +(fs.statSync(path.join(__dirname, '..', 'data', 'w1.db')).size / 1048576).toFixed(1); } catch (e) {}

  const data = {
    ok: true,
    as_of: now,
    quality_score: coverage,
    summary: { total: tables.length, ok, stale, empty, coverage_pct: coverage },
    db: {
      file_mb: fileMb,
      page_count: pageCount,
      freelist_pages: freelist,
      reclaimable_mb: +(freelist * pageSize / 1048576).toFixed(1)
    },
    tables
  };
  cache = { ts: Date.now(), data };
  return data;
}

module.exports = { collect, PAYLOAD_TABLES };
