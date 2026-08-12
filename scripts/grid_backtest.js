#!/usr/bin/env node
'use strict';
// ============================================================
// γ 网格 · 区间震荡收割引擎 v3（方向偏置网格，2026-08-12）
// 独立引擎，不影响任何现有策略
//  - regime：日线 ADX+EMA 判定（与 α1 同口径）；RANGE 才开网格
//  - 方向偏置：EMA20(1h) 斜率 > 0 → 只做多网格；< 0 → 只做空网格；≈0 → 双向
//  - 区间：布林(20,2)带内等距 N 格
//  - 多网格：下穿格买入、回上一格卖出；空网格：上穿格做空、回下一格平空
//  - 每份止损 2 格距；破位（收盘出带）清仓 + 冷却
// ============================================================
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });

const h1 = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
const m15 = db.prepare("SELECT ts,o,h,l,c FROM klines15 ORDER BY ts").all();
const N1h = h1.length;

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
const d1 = (() => {
  const map = new Map();
  for (const b of h1) {
    const day = new Date(b.ts + 8 * 3600e3).toISOString().slice(0, 10);
    if (!map.has(day)) map.set(day, { ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c });
    else { const d = map.get(day); d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); d.c = b.c; }
  }
  return [...map.values()];
})();
const dc = d1.map(b => b.c);
const e20d = emaArr(dc, 20), e50d = emaArr(dc, 50), e200d = emaArr(dc, 200);
const adxD = adxArr(d1, 14);
const hc1 = h1.map(b => b.c);
const e20h1 = emaArr(hc1, 20);
const bbU1 = new Array(N1h).fill(0), bbL1 = new Array(N1h).fill(0), bbM1 = new Array(N1h).fill(0);
for (let i = 19; i < N1h; i++) {
  const seg = hc1.slice(i - 19, i + 1);
  const m = seg.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  bbU1[i] = m + 2 * sd; bbL1[i] = m - 2 * sd; bbM1[i] = m;
}
const dIdxOfH1 = new Array(N1h).fill(0);
{ let di = 0; for (let i = 0; i < N1h; i++) { while (di + 1 < d1.length && d1[di + 1].ts <= h1[i].ts) di++; dIdxOfH1[i] = di; } }
function m15RangeForH1(h1Idx) {
  const startTs = h1[h1Idx].ts, endTs = startTs + 3600 * 1000;
  let lo = 0, hi = m15.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m15[mid].ts < startTs) lo = mid + 1; else hi = mid; }
  const a = lo;
  while (lo < m15.length && m15[lo].ts < endTs) lo++;
  return [a, lo];
}
const regimeOf = new Array(N1h).fill('RANGE');
for (let i = 60; i < N1h; i++) {
  const di = dIdxOfH1[i];
  const adxv = adxD[di] || 0;
  const up = e20d[di] > e50d[di] && e50d[di] > e200d[di];
  const dn = e20d[di] < e50d[di] && e50d[di] < e200d[di];
  const crossUp = e20d[di] > e50d[di] && e20d[di - 1] <= e50d[di - 1];
  const crossDn = e20d[di] < e50d[di] && e20d[di - 1] >= e50d[di - 1];
  const adxSlope = adxv - (adxD[di - 5] || 0);
  let type;
  if (adxv >= 25 && up && adxSlope > -1) type = 'TREND_UP';
  else if (adxv >= 25 && dn && adxSlope < 1) type = 'TREND_DOWN';
  else if (crossUp && adxv < 25) type = 'TURN_UP';
  else if (crossDn && adxv < 25) type = 'TURN_DOWN';
  else if (adxv < 20) type = 'RANGE';
  else type = adxv >= 25 ? (up ? 'TREND_UP' : dn ? 'TREND_DOWN' : 'RANGE') : 'RANGE';
  regimeOf[i] = type;
}

function run(cfg) {
  const {
    grid_n = 8, grid_risk = 0.5, max_pos = 4,
    cooldown_h = 12, startTs, endTs, cost_bps = 0,
    stop_grids = 2.0, slope_win = 12, slope_eps = 0.00002
  } = cfg;
  const PRINCIPAL = 10000;
  const startIdx = Math.max(300, h1.findIndex(b => b.ts >= startTs));
  const endIdx = (() => { const k = h1.findIndex(b => b.ts > endTs); return k === -1 ? N1h : k; })();
  let trades = [], equity = PRINCIPAL, peak = PRINCIPAL, maxDd = 0;
  let longs = [], shorts = [];   // {px, ts, qty, stop}
  let gridTop = null, gridBot = null, gridLevels = [], gridMid = null, gridStep = null, gridQty = null;
  let cooldownUntil = -1;
  const curve = cfg.curve || null;

  for (let i = startIdx; i < endIdx; i++) {
    const bar = h1[i]; const ts = bar.ts;
    const dayStr = new Date(ts).toISOString().slice(0, 10);
    const reg = regimeOf[i];
    const isRange = reg === 'RANGE' || reg === 'TURN_UP' || reg === 'TURN_DOWN';

    if (!isRange) {
      // 趋势：全部平仓
      const exitPx = bar.c;
      for (const b of longs) { const pnl = (exitPx - b.px) * b.qty; equity += pnl; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd; trades.push({ day: dayStr, entryTs: b.ts, exitTs: ts, dir: 'long', reason: 'trend_exit', r: 0, status: pnl >= 0 ? 'WIN' : 'LOSS', entry: +b.px.toFixed(1), exit: +exitPx.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); if (curve) curve.push({ day: dayStr, eq: Math.round(equity) }); }
      for (const s of shorts) { const pnl = (s.px - exitPx) * s.qty; equity += pnl; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd; trades.push({ day: dayStr, entryTs: s.ts, exitTs: ts, dir: 'short', reason: 'trend_exit', r: 0, status: pnl >= 0 ? 'WIN' : 'LOSS', entry: +s.px.toFixed(1), exit: +exitPx.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); if (curve) curve.push({ day: dayStr, eq: Math.round(equity) }); }
      longs = []; shorts = [];
      gridTop = null; gridBot = null; gridLevels = [];
      continue;
    }
    // 建立网格
    if (!gridTop && ts >= cooldownUntil) {
      gridTop = bbU1[i]; gridBot = bbL1[i];
      gridMid = (gridTop + gridBot) / 2;
      gridStep = (gridTop - gridBot) / grid_n;
      gridLevels = [];
      for (let g = 1; g < grid_n; g++) gridLevels.push(gridBot + g * gridStep);
      gridQty = (equity * grid_risk / 100) / (gridStep / gridMid) / gridMid;
    }
    if (!gridTop) continue;

    const [m0, m1] = m15RangeForH1(i);
    let pxLow = bar.l, pxHigh = bar.h;
    for (let k = m0; k < m1; k++) { if (m15[k].l < pxLow) pxLow = m15[k].l; if (m15[k].h > pxHigh) pxHigh = m15[k].h; }

    // 方向偏置（EMA20 斜率，已收盘）
    const slope = (e20h1[i] - e20h1[Math.max(0, i - slope_win)]) / e20h1[i];
    const longOk = slope > -slope_eps;    // 上涨/走平 → 多网格可开
    const shortOk = slope < slope_eps;    // 下跌/走平 → 空网格可开

    // 多单止损
    for (let bi = longs.length - 1; bi >= 0; bi--) {
      const b = longs[bi];
      if (pxLow <= b.stop) {
        const pnl = (b.stop - b.px) * b.qty; equity += pnl; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
        trades.push({ day: dayStr, entryTs: b.ts, exitTs: ts, dir: 'long', reason: 'stop', r: +((b.stop - b.px) / b.px / (gridStep / gridMid)).toFixed(2), status: 'LOSS', entry: +b.px.toFixed(1), exit: +b.stop.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); if (curve) curve.push({ day: dayStr, eq: Math.round(equity) });
        longs.splice(bi, 1);
      }
    }
    // 空单止损
    for (let si = shorts.length - 1; si >= 0; si--) {
      const s = shorts[si];
      if (pxHigh >= s.stop) {
        const pnl = (s.px - s.stop) * s.qty; equity += pnl; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
        trades.push({ day: dayStr, entryTs: s.ts, exitTs: ts, dir: 'short', reason: 'stop', r: +((s.px - s.stop) / s.px / (gridStep / gridMid)).toFixed(2), status: 'LOSS', entry: +s.px.toFixed(1), exit: +s.stop.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); if (curve) curve.push({ day: dayStr, eq: Math.round(equity) });
        shorts.splice(si, 1);
      }
    }

    // 下行穿格：买多（longOk）或 平空
    for (let g = gridLevels.length - 1; g >= 0; g--) {
      const lv = gridLevels[g];
      if (pxLow <= lv) {
        // 平空（该格及以上有空单，回落到此格平仓）
        const si = shorts.findIndex(s => s.px > lv);
        if (si >= 0) {
          const s = shorts.splice(si, 1)[0];
          const pnl = (s.px - lv) * s.qty; equity += pnl; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
          trades.push({ day: dayStr, entryTs: s.ts, exitTs: ts, dir: 'short', reason: 'grid_buy', r: +((s.px - lv) / s.px / (gridStep / gridMid)).toFixed(2), status: 'WIN', entry: +s.px.toFixed(1), exit: +lv.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); if (curve) curve.push({ day: dayStr, eq: Math.round(equity) });
        } else if (longOk && longs.length < max_pos) {
          longs.push({ px: lv, ts, qty: gridQty, stop: lv * (1 - stop_grids * gridStep / gridMid) });
          gridLevels.splice(g, 1);
        }
      }
    }
    // 上行穿格：卖平多 或 开空（shortOk）
    const sellLevels = [...gridLevels].sort((a, b) => a - b);
    for (const lv of sellLevels) {
      if (pxHigh >= lv) {
        const li = longs.findIndex(b => b.px < lv);
        if (li >= 0) {
          const b = longs.splice(li, 1)[0];
          let pnl = (lv - b.px) * b.qty; if (cost_bps > 0) pnl -= (lv * b.qty + b.px * b.qty) * cost_bps / 10000;
          equity += pnl; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
          trades.push({ day: dayStr, entryTs: b.ts, exitTs: ts, dir: 'long', reason: 'grid_sell', r: +((lv - b.px) / b.px / (gridStep / gridMid)).toFixed(2), status: 'WIN', entry: +b.px.toFixed(1), exit: +lv.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); if (curve) curve.push({ day: dayStr, eq: Math.round(equity) });
        } else if (shortOk && shorts.length < max_pos) {
          shorts.push({ px: lv, ts, qty: gridQty, stop: lv * (1 + stop_grids * gridStep / gridMid) });
          const gi = gridLevels.indexOf(lv); if (gi >= 0) gridLevels.splice(gi, 1);
        }
      }
    }
    // 破位清仓 + 冷却
    if (bar.c > gridTop || bar.c < gridBot) {
      const exitPx = bar.c;
      for (const b of longs) { const pnl = (exitPx - b.px) * b.qty; equity += pnl; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd; trades.push({ day: dayStr, entryTs: b.ts, exitTs: ts, dir: 'long', reason: 'band_break', r: +((exitPx - b.px) / b.px / (gridStep / gridMid)).toFixed(2), status: exitPx >= b.px ? 'WIN' : 'LOSS', entry: +b.px.toFixed(1), exit: +exitPx.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); if (curve) curve.push({ day: dayStr, eq: Math.round(equity) }); }
      for (const s of shorts) { const pnl = (s.px - exitPx) * s.qty; equity += pnl; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd; trades.push({ day: dayStr, entryTs: s.ts, exitTs: ts, dir: 'short', reason: 'band_break', r: +((s.px - exitPx) / s.px / (gridStep / gridMid)).toFixed(2), status: exitPx <= s.px ? 'WIN' : 'LOSS', entry: +s.px.toFixed(1), exit: +exitPx.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); if (curve) curve.push({ day: dayStr, eq: Math.round(equity) }); }
      longs = []; shorts = [];
      gridTop = null; gridBot = null; gridLevels = [];
      cooldownUntil = ts + cooldown_h * 3600e3;
    }
  }
  // 期末平
  if (longs.length || shorts.length) {
    const exitPx = h1[Math.min(endIdx, N1h - 1)].c;
    for (const b of longs) { const pnl = (exitPx - b.px) * b.qty; equity += pnl; trades.push({ day: dayStr, entryTs: b.ts, exitTs: h1[Math.min(endIdx, N1h - 1)].ts, dir: 'long', reason: 'eod', r: 0, status: pnl >= 0 ? 'WIN' : 'LOSS', entry: +b.px.toFixed(1), exit: +exitPx.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); }
    for (const s of shorts) { const pnl = (s.px - exitPx) * s.qty; equity += pnl; trades.push({ day: dayStr, entryTs: s.ts, exitTs: h1[Math.min(endIdx, N1h - 1)].ts, dir: 'short', reason: 'eod', r: 0, status: pnl >= 0 ? 'WIN' : 'LOSS', entry: +s.px.toFixed(1), exit: +exitPx.toFixed(1), pnl_usd: Math.round(pnl), equity_after: Math.round(equity), mode: 'grid' }); }
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
    avg_win_r: +(wins.reduce((a, b) => a + b.r, 0) / (wins.length || 1)).toFixed(2),
    avg_loss_r: +(losses.reduce((a, b) => Math.abs(b.r), 0) / (losses.length || 1)).toFixed(2),
    by_reason: trades.reduce((a, t) => { a[t.reason] = (a[t.reason] || 0) + 1; return a; }, {}),
    by_dir: trades.reduce((a, t) => { a[t.dir] = (a[t.dir] || 0) + 1; return a; }, {}),
    sharpe: 0, withdrawn_total: 0, withdrawn_count: 0
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
