'use strict';
// ============================================================
// 严谨回测重放 v1（2026-08-11 · William 老板审计指令）
// 对 experience.json 全部已结算场次，用三种口径重算对比：
//   A. 旧口径(14天收盘+亏损封顶)      —— 复现原作弊
//   B. 对称盈亏(14天收盘, 不封顶+费)   —— 隔离"封顶"效应
//   C. 真实持仓(逐bar止损/爆仓/止盈+费) —— 严谨版
// 信号生成完全一致：experience_engine.analyze(freeze)+judge
// ============================================================
const fs = require('fs');
const Database = require('better-sqlite3');
const eng = require('/home/ubuntu/w1-board/lib/experience_engine.js');
const { settleTrade, FEE, SLIP } = require('/home/ubuntu/w1-board/scripts/experience/honest_settle.js');

const DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const EX = '/home/ubuntu/w1-board/public/experience.json';
const LEVER = 100, PRINCIPAL = 10000;

const db = new Database(DB, { readonly: true });
const data = JSON.parse(fs.readFileSync(EX, 'utf8'));

function dateToFreeze(d) { return new Date(d + 'T23:59:59+08:00').getTime(); }

// 取 freeze 之后 N 天的 1H bars（hist.db klines ts 为毫秒）
function barsAfter(freezeMs, days = 15) {
  const end = freezeMs + days * 86400000;
  return db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' AND ts>? AND ts<=? ORDER BY ts").all(freezeMs, end);
}

// 用冻结时点数据重算订单（修复 buildOrder 用 Date.now() 的 bug）
function orderAt(freezeMs, a, j, symbol) {
  const price = a.price;
  const dir = eng.directionOf(j.label);
  if (!dir || j.pos <= 0) return null;
  const rows = db.prepare(`
    SELECT date(ts/1000,'unixepoch','+8 hours') d,
           (SELECT c FROM klines k2 WHERE k2.symbol=k1.symbol AND k2.ts=(SELECT MAX(ts) FROM klines k3 WHERE k3.symbol=k1.symbol AND date(k3.ts/1000,'unixepoch','+8 hours')=date(k1.ts/1000,'unixepoch','+8 hours'))) c
    FROM klines k1 WHERE symbol='BTCUSDT' AND ts < ? GROUP BY d ORDER BY d DESC LIMIT 15
  `).all(freezeMs);
  const closes = rows.map(r => r.c).reverse();
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

const rows = [];
for (let ri = 0; ri < data.results.length; ri++) {
  const r = data.results[ri];
  if (ri % 10 === 0) console.error(`[进度] ${ri}/${data.results.length}...`);
  if (r.hit === null || r.pnl === undefined) continue;   // 只算已结算
  const freeze = dateToFreeze(r.date);
  const a = eng.analyze(freeze);
  const j = eng.judge(a);
  const dir = eng.directionOf(j.label);
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

// ===== 汇总对比 =====
function sum(arr, key, filter) { return arr.filter(x => filter(x)).reduce((s, x) => s + (x[key] || 0), 0); }
function stats(rows, keyPnl, keyHit) {
  const t = rows.filter(x => x[keyPnl] !== null && x[keyPnl] !== undefined && x.pos > 0);
  const wins = t.filter(x => x[keyHit] === true);
  const losses = t.filter(x => x[keyHit] === false);
  const gp = wins.reduce((s, x) => s + x[keyPnl], 0), gl = Math.abs(losses.reduce((s, x) => s + x[keyPnl], 0));
  let peak = PRINCIPAL, eq = PRINCIPAL, mdd = 0;
  for (const x of t) { eq += x[keyPnl]; if (eq > peak) peak = eq; mdd = Math.max(mdd, peak - eq); }
  return {
    trades: t.length, winRate: t.length ? Math.round(wins.length / t.length * 1000) / 10 : 0,
    net: Math.round(t.reduce((s, x) => s + x[keyPnl], 0)),
    pf: gl > 0 ? Math.round(gp / gl * 100) / 100 : (gp > 0 ? 99 : 0),
    maxWin: t.length ? Math.max(...t.map(x => x[keyPnl])) : 0,
    maxLoss: t.length ? Math.min(...t.map(x => x[keyPnl])) : 0,
    mdd: Math.round(mdd), avgWin: wins.length ? Math.round(wins.reduce((s,x)=>s+x[keyPnl],0)/wins.length) : 0,
    avgLoss: losses.length ? Math.round(losses.reduce((s,x)=>s+x[keyPnl],0)/losses.length) : 0
  };
}
const sA = stats(rows, 'pnlA', 'hitA');
const sB = stats(rows, 'pnlB', 'hitB');
const sC = stats(rows, 'pnlC', 'hitC');

console.log('='.repeat(70));
console.log('严谨回测重放对比（同一批信号，三种结算口径）');
console.log('样本: 已结算场次 ' + rows.length + '（其中持仓场次 ' + rows.filter(x=>x.pos>0).length + '，观望 ' + rows.filter(x=>x.pos===0).length + '）');
console.log('本金 10000U · 杠杆 100x · 费 0.05%×2+滑点 0.02%');
console.log('='.repeat(70));
console.log(`A. 旧口径(收盘+封顶)      : 交易${sA.trades} 胜率${sA.winRate}% 净${sA.net}U PF${sA.pf} 最大盈${sA.maxWin} 最大亏${sA.maxLoss} 回撤${sA.mdd}`);
console.log(`B. 对称盈亏(收盘扛单)      : 交易${sB.trades} 胜率${sB.winRate}% 净${sB.net}U PF${sB.pf} 最大盈${sB.maxWin} 最大亏${sB.maxLoss} 回撤${sB.mdd}`);
console.log(`C. 真实持仓(止损/爆仓)     : 交易${sC.trades} 胜率${sC.winRate}% 净${sC.net}U PF${sC.pf} 最大盈${sC.maxWin} 最大亏${sC.maxLoss} 回撤${sC.mdd}`);
console.log('='.repeat(70));
console.log('\nC口径 爆仓/止损明细:');
const stMap = {};
for (const x of rows) if (x.stC) stMap[x.stC.status] = (stMap[x.stC.status] || 0) + 1;
console.log(' ', JSON.stringify(stMap));
console.log('\nC口径 逐场（前40场，pnlC≠0 的）:');
let shown = 0;
for (const x of rows) {
  if (shown >= 40) break;
  if (x.pnlC === 0 && x.pos === 0) continue;
  const st = x.stC ? `${x.stC.reason}@${x.stC.exitPx}` : 'flat';
  console.log(`  ${x.date} ${x.label} pos${x.pos} ${x.dir} → ${st} pnl=${x.pnlC > 0 ? '+' : ''}${x.pnlC}U rr=${x.stC ? x.stC.rr : '-'}`);
  shown++;
}

// 保存 C 口径全量明细
const out = { generated: new Date().toISOString(), principal: PRINCIPAL, leverage: LEVER,
  stats: { old: sA, symmetric_close: sB, honest: sC }, detail: rows.map(x => ({
    date: x.date, label: x.label, pos: x.pos, dir: x.dir,
    pnlA: x.pnlA, pnlB: x.pnlB, pnlC: x.pnlC, status: x.stC ? x.stC.status : null, reason: x.stC ? x.stC.reason : null, exitPx: x.stC ? x.stC.exitPx : null, rr: x.stC ? x.stC.rr : null
  })) };
fs.writeFileSync('/home/ubuntu/w1-board/data/honest_backtest.json', JSON.stringify(out, null, 1));
console.log('\n明细已存: data/honest_backtest.json');
