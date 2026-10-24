'use strict';
const Database = require('better-sqlite3');
const { assessSentiment, assessInfluence } = require('../lib/news');
const db = new Database('/home/ubuntu/w1-board/data/w1.db');
const rows = db.prepare('SELECT rowid,title,content FROM news').all();
const upd = db.prepare('UPDATE news SET sentiment=?, influence=? WHERE rowid=?');
let n = 0;
const tx = db.transaction(() => {
  for (const r of rows) { upd.run(assessSentiment(r.title, r.content), assessInfluence(r.title, r.content), r.rowid); n++; }
});
tx();
db.close();
console.log('reclassified ' + n);
