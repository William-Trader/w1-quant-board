'use strict';
// 三口径统一对比（2026-08-11）：同一批备份信号（统一引擎输出），三种结算口径
// A 旧口径(14天收盘+亏损封顶) | B 对称盈亏(14天收盘扛单) | C 真实持仓(逐bar止损/爆仓/双边费)
const fs = require('fs');
const Database = require('/home/ubuntu/w1-board/node_modules/better-sqlite3');
const { settleTrade, FEE, SLIP } = require('/home/ubuntu/w1-board/scripts/experience/honest_settle.js');

const DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const BACKUP = '/home/ubuntu/w1-board/public/experience.json.bak-audit-20260811';
const PRINCIPAL = 10000, LEVER = 100;
const db = new Database(DB, { readonly: true });
const allBars = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();

function atrAt(freezeMs) {
  const closes = [];
  for (let i = allBars.length - 1; i >= 0 && closes.length < 15; i--) if (allBars[i].ts < freezeMs) closes.push(allBars[i].c);
  closes.reverse();
  return closes.length >= 2 ? Math.abs(closes[closes.length - 1] - closes[closes.length - 2]) : null;
}
function buildOrder(r, freezeMs) {
  const price = r.price, label = r.label;
  const dir = label.includes('多') ? 'long' : label.includes('空') ? 'short' : null;
  if (!dir || !r.pos || r.pos <= 0) return null;
  const atr = atrAt(freezeMs) || price * 0.01;
  const stopMult = r.pos >= 8 ? 2.0 : r.pos >= 3 ? 1.5 : 1.2;
  const stopDist = Math.max(atr * stopMult, price * 0.008);
  const fgiDisc = r.fgi != null ? (r.fgi <= 20 ? 0.3 : r.fgi <= 30 ? 0.5 : r.fgi <= 45 ? 0.7 : 1) : 1;
  const posPct = Math.min(12, Math.max(0, Math.round(r.pos * fgiDisc * 100) / 100));
  let entry, stop, t1, t2;
  if (dir === 'long') { entry = price; stop = price - stopDist; t1 = entry + stopDist * 1.5; t2 = entry + stopDist * 2.5; }
  else { entry = price; stop = price + stopDist; t1 = entry - stopDist * 1.5; t2 = entry - stopDist * 2.5; }
  return { dir, entry, stop, t1, t2, posPct };
}

const data = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
const rows = [];
for (const r of data.results) {
  const freeze = new Date(r.date + 'T23:59:59+08:00').getTime();
  const startTs = freeze + 3600000;
  const bars = allBars.filter(b => b.ts > startTs && b.ts <= freeze + 15 * 86400000);
  const p14 = bars.length ? bars[bars.length - 1].c : null;
  const dir = r.label.includes('多') ? 'long' : r.label.includes('空') ? 'short' : null;
  const pos = r.pos || 0;
  const chg14 = p14 != null ? (p14 / r.price - 1) * 100 : null;

  // A 旧口径（复现作弊公式；观望=命中）
  let pnlA = 0, hitA = true;
  if (pos > 0 && dir && chg14 != null) {
    const dr = dir === 'long' ? 1 : -1;
    pnlA = Math.round(dr * pos * chg14 * 100);
    hitA = dr * chg14 > 0;
    if (!hitA) pnlA = -Math.min(Math.abs(pnlA), pos * 100);
  }
  // B 对称盈亏（扛单14天，双边费）
  let pnlB = 0, hitB = null;
  if (pos > 0 && dir && chg14 != null) {
    const notional = PRINCIPAL * pos / 100 * LEVER;
    const move = (dir === 'long' ? 1 : -1) * chg14 / 100;
    pnlB = Math.round(notional * move - notional * (2 * FEE + SLIP));
    hitB = move > 0;
  }
  // C 真实持仓
  const ord = buildOrder(r, freeze);
  let pnlC = 0, hitC = null, stC = null;
  if (ord && bars.length) {
    stC = settleTrade({ entry: ord.entry, dir: ord.dir, stop: ord.stop, t1: ord.t1, t2: ord.t2, bars, leverage: LEVER, posPct: ord.posPct, equity: PRINCIPAL });
    pnlC = stC.pnlUsd; hitC = stC.pnlUsd > 0;
  }
  rows.push({ date: r.date, label: r.label, pos, dir: dir || 'flat', chg14, pnlA, hitA, pnlB, hitB, pnlC, hitC, stC });
}

function stats(rows, kPnl, kHit) {
  const t = rows.filter(x => x.pos > 0 && x[kPnl] !== null);
  const wins = t.filter(x => x[kHit] === true), losses = t.filter(x => x[kHit] === false);
  const gp = wins.reduce((s, x) => s + x[kPnl], 0), gl = Math.abs(losses.reduce((s, x) => s + x[kPnl], 0));
  let peak = PRINCIPAL, eq = PRINCIPAL, mdd = 0;
  for (const x of t) { eq += x[kPnl]; if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
  return {
    trades: t.length,
    winRate: t.length ? Math.round(wins.length / t.length * 1000) / 10 : 0,
    net: Math.round(t.reduce((s, x) => s + x[kPnl], 0)),
    pf: gl > 0 ? Math.round(gp / gl * 100) / 100 : (gp > 0 ? 99 : 0),
    avgWin: wins.length ? Math.round(wins.reduce((s, x) => s + x[kPnl], 0) / wins.length) : 0,
    avgLoss: losses.length ? Math.round(losses.reduce((s, x) => s + x[kPnl], 0) / losses.length) : 0,
    mdd: Math.round(mdd)
  };
}
const sA = stats(rows, 'pnlA', 'hitA');
const sB = stats(rows, 'pnlB', 'hitB');
const sC = stats(rows, 'pnlC', 'hitC');

// A 口径含观望=命中时的"总准确率"（复现原展示口径）
const aAll = rows.filter(x => x.hitA === true).length;
const aAcc = Math.round(aAll / rows.length * 100);
const stMap = {};
for (const x of rows) if (x.stC) stMap[x.stC.reason] = (stMap[x.stC.reason] || 0) + 1;

console.log('='.repeat(74));
console.log('三口径统一对比（同一批信号 = 备份的统一引擎输出，129场）');
console.log('本金 10000U · 杠杆 100x · 双边费 0.05%×2 + 滑点 0.02% · 逐1H bar');
console.log('='.repeat(74));
console.log(`A 旧口径(14天收盘+亏损封顶): 交易${sA.trades} 胜率${sA.winRate}% 净${sA.net}U PF${sA.pf} 均盈${sA.avgWin}/均亏${sA.avgLoss} 回撤${sA.mdd}`);
console.log(`   ├ 含观望=命中的展示口径: 命中 ${aAll}/${rows.length} = ${aAcc}% 准确率（原战绩展示方式）`);
console.log(`B 对称盈亏(14天收盘扛单)  : 交易${sB.trades} 胜率${sB.winRate}% 净${sB.net}U PF${sB.pf} 均盈${sB.avgWin}/均亏${sB.avgLoss} 回撤${sB.mdd}`);
console.log(`C 真实持仓(逐bar止损/爆仓): 交易${sC.trades} 胜率${sC.winRate}% 净${sC.net}U PF${sC.pf} 均盈${sC.avgWin}/均亏${sC.avgLoss} 回撤${sC.mdd}`);
console.log('='.repeat(74));
console.log('C口径出场分布:', JSON.stringify(stMap));
console.log('观望场(不计命中):', rows.filter(x => x.pos === 0).length);

const out = { generated: new Date().toISOString().slice(0, 10), principal: PRINCIPAL, leverage: LEVER,
  stats: { old: sA, old_display_acc: aAcc, symmetric_close: sB, honest: sC }, exits: stMap,
  detail: rows.map(x => ({ date: x.date, label: x.label, pos: x.pos, dir: x.dir, pnlA: x.pnlA, pnlB: x.pnlB, pnlC: x.pnlC, status: x.stC ? x.stC.status : null, reason: x.stC ? x.stC.reason : null, exitPx: x.stC ? x.stC.exitPx : null, rr: x.stC ? x.stC.rr : null })) };
fs.writeFileSync('/home/ubuntu/w1-board/data/honest_backtest.json', JSON.stringify(out, null, 1));
console.log('\n✅ 统一对比明细已存 data/honest_backtest.json');
