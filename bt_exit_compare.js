/* 出场策略对比回测：现有固定T2 vs 布林带T2 vs 结构位T2
 * 同一入场信号，仅出场不同 → 纯出场维度对比（抗过拟合：参数全复用现有值）
 * 入场：4h动量突破（与tianji同向简化版）+ 真实 signal_track 回放
 */
const db = require('better-sqlite3')('data/w1.db');
const { fetchKlines } = require('./lib/backtest');
const { bollinger } = require('./lib/signal');

const SYMS = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','LINK'];
const DAYS = 45, BAR_MS = 15*60*1000;
const HOLD_MS = 48*3600*1000;
const T2_MULT = 2.4, T1_MULT = 1.2, ATR_MULT = 2.5;

function sma(arr,n){ if(arr.length<n) return null; let s=0; for(let i=arr.length-n;i<arr.length;i++) s+=arr[i]; return s/n; }

function buildPlan(px, atrPct, dir) {
  const atrStop = px*(atrPct||0.15)/100*ATR_MULT;
  const floor = px*0.008, cap = px*0.05;
  const sd = Math.min(Math.max(atrStop, floor), cap);
  return { stopDist: sd, stop: dir==='long'?px-sd:px+sd };
}

// 4h ATR%（按4h收盘序列）
function atr4hPct(closes4h, last) {
  if (closes4h.length < 2) return 0.5;
  let ts=0; for (let i=1;i<closes4h.length;i++) ts += Math.abs(closes4h[i]-closes4h[i-1]);
  return ts/(closes4h.length-1)/last*100;
}

// 单笔模拟：返回 pnl%（含60/40拆分）
function simulate(bars, entryIdx, dir, opts) {
  const { t2mode } = opts;
  const px0 = bars[entryIdx].c;
  const closes4h = [];
  for (let i=entryIdx; i>=0 && closes4h.length<30; i-=16) if (bars[i]) closes4h.push(bars[i].c);
  closes4h.reverse();
  const atrP = atr4hPct(closes4h, px0);
  const plan = buildPlan(px0, atrP, dir);
  const stop = plan.stop;
  // T2 变体
  let t2 = dir==='long' ? px0 + plan.stopDist*T2_MULT : px0 - plan.stopDist*T2_MULT;
  if (t2mode==='boll') {
    const closes = [];
    for (let i=entryIdx; i>=0 && closes.length<60; i-=1) closes.push(bars[i].c);
    closes.reverse();
    const bb = bollinger(closes, 20, 2);
    if (bb) {
      const cand = dir==='long' ? bb.upper : bb.lower;
      if (dir==='long' ? cand > px0 : cand < px0) t2 = cand; // 只在同侧才替换
    }
  } else if (t2mode==='struct') {
    const w = [];
    for (let i=entryIdx-1; i>=0 && w.length<48; i-=16) if (bars[i]) w.push(bars[i]);
    if (w.length >= 2) {
      const hi = Math.max(...w.map(b=>b.h)), lo = Math.min(...w.map(b=>b.l));
      const cand = dir==='long' ? hi : lo;
      if (dir==='long' ? cand > px0 : cand < px0) t2 = cand;
    }
  }
  const t1 = dir==='long' ? px0 + plan.stopDist*T1_MULT : px0 - plan.stopDist*T1_MULT;
  const t1Gain = Math.abs(t1-px0)/px0*100;
  let t1Hit = false, curStop = stop, peak = px0, lastTrail = px0;
  const step = Math.max(atrP*px0/100*1.5, px0*0.005);
  const endTs = bars[entryIdx].ts + HOLD_MS;
  const startI = entryIdx, endI = Math.min(bars.length-1, entryIdx + Math.ceil(HOLD_MS/BAR_MS));
  for (let i = startI+1; i <= endI; i++) {
    const b = bars[i];
    if (b.ts > endTs) break;
    const isLong = dir==='long';
    if (!t1Hit) {
      if ((isLong && b.h >= t1) || (!isLong && b.l <= t1)) {
        t1Hit = true; curStop = px0;
        // 更新峰值后继续
      }
      if ((isLong && b.l <= curStop) || (!isLong && b.h >= curStop)) {
        return { pnl: -Math.abs(curStop-px0)/px0*100, reason:'SL' };
      }
    } else {
      // 追踪：创新高/新低 → 止损上移（1.5×ATR 步长）
      const mv = isLong ? b.h > peak : b.l < peak;
      if (mv) { peak = isLong ? b.h : b.l; lastTrail = isLong ? b.h : b.l; }
      if (isLong && lastTrail - step > curStop) { curStop = lastTrail - step; }
      if (!isLong && lastTrail + step < curStop) { curStop = lastTrail + step; }
      if ((isLong && b.l <= curStop) || (!isLong && b.h >= curStop)) {
        const restPnl = Math.abs(curStop-px0)/px0*100;
        return { pnl: 0.6*t1Gain + 0.4*(curStop===px0?0:restPnl), reason:'trail' };
      }
      if ((isLong && b.h >= t2) || (!isLong && b.l <= t2)) {
        const t2Gain = Math.abs(t2-px0)/px0*100;
        return { pnl: 0.6*t1Gain + 0.4*t2Gain, reason:'T2' };
      }
    }
  }
  // 超时
  const lastPx = bars[endI].c;
  const p = (dir==='long'?1:-1)*(lastPx-px0)/px0*100;
  const pnl = t1Hit ? 0.6*t1Gain + 0.4*(p>0?p:0) : p;
  return { pnl, reason:'timeout' };
}

function stats(results) {
  const wins = results.filter(r=>r.pnl>0), losses = results.filter(r=>r.pnl<=0);
  const wr = results.length? wins.length/results.length : 0;
  const avgW = wins.length? wins.reduce((s,r)=>s+r.pnl,0)/wins.length : 0;
  const avgL = losses.length? losses.reduce((s,r)=>s+r.pnl,0)/losses.length : 0;
  const E = results.length? results.reduce((s,r)=>s+r.pnl,0)/results.length : 0;
  return { n: results.length, wr: (wr*100).toFixed(1)+'%', avgW: avgW.toFixed(2)+'%', avgL: avgL.toFixed(2)+'%', E: E.toFixed(3)+'%' };
}

async function main() {
  const barsMap = {};
  for (const s of SYMS) {
    try { barsMap[s] = await fetchKlines({db}, s, '15m', DAYS); console.log(s, 'bars:', barsMap[s].length); }
    catch(e){ console.log(s, 'fetch ERR', e.message); }
  }
  // ---- 合成信号：每4h评估动量突破 ----
  const results = { cur: [], boll: [], struct: [] };
  for (const s of SYMS) {
    const bars = barsMap[s]; if (!bars || bars.length < 400) continue;
    for (let i = 320; i < bars.length-1; i += 16) {
      const closes = []; for (let j=i;j>=0 && closes.length<24;j-=16) closes.push(bars[j].c);
      if (closes.length < 24) continue;
      const c = bars[i].c, s20 = sma(closes,20);
      if (!s20) continue;
      const prior = closes.slice(1, 21); // 前20个4h收盘
      const hi = Math.max(...prior), lo = Math.min(...prior);
      const chg4h = (c - closes[1])/closes[1]*100;
      let dir = null;
      if (c > s20 && c > hi && chg4h > 0.5) dir = 'long';
      else if (c < s20 && c < lo && chg4h < -0.5) dir = 'short';
      if (!dir) continue;
      // 冷却：同向6h内不重复（12根15m）
      const cd = 12;
      const lastLong = results.cur.filter(r=>r.sym===s && r.dir==='long' && r.entryIdx>=i-cd).length;
      const lastShort = results.cur.filter(r=>r.sym===s && r.dir==='short' && r.entryIdx>=i-cd).length;
      if (dir==='long' ? lastLong>0 : lastShort>0) continue;
      for (const mode of ['cur','boll','struct']) {
        const r = simulate(bars, i, dir, { t2mode: mode==='cur'?null:mode });
        results[mode].push({ sym:s, dir, entryIdx:i, pnl:r.pnl, reason:r.reason });
      }
    }
  }
  console.log('\n======== 合成信号（4h动量突破，8币种，45天）========');
  for (const mode of ['cur','boll','struct']) {
    const st = stats(results[mode]);
    console.log(mode.padEnd(6), 'n='+String(st.n).padStart(4), '胜率', st.wr, '| avgW', st.avgW, '| avgL', st.avgL, '| E/单', st.E);
  }
  // ---- 真实信号回放（signal_track 已了结）----
  console.log('\n======== 真实 tianji 信号回放（17单已了结）========');
  const rows = db.prepare("SELECT symbol,direction,entry,pushed_at FROM signal_track WHERE strategy='TIANJI' AND status IN ('WIN','LOSS','FLAT') ORDER BY pushed_at").all();
  const real = { cur: [], boll: [], struct: [] };
  for (const r of rows) {
    const bars = barsMap[r.symbol]; if (!bars) continue;
    // 找入场对应bar（pushed_at 就近）
    let idx = bars.findIndex(b => b.ts >= r.pushed_at - 10*60*1000);
    if (idx < 0) continue;
    for (const mode of ['cur','boll','struct']) {
      const sim = simulate(bars, idx, r.direction, { t2mode: mode==='cur'?null:mode });
      real[mode].push({ sym:r.symbol, dir:r.direction, pnl:sim.pnl, reason:sim.reason });
    }
  }
  for (const mode of ['cur','boll','struct']) {
    const st = stats(real[mode]);
    console.log(mode.padEnd(6), 'n='+String(st.n).padStart(4), '胜率', st.wr, '| avgW', st.avgW, '| avgL', st.avgL, '| E/单', st.E);
  }
  // 明细（真实信号，三模式并排）
  console.log('\n真实信号逐单明细 (E%=cur/boll/struct):');
  real.cur.forEach((r,i)=>console.log(
    r.sym.padEnd(5), r.dir.padEnd(5),
    'cur='+r.pnl.toFixed(2)+'%'.padStart(7),
    'boll='+real.boll[i].pnl.toFixed(2)+'%'.padStart(7),
    'struct='+real.struct[i].pnl.toFixed(2)+'%'.padStart(7),
    '('+r.reason+'/'+real.boll[i].reason+'/'+real.struct[i].reason+')'));
}

main().catch(e=>{ console.error('FATAL', e); process.exit(1); });
