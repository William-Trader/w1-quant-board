'use strict';
// 诊断: 2025年交易明细（方向/出场原因/R值）→ 定位震荡市短板根因
const bt = require('./backtest_v4.js');
function toTs(y,m,d) { return Date.UTC(y,m,d,23,59); }
const cfg = { entry_th:3.0, risk_pct:2, stop_atr:2.5, t1_rr:0.8, t1_pct:50, trail_atr:3, time_bars:16, min_r:0.5, lev_cap:50, cooldown:6, cons_only:1 };
// 直接调 runBacktest 拿不到明细，改造: 复制核心循环输出 trades
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });
const rows = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
const h1 = rows.map(r => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
function agg(bars, secs) { const out=[]; let cur=null; for (const b of bars){ const bk=Math.floor(b.ts/(secs*1000)); if(!cur||cur.bucket!==bk){ if(cur)out.push(cur); cur={bucket:bk,ts:b.ts,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v}; } else { cur.h=Math.max(cur.h,b.h); cur.l=Math.min(cur.l,b.l); cur.c=b.c; cur.v+=b.v; } } if(cur)out.push(cur); return out; }
const h4 = agg(h1,14400), d1 = agg(h1,86400);
const N4 = h4.length;
const dc = d1.map(b=>b.c), hc = h4.map(b=>b.c);
const e20d=[]; {let k=2/21, p=dc[0]; for(let i=0;i<dc.length;i++){ p=i?dc[i]*k+p*(1-k):dc[0]; e20d.push(p);} }
const e50d=[]; {let k=2/51, p=dc[0]; for(let i=0;i<dc.length;i++){ p=i?dc[i]*k+p*(1-k):dc[0]; e50d.push(p);} }
const e200d=[]; {let k=2/201, p=dc[0]; for(let i=0;i<dc.length;i++){ p=i?dc[i]*k+p*(1-k):dc[0]; e200d.push(p);} }
const dIdxOf4 = new Array(N4).fill(0); {let di=0; for(let i=0;i<N4;i++){ while(di+1<d1.length && d1[di+1].ts<=h4[i].ts) di++; dIdxOf4[i]=di; } }
// 方向分（简化: 日线趋势分 + 4h MACD 方向）
const score4h = new Array(N4).fill(0);
for (let i=60;i<N4;i++){
  const di=dIdxOf4[i];
  const up=e20d[di]>e50d[di]&&e50d[di]>e200d[di], dn=e20d[di]<e50d[di]&&e50d[di]<e200d[di];
  let sc = up?2.0:dn?-2.0:(e20d[di]>e50d[di]?0.6:-0.6);
  sc += dc[di]>e200d[di]?0.8:-0.8;
  score4h[i]=sc;
}
// 2025 交易统计（近似）
let y25 = { long:0, short:0, longWin:0, shortWin:0, byReason:{}, winR:0, lossR:0 };
let pos=null, cd={long:-1e9,short:-1e9};
for (let i=90;i<N4;i++){
  const bar=h4[i]; const ts=bar.ts;
  if (ts < Date.UTC(2025,0,1) || ts > Date.UTC(2025,11,31)) continue;
  // 简单模拟: 方向分超阈值即开仓（无完整出场，仅统计开仓方向分布）
  const sc = score4h[i];
  if (!pos){
    const di=dIdxOf4[i];
    const dir = sc>=3.0?'long':sc<=-3.0?'short':null;
    if (dir && i-cd[dir]>=6){ pos={dir,idx:i,entry:bar.c}; cd[dir]=i; }
  } else {
    // 简化出场: 20根后平仓，看盈亏
    if (i-pos.idx>=20){
      const pnl = pos.dir==='long'?(bar.c-pos.entry)/pos.entry*100:(pos.entry-bar.c)/pos.entry*100;
      y25[pos.dir]++; if(pnl>0) y25[pos.dir+'Win']++;
      pos=null;
    }
  }
}
console.log('2025年简化统计（20根4h持仓）:');
console.log('  多单:', y25.long, '胜', y25.longWin, '(', (y25.longWin/Math.max(1,y25.long)*100).toFixed(0)+'%)');
console.log('  空单:', y25.short, '胜', y25.shortWin, '(', (y25.shortWin/Math.max(1,y25.short)*100).toFixed(0)+'%)');
console.log('  多空比:', y25.long+':'+y25.short);
