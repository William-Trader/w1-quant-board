'use strict';
// W1 v4 中低频方向系统回测（2024-01 → 2026-08）
// 纪律：信号只看截止时点数据；每笔按 1H bar 级结算 LIQ→SL→TP2→TP1（不利事件优先）
const Database = require('better-sqlite3');
const eng = require('../lib/direction_engine');
const HIST = '/home/ubuntu/btc-oracle/backtest/hist.db';
const db = new Database(HIST, { readonly: true });
const REAL = 10000, VIRTUAL = 50000, FEE = 0.0005, SLIP = 0.0002;

// 取每日收盘时点（UTC+8 自然日）
const days = db.prepare(`
  SELECT date(ts/1000,'unixepoch','+8 hours') d, MAX(ts) ts
  FROM klines WHERE symbol='BTCUSDT' GROUP BY d ORDER BY d
`).all();

// 1H bars 快速索引
const h1 = db.prepare("SELECT ts,o,h,l,c FROM klines WHERE symbol='BTCUSDT' AND ts>=? AND ts<? ORDER BY ts").all;
const barIdx = db.prepare("SELECT ts,o,h,l,c FROM klines WHERE symbol='BTCUSDT' AND ts>=? AND ts<? ORDER BY ts");

let equity = REAL;
const trades = [];
let skipped = 0, held = null;   // held = 当前持仓

function settleTrade(t, lastBar) {
  // 入场后到 lastBar 之间的 1H bar 结算
  const entry = t.entry, dir = t.direction === 'long' ? 1 : -1;
  const bars = barIdx.all(t.entryTs, lastBar.ts + 1);
  const margin = t.margin, notional = t.notional;
  let exit = null;
  for (const b of bars) {
    // 不利事件优先：爆仓 → 止损 → 止盈2 → 止盈1
    if (dir > 0) {
      if (b.l <= t.liqPx) { exit = { reason: 'LIQ', px: t.liqPx, pnl: -margin, ts: b.ts }; break; }
      if (b.l <= t.stop) { exit = { reason: 'SL', px: t.stop, pnl: -notional * (t.stop - entry) / entry - notional * (FEE + SLIP), ts: b.ts }; break; }
      if (b.h >= t.t2) { exit = { reason: 'TP2', px: t.t2, pnl: notional * (t.t2 - entry) / entry - notional * (FEE + SLIP), ts: b.ts }; break; }
      if (b.h >= t.t1) { exit = { reason: 'TP1', px: t.t1, pnl: notional * (t.t1 - entry) / entry - notional * (FEE + SLIP), ts: b.ts }; break; }
    } else {
      if (b.h >= t.liqPx) { exit = { reason: 'LIQ', px: t.liqPx, pnl: -margin, ts: b.ts }; break; }
      if (b.h >= t.stop) { exit = { reason: 'SL', px: t.stop, pnl: -notional * (entry - t.stop) / entry - notional * (FEE + SLIP), ts: b.ts }; break; }
      if (b.l <= t.t2) { exit = { reason: 'TP2', px: t.t2, pnl: notional * (entry - t.t2) / entry - notional * (FEE + SLIP), ts: b.ts }; break; }
      if (b.l <= t.t1) { exit = { reason: 'TP1', px: t.t1, pnl: notional * (entry - t.t1) / entry - notional * (FEE + SLIP), ts: b.ts }; break; }
    }
  }
  if (!exit) {
    // 超时：14 天最后收盘价平仓
    const px = lastBar.c;
    const movePct = dir > 0 ? (px - entry) / entry : (entry - px) / entry;
    exit = { reason: 'TIMEOUT', px, pnl: notional * movePct - notional * (FEE + SLIP), ts: lastBar.ts };
  }
  return exit;
}

// 主循环：每日收盘扫描（中低频）
const START = Date.parse('2024-01-10T00:00:00+08:00');
for (const day of days) {
  const freeze = day.ts;
  if (freeze < START) continue;
  if (held) {
    // 结算持仓：最多持有14天
    const maxHold = held.entryTs + 14 * 86400000;
    if (freeze >= maxHold || day.ts - held.entryTs >= 14 * 86400000) {
      const last = barIdx.get(freeze - 3600000, freeze + 1); // last bar <= freeze
      const lastBar = last && last.length ? last[last.length - 1] : null;
      const ex = settleTrade(held, lastBar || { c: held.entry, ts: freeze });
      equity += ex.pnl;
      held.exit = ex; held.pnl = +ex.pnl.toFixed(2); held.equity = +equity.toFixed(2);
      trades.push(held); held = null;
    }
  }
  // 无持仓 → 扫描新信号
  if (!held) {
    const sig = eng.signalAt(freeze);
    if (!sig) { skipped++; continue; }
    if (sig.direction) {
      const posPctReal = sig.pos_pct * VIRTUAL / REAL / 100; // 实际占用真实账户比例
      const margin = equity * Math.min(posPctReal, 0.9);
      const ord = eng.buildOrder(sig.price, sig.direction, { stop_dist_pct: sig.stop_dist_pct, liq_px_off: sig.liq_px_off });
      held = {
        entryTs: freeze, date: sig.date, price: sig.price, direction: sig.direction,
        label: sig.label, score: sig.score, regime: sig.regime, fgi: sig.fgi,
        entry: ord.entry, stop: ord.stop, t1: ord.t1, t2: ord.t2, liqPx: ord.liqPx,
        margin: +margin.toFixed(2), notional: +(margin * sig.eff_leverage).toFixed(2),
        pos_pct: sig.pos_pct, eff_lev: sig.eff_leverage, reasons: sig.reasons.slice(0, 4)
      };
    } else skipped++;
  }
}
// 收尾：平掉最后持仓
if (held) {
  const last = barIdx.get(held.entryTs, Date.now());
  const lastBar = last[last.length - 1];
  const ex = settleTrade(held, lastBar);
  equity += ex.pnl;
  held.exit = ex; held.pnl = +ex.pnl.toFixed(2); held.equity = +equity.toFixed(2);
  trades.push(held); held = null;
}

// ---- 指标 ----
const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0), flats = trades.filter(t => t.pnl === 0);
const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
let peak = REAL, mdd = 0;
for (const t of trades) { peak = Math.max(peak, t.equity); mdd = Math.max(mdd, peak - t.equity); }
const daysTotal = (Date.now() - Date.parse('2024-01-10T00:00:00+08:00')) / 86400000;
const years = daysTotal / 365;
const cagr = years > 0 ? (Math.pow(equity / REAL, 1 / years) - 1) * 100 : 0;
const liqCount = trades.filter(t => t.exit.reason === 'LIQ').length;
const exitDist = {};
for (const t of trades) exitDist[t.exit.reason] = (exitDist[t.exit.reason] || 0) + 1;

console.log('========== W1 v4 中低频方向系统回测 ==========');
console.log(`区间: 2024-01-10 → 2026-08-11 (${daysTotal.toFixed(0)}天)`);
console.log(`扫描日: ${days.length} | 信号: ${trades.length} 笔 | 观望跳过: ${skipped}`);
console.log(`胜率: ${wins.length}/${trades.length} = ${(wins.length / trades.length * 100).toFixed(1)}% (盈亏平:${flats.length})`);
console.log(`净盈亏: ${equity > REAL ? '+' : ''}${(equity - REAL).toFixed(0)}U | 期末权益: ${equity.toFixed(0)}U`);
console.log(`盈亏比(PF): ${pf.toFixed(2)} | 年化: ${cagr.toFixed(1)}% | 最大回撤: ${mdd.toFixed(0)}U (${(mdd / REAL * 100).toFixed(1)}%)`);
console.log(`均盈: ${(grossWin / Math.max(wins.length,1)).toFixed(0)}U | 均亏: ${(-grossLoss / Math.max(losses.length,1)).toFixed(0)}U`);
console.log(`出场分布: ${JSON.stringify(exitDist)} (爆仓${liqCount})`);
console.log(`方向: 多${trades.filter(t=>t.direction==='long').length} 空${trades.filter(t=>t.direction==='short').length}`);
console.log('--- 最近 12 笔 ---');
for (const t of trades.slice(-12)) {
  console.log(`${t.date} ${t.direction==='long'?'多':'空'} score${t.score} ${t.regime} pos${t.pos_pct}% → ${t.exit.reason} ${t.pnl > 0 ? '+' : ''}${t.pnl}U (权益${t.equity})`);
}
