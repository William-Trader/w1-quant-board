'use strict';
// ============================================================
// α1 v2 破浪·布林双模 中高频引擎（实验版 2026-08-12）
// 设计：激进中高频 + 保证胜率 + 不扛单
//   - 市况判定（日线 regime）：RANGE=震荡市 / TREND/TURN=非震荡市
//   - 震荡市：布林带均值回归（1h 触下轨+RSI超卖做多 → 止盈中轨；上轨对称）
//   - 非震荡市：布林突破 + EMA20 回调企稳顺势做多/做空，1.5R止盈 + 吊灯追踪
//   - 硬约束：每笔必带 ATR 止损 + 超时强制平仓（无马丁、无扛单）
//   - 提现：mult 模式 15%@2x（与 α1 v1 一致）
// 数据：hist.db klines(1h) + klines15 + funding + fgi
// 输出：JSON {engine,caliber,params,samples:[...trade_list]}
// ============================================================
const fs = require('fs');
const Database = require('/home/ubuntu/w1-board/node_modules/better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });

const rows = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
const h1 = rows.map(r => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
const funding = db.prepare('SELECT ts, rate FROM funding ORDER BY ts').all();
const fgi = db.prepare('SELECT ts, value FROM fgi ORDER BY ts').all();
const rows15 = db.prepare("SELECT ts,o,h,l,c FROM klines15 ORDER BY ts").all();
const m15 = rows15.map(r => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c }));
console.error('[bt-dual] 1h bars:', h1.length, '| 15m bars:', m15.length);

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
const N1h = h1.length, N1 = d1.length;

// ---------- 15m 区间映射（1h 桶） ----------
function m15RangeForH1(h1Idx) {
  const startTs = h1[h1Idx].ts, endTs = startTs + 3600 * 1000;
  let lo = 0, hi = m15.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m15[mid].ts < startTs) lo = mid + 1; else hi = mid; }
  const a = lo;
  while (lo < m15.length && m15[lo].ts < endTs) lo++;
  return [a, lo];
}

// ---------- 15m 指标（入场确认用，因果：只用已收盘 bar） ----------
const m15c = m15.map(b => b.c);
const rsi15 = rsiArr(m15c, 14);
const e20m15 = emaArr(m15c, 20);
const atr15 = atrArr(m15, 14);
const bb15U = new Array(m15.length).fill(0), bb15L = new Array(m15.length).fill(0), bb15M = new Array(m15.length).fill(0);
for (let i = 19; i < m15.length; i++) {
  const seg = m15c.slice(i - 19, i + 1);
  const m = seg.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  bb15U[i] = m + 2 * sd; bb15L[i] = m - 2 * sd; bb15M[i] = m;
}

// ---------- 指标工具 ----------
function emaArr(arr, n) { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; }
function rsiArr(closes, n = 14) {
  const out = new Array(closes.length).fill(50); let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = g * (n - 1) / n + (d > 0 ? d : 0); l = l * (n - 1) / n + (d < 0 ? -d : 0);
    if (i >= n) { const rs = l === 0 ? 100 : g / l; out[i] = 100 - 100 / (1 + rs); }
  }
  return out;
}
function atrArr(bars, n = 14) {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    out[i] = i === 1 ? tr : (out[i - 1] * (n - 1) + tr) / n;
  }
  return out;
}
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
function pctileRank(arr, v) { if (!arr.length) return 50; const sorted = [...arr].sort((a, b) => a - b); return sorted.filter(x => x <= v).length / sorted.length * 100; }

// ---------- 1h 指标预计算 ----------
const hc1 = h1.map(b => b.c);
const dc = d1.map(b => b.c);
const e20h1 = emaArr(hc1, 20), e50h1 = emaArr(hc1, 50), e200h1 = emaArr(hc1, 200);
const e20d = emaArr(dc, 20), e50d = emaArr(dc, 50), e100d = emaArr(dc, 100), e200d = emaArr(dc, 200);
const rsiH1 = rsiArr(hc1, 14);
const atrH1 = atrArr(h1, 14);
const adxD = adxArr(d1, 14);
// 1h 布林带（20,2）
const bbU1 = new Array(N1h).fill(0), bbL1 = new Array(N1h).fill(0), bbM1 = new Array(N1h).fill(0);
for (let i = 19; i < N1h; i++) {
  const seg = hc1.slice(i - 19, i + 1);
  const m = seg.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  bbU1[i] = m + 2 * sd; bbL1[i] = m - 2 * sd; bbM1[i] = m;
}

// ---------- 日线 regime（震荡/趋势判定） ----------
const regimeOf = new Array(N1).fill('RANGE');
for (let i = 60; i < N1; i++) {
  const adxv = adxD[i] || 0;
  const up = e20d[i] > e50d[i] && e50d[i] > e200d[i];
  const dn = e20d[i] < e50d[i] && e50d[i] < e200d[i];
  const crossUp = e20d[i] > e50d[i] && e20d[i - 1] <= e50d[i - 1];
  const crossDn = e20d[i] < e50d[i] && e20d[i - 1] >= e50d[i - 1];
  const adxSlope = adxv - (adxD[i - 5] || 0);
  let type;
  if (adxv >= 25 && up && adxSlope > -1) type = 'TREND_UP';
  else if (adxv >= 25 && dn && adxSlope < 1) type = 'TREND_DOWN';
  else if (crossUp && adxv < 25) type = 'TURN_UP';
  else if (crossDn && adxv < 25) type = 'TURN_DOWN';
  else if (adxv < 20) type = 'RANGE';
  else type = adxv >= 25 ? (up ? 'TREND_UP' : dn ? 'TREND_DOWN' : 'RANGE') : 'RANGE';
  regimeOf[i] = type;
}
// 1h → 日索引
const dIdxOfH1 = new Array(N1h).fill(0);
{ let di = 0; for (let i = 0; i < N1h; i++) { while (di + 1 < N1 && d1[di + 1].ts <= h1[i].ts) di++; dIdxOfH1[i] = di; } }

// ---------- 主回测 ----------
function run(cfg) {
  const {
    risk_pct = 0.8, range_touch_atr = 0.15, range_rsi_lo = 40, range_rsi_hi = 60,
    range_stop_atr = 1.2, range_timeout = 24, range_t1_mode = 'mid', range_trail_atr = 1.5,
    trend_stop_atr = 1.8, trend_t1_rr = 1.5, trend_trail_atr = 2.5, trend_timeout = 48,
    cooldown = 12, dd_fuse = 10, lev_cap = 50, min_r = 0.3, t1_pct = 60,
    withdrawPct = 0.15, withdrawMult = 2, compound = 1, startTs, endTs, outFile = null,
    use15mEntry = 0,   // 15m 更小级别入场确认（默认关；开=1h 信号后在 15m 找确认点，无确认放弃）
    partial_be_r = 0,  // 部分止盈后保本价 = entry + partial_be_r*stopDist（0=纯保本）
    range_rsi15_lo = null, range_rsi15_hi = null, trend_rsi15_lo = null, trend_rsi15_hi = null,  // 15m 确认单独阈值（null=用 1h 阈值）
    cost_bps = 0       // 交易成本（基点/边）：手续费+滑点，双边扣费（0=无成本回测）
  } = cfg;
  const PRINCIPAL = 10000;
  const startIdx = Math.max(300, h1.findIndex(b => b.ts >= startTs));
  const endIdx = (() => { const k = h1.findIndex(b => b.ts > endTs); return k === -1 ? N1h : k; })();
  let trades = [], equity = PRINCIPAL, peak = PRINCIPAL, maxDd = 0;
  const curve = cfg.curve || null;
  let wdBase = PRINCIPAL, withdrawnTotal = 0, withdrawnCount = 0;
  let pos = null, lastEntry = -1e9;
  for (let i = startIdx; i < endIdx; i++) {
    const bar = h1[i]; const ts = bar.ts;
    const dayStr = new Date(ts).toISOString().slice(0, 10);
    const di = dIdxOfH1[i];
    if (pos) {
      pos.barsHeld++;
      const isLong = pos.dir === 'long';
      // 动态止盈：震荡模式 T1 = 布林中轨
      if (pos.mode === 'range' && !pos.partial) {
        pos.t1 = bbM1[i - 1];
        if (pos.liqSafe) pos.t1 = isLong ? Math.min(pos.t1, pos.entry + pos.stopDist * 2.5) : Math.max(pos.t1, pos.entry - pos.stopDist * 2.5);
      }
      // 吊灯追踪（1h 窗口）
      if (pos.mode === 'trend') {
        const win = 40;
        if (isLong) { let mx = -Infinity; for (let k = Math.max(0, i - win); k <= i - 1; k++) if (h1[k].h > mx) mx = h1[k].h; pos.trail = Math.max(mx - trend_trail_atr * atrH1[i], pos.partial ? pos.entry : 0); }
        else { let mn = Infinity; for (let k = Math.max(0, i - win); k <= i - 1; k++) if (h1[k].l < mn) mn = h1[k].l; pos.trail = Math.min(mn + trend_trail_atr * atrH1[i], pos.partial ? pos.entry : Infinity); }
      } else {
        const win = 20;
        if (isLong) { let mx = -Infinity; for (let k = Math.max(0, i - win); k <= i - 1; k++) if (h1[k].h > mx) mx = h1[k].h; pos.trail = Math.max(mx - range_trail_atr * atrH1[i], pos.partial ? pos.entry : 0); }
        else { let mn = Infinity; for (let k = Math.max(0, i - win); k <= i - 1; k++) if (h1[k].l < mn) mn = h1[k].l; pos.trail = Math.min(mn + range_trail_atr * atrH1[i], pos.partial ? pos.entry : Infinity); }
      }
      let exitPx = null, reason = null;
      const [m0, m1] = m15RangeForH1(i);
      const kStart = (pos.entry15Idx != null && pos.entry15Idx > m0) ? pos.entry15Idx : m0;
      for (let k = kStart; k < m1; k++) {
        const b15 = m15[k];
        if (isLong && b15.l <= pos.stop) { exitPx = pos.stop; reason = 'stop'; break; }
        if (!isLong && b15.h >= pos.stop) { exitPx = pos.stop; reason = 'stop'; break; }
        if (!pos.partial && isLong && b15.h >= pos.t1) { exitPx = pos.t1; reason = 't1'; break; }
        if (!pos.partial && !isLong && b15.l <= pos.t1) { exitPx = pos.t1; reason = 't1'; break; }
        if (pos.barsHeld >= 2 && isLong && b15.l <= pos.trail) { exitPx = pos.trail; reason = 'trail'; break; }
        if (pos.barsHeld >= 2 && !isLong && b15.h >= pos.trail) { exitPx = pos.trail; reason = 'trail'; break; }
        if (pos.barsHeld >= pos.timeout) {
          const rNow = (isLong ? (b15.c - pos.entry) : (pos.entry - b15.c)) / pos.stopDist;
          exitPx = b15.c; reason = rNow >= min_r ? 'timeout_win' : 'timeout'; break;
        }
      }
      if (exitPx != null) {
        const rTotal = (isLong ? (exitPx - pos.entry) : (pos.entry - exitPx)) / pos.stopDist;
        if (reason === 't1') {
          let partReal = pos.riskUsd * (t1_pct / 100) * rTotal;
          if (cost_bps > 0) partReal -= pos.notional * (t1_pct / 100) * cost_bps / 10000 * 2;
          equity += partReal; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
          trades.push({ id: trades.length + 1, day: dayStr, entryTs: pos.entryTs, exitTs: ts, dir: pos.dir, reason: 't1', r: +rTotal.toFixed(2), status: 'WIN', regime: pos.reg, score: pos.score,
            entry: +pos.entry.toFixed(1), exit: +exitPx.toFixed(1), stop: +pos.origStop.toFixed(1),
            leverage: pos.leverage, notional: Math.round(pos.notional), margin: Math.round(pos.margin),
            risk_usd: Math.round(pos.riskUsd), share: +(t1_pct / 100).toFixed(2),
            pnl_usd: Math.round(partReal), equity_after: Math.round(equity), mode: pos.mode });
          if (curve) curve.push({ day: dayStr, eq: Math.round(equity) });
          pos = { ...pos, stop: pos.entry + (pos.dir === 'long' ? partial_be_r * pos.stopDist : -partial_be_r * pos.stopDist), t1: null, remaining: +(1 - t1_pct / 100).toFixed(3), partial: true };
          continue;
        }
        let realized = pos.riskUsd * (pos.remaining || 1) * rTotal;
        if (cost_bps > 0) realized -= pos.notional * (pos.remaining || 1) * cost_bps / 10000 * 2;
        equity += realized; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
        const status = rTotal > 0 ? 'WIN' : 'LOSS';
        trades.push({ id: trades.length + 1, day: dayStr, entryTs: pos.entryTs, exitTs: ts, dir: pos.dir, reason, r: +rTotal.toFixed(2), status, regime: pos.reg, score: pos.score,
          entry: +pos.entry.toFixed(1), exit: +exitPx.toFixed(1), stop: +pos.origStop.toFixed(1),
          leverage: pos.leverage, notional: Math.round(pos.notional), margin: Math.round(pos.margin),
          risk_usd: Math.round(pos.riskUsd), share: +(pos.remaining || 1).toFixed(2),
          pnl_usd: Math.round(realized), equity_after: Math.round(equity), mode: pos.mode });
        if (curve) curve.push({ day: dayStr, eq: Math.round(equity) });
        pos = null;
      }
    }
    // 提现（mult：权益达基准×mult 提利润 pct%）
    if (withdrawPct > 0 && equity >= wdBase * withdrawMult) {
      const profit = equity - wdBase; const wd = profit * withdrawPct;
      if (wd > 0) { equity -= wd; withdrawnTotal += wd; withdrawnCount++; }
      wdBase = equity;
    }
    // ---------- 信号（无未来函数：用 i 及之前，入场 = i+1 开盘） ----------
    if (!pos && i < endIdx - 1 && i - lastEntry >= cooldown) {
      const reg = regimeOf[di];
      const c = bar.c, atr = atrH1[i] || c * 0.01;
      let sig = null, mode = null;
      if (reg === 'RANGE') {
        // 震荡市：布林均值回归
        const touchTol = range_touch_atr * atr;
        if (c <= bbL1[i] + touchTol && rsiH1[i] < range_rsi_lo) { sig = 'long'; mode = 'range'; }
        else if (c >= bbU1[i] - touchTol && rsiH1[i] > range_rsi_hi) { sig = 'short'; mode = 'range'; }
      } else if (reg === 'TREND_UP' || reg === 'TURN_UP') {
        // 非震荡市（多头）：布林突破 or EMA20 回调企稳
        if (c > bbU1[i] && e20h1[i] > e50h1[i]) { sig = 'long'; mode = 'trend'; }
        else if (c >= e20h1[i] * 0.995 && c <= e20h1[i] * 1.01 && rsiH1[i] >= 40 && rsiH1[i] <= 55 && e20h1[i] > e50h1[i]) { sig = 'long'; mode = 'trend'; }
      } else if (reg === 'TREND_DOWN' || reg === 'TURN_DOWN') {
        if (c < bbL1[i] && e20h1[i] < e50h1[i]) { sig = 'short'; mode = 'trend'; }
        else if (c <= e20h1[i] * 1.005 && c >= e20h1[i] * 0.99 && rsiH1[i] >= 45 && rsiH1[i] <= 60 && e20h1[i] < e50h1[i]) { sig = 'short'; mode = 'trend'; }
      }
      if (sig) {
        // ---- 15m 入场确认（use15mEntry）：在下一根 1h 的 15m 桶内找更小级别入场点 ----
        let entryPx = h1[i + 1].o, entryTs15 = h1[i + 1].ts, entry15Idx = null, skipSig = false;
        if (use15mEntry && i + 1 < N1h) {
          const [m0, m1] = m15RangeForH1(i + 1);
          let found = false;
          for (let k = m0; k < m1 && !found; k++) {
            const b = m15[k];
            const tol15 = 0.15 * (atr15[k] || b.c * 0.01);
            let ok = false;
            if (mode === 'range') {
              const lo15 = range_rsi15_lo != null ? range_rsi15_lo : range_rsi_lo;
              const hi15 = range_rsi15_hi != null ? range_rsi15_hi : range_rsi_hi;
              if (sig === 'long') ok = b.c <= bb15L[k] + tol15 && rsi15[k] < lo15;
              else ok = b.c >= bb15U[k] - tol15 && rsi15[k] > hi15;
            } else {
              const lo15 = trend_rsi15_lo != null ? trend_rsi15_lo : 40;
              const hi15 = trend_rsi15_hi != null ? trend_rsi15_hi : 55;
              if (sig === 'long') ok = b.c >= e20m15[k] * 0.997 && b.c <= e20m15[k] * 1.003 && rsi15[k] >= lo15 && rsi15[k] <= hi15;
              else ok = b.c <= e20m15[k] * 1.003 && b.c >= e20m15[k] * 0.997 && rsi15[k] >= 45 && rsi15[k] <= 60;
            }
            if (ok) { entryPx = m15[k + 1] ? m15[k + 1].o : h1[i + 2] ? h1[i + 2].o : b.c; entryTs15 = m15[k + 1] ? m15[k + 1].ts : h1[i + 2] ? h1[i + 2].ts : b.ts; entry15Idx = k + 1; found = true; }
          }
          if (!found) skipSig = true;   // 15m 无确认 → 放弃该信号（更小级别入场过滤）
        }
        if (skipSig) { /* 无入场点，跳过 */ }
        else {
        const stopAt = mode === 'range' ? range_stop_atr : trend_stop_atr;
        const stopDistPct = Math.min(4, Math.max(0.5, stopAt * atr / entryPx * 100));
        const stopDist = entryPx * stopDistPct / 100;
        const stop = sig === 'long' ? entryPx - stopDist : entryPx + stopDist;
        // 风险预算（熔断降仓）
        let effRp = risk_pct;
        const curDd = (peak - equity) / peak * 100;
        if (dd_fuse > 0) { if (curDd > dd_fuse * 0.6) effRp = risk_pct * 0.5; if (curDd > dd_fuse) effRp = risk_pct * 0.2; }
        const riskUsd = (compound ? equity : PRINCIPAL) * effRp / 100;
        const notional = riskUsd / (stopDistPct / 100);
        const liqDist = stopDistPct * 1.3;
        const leverage = Math.min(lev_cap, Math.floor(100 / liqDist * 10) / 10);
        const margin = notional / leverage;
        let t1;
        if (mode === 'range') t1 = bbM1[i + 1]; // 中轨（动态更新）
        else t1 = sig === 'long' ? entryPx + stopDist * trend_t1_rr : entryPx - stopDist * trend_t1_rr;
        // 评分（供看板 label 用）：range 按 RSI 深度 1.5~2.5；trend 按突破/回调 2.5~4
        let score;
        if (mode === 'range') score = sig === 'long' ? (1.5 + Math.max(0, (range_rsi_lo - rsiH1[i]) / 10)) : -(1.5 + Math.max(0, (rsiH1[i] - range_rsi_hi) / 10));
        else score = sig === 'long' ? (c > bbU1[i] ? 3.6 : 2.8) : (c < bbL1[i] ? -3.6 : -2.8);
        pos = { dir: sig, mode, entry: entryPx, stop, origStop: stop, t1, trail: 0, barsHeld: 0,
          notional, margin, leverage, riskUsd, remaining: 1, partial: false, liqPx: null,
          reg, score: +score.toFixed(2), day: dayStr, entryTs: entryTs15, timeout: mode === 'range' ? range_timeout : trend_timeout,
          stopDist, liqSafe: false, entry15Idx };
        lastEntry = i;
        }
      }
    }
  }
  const settled = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
  const wins = settled.filter(t => t.status === 'WIN');
  const losses = settled.filter(t => t.status === 'LOSS');
  const winRate = settled.length ? wins.length / settled.length : 0;
  const grossWin = wins.reduce((a, b) => a + b.r, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.r, 0));
  const days = [...new Set(trades.map(t => t.day))].sort();
  const dailyPnl = new Map();
  trades.forEach(t => dailyPnl.set(t.day, (dailyPnl.get(t.day) || 0) + t.pnl_usd));
  const dailyReturns = days.map(d => (dailyPnl.get(d) || 0) / PRINCIPAL);
  const meanR = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const sdR = dailyReturns.length > 1 ? Math.sqrt(dailyReturns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (dailyReturns.length - 1)) : 0;
  const sharpe = sdR > 0 ? meanR / sdR * Math.sqrt(365) : 0;
  const totalRet = (equity - PRINCIPAL) / PRINCIPAL * 100;
  const daysSpan = (endTs - startTs) / 86400000;
  const cagr = daysSpan > 0 ? ((Math.pow(1 + totalRet / 100, 365 / daysSpan) - 1) * 100) : 0;
  const result = { trades: trades.length, settled: settled.length, wins: wins.length, losses: losses.length, win_rate: +(winRate * 100).toFixed(1), avg_win_r: +(wins.reduce((a, b) => a + b.r, 0) / (wins.length || 1)).toFixed(2), avg_loss_r: +(losses.reduce((a, b) => Math.abs(b.r), 0) / (losses.length || 1)).toFixed(2), profit_factor: +(grossWin / (grossLoss || 1)).toFixed(2), sharpe: +sharpe.toFixed(2), total_ret_pct: +totalRet.toFixed(1), cagr_pct: +cagr.toFixed(1), max_dd_pct: +(maxDd / peak * 100).toFixed(1), equity: +equity.toFixed(0), by_reason: trades.reduce((a, t) => { a[t.reason] = (a[t.reason] || 0) + 1; return a; }, {}), by_mode: trades.reduce((a, t) => { a[t.mode] = (a[t.mode] || 0) + 1; return a; }, {}), withdrawn_total: Math.round(withdrawnTotal), withdrawn_count: withdrawnCount };
  if (cfg.return_trades) result.trade_list = trades;
  return result;
}

// ---------- CLI ----------
module.exports = { run };
if (require.main === module) {
  const arg = JSON.parse(process.argv[2] || '{}');
  const S0 = Date.UTC(2020, 0, 1), E_ALL = Date.UTC(2026, 7, 11, 23, 59);
  const TRAIN_S = Date.UTC(2024, 0, 1), TRAIN_E = Date.UTC(2025, 11, 31, 23, 59);
  const TEST_S = Date.UTC(2026, 0, 1), TEST_E = Date.UTC(2026, 7, 11, 23, 59);
  const combos = arg.combos || [{}];
  const seg = arg.seg || 'all';
  const results = [];
  for (const c of combos) {
    const runs = {};
    if (seg === 'train' || seg === 'all') runs.train = run(Object.assign({}, c, { startTs: TRAIN_S, endTs: TRAIN_E }));
    if (seg === 'test' || seg === 'all') runs.test = run(Object.assign({}, c, { startTs: TEST_S, endTs: TEST_E }));
    if (seg === 'full' || seg === 'all') runs.full = run(Object.assign({}, c, { startTs: S0, endTs: E_ALL }));
    results.push({ cfg: c, ...runs });
  }
  console.log(JSON.stringify(results, null, 1));
  // 生成 samples 文件（供 gen_windows 使用）
  if (arg.outSamples) {
    const full = run(Object.assign({}, arg.cfg || {}, { startTs: S0, endTs: E_ALL, return_trades: true }));
    const out = { engine: 'alpha1-v2-bb-dual', caliber: 'v2_dual_real', params: arg.cfg || {}, samples: full.trade_list };
    fs.writeFileSync(arg.outSamples, JSON.stringify(out, null, 1));
    console.log('samples written →', arg.outSamples, full.trade_list.length, 'trades');
  }
}
