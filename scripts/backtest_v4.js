'use strict';
// W1 中低频方向系统回测 v4（高性能版 2026-08-11）
// 核心优化: 所有指标(EMA/ADX/ATR/RSI/MACD/regime/score)一次性预计算
// 回测循环 O(1) 索引读取，百倍提速 → 支持大网格 + 样本外验证
// 防过拟合: 训练段(2024-2025)选参 + 测试段(2026)验证 + 邻域稳定性
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });

// ---------- 数据 ----------
const rows = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
const h1 = rows.map(r => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
const funding = db.prepare('SELECT ts, rate FROM funding ORDER BY ts').all();
const fgi = db.prepare('SELECT ts, value FROM fgi ORDER BY ts').all();

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
const h4 = agg(h1, 14400);
const d1 = agg(h1, 86400);
const N4 = h4.length, N1 = d1.length;

// ---------- 工具 ----------
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
function macdArr(closes, f = 12, s = 26, sig = 9) {
  const ef = emaArr(closes, f), es = emaArr(closes, s);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sg = emaArr(line, sig);
  return { line, signal: sg, hist: line.map((v, i) => v - sg[i]) };
}
function pctileRank(arr, v) { if (!arr.length) return 50; const sorted = [...arr].sort((a, b) => a - b); return sorted.filter(x => x <= v).length / sorted.length * 100; }
function zscoreLast(arr) { if (arr.length < 5) return 0; const m = arr.reduce((a, b) => a + b, 0) / arr.length; const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); return sd === 0 ? 0 : (arr[arr.length - 1] - m) / sd; }

// ---------- 预计算（一次性，因果） ----------
const dc = d1.map(b => b.c);
const hc = h4.map(b => b.c);
const e20d = emaArr(dc, 20), e50d = emaArr(dc, 50), e100d = emaArr(dc, 100), e200d = emaArr(dc, 200);
const adxD = adxArr(d1, 14);
const atrH4 = atrArr(h4, 14);
const rsiH4 = rsiArr(hc, 14);
const macdH4 = macdArr(hc);
const e20h4 = emaArr(hc, 20), e50h4 = emaArr(hc, 50);
const vSMA20 = (() => { const out = new Array(N4).fill(0); let sum = 0; for (let i = 0; i < N4; i++) { sum += h4[i].v; if (i >= 20) sum -= h4[i-20].v; if (i >= 19) out[i] = sum / 20; } return out; })();
const h4UpArr = new Array(N4).fill(false);
for (let i = 20; i < N4; i++) h4UpArr[i] = e20h4[i] > e50h4[i];
// 4h布林带（20,2）上/下轨
const bbUpper = new Array(N4).fill(0), bbLower = new Array(N4).fill(0);
for (let i = 19; i < N4; i++) {
  const seg = hc.slice(i - 19, i + 1);
  const m = seg.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  bbUpper[i] = m + 2 * sd; bbLower[i] = m - 2 * sd;
}
// 日线布林带宽（20,2）历史分位
const bbwHist = [];
for (let i = 50; i < N1; i++) {
  const seg = dc.slice(i - 20 + 1, i + 1);
  const m = seg.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  if (sd > 0) bbwHist.push(4 * sd / dc[i]);
}
// 日线ATR%历史
const atrD = atrArr(d1, 14);
const atrPctHist = [];
for (let i = 30; i < N1; i++) atrPctHist.push(atrD[i] / dc[i] * 100);

// 每根日线的 regime 预计算
const regimeOf = new Array(N1).fill('RANGE');
const adxVal = new Array(N1).fill(0);
const bbwPctVal = new Array(N1).fill(50);
const atrPctVal = new Array(N1).fill(1);
const volLevelOf = new Array(N1).fill('MID');
const trendScoreD = new Array(N1).fill(0);
for (let i = 60; i < N1; i++) {
  const adxv = adxD[i] || 0;
  adxVal[i] = adxv;
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
  // 波动率档位
  const atrP = atrD[i] / dc[i] * 100;
  atrPctVal[i] = atrP;
  const ap = pctileRank(atrPctHist.slice(0, i - 29), atrP);
  volLevelOf[i] = ap >= 75 ? 'HIGH' : ap <= 30 ? 'LOW' : 'MID';
  // 布林带宽分位
  const curBbw = (() => { const seg = dc.slice(i - 19, i + 1); const m = seg.reduce((a, b) => a + b, 0) / 20; const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20); return sd > 0 ? 4 * sd / dc[i] : 0; })();
  bbwPctVal[i] = pctileRank(bbwHist.slice(0, i - 49), curBbw);
  // 日线趋势分（供评分用）
  let ts = 0;
  if (up && adxv >= 20) ts = 2.0; else if (dn && adxv >= 20) ts = -2.0;
  else if (e20d[i] > e50d[i]) ts = 0.6; else if (e20d[i] < e50d[i]) ts = -0.6;
  // 方向锚（可配置 EMA 周期，默认200；50/100 更快捕捉转势）
  const anc = typeof global.__ANCHOR_EMA === 'number' ? global.__ANCHOR_EMA : 200;
  const ancArr = anc === 50 ? e50d : anc === 100 ? e100d : e200d;
  if (dc[i] > ancArr[i]) ts += 0.8; else ts -= 0.8;
  trendScoreD[i] = ts;
}

// 费率窗口 z（截至某 ts，近30天）
const fundTs = funding.map(f => f.ts), fundRate = funding.map(f => f.rate);
const fundZCache = new Map();
function fundingZ(ts) {
  if (fundZCache.has(ts)) return fundZCache.get(ts);
  const cutoff = ts - 30 * 86400 * 1000;
  const out = [];
  for (let j = fundTs.length - 1; j >= 0; j--) { if (fundTs[j] < cutoff) break; out.push(fundRate[j]); }
  out.reverse();
  const z = zscoreLast(out);
  fundZCache.set(ts, z);
  return z;
}
const fgiTs = fgi.map(f => f.ts), fgiVal = fgi.map(f => f.value);
function lastFgi(ts) {
  // fgi 表 ts 为秒级，K线 ts 为毫秒级；统一转毫秒比较（修复未来函数隐患）
  const t = ts / 1000;
  let lo = 0, hi = fgiTs.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fgiTs[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return fgiVal[ans];
}

// 4h → 日线索引映射
const dIdxOf4 = new Array(N4).fill(0);
{
  let di = 0;
  for (let i = 0; i < N4; i++) { while (di + 1 < N1 && d1[di + 1].ts <= h4[i].ts) di++; dIdxOf4[i] = di; }
}

// ---------- 方向评分（预计算到每根4h） ----------
// score4h[i]: 截至第i根4h的方向分（因果，只用 i 及之前数据）
const score4h = new Array(N4).fill(0);
const regime4h = new Array(N4).fill('RANGE');
const vol4h = new Array(N4).fill('MID');
const fz4h = new Array(N4).fill(0);
for (let i = 60; i < N4; i++) {
  const di = dIdxOf4[i];
  regime4h[i] = regimeOf[di];
  vol4h[i] = volLevelOf[di];
  fz4h[i] = fundingZ(h4[i].ts);
  let sc = trendScoreD[di];
  // 4h动量
  const mh = macdH4.hist[i], mhPrev = macdH4.hist[i - 1];
  if (mh > 0 && mhPrev <= 0) sc += 1.2;
  else if (mh < 0 && mhPrev >= 0) sc -= 1.2;
  else if (mh > 0) sc += 0.4;
  else if (mh < 0) sc -= 0.4;
  // RSI 背离
  const curRsi = rsiH4[i];
  if (i > 40) {
    const seg = hc.slice(i - 40, i + 1);
    const lo4 = Math.min(...seg);
    const loIdx = i - 40 + seg.indexOf(lo4);
    if (hc[i] > lo4 * 1.01 && lo4 < seg[0] && curRsi > rsiH4[loIdx] + 3) sc += 0.8;
  }
  // 费率极端
  const fz = fz4h[i];
  if (fz >= 2.0) sc -= 0.8;
  else if (fz <= -2.0) sc += 0.8;
  score4h[i] = sc;
}
// 方向一致性（4h 动量 vs 日线趋势）
const consArr = new Array(N4).fill(false);
const sustainUp = new Array(N4).fill(0);     // 完美多头排列连续天数
const sustainDn = new Array(N4).fill(0);     // 完美空头排列连续天数
let cntUp = 0, cntDn = 0;
for (let i = 60; i < N4; i++) {
  const di = dIdxOf4[i];
  const ts = trendScoreD[di];
  const sc = score4h[i];
  consArr[i] = (ts > 0 && sc > 0) || (ts < 0 && sc < 0);
  const upPerfect = e20d[di] > e50d[di] && e50d[di] > e200d[di] && d1[di].c > e20d[di];
  const dnPerfect = e20d[di] < e50d[di] && e50d[di] < e200d[di] && d1[di].c < e20d[di];
  cntUp = upPerfect ? cntUp + 1 : 0;
  cntDn = dnPerfect ? cntDn + 1 : 0;
  sustainUp[i] = cntUp;
  sustainDn[i] = cntDn;
}

// ---------- 单次回测（O(n) 循环） ----------
function runBacktest(cfg, startTs, endTs) {
  const { entry_th, risk_pct, stop_atr, t1_rr, t1_pct = 50, trail_atr, time_bars, min_r = 0.5, lev_cap = 50, cooldown = 6, cons_only = 0, vol_confirm = 0, adx_min = 0, only_trend = 0, trend_min = 0, use_fgi = 1, quality = 0, sustain = 0, return_trades = false, bb_break = 0, range_et = 0, compound = 0, dd_fuse = 0 } = cfg;
  const PRINCIPAL = 10000;
  const startIdx = Math.max(60, h4.findIndex(b => b.ts >= startTs));
  const endIdx = (() => { const k = h4.findIndex(b => b.ts > endTs); return k === -1 ? N4 : k; })();
  let trades = [], equity = PRINCIPAL, peak = PRINCIPAL, maxDd = 0;
  let dailyPnl = new Map(), pos = null;
  let cd = { long: -1e9, short: -1e9 };
  for (let i = startIdx; i < endIdx; i++) {
    const bar = h4[i]; const ts = bar.ts;
    const dayStr = new Date(ts).toISOString().slice(0, 10);
    if (pos) {
      pos.barsHeld++;
      const isLong = pos.dir === 'long';
      if (isLong) {
        let mx = -Infinity;
        for (let k = Math.max(0, i - 40); k <= i; k++) if (h4[k].h > mx) mx = h4[k].h;
        pos.trail = Math.max(mx - trail_atr * atrH4[i], pos.partial ? pos.entry : 0);
      } else {
        let mn = Infinity;
        for (let k = Math.max(0, i - 40); k <= i; k++) if (h4[k].l < mn) mn = h4[k].l;
        pos.trail = Math.min(mn + trail_atr * atrH4[i], pos.partial ? pos.entry : Infinity);
      }
      let exitPx = null, reason = null;
      if (isLong && bar.l <= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
      else if (!isLong && bar.h >= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
      else if (!pos.partial && isLong && bar.h >= pos.t1) { exitPx = pos.t1; reason = 't1'; }
      else if (!pos.partial && !isLong && bar.l <= pos.t1) { exitPx = pos.t1; reason = 't1'; }
      else if (pos.barsHeld >= 2 && isLong && bar.l <= pos.trail) { exitPx = pos.trail; reason = 'trail'; }
      else if (pos.barsHeld >= 2 && !isLong && bar.h >= pos.trail) { exitPx = pos.trail; reason = 'trail'; }
      else if (pos.barsHeld >= time_bars) {
        const rNow = (isLong ? (bar.c - pos.entry) : (pos.entry - bar.c)) / Math.abs(pos.entry - pos.origStop);
        if (rNow >= min_r) { exitPx = bar.c; reason = 'timeout_win'; }
        else { exitPx = bar.c; reason = 'timeout'; }
      }
      if (exitPx != null) {
        const rTotal = (isLong ? (exitPx - pos.entry) : (pos.entry - exitPx)) / Math.abs(pos.entry - pos.origStop);
        if (reason === 't1') {
          const partReal = pos.riskUsd * (t1_pct / 100) * rTotal;
          equity += partReal; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
          dailyPnl.set(dayStr, (dailyPnl.get(dayStr) || 0) + partReal);
          trades.push({ day: dayStr, dir: pos.dir, reason: 't1', r: +rTotal.toFixed(2), status: 'WIN', regime: pos.reg, score: pos.score });
          pos = { ...pos, stop: pos.entry, t1: null, remaining: +(1 - t1_pct / 100).toFixed(3), barsHeld: pos.barsHeld, partial: true, origStop: pos.origStop };
          continue;
        } else {
          const realized = pos.riskUsd * (pos.remaining || 1) * rTotal;
          equity += realized; if (equity > peak) peak = equity; const dd = peak - equity; if (dd > maxDd) maxDd = dd;
          dailyPnl.set(dayStr, (dailyPnl.get(dayStr) || 0) + realized);
          const status = rTotal > 0 ? 'WIN' : 'LOSS';
          trades.push({ day: dayStr, dir: pos.dir, reason, r: +rTotal.toFixed(2), status, regime: pos.reg, score: pos.score });
          pos = null;
        }
      }
    }
    if (!pos) {
      let sc = score4h[i];
      // FGI 情绪因子（use_fgi 开关 + 明确趋势时不干扰方向：|趋势分|>=2 则跳过）
      if (use_fgi) {
        const fv = lastFgi(ts);
        if (fv != null) {
          const td = trendScoreD[dIdxOf4[i]];
          const clearTrend = Math.abs(td) >= 2.0;
          if (!clearTrend) {
            if (fv <= 20) sc += 1.0;
            else if (fv <= 30) sc += 0.5;
            else if (fv >= 85) sc -= 1.0;
            else if (fv >= 70) sc -= 0.5;
          }
        }
      }
      const reg = regime4h[i];
      const rangeTh = range_et > 0 ? range_et : entry_th + 1.5;
      const canTrade = reg === 'TREND_UP' || reg === 'TREND_DOWN' || reg === 'TURN_UP' || reg === 'TURN_DOWN' || Math.abs(sc) >= rangeTh;
      const canTrade2 = only_trend ? (reg === 'TREND_UP' || reg === 'TREND_DOWN') : canTrade;
      if (canTrade2 && i < N4 - 1) {
        const dir = sc >= entry_th ? 'long' : sc <= -entry_th ? 'short' : null;
        if (dir && i - cd[dir] >= cooldown) {
          // 信号质量过滤（防过拟合的合理约束）
          if (trend_min > 0 && Math.abs(trendScoreD[dIdxOf4[i]]) < trend_min) { /* skip: 日线趋势强度不足 */ }
          else if (cons_only && !consArr[i]) { /* skip */ }
          else if (sustain > 0 && dir === 'long' && sustainUp[i] < sustain) { /* skip: 多头排列未持续 */ }
          else if (sustain > 0 && dir === 'short' && sustainDn[i] < sustain) { /* skip: 空头排列未持续 */ }
          else if (bb_break === 1 && dir === 'long' && !(bar.c > bbUpper[i])) { /* skip: 多头需突破布林上轨 */ }
          else if (bb_break === 1 && dir === 'short' && !(bar.c < bbLower[i])) { /* skip: 空头需跌破布林下轨 */ }
          else if (bb_break === 2 && dir === 'long' && !(bar.c > bbUpper[i] || bar.c > e20h4[i])) { /* skip: 多头需突破或站上EMA20 */ }
          else if (bb_break === 2 && dir === 'short' && !(bar.c < bbLower[i] || bar.c < e20h4[i])) { /* skip: 空头需跌破或破EMA20 */ }
          else if (vol_confirm && vSMA20[i] > 0 && bar.v < vol_confirm * vSMA20[i]) { /* skip */ }
          else if (adx_min > 0 && adxVal[dIdxOf4[i]] < adx_min) { /* skip */ }
          else {
          const atrV = atrH4[i] || bar.c * 0.01;
          // 严格口径：收盘确认信号 → 次根开盘价入场（杜绝未来函数）
          const entryPx = h4[i + 1].o;
          const stopDistPct = Math.min(6, Math.max(0.8, stop_atr * atrV / entryPx * 100));
          // 智能仓位（风险预算）
          let mult = 1.0;
          if (reg === 'TREND_UP' || reg === 'TREND_DOWN') mult = 1.2;
          else if (reg === 'RANGE') mult = 0.85;
          if (vol4h[i] === 'HIGH') mult *= 1.25; else if (vol4h[i] === 'LOW') mult *= 0.8;
          const confMult = Math.abs(sc) >= 4 ? 1.1 : Math.abs(sc) >= 3 ? 1.05 : 1.0;
          const effStop = Math.max(0.8, Math.min(6, stopDistPct * mult * confMult));
          let baseEq = compound ? equity : PRINCIPAL;
          let effRp = risk_pct;
          if (dd_fuse > 0) {
            const curDd = (peak - equity) / peak * 100;
            if (curDd > dd_fuse * 0.6) effRp = risk_pct * 0.5;
            if (curDd > dd_fuse) effRp = risk_pct * 0.2;
          }
          const riskUsd = baseEq * effRp / 100;
          const notional = riskUsd / (effStop / 100);
          const liqDist = effStop * 1.3;
          const leverage = Math.min(lev_cap, Math.floor(100 / liqDist * 10) / 10);
          const margin = notional / leverage;
          const stop = dir === 'long' ? entryPx * (1 - effStop / 100) : entryPx * (1 + effStop / 100);
          const t1 = dir === 'long' ? entryPx * (1 + effStop * t1_rr / 100) : entryPx * (1 - effStop * t1_rr / 100);
          const liqPx = dir === 'long' ? entryPx * (1 - liqDist / 100) : entryPx * (1 + liqDist / 100);
          pos = { dir, entry: entryPx, stop, origStop: stop, t1, trail: 0, barsHeld: 0, notional, margin, riskUsd, remaining: 1, partial: false, liqPx, reg, score: sc, day: dayStr };
          cd[dir] = i;
          }
        }
      }
    }
  }
  const settled = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
  const wins = settled.filter(t => t.status === 'WIN');
  const losses = settled.filter(t => t.status === 'LOSS');
  const winRate = settled.length ? wins.length / settled.length : 0;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b.r, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b.r, 0) / losses.length) : 0;
  const grossWin = wins.reduce((a, b) => a + b.r, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.r, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const days = [...dailyPnl.keys()].sort();
  const dailyReturns = days.map(d => (dailyPnl.get(d) || 0) / PRINCIPAL);
  const meanR = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const sdR = dailyReturns.length > 1 ? Math.sqrt(dailyReturns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (dailyReturns.length - 1)) : 0;
  const sharpe = sdR > 0 ? meanR / sdR * Math.sqrt(365) : 0;
  const totalRet = (equity - PRINCIPAL) / PRINCIPAL * 100;
  const daysSpan = (endTs - startTs) / 86400000;
  const cagr = daysSpan > 0 ? ((Math.pow(1 + totalRet / 100, 365 / daysSpan) - 1) * 100) : 0;
  const result = { trades: trades.length, settled: settled.length, wins: wins.length, losses: losses.length, win_rate: +(winRate * 100).toFixed(1), avg_win_r: +avgWin.toFixed(2), avg_loss_r: +avgLoss.toFixed(2), profit_factor: +profitFactor.toFixed(2), sharpe: +sharpe.toFixed(2), total_ret_pct: +totalRet.toFixed(1), cagr_pct: +cagr.toFixed(1), max_dd_pct: +(maxDd / PRINCIPAL * 100).toFixed(1), equity: +equity.toFixed(0), compound: compound ? 1 : 0, dd_fuse: dd_fuse || 0, by_reason: trades.reduce((a, t) => { a[t.reason] = (a[t.reason] || 0) + 1; return a; }, {}), by_dir: trades.reduce((a, t) => { a[t.dir] = (a[t.dir] || 0) + 1; return a; }, {}) };
  if (return_trades) result.trade_list = trades;
  return result;
}

module.exports = { runBacktest, h4, d1 };
if (require.main === module) {
  const scan = JSON.parse(process.argv[2] || '{}');
  const combos = scan.combos || [];
  const TRAIN_START = Date.UTC(2024, 0, 1), TRAIN_END = Date.UTC(2025, 11, 31, 23, 59);
  const TEST_START = Date.UTC(2026, 0, 1), TEST_END = Date.UTC(2026, 11, 31, 23, 59);
  const results = [];
  for (const c of combos) {
    const train = runBacktest(c, TRAIN_START, TRAIN_END);
    const test = runBacktest(c, TEST_START, TEST_END);
    results.push({ cfg: c, train, test });
  }
  console.log(JSON.stringify(results, null, 1));
}
