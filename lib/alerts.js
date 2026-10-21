'use strict';
// 统一告警中心 v1（2026-10-21）
// - 统一状态机：open → ack / silenced → resolved
// - 幂等去重：dedup_key（同一事件只保留一条活动告警，计数累加）
// - 生命周期：first_seen/last_seen/count/ack_by/ack_at/silenced_until/resolved_at
// - 推送与记录分离：record() 只入库，emit() 入库并按策略推送；health_guard 可聚合推送后 markNotified()
const SCHEMA = `
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'P2',
  symbol TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  ack_by TEXT,
  ack_at INTEGER,
  silenced_until INTEGER,
  resolved_at INTEGER,
  notified_at INTEGER,
  payload TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_active ON alerts(dedup_key) WHERE state IN ('open','ack','silenced');
CREATE INDEX IF NOT EXISTS idx_alerts_last_seen ON alerts(last_seen);
CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts(rule);

CREATE TABLE IF NOT EXISTS alert_outcomes (
  alert_id INTEGER NOT NULL,
  horizon_sec INTEGER NOT NULL,
  ret_pct REAL,
  mfe_pct REAL,
  mae_pct REAL,
  evaluated_at INTEGER NOT NULL,
  PRIMARY KEY(alert_id, horizon_sec)
);

CREATE TABLE IF NOT EXISTS slo_daily (
  source TEXT NOT NULL,
  date TEXT NOT NULL,
  total INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  p95_ms REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(source, date)
);
`;

function ensureSchema(db) { db.exec(SCHEMA); }

function normSeverity(s) {
  const v = String(s || 'P2').toUpperCase();
  return v === 'P0' || v === 'P1' || v === 'P2' ? v : 'P2';
}

function record(db, a) {
  const now = Math.floor(Date.now() / 1000);
  const key = String(a.dedup_key || a.dedupKey || a.rule + ':' + (a.symbol || ''));
  const sev = normSeverity(a.severity);
  const existing = db.prepare("SELECT * FROM alerts WHERE dedup_key=? AND state IN ('open','ack','silenced') ORDER BY id DESC LIMIT 1").get(key);
  const payload = a.payload == null ? null : (typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload));
  if (existing) {
    const newSev = rank(sev) < rank(existing.severity) ? sev : existing.severity; // P0 最高
    db.prepare('UPDATE alerts SET last_seen=?, count=count+1, severity=?, title=?, detail=?, symbol=?, payload=COALESCE(?,payload) WHERE id=?')
      .run(now, newSev, a.title || existing.title, a.detail || existing.detail, a.symbol || existing.symbol, payload, existing.id);
    return { id: existing.id, isNew: false, row: db.prepare('SELECT * FROM alerts WHERE id=?').get(existing.id) };
  }
  const info = db.prepare(`INSERT INTO alerts(dedup_key,rule,severity,symbol,title,detail,state,first_seen,last_seen,count,payload)
    VALUES(?,?,?,?,?,?, 'open', ?,?,1,?)`)
    .run(key, a.rule || 'unknown', sev, a.symbol || null, a.title || key, a.detail || null, now, now, payload);
  return { id: Number(info.lastInsertRowid), isNew: true, row: db.prepare('SELECT * FROM alerts WHERE id=?').get(info.lastInsertRowid) };
}

function rank(sev) { return sev === 'P0' ? 0 : sev === 'P1' ? 1 : 2; }

function isQuiet(row, now) {
  if (row.state === 'silenced' && row.silenced_until && row.silenced_until > now) return true;
  return false;
}

async function emit(db, env, a, opts = {}) {
  const res = record(db, a);
  const row = res.row;
  const now = Math.floor(Date.now() / 1000);
  if (opts.notify === false) return res;
  if (isQuiet(row, now)) return res;
  const cooldown = opts.cooldownSec == null ? 1800 : opts.cooldownSec;
  const last = row.notified_at || 0;
  const escalated = res.isNew || row.severity === 'P0';
  if (!escalated && now - last < cooldown) return res;
  const msg = (opts.prefix ? opts.prefix + '\n' : '') + '[' + row.severity + '] ' + row.title + (a.detail ? '\n' + a.detail : '');
  let ok = false;
  try {
    const { pushToGroup } = require('./qqbot');
    ok = await pushToGroup(env, db, msg, opts.type || 'monitor');
  } catch (e) { ok = false; }
  if (ok) db.prepare('UPDATE alerts SET notified_at=? WHERE id=?').run(now, row.id);
  return Object.assign(res, { pushed: ok });
}

function markNotified(db, ids) {
  const now = Math.floor(Date.now() / 1000);
  const st = db.prepare('UPDATE alerts SET notified_at=? WHERE id=?');
  db.transaction((list) => { for (const id of list) st.run(now, id); })(ids || []);
}

function resolve(db, dedupKey, note) {
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare("UPDATE alerts SET state='resolved', resolved_at=?, detail=COALESCE(?,detail) WHERE dedup_key=? AND state IN ('open','ack','silenced')")
    .run(now, note || null, dedupKey);
  return info.changes;
}

function resolveMissing(db, rule, activeKeys) {
  const set = new Set(activeKeys || []);
  const rows = db.prepare("SELECT id,dedup_key FROM alerts WHERE rule=? AND state IN ('open','ack','silenced')").all(rule);
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  for (const r of rows) {
    if (!set.has(r.dedup_key)) { db.prepare("UPDATE alerts SET state='resolved', resolved_at=? WHERE id=?").run(now, r.id); n++; }
  }
  return n;
}

function ack(db, id, by) {
  const now = Math.floor(Date.now() / 1000);
  const info = db.prepare("UPDATE alerts SET state='ack', ack_by=?, ack_at=? WHERE id=? AND state IN ('open','silenced')").run(by || 'owner', now, id);
  return info.changes;
}

function silence(db, id, minutes, by) {
  const until = Math.floor(Date.now() / 1000) + Math.max(1, Number(minutes) || 60) * 60;
  const info = db.prepare("UPDATE alerts SET state='silenced', silenced_until=?, ack_by=COALESCE(?,ack_by) WHERE id=? AND state!='resolved'").run(until, by || null, id);
  return info.changes;
}

function list(db, opts = {}) {
  const state = opts.state || 'active';
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  let where = '';
  if (state === 'active') where = "WHERE state IN ('open','ack','silenced')";
  else if (state !== 'all') where = "WHERE state='" + String(state).replace(/'/g, '') + "'";
  const rows = db.prepare('SELECT * FROM alerts ' + where + ' ORDER BY last_seen DESC LIMIT ' + limit).all();
  return rows.map(r => Object.assign({}, r, { age_sec: Math.max(0, Math.floor(Date.now() / 1000) - r.last_seen) }));
}

function stats(db) {
  const now = Math.floor(Date.now() / 1000);
  const bySev = db.prepare("SELECT severity, COUNT(*) n FROM alerts WHERE state IN ('open','ack','silenced') GROUP BY severity").all();
  const open = bySev.reduce((s, x) => s + x.n, 0);
  const acked = db.prepare("SELECT COUNT(*) n, AVG(ack_at-first_seen) mtta FROM alerts WHERE ack_at IS NOT NULL").get();
  const resolved = db.prepare("SELECT COUNT(*) n, AVG(resolved_at-first_seen) mttr FROM alerts WHERE resolved_at IS NOT NULL").get();
  const last24 = db.prepare('SELECT COUNT(*) n FROM alerts WHERE last_seen>=?').get(now - 86400).n;
  return {
    open,
    by_severity: Object.fromEntries(bySev.map(x => [x.severity, x.n])),
    last_24h: last24,
    ack: { count: acked.n || 0, mtta_sec: acked.mtta == null ? null : Math.round(acked.mtta) },
    resolved: { count: resolved.n || 0, mttr_sec: resolved.mttr == null ? null : Math.round(resolved.mttr) }
  };
}

module.exports = { ensureSchema, record, emit, markNotified, resolve, resolveMissing, ack, silence, list, stats, rank };
