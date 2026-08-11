'use strict';
// 诊断: 2025年 EMA200 锚定问题 — 价格 vs EMA200 关系
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });
const rows = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
const h1 = rows.map(r => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
function agg(bars, secs) { const out=[]; let cur=null; for (const b of bars){ const bk=Math.floor(b.ts/(secs*1000)); if(!cur||cur.bucket!==bk){ if(cur)out.push(cur); cur={bucket:bk,ts:b.ts,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v}; } else { cur.h=Math.max(cur.h,b.h); cur.l=Math.min(cur.l,b.l); cur.c=b.c; cur.v+=b.v; } } if(cur)out.push(cur); return out; }
const d1 = agg(h1,86400);
function emaArr(arr, n) { const k = 2/(n+1); const out=[arr[0]]; for(let i=1;i<arr.length;i++) out.push(arr[i]*k+out[i-1]*(1-k)); return out; }
const dc = d1.map(b=>b.c);
const e200 = emaArr(dc, 200);
const e50 = emaArr(dc, 50);
const e20 = emaArr(dc, 20);
// 统计 2025 全年: 价格在EMA200上方天数、EMA200斜率、多头排列但价格下跌的天数
let above = 0, below = 0, upSlope = 0, dnSlope = 0, fakeUp = 0, n = 0;
const monthly = {};
for (let i = 210; i < d1.length; i++) {
  const b = d1[i];
  if (b.ts < Date.UTC(2025,0,1) || b.ts > Date.UTC(2025,11,31)) continue;
  n++;
  const m = new Date(b.ts).toISOString().slice(0,7);
  if (!monthly[m]) monthly[m] = { above:0, below:0, upArr:0, dnArr:0, fake:0, n:0 };
  monthly[m].n++;
  if (b.c > e200[i]) { above++; monthly[m].above++; } else { below++; monthly[m].below++; }
  const slope = e200[i] - e200[Math.max(0,i-10)];
  if (slope > 0) { upSlope++; monthly[m].upArr++; } else { dnSlope++; monthly[m].dnArr++; }
  // 假多头: 完美多头排列(20>50>200) 但 30天前价格更高(实际在跌)
  const upPerfect = e20[i]>e50[i] && e50[i]>e200[i];
  if (upPerfect && i>=30 && b.c < d1[i-30].c) { fakeUp++; monthly[m].fake++; }
}
console.log(`2025全年 n=${n}: 价格>EMA200 ${above}天(${(above/n*100).toFixed(0)}%) | 价格<EMA200 ${below}天(${(below/n*100).toFixed(0)}%)`);
console.log(`EMA200斜率向上 ${upSlope}天(${(upSlope/n*100).toFixed(0)}%) | 向下 ${dnSlope}天(${(dnSlope/n*100).toFixed(0)}%)`);
console.log(`假多头(排列完美但30天在跌): ${fakeUp}天(${(fakeUp/n*100).toFixed(0)}%)`);
console.log('\n按月: 月份 | 价>200 | 200斜率上 | 假多头');
for (const m in monthly) {
  const v = monthly[m];
  console.log(`  ${m} | ${(v.above/v.n*100).toFixed(0)}% | ${(v.upArr/v.n*100).toFixed(0)}% | ${(v.fake/v.n*100).toFixed(0)}%`);
}
