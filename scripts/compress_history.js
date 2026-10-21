'use strict';
// 历史载荷压缩：把保留窗口之外的 JSON payload（TEXT）压缩为 gzip BLOB。
// - 幂等：只处理 typeof(payload)='text'
// - 安全：每行压缩后立刻 gunzip 回读比对，不一致即中止
// - 分批：keyset 分页（rowid），每批 200 行一个事务，不一次性载入内存
// 用法: node scripts/compress_history.js [--dry-run] [--table=liquidation]
const Database = require('better-sqlite3');
const zlib = require('zlib');
const path = require('path');

const DB = process.env.W1_DB || path.join(__dirname, '..', 'data', 'w1.db');
const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');

const DRY = process.argv.includes('--dry-run');
const only = (process.argv.find(a => a.startsWith('--table=')) || '').split('=')[1];
const NOW = Math.floor(Date.now() / 1000);
const TABLES = [
  { t: 'liquidation',       keepDays: 7  },
  { t: 'futures_markets',   keepDays: 7  },
  { t: 'economic_calendar', keepDays: 30 },
  { t: 'cgpro_history',     keepDays: 30 },
  { t: 'openclue_archive',  keepDays: 30 },
  { t: 'lsr_signals',       keepDays: 7  }
];
const BATCH = 200;

function isGzip(buf) { return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b; }

let totalIn = 0, totalOut = 0, totalRows = 0;
for (const { t, keepDays } of TABLES) {
  if (only && only !== t) continue;
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (!exists) { console.log('[skip] ' + t + ' 不存在'); continue; }
  const cutoff = NOW - keepDays * 86400;
  let lastId = 0, rows = 0, inBytes = 0, outBytes = 0;
  const upd = db.prepare('UPDATE "' + t + '" SET payload=? WHERE rowid=?');
  for (;;) {
    const batch = db.prepare(
      'SELECT rowid id, payload FROM "' + t + '" WHERE rowid > ? AND ts < ? AND typeof(payload)=\'text\' ORDER BY rowid LIMIT ' + BATCH
    ).all(lastId, cutoff);
    if (!batch.length) break;
    if (DRY) {
      for (const r of batch) { inBytes += Buffer.byteLength(r.payload); outBytes += zlib.gzipSync(r.payload).length; }
      rows += batch.length; lastId = batch[batch.length - 1].id; continue;
    }
    const tx = db.transaction((list) => {
      for (const r of list) {
        const text = r.payload;
        const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 6 });
        const back = zlib.gunzipSync(gz).toString('utf8');
        if (back !== text) throw new Error('roundtrip mismatch rowid=' + r.id);
        upd.run(gz, r.id);
        inBytes += Buffer.byteLength(text);
        outBytes += gz.length;
        rows++;
      }
    });
    tx(batch);
    lastId = batch[batch.length - 1].id;
  }
  totalIn += inBytes; totalOut += outBytes; totalRows += rows;
  const pct = inBytes ? (100 * outBytes / inBytes).toFixed(1) : '0.0';
  console.log('[' + (DRY ? 'dry' : 'done') + '] ' + t + ' rows=' + rows + ' ' +
    (inBytes / 1048576).toFixed(1) + 'MB -> ' + (outBytes / 1048576).toFixed(1) + 'MB (' + pct + '%)')
}
if (!DRY) { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {} }
console.log('[summary] ' + totalRows + ' rows, ' + (totalIn / 1048576).toFixed(1) + 'MB -> ' +
  (totalOut / 1048576).toFixed(1) + 'MB (' + (totalIn ? (100 * totalOut / totalIn).toFixed(1) : '0') + '%)');
db.close();
