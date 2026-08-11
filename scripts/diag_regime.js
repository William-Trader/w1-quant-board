'use strict';
// 诊断: 2025年 regime 分布 + 误判分析
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
const d1 = agg(h1, 86400);
function emaArr(arr, n) { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; }
function adxArr(bars, n = 14) {
  const out = new Array(bars.length).fill(0); let pDM = 0, mDM = 0, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    const pDm = up > dn && up > 0 ? up : 0, mDm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { pDM += pDm; mDM += mDm; trSum += tr; if (i < n) continue; }
    else { pDM = pDM - pDM / n + pDm; mDM = mDM - mDM / n + mDm; trSum = trSum - trSum / n + tr; }
    const pdi = 100 * pDM / (trSum || 1), mdi = 100 * mDM / (trSum || 1);
    const dx = 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1);
    out[i] = i === n ? dx : (out[i - 1] * (n - 1) + dx) / n;
  }
  return out;
}
const dc = d1.map(b => b.c);
const e20 = emaArr(dc, 20), e50 = emaArr(dc, 50), e200 = emaArr(dc, 200);
const adx = adxArr(d1, 14);
// 逐日统计 2025 的 regime 分布
const dist = {};
let n = 0;
for (let i = 60; i < d1.length; i++) {
  const b = d1[i];
  if (b.ts < Date.UTC(2025,0,1) || b.ts > Date.UTC(2025,11,31)) continue;
  n++;
  const up = e20[i] > e50[i] && e50[i] > e200[i];
  const dn = e20[i] < e50[i] && e50[i] < e200[i];
  const adxv = adx[i] || 0;
  let type;
  if (adxv >= 25 && up) type = 'TREND_UP';
  else if (adxv >= 25 && dn) type = 'TREND_DOWN';
  else if (adxv < 20) type = 'RANGE';
  else type = up ? 'TREND_UP-ish' : dn ? 'TREND_DOWN-ish' : 'RANGE';
  dist[type] = (dist[type] || 0) + 1;
  // 检测假突破: ADX>=25 但之后20天内方向反转
}
console.log('2025年regime分布 (n=' + n + '):');
for (const k in dist) console.log(`  ${k}: ${dist[k]} (${(dist[k]/n*100).toFixed(0)}%)`);
// 更关键的指标: ADX>=25 的日子占比 + 均线完美排列占比
let adxHigh = 0, perfectUp = 0, perfectDn = 0;
for (let i = 60; i < d1.length; i++) {
  const b = d1[i];
  if (b.ts < Date.UTC(2025,0,1) || b.ts > Date.UTC(2025,11,31)) continue;
  if ((adx[i]||0) >= 25) adxHigh++;
  if (e20[i] > e50[i] && e50[i] > e200[i]) perfectUp++;
  if (e20[i] < e50[i] && e50[i] < e200[i]) perfectDn++;
}
console.log(`ADX>=25: ${(adxHigh/n*100).toFixed(0)}% | 完美多头排列: ${(perfectUp/n*100).toFixed(0)}% | 完美空头排列: ${(perfectDn/n*100).toFixed(0)}%`);
// 2024 vs 2026 对比
for (const [name, y0] of [['2024',2024],['2026',2026]]) {
  let nn=0, aa=0, pu=0, pd=0;
  for (let i = 60; i < d1.length; i++) {
    const b = d1[i];
    if (b.ts < Date.UTC(y0,0,1) || b.ts > Date.UTC(y0,11,31)) continue;
    nn++;
    if ((adx[i]||0) >= 25) aa++;
    if (e20[i] > e50[i] && e50[i] > e200[i]) pu++;
    if (e20[i] < e50[i] && e50[i] < e200[i]) pd++;
  }
  console.log(`${name}: ADX>=25 ${(aa/nn*100).toFixed(0)}% | 完美多头 ${(pu/nn*100).toFixed(0)}% | 完美空头 ${(pd/nn*100).toFixed(0)}%`);
}
