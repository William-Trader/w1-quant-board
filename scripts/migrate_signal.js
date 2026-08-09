#!/usr/bin/env node
// scripts/migrate_signal.js — 数据库迁移（幂等）
const path = require('path');
const D = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new D(path.join(__dirname, '..', 'data', 'w1.db'));
const cols = ['strategy_id TEXT DEFAULT \'\'', 'regime TEXT DEFAULT \'\'', 'exit_reason TEXT DEFAULT \'\''];
const exist = new Set(db.prepare("PRAGMA table_info(signal_track)").all().map(c => c.name));
let n = 0;
for (const c of cols) {
  const name = c.split(' ')[0];
  if (!exist.has(name)) { db.exec(`ALTER TABLE signal_track ADD COLUMN ${c}`); n++; console.log('added', name); }
}
console.log(`migrate done, added ${n} columns`);
db.close();
