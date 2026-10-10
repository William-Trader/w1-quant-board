'use strict';
// ============================================================
// W1 中低频方向判断引擎 v1.0 PROD（2026-08-11 William 老板指令）
// 与回测 v4 (backtest_v4.js) 完全同口径：
//   锁定参数(2026-08-11 复利定案 v2): entry_th=3.0 risk_pct=3.5% stop_atr=2.8 t1_rr=0.8 t1_pct=60%
//             trail_atr=2.5 time_bars=10 min_r=0.5 cons_only=1 cooldown=3 compound=1 dd_fuse=5
//   全段(24-26): WR 65.5% 夏普 7.56 年化CAGR 79.9% 收益+482.9% PF4.22 回撤17.6%
//   样本外26: WR 71.4% 夏普 9.42 年化54.7% | 邻域2187组合中位79.3%（宽阔参数高原，78%组合年化≥50%）
// 数据源: hist.db(BTCUSDT 1h K线) + w1.db(futures_markets 实时衍生品)
// 输出: 行情类型(regime) + 方向评分(score/dir/confidence) + 智能仓位计划
// ============================================================
const Database = require('better-sqlite3');
const HIST_DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const W1_DB = '/home/ubuntu/w1-board/data/w1.db';
// v3 进攻版（2026-08-11 老板指令：放宽回撤至20-29%换取更高年化）：风险4.25%/笔，熔断3.6%/6%
const PRINCIPAL = 10000, RISK_PCT = 4.25, DD_FUSE = 6;

let _w1 = null;
function w1Db() { if (!_w1) _w1 = new Database(W1_DB, { readonly: true }); return _w1; }

/* ---------- 模拟账户（与回测复利同口径）：本金 10000u，按已结算 UNIFIED/DIR 单盈亏滚动
 * 盈亏 = risk_usd × R（R = 价格变动% / 止损距离%），与回测 runBacktest 的 riskUsd×rTotal 完全同构
 * 注意：当前 OPEN 单不参与（只统计已结算 WIN/LOSS/FLAT），已开仓位不受影响 ---------- */
function simAccount() {
  let eq = PRINCIPAL, peak = PRINCIPAL;
  try {
    const rows = w1Db().prepare(
      "SELECT pnl_pct, entry, stop, risk_usd FROM signal_track WHERE status IN ('WIN','LOSS','FLAT') AND strategy IN ('UNIFIED','DIR') AND pnl_pct IS NOT NULL ORDER BY resolved_at"
    ).all();
    for (const r of rows) {
      const entry = Number(r.entry), stop = Number(r.stop);
      const stopDistPct = entry > 0 && stop > 0 ? Math.abs(entry - stop) / entry * 100 : 1;
      const riskUsd = Number(r.risk_usd) || PRINCIPAL * RISK_PCT / 100;
      const fu = riskUsd * (Number(r.pnl_pct) / stopDistPct); // 风险 × R
      eq += fu;
      if (eq > peak) peak = eq;
    }
  } catch (e) { console.warn('[dir_prod] 模拟账户读取失败:', e.message); }
  const ddPct = (peak - eq) / peak * 100;
  return { equity: eq, peak, dd_pct: ddPct, risk_pct_eff: RISK_PCT * (ddPct > DD_FUSE ? 0.2 : ddPct > DD_FUSE * 0.6 ? 0.5 : 1) };
}

/* ---------- FGI 恐惧贪婪指数（实盘读取 w1.db，回测读取 hist.db fgi 表同口径） ---------- */
function lastFgi(ts) {
  try {
    const row = w1Db().prepare("SELECT value FROM fear_greed WHERE ts <= ? ORDER BY ts DESC LIMIT 1").get(Math.floor(ts / 1000));
    return row ? row.value : null;
  } catch { return null; }
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
function macdArr(closes, f = 12, s = 26, sig = 9) {
  const ef = emaArr(closes, f), es = emaArr(closes, s);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sg = emaArr(line, sig);
  return { line, signal: sg, hist: line.map((v, i) => v - sg[i]) };
}
function pctileRank(arr, v) { if (!arr.length) return 50; const sorted = [...arr].sort((a, b) => a - b); return sorted.filter(x => x <= v).length / sorted.length * 100; }
function zscoreLast(arr) { if (arr.length < 5) return 0; const m = arr.reduce((a, b) => a + b, 0) / arr.length; const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); return sd === 0 ? 0 : (arr[arr.length - 1] - m) / sd; }

// ---------- 数据加载（hist.db K线 → 1h/4h/1d） ----------
function loadBars() {
  const db = new Database(HIST_DB, { readonly: true });
  const rows = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
  db.close();
  const h1 = rows.map(r => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
  const agg = (bars, secs) => {
    const out = []; let cur = null;
    for (const b of bars) {
      const bucket = Math.floor(b.ts / (secs * 1000));
      if (!cur || cur.bucket !== bucket) { if (cur) out.push(cur); cur = { bucket, ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; }
      else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
    }
    if (cur) out.push(cur);
    return out;
  };
  return { h1, h4: agg(h1, 14400), d1: agg(h1, 86400) };
}

// ---------- 行情类型 + 方向评分（与回测 v4 预计算逻辑一致） ----------
function analyze(symbol = 'BTC', nowTs = Date.now()) {
  const { h4, d1 } = loadBars();
  const N4 = h4.length, N1 = d1.length;
  const dc = d1.map(b => b.c), hc = h4.map(b => b.c);
  // 只用到 nowTs 之前的数据（因果）
  const last4 = h4[N4 - 1].ts <= nowTs ? N4 - 1 : N4 - 2;
  const lastD = d1[N1 - 1].ts <= nowTs ? N1 - 1 : N1 - 2;
  const e20d = emaArr(dc, 20), e50d = emaArr(dc, 50), e200d = emaArr(dc, 200);
  const adxD = adxArr(d1, 14);
  const atrD = atrArr(d1, 14);
  const atrH4 = atrArr(h4, 14);
  const rsiH4 = rsiArr(hc, 14);
  const macdH4 = macdArr(hc);
  const e20h4 = emaArr(hc, 20), e50h4 = emaArr(hc, 50);
  const i = lastD;
  // 日线 regime
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
  // 波动率档位
  const atrPctHist = [];
  for (let k = 30; k <= i; k++) atrPctHist.push(atrD[k] / dc[k] * 100);
  const atrP = atrD[i] / dc[i] * 100;
  const ap = pctileRank(atrPctHist, atrP);
  const volLevel = ap >= 75 ? 'HIGH' : ap <= 30 ? 'LOW' : 'MID';
  // 日线趋势分
  let ts = 0;
  if (up && adxv >= 20) ts = 2.0; else if (dn && adxv >= 20) ts = -2.0;
  else if (e20d[i] > e50d[i]) ts = 0.6; else if (e20d[i] < e50d[i]) ts = -0.6;
  if (dc[i] > e200d[i]) ts += 0.8; else ts -= 0.8;
  // 4h 评分（用最后已收盘4h）
  let sc = ts;
  const j = last4;
  const mh = macdH4.hist[j], mhPrev = macdH4.hist[j - 1];
  if (mh > 0 && mhPrev <= 0) sc += 1.2; else if (mh < 0 && mhPrev >= 0) sc -= 1.2;
  else if (mh > 0) sc += 0.4; else if (mh < 0) sc -= 0.4;
  const curRsi = rsiH4[j];
  if (j > 40) {
    const seg = hc.slice(j - 40, j + 1);
    const lo4 = Math.min(...seg);
    const loIdx = j - 40 + seg.indexOf(lo4);
    if (hc[j] > lo4 * 1.01 && lo4 < seg[0] && curRsi > rsiH4[loIdx] + 3) sc += 0.8;
  }
  // FGI 情绪因子（与回测 use_fgi=1 一致：明确趋势 |趋势分|>=2 时不干扰方向）
  {
    const fv = lastFgi(nowTs);
    if (fv != null && Math.abs(ts) < 2.0) {
      if (fv <= 20) sc += 1.0;
      else if (fv <= 30) sc += 0.5;
      else if (fv >= 85) sc -= 1.0;
      else if (fv >= 70) sc -= 0.5;
    }
  }
  // 方向一致性（与回测 cons_only 一致）
  const h4Up = e20h4[j] > e50h4[j];
  const cons = (ts > 0 && sc > 0) || (ts < 0 && sc < 0);
  const dir = sc >= 3.0 ? 'long' : sc <= -3.0 ? 'short' : 'flat';
  const confidence = Math.min(1, Math.abs(sc) / 5);
  // 智能仓位计划（10000u 当 50000u 用）
  const atrV = atrH4[j] || hc[j] * 0.01;
  const stopDistPct = Math.min(6, Math.max(0.8, 2.8 * atrV / hc[j] * 100));
  let mult = 1.0;
  if (type === 'TREND_UP' || type === 'TREND_DOWN') mult = 1.2;
  else if (type === 'RANGE') mult = 0.85;
  if (volLevel === 'HIGH') mult *= 1.25; else if (volLevel === 'LOW') mult *= 0.8;
  const confMult = Math.abs(sc) >= 4 ? 1.1 : Math.abs(sc) >= 3 ? 1.05 : 1.0;
  const effStop = Math.max(0.8, Math.min(6, stopDistPct * mult * confMult));
  // 模拟账户复利（与回测 compound=1 同口径）：baseEq = 当前模拟权益（10000u 起步）
  const acc = simAccount();
  const baseEq = acc.equity;
  const effRp = acc.risk_pct_eff; // dd_fuse 熔断：回撤>3% → ×0.5；>5% → ×0.2
  const riskUsd = baseEq * effRp / 100;
  const notional = riskUsd / (effStop / 100);
  const liqDist = effStop * 1.3;
  const leverage = Math.min(50, Math.floor(100 / liqDist * 10) / 10);
  const margin = notional / leverage;
  const liqOffsetPct = 100 / leverage;
  const plan = {
    principal: PRINCIPAL, risk_pct: RISK_PCT, risk_usd: +riskUsd.toFixed(0),
    dd_fuse_pct: DD_FUSE, compound: 1, version: 'v4-15m精确执行',
    account_equity: +baseEq.toFixed(0), account_dd_pct: +acc.dd_pct.toFixed(2), risk_pct_eff: +effRp.toFixed(2),
    stop_dist_pct: +effStop.toFixed(2), notional_usd: +notional.toFixed(0),
    notional_multiple: +(notional / PRINCIPAL).toFixed(1),
    leverage: +leverage.toFixed(1), margin_usd: +margin.toFixed(0),
    margin_pct: +(margin / PRINCIPAL * 100).toFixed(2),
    liq_dist_pct: +liqOffsetPct.toFixed(2), liq_buffer: +((liqDist - effStop) / effStop).toFixed(2)
  };
  // 价格水平（止损/目标/爆仓价）
  const px = hc[j];
  const stop = dir === 'long' ? px * (1 - effStop / 100) : dir === 'short' ? px * (1 + effStop / 100) : null;
  const t1 = dir === 'long' ? px * (1 + effStop * 0.8 / 100) : dir === 'short' ? px * (1 - effStop * 0.8 / 100) : null;
  const liqPx = dir === 'long' ? px * (1 - liqDist / 100) : dir === 'short' ? px * (1 + liqDist / 100) : null;
  return {
    symbol, ts: nowTs, price: +px.toFixed(2),
    regime: { type, vol_level: volLevel, adx: +adxv.toFixed(1), adx_slope: +adxSlope.toFixed(1) },
    score: { value: +sc.toFixed(2), dir, confidence: +confidence.toFixed(2), cons,
             trend_d: +ts.toFixed(2), macd_4h: mh > 0 ? 'bull' : 'bear', rsi_4h: +curRsi.toFixed(1),
             ema20_gt_50_4h: h4Up },
    tradeable: cons && dir !== 'flat' && (type === 'TREND_UP' || type === 'TREND_DOWN' || type === 'TURN_UP' || type === 'TURN_DOWN'),
    plan, levels: { stop: stop != null ? +stop.toFixed(2) : null, target1: t1 != null ? +t1.toFixed(2) : null, liq_price: liqPx != null ? +liqPx.toFixed(2) : null },
    factors: {
      trend: up ? '日线多头排列' : dn ? '日线空头排列' : '日线震荡',
      ema200: dc[i] > e200d[i] ? 'EMA200上方' : 'EMA200下方',
      macd: mh > 0 ? '4h MACD多头' : '4h MACD空头',
      consistency: cons ? '方向一致✓' : '方向不一致✗'
    }
  };
}

// ---------- 实时衍生品快照（futures_markets，聚合费率/OI/清算/LSR） ----------
function derivSnapshot(w1db, symbol = 'BTC') {
  const row = w1db.prepare("SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 1").get();
  if (!row) return null;
  let data;
  try { data = JSON.parse(row.payload).data || []; } catch { return null; }
  const item = data.find(d => d.symbol === symbol);
  if (!item) return null;
  return {
    price: item.current_price,
    funding_rate: item.avg_funding_rate_by_oi,
    oi_usd: item.open_interest_usd,
    oi_chg_24h: item.open_interest_change_percent_24h,
    liq_24h: item.liquidation_usd_24h,
    long_liq_24h: item.long_liquidation_usd_24h,
    short_liq_24h: item.short_liquidation_usd_24h,
    lsr_4h: item.long_short_ratio_4h,
    lsr_24h: item.long_short_ratio_24h
  };
}

module.exports = { analyze, derivSnapshot, loadBars };
