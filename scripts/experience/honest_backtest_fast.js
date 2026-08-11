'use strict';
// 内存版严谨回测（修复 SQL 逐场查询性能问题）
const fs = require('fs');
const Database = require('/home/ubuntu/w1-board/node_modules/better-sqlite3');
const { settleTrade, FEE, SLIP } = require('/home/ubuntu/w1-board/scripts/experience/honest_settle.js');

const DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const EX = '/home/ubuntu/w1-board/public/experience.json';
const LEVER = 100, PRINCIPAL = 10000;
const db = new Database(DB, { readonly: true });

// ===== 一次性加载全量 1H bars =====
const allBars = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
console.log('全量bars:', allBars.length);
const barIdx = new Map(allBars.map((b, i) => [b.ts, i]));

// ===== 日线聚合（与 analyze SQL 同口径：取每日收盘=当日最后一根bar收盘）=====
const dayMap = new Map(); // 'YYYY-MM-DD' -> {d, c, o, h, l, v}
const dayArr = [];
for (const b of allBars) {
  const d = new Date(b.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  let g = dayMap.get(d);
  if (!g) { g = { d, o: b.o, h: b.h, l: b.l, c: b.c, v: 0 }; dayMap.set(d, g); dayArr.push(g); }
  g.h = Math.max(g.h, b.h); g.l = Math.min(g.l, b.l); g.c = b.c; g.v += b.v;
}
console.log('日线bars:', dayArr.length);

// ===== 指标函数（与 experience_engine 一致）=====
function sma(vals, n) { if (vals.length < n) return null; return vals.slice(-n).reduce((a, b) => a + b, 0) / n; }
function rsiOf(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) { const chg = closes[i] - closes[i - 1]; if (chg >= 0) g += chg; else l -= chg; }
  if (l === 0) return 100.0;
  return 100 - 100 / (1 + (g / n) / (l / n));
}
function emaArr(v, n) { const k = 2 / (n + 1); let e = v[0]; const out = [e]; for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); out.push(e); } return out; }
function macdOf(closes, f = 12, s = 26, sig = 9) {
  if (closes.length < s + sig) return null;
  const ef = emaArr(closes, f), es = emaArr(closes, s);
  const dif = ef.map((a, i) => a - es[i]);
  const dea = emaArr(dif, sig);
  return (dif[dif.length - 1] - dea[dea.length - 1]) * 2;
}
function bollOf(closes, n = 20) {
  if (closes.length < n) return [null, null];
  const seg = closes.slice(-n); const mid = seg.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(seg.reduce((a, x) => a + (x - mid) ** 2, 0) / n);
  return [mid + 2 * sd, mid - 2 * sd];
}

// ===== 冻结时点指标（内存版，等价 analyze）=====
function analyzeAt(freezeMs) {
  const idx = dayArr.findIndex(g => new Date(g.d + 'T23:59:59+08:00').getTime() >= freezeMs);
  const days = dayArr.slice(0, idx);   // 严格 < freeze
  if (days.length < 40) return null;
  const closes = days.map(g => g.c);
  const last = days[days.length - 1];
  const price = last.c;
  const r = rsiOf(closes);
  const hist = macdOf(closes);
  const s7 = sma(closes, 7), s25 = sma(closes, 25), s99 = sma(closes, 99);
  const [bu, bl] = bollOf(closes);
  const mom5 = closes.length >= 6 ? (price / closes[closes.length - 6] - 1) * 100 : null;
  const mom20 = closes.length >= 21 ? (price / closes[closes.length - 21] - 1) * 100 : null;
  const lo20 = Math.min(...closes.slice(-20)), hi20 = Math.max(...closes.slice(-20));
  const pos20 = hi20 > lo20 ? (price - lo20) / (hi20 - lo20) * 100 : 50;
  const v5rows = days.slice(-6, -1);
  const v5 = v5rows.length >= 5 ? v5rows.reduce((a, b) => a + b.v, 0) / 5 : (last.v || 0);
  const volr = v5 ? last.v / v5 : 1.0;
  const fgiRow = db.prepare('SELECT value FROM fgi WHERE ts < ? ORDER BY ts DESC LIMIT 1').get(Math.floor(freezeMs / 1000));
  const fndRow = db.prepare('SELECT rate FROM funding WHERE ts < ? ORDER BY ts DESC LIMIT 1').get(freezeMs);
  return { date: last.d, price, rsi: r, macd_hist: hist, s7, s25, s99, boll_up: bu, boll_lo: bl, mom5, mom20, pos20, volr, fgi: fgiRow ? fgiRow.value : null, funding: fndRow ? fndRow.rate : null };
}
function judge(a) {
  if (!a) return null;
  let score = 0; const reasons = [];
  const p = a.price;
  if (a.rsi !== null && a.rsi !== undefined) { if (a.rsi < 25) score += 2.0; else if (a.rsi < 30) score += 1.5; else if (a.rsi > 80) score -= 2.0; else if (a.rsi > 70) score -= 1.5; }
  if (a.macd_hist !== null && a.macd_hist !== undefined) score += a.macd_hist > 0 ? 1.5 : -1.5;
  if (a.s7 && a.s25 && a.s99) { if (a.s7 > a.s25 && a.s25 > a.s99) score += 1.0; else if (a.s7 < a.s25 && a.s25 < a.s99) score -= 1.0; }
  if (a.boll_up && a.boll_lo) { if (p > a.boll_up) score -= 1.0; else if (p < a.boll_lo) score += 1.0; }
  if (a.mom20 !== null && a.mom20 !== undefined) { if (a.mom20 < -10) score += 1.0; else if (a.mom20 > 10) score -= 1.0; }
  if (a.volr !== null && a.volr !== undefined) { if (a.volr > 1.6 && a.mom5 !== null && a.mom5 < 0) score -= 1.0; else if (a.volr > 1.6 && a.mom5 !== null && a.mom5 > 0) score += 1.0; }
  if (a.fgi !== null && a.fgi !== undefined) { if (a.fgi < 20) score += 2.0; else if (a.fgi < 30) score += 1.0; else if (a.fgi > 85) score -= 2.0; else if (a.fgi > 70) score -= 1.0; }
  let label, pos;
  if (score >= 3.0) { label = '🚀 强烈看多'; pos = 12; } else if (score >= 2.0) { label = '📈 看多'; pos = 8; }
  else if (score >= 1.0) { label = '↗️ 谨慎看多'; pos = 3; } else if (score > 0.3) { label = '↗️ 中性偏多'; pos = 0; }
  else if (score >= -0.3) { label = '⚡ 中性震荡'; pos = 0; } else if (score >= -1.0) { label = '↘️ 中性偏空'; pos = 0; }
  else if (score >= -2.0) { label = '↘️ 谨慎看空'; pos = 3; } else if (score >= -3.0) { label = '📉 看空'; pos = 8; }
  else { label = '🛑 强烈看空'; pos = 12; }
  return { score: Math.round(score * 100) / 100, label, pos, reasons };
}
function directionOf(label) { if (label.includes('多')) return 'long'; if (label.includes('空')) return 'short'; return null; }

// ===== 订单计划（冻结时点口径，等价 orderAt）=====
function orderAt(freezeMs, a, j) {
  const price = a.price; const dir = directionOf(j.label);
  if (!dir || j.pos <= 0) return null;
  const idx = dayArr.findIndex(g => new Date(g.d + 'T23:59:59+08:00').getTime() >= freezeMs);
  const closes = dayArr.slice(Math.max(0, idx - 15), idx).map(g => g.c);
  const atr = closes.length >= 2 ? Math.abs(closes[closes.length - 1] - closes[closes.length - 2]) : price * 0.01;
  const stopMult = j.pos >= 8 ? 2.0 : j.pos >= 3 ? 1.5 : 1.2;
  const stopDist = Math.max(atr * stopMult, price * 0.008);
  const fgiDisc = a.fgi !== null ? (a.fgi <= 20 ? 0.3 : a.fgi <= 30 ? 0.5 : a.fgi <= 45 ? 0.7 : 1) : 1;
  const posPct = Math.min(12, Math.max(0, Math.round(j.pos * fgiDisc * 100) / 100));
  let entry, stop, t1, t2;
  if (dir === 'long') { entry = price; stop = price - stopDist; t1 = entry + stopDist * 1.5; t2 = entry + stopDist * 2.5; }
  else { entry = price; stop = price + stopDist; t1 = entry - stopDist * 1.5; t2 = entry - stopDist * 2.5; }
  return { dir, entry, stop, t1, t2, posPct };
}
function barsAfter(freezeMs, days = 15) {
  const startTs = freezeMs + 3600000;  // 从下一根1H bar开始（不包含冻结点本身，避免用未来K线开单）
  const endTs = freezeMs + days * 86400000;
  return allBars.filter(b => b.ts > startTs && b.ts <= endTs);
}

// ===== 主循环 =====
const data = JSON.parse(fs.readFileSync(EX, 'utf8'));
const rows = [];
for (let ri = 0; ri < data.results.length; ri++) {
  const r = data.results[ri];
  if (r.hit === null || r.pnl === undefined) continue;
  if (ri % 25 === 0) console.error(`[进度] ${ri}/${data.results.length}...`);
  const freeze = new Date(r.date + 'T23:59:59+08:00').getTime();
  const a = analyzeAt(freeze);
  const j = judge(a);
  const dir = directionOf(j.label);
  const bars = barsAfter(freeze);
  const p14 = bars.length ? bars[bars.length - 1].c : null;

  // A. 旧口径复现
  let pnlA = null, hitA = null;
  if (r.chg14 != null) {
    const chg = r.chg14;
    if (j.pos > 0 && dir) {
      const dr = dir === 'long' ? 1 : -1;
      pnlA = Math.round(dr * j.pos * chg * 100);
      hitA = dr * chg > 0;
      if (!hitA) pnlA = -Math.min(Math.abs(pnlA), j.pos * 100);
    } else { pnlA = 0; hitA = true; }
  }
  // B. 对称盈亏（扛单 14 天收盘）
  let pnlB = 0, hitB = null;
  if (j.pos > 0 && dir && p14 != null) {
    const chg = (p14 / a.price - 1) * 100;
    const notional = PRINCIPAL * j.pos / 100 * LEVER;
    const move = (dir === 'long' ? 1 : -1) * chg / 100;
    pnlB = Math.round(notional * move - notional * (2 * FEE + SLIP));
    hitB = move > 0;
  }
  // C. 真实持仓
  const ord = orderAt(freeze, a, j);
  let pnlC = 0, hitC = null, stC = null;
  if (ord && bars.length) {
    stC = settleTrade({ entry: ord.entry, dir: ord.dir, stop: ord.stop, t1: ord.t1, t2: ord.t2, bars, leverage: LEVER, posPct: ord.posPct, equity: PRINCIPAL });
    pnlC = stC.pnlUsd; hitC = stC.pnlUsd > 0;
  }
  rows.push({ date: r.date, label: j.label, pos: j.pos, dir: dir || 'flat', pnlA, hitA, pnlB, hitB, pnlC, hitC, stC });
}

function stats(rows, keyPnl, keyHit) {
  const t = rows.filter(x => x[keyPnl] !== null && x[keyPnl] !== undefined && x.pos > 0);
  const wins = t.filter(x => x[keyHit] === true);
  const losses = t.filter(x => x[keyHit] === false);
  const gp = wins.reduce((s, x) => s + x[keyPnl], 0), gl = Math.abs(losses.reduce((s, x) => s + x[keyPnl], 0));
  let peak = PRINCIPAL, eq = PRINCIPAL, mdd = 0;
  for (const x of t) { eq += x[keyPnl]; if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
  return { trades: t.length, winRate: t.length ? Math.round(wins.length / t.length * 1000) / 10 : 0, net: Math.round(t.reduce((s, x) => s + x[keyPnl], 0)), pf: gl > 0 ? Math.round(gp / gl * 100) / 100 : (gp > 0 ? 99 : 0), maxWin: t.length ? Math.max(...t.map(x => x[keyPnl])) : 0, maxLoss: t.length ? Math.min(...t.map(x => x[keyPnl])) : 0, mdd: Math.round(mdd), avgWin: wins.length ? Math.round(wins.reduce((s,x)=>s+x[keyPnl],0)/wins.length) : 0, avgLoss: losses.length ? Math.round(losses.reduce((s,x)=>s+x[keyPnl],0)/losses.length) : 0 };
}
const sA = stats(rows, 'pnlA', 'hitA');
const sB = stats(rows, 'pnlB', 'hitB');
const sC = stats(rows, 'pnlC', 'hitC');

console.log('='.repeat(72));
console.log('严谨回测重放对比（同一批信号，三种结算口径）');
console.log('样本: 已结算 ' + rows.length + ' 场（持仓 ' + rows.filter(x=>x.pos>0).length + ' · 观望 ' + rows.filter(x=>x.pos===0).length + '）');
console.log('本金 10000U · 杠杆 100x · 双边费 0.05%×2 + 滑点 0.02%');
console.log('='.repeat(72));
console.log(`A 旧口径(14天收盘+亏损封顶): 交易${sA.trades} 胜率${sA.winRate}% 净${sA.net}U PF${sA.pf} 最大盈${sA.maxWin} 最大亏${sA.maxLoss} 回撤${sA.mdd}`);
console.log(`B 对称盈亏(14天收盘扛单)  : 交易${sB.trades} 胜率${sB.winRate}% 净${sB.net}U PF${sB.pf} 最大盈${sB.maxWin} 最大亏${sB.maxLoss} 回撤${sB.mdd}`);
console.log(`C 真实持仓(逐bar止损/爆仓): 交易${sC.trades} 胜率${sC.winRate}% 净${sC.net}U PF${sC.pf} 最大盈${sC.maxWin} 最大亏${sC.maxLoss} 回撤${sC.mdd}`);
console.log('='.repeat(72));
const stMap = {};
for (const x of rows) if (x.stC) stMap[x.stC.status] = (stMap[x.stC.status] || 0) + 1;
console.log('C口径出场分布:', JSON.stringify(stMap));
console.log('\nC口径逐场（有持仓的）:');
for (const x of rows) {
  if (x.pos === 0) continue;
  const st = x.stC ? `${x.stC.reason}@${x.stC.exitPx}` : 'flat';
  console.log(`  ${x.date} ${x.label} pos${x.pos} ${x.dir} → ${st} pnl=${x.pnlC > 0 ? '+' : ''}${x.pnlC}U rr=${x.stC ? x.stC.rr : '-'}`);
}
const out = { generated: new Date().toISOString(), principal: PRINCIPAL, leverage: LEVER, stats: { old: sA, symmetric_close: sB, honest: sC }, detail: rows.map(x => ({ date: x.date, label: x.label, pos: x.pos, dir: x.dir, pnlA: x.pnlA, pnlB: x.pnlB, pnlC: x.pnlC, status: x.stC ? x.stC.status : null, reason: x.stC ? x.stC.reason : null, exitPx: x.stC ? x.stC.exitPx : null, rr: x.stC ? x.stC.rr : null })) };
fs.writeFileSync('/home/ubuntu/w1-board/data/honest_backtest.json', JSON.stringify(out, null, 1));
console.log('\n明细已存: data/honest_backtest.json');
