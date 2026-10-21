'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const alerts = require('../lib/alerts');
const adaptive = require('../lib/adaptive');

const db = new Database(':memory:');
alerts.ensureSchema(db);

const a = alerts.record(db, { dedup_key: 'test:x', rule: 'test', severity: 'P1', symbol: 'BTC', title: '测试告警', detail: 'd1' });
assert.strictEqual(a.isNew, true);
const b = alerts.record(db, { dedup_key: 'test:x', rule: 'test', severity: 'P1', symbol: 'BTC', title: '测试告警', detail: 'd2' });
assert.strictEqual(b.isNew, false);
assert.strictEqual(b.row.count, 2);
assert.strictEqual(b.row.state, 'open');

assert.strictEqual(alerts.ack(db, a.id, 'owner'), 1);
assert.strictEqual(db.prepare('SELECT state,ack_by FROM alerts WHERE id=?').get(a.id).state, 'ack');
assert.strictEqual(alerts.silence(db, a.id, 60, 'owner'), 1);
assert.strictEqual(db.prepare('SELECT state FROM alerts WHERE id=?').get(a.id).state, 'silenced');
assert.strictEqual(alerts.resolve(db, 'test:x'), 1);
assert.strictEqual(db.prepare('SELECT state FROM alerts WHERE id=?').get(a.id).state, 'resolved');
assert.strictEqual(alerts.list(db, { state: 'all' }).length, 1);
const st = alerts.stats(db);
assert.strictEqual(st.open, 0);

const th = adaptive.priceMoveThreshold(db, 'BTC', 2);
assert.strictEqual(th.threshold, 2);
assert.strictEqual(th.source, 'fallback');
assert.strictEqual(adaptive.clamp(5, 1, 3), 3);

db.close();
console.log('monitoring tests passed');
