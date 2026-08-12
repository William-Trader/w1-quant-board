#!/usr/bin/env node
'use strict';
// ============================================================
// 无名 v2 · 大趋势引擎（2026-08-12）
//  - 唐奇安通道突破（海龟式）：突破 55 日高点做多 / 55 日低点做空
//  - 趋势加仓：每涨 0.5×ATR 加一份（最多 3 份），止损跟随最新入场-2×ATR
//  - 离场：跌破 20 日低点（多）/ 突破 20 日高点（空）——让利润奔跑
//  - 硬止损 15% + 1.5x 杠杆（类现货）
// ============================================================
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });

const h1 = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
function emaArr(arr, n) { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; }
function atrArr(bars, n = 14) {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    out[i] = i === 1 ? tr : (out[i - 1] * (n - 1) + tr) / n;
  }
  return out;
}
const d1 = (() => {
  const map = new Map();
  for (const b of h1) {
    const day = new Date(b.ts + 8 * 3600e3).toISOString().slice(0, 10);
    if (!map.has(day)) map.set(day, { ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c });
    else { const d = map.get(day); d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); d.c = b.c; }
  }
  return [...map.values()];
})();
const N = d1.length;
const dc = d1.map(b => b.c);
const atrD = atrArr(d1, 20);
// FGI（恐惧贪婪指数，ts 秒级）
const fgi = db.prepare("SELECT ts, value FROM fgi ORDER BY ts").all();
let fgiIdx = 0;
function fgiAt(ts) { while (fgiIdx + 1 < fgi.length && fgi[fgiIdx + 1].ts * 1000 <= ts) fgiIdx++; return fgi[fgiIdx] ? fgi[fgiIdx].value : 50; }
// 日线 ADX
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
const adxD = adxArr(d1, 14);

function run(cfg) {
  const {
    entry_n = 55, exit_n = 20, atr_add = 0.5, max_add = 3,
    lev = 1.5, hard_stop = 15, cost_bps = 8,
    fgi_hi = 85, fgi_lo = 10, adx_min = 0,
    startTs, endTs
  } = cfg;
  const PRINCIPAL = 10000;
  const startIdx = Math.max(entry_n + 10, d1.findIndex(b => b.ts >= startTs));
  const endIdx = (() => { const k = d1.findIndex(b => b.ts > endTs); return k === -1 ? N : k; })();
  let trades = [], equity = PRINCIPAL, peak = PRINCIPAL, maxDd = 0;
  let pos = null;   // {dir, units:[{px,ts}], stop}
  const curve = cfg.curve || null;

  for (let i = startIdx; i < endIdx; i++) {
    const bar = d1[i];
    const dayStr = new Date(bar.ts).toISOString().slice(0, 10);
    // 唐奇安通道（用 i-1 及之前，避免未来函数）
    let hiN = -Infinity, loN = Infinity;
    for (let k = Math.max(0, i - entry_n); k < i; k++) { if (d1[k].h > hiN) hiN = d1[k].h; if (d1[k].l < loN) loN = d1[k].l; }
    let hiExit = -Infinity, loExit = Infinity;
    for (let k = Math.max(0, i - exit_n); k < i; k++) { if (d1[k].h > hiExit) hiExit = d1[k].h; if (d1[k].l < loExit) loExit = d1[k].l; }
    const at = atrD[i] || bar.c * 0.02;

    if (!pos) {
      const fv = fgiAt(bar.ts);
      const adxv = adxD[i] || 0;
      let dir = null;
      if (bar.c > hiN && fv < fgi_hi && adxv >= adx_min) dir = 'long';
      else if (bar.c < loN && fv > fgi_lo && adxv >= adx_min) dir = 'short';
      if (dir) {
        const unitQty = equity * 0.333 / bar.c;   // 3 份预算，每份 ~33% 权益名义
        pos = { dir, units: [{ px: bar.c, ts: bar.ts }], stop: dir === 'long' ? bar.c - 2 * at : bar.c + 2 * at, qty: unitQty };
      }
    } else {
      let exitPx = null, reason = null;
      if (pos.dir === 'long') {
        // 加仓：每涨 atr_add×ATR 加一份
        if (pos.units.length < max_add) {
          const last = pos.units[pos.units.length - 1];
          if (bar.h >= last.px + atr_add * at) {
            const addPx = last.px + atr_add * at;
            pos.units.push({ px: addPx, ts: bar.ts });
            pos.stop = addPx - 2 * at;   // 止损跟随最新入场
          }
        }
        // 离场
        if (bar.l <= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
        else if (bar.c < loExit) { exitPx = bar.c; reason = 'exit_channel'; }
        else if ((pos.stop - pos.units[0].px) / pos.units[0].px * 100 <= -hard_stop) { exitPx = pos.units[0].px * (1 - hard_stop / 100); reason = 'hard_stop'; }
      } else {
        if (pos.units.length < max_add) {
          const last = pos.units[pos.units.length - 1];
          if (bar.l <= last.px - atr_add * at) {
            const addPx = last.px - atr_add * at;
            pos.units.push({ px: addPx, ts: bar.ts });
            pos.stop = addPx + 2 * at;
          }
        }
        if (bar.h >= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
        else if (bar.c > hiExit) { exitPx = bar.c; reason = 'exit_channel'; }
        else if ((pos.units[0].px - pos.stop) / pos.units[0].px * 100 <= -hard_stop) { exitPx = pos.units[0].px * (1 + hard_stop / 100); reason = 'hard_stop'; }
      }
      if (exitPx != null) {
        let pnlUsd = 0;
        for (const u of pos.units) {
          pnlUsd += (pos.dir === 'long' ? (exitPx - u.px) : (u.px - exitPx)) * pos.qty * lev;
        }
        const fee = pos.units.reduce((s, u) => s + u.px * pos.qty * lev, 0) * cost_bps / 10000 * 2;
        pnlUsd -= fee;
        equity += pnlUsd; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
        trades.push({ day: dayStr, entryTs: pos.units[0].ts, exitTs: bar.ts, dir: pos.dir, reason, r: 0, status: pnlUsd >= 0 ? 'WIN' : 'LOSS', entry: +pos.units[0].px.toFixed(1), exit: +exitPx.toFixed(1), units: pos.units.length, pnl_usd: Math.round(pnlUsd), equity_after: Math.round(equity), mode: 'unnamed2', ret_pct: +(pnlUsd / equity * 100).toFixed(2) });
        if (curve) curve.push({ day: dayStr, eq: Math.round(equity) });
        pos = null;
      }
    }
  }
  if (pos) {
    const exitPx = d1[Math.min(endIdx - 1, N - 1)].c;
    const dayStr = new Date(d1[Math.min(endIdx - 1, N - 1)].ts).toISOString().slice(0, 10);
    let pnlUsd = 0;
    for (const u of pos.units) pnlUsd += (pos.dir === 'long' ? (exitPx - u.px) : (u.px - exitPx)) * pos.qty * lev;
    equity += pnlUsd;
    trades.push({ day: dayStr, entryTs: pos.units[0].ts, exitTs: d1[Math.min(endIdx - 1, N - 1)].ts, dir: pos.dir, reason: 'eod', r: 0, status: pnlUsd >= 0 ? 'WIN' : 'LOSS', entry: +pos.units[0].px.toFixed(1), exit: +exitPx.toFixed(1), units: pos.units.length, pnl_usd: Math.round(pnlUsd), equity_after: Math.round(equity), mode: 'unnamed2', ret_pct: 0 });
  }
  const settled = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
  const wins = settled.filter(t => t.status === 'WIN');
  const losses = settled.filter(t => t.status === 'LOSS');
  const winRate = settled.length ? wins.length / settled.length : 0;
  const grossWin = wins.reduce((a, b) => a + b.pnl_usd, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnl_usd, 0));
  const totalRet = (equity - PRINCIPAL) / PRINCIPAL * 100;
  const daysSpan = (endTs - startTs) / 86400000;
  const cagr = daysSpan > 0 ? ((Math.pow(1 + totalRet / 100, 365 / daysSpan) - 1) * 100) : 0;
  return {
    trades: settled.length, win_rate: +(winRate * 100).toFixed(1),
    profit_factor: +(grossWin / (grossLoss || 1)).toFixed(2),
    total_ret_pct: +totalRet.toFixed(1), cagr_pct: +cagr.toFixed(1),
    max_dd_pct: +(maxDd / peak * 100).toFixed(1), equity: +equity.toFixed(0),
    sharpe: 0,
    avg_hold_days: settled.length ? +(settled.reduce((a, t) => a + (t.exitTs - t.entryTs) / 86400000, 0) / settled.length).toFixed(1) : 0,
    avg_units: settled.length ? +(settled.reduce((a, t) => a + (t.units || 1), 0) / settled.length).toFixed(2) : 0,
    by_reason: trades.reduce((a, t) => { a[t.reason] = (a[t.reason] || 0) + 1; return a; }, {}),
    by_dir: trades.reduce((a, t) => { a[t.dir] = (a[t.dir] || 0) + 1; return a; }, {}),
    withdrawn_total: 0, withdrawn_count: 0
  };
}

module.exports = { run };
if (require.main === module) {
  const arg = JSON.parse(process.argv[2] || '{}');
  const S0 = Date.UTC(2020, 0, 1), E_ALL = Date.UTC(2026, 7, 11, 23, 59);
  const TS = Date.UTC(2026, 0, 1), TE = Date.UTC(2026, 7, 11, 23, 59);
  const seg = arg.seg || 'all';
  const out = {};
  if (seg === 'all' || seg === 'full') out.full = run(Object.assign({}, arg.cfg || {}, { startTs: S0, endTs: E_ALL }));
  if (seg === 'all' || seg === 'test') out.test = run(Object.assign({}, arg.cfg || {}, { startTs: TS, endTs: TE }));
  console.log(JSON.stringify(out, null, 1));
}
