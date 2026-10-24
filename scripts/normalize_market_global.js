'use strict';
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/w1-board/data/w1.db');
const rows = db.prepare('SELECT ts,payload FROM market_global').all();
const upd = db.prepare('UPDATE market_global SET payload=? WHERE ts=?');
let n = 0;
for (const r of rows) {
  try {
    var p = JSON.parse(r.payload);
    var v = Number(p.total_volume_usd);
    if (isFinite(v) && Math.abs(v) > 1e15) {
      p.total_volume_usd = Math.round(v / 1e6);
      upd.run(JSON.stringify(p), r.ts);
      n++;
    }
  } catch (e) {}
}
db.close();
console.log('normalized ' + n + ' / ' + rows.length);
