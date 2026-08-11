// 诊断2025年窗口交易明细：为什么胜率只有50%
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });
const rows = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
const h1 = rows.map(r => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
function agg(bars, secs) {
  const out = []; let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.ts / (secs * 1000));
    if (!cur || cur.bucket !== bucket) { if (cur) out.push(cur); cur = { bucket, ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  if (cur) out.push(cur);
  return out;
}
const h4 = agg(h1, 14400);
// 2025年BTC价格走势
const d1 = agg(h1, 86400);
const y2025 = d1.filter(b => b.ts >= Date.UTC(2025,0,1) && b.ts <= Date.UTC(2025,11,31));
console.log('2025年BTC价格轨迹（月初收盘）:');
let lastM = -1;
for (const b of y2025) {
  const m = new Date(b.ts).getUTCMonth();
  if (m !== lastM) { console.log(`  ${new Date(b.ts).toISOString().slice(0,7)}: $${b.c.toFixed(0)}`); lastM = m; }
}
console.log(`2025全年: 开$${y2025[0].o.toFixed(0)} → 收$${y2025[y2025.length-1].c.toFixed(0)} (${((y2025[y2025.length-1].c/y2025[0].o-1)*100).toFixed(0)}%)`);
console.log(`最高$${Math.max(...y2025.map(b=>b.h)).toFixed(0)} 最低$${Math.min(...y2025.map(b=>b.l)).toFixed(0)}`);
