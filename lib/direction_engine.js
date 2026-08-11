'use strict';
// ============================================================
// W1 v4 中低频方向系统引擎（2026-08-11 · William 老板指令）
// 大方向看准 → 关键行情吃到 → 高盈亏比胜率
// 核心: 行情体制闸门 × 多周期共振 × 资金面拥挤度 × AI共识 × 智能仓位
// 纪律: 只用截止时点数据（冻结时间，严禁未来函数）
// ============================================================
const Database = require('better-sqlite3');
const HIST_DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const W1_DB = '/home/ubuntu/w1-board/data/w1.db';
const REAL_ACCOUNT = 10000;      // 真实账户 10000U
const VIRTUAL_ACCOUNT = 50000;   // 视同账户 50000U（10000 当 50000 用）
const LEVER = 100;               // 交易所杠杆 100x

let _hist = null, _w1 = null;
function histDb() { if (!_hist) _hist = new Database(HIST_DB, { readonly: true }); return _hist; }
function w1Db() { if (!_w1) _w1 = new Database(W1_DB, { readonly: true }); return _w1; }

/* ---------------- 基础指标 ---------------- */
function ema(arr, n) { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; }
function sma(arr, n) { if (arr.length < n) return null; return arr.slice(-n).reduce((a, b) => a + b, 0) / n; }
function rsiOf(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / n) / (l / n));
}
function macdOf(closes, f = 12, s = 26, sig = 9) {
  if (closes.length < s + sig) return [null, null, null];
  const ef = ema(closes, f), es = ema(closes, s);
  const dif = ef.map((a, i) => a - es[i]);
  const dea = ema(dif, sig);
  return [dif[dif.length - 1], dea[dea.length - 1], (dif[dif.length - 1] - dea[dea.length - 1]) * 2];
}
function adxOf(bars, n = 14) {
  if (bars.length < n + 1) return null;
  let pDM = 0, mDM = 0, trSum = 0, dxPrev = 0;
  const start = Math.max(1, bars.length - n * 2);
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    const pDm = up > dn && up > 0 ? up : 0, mDm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { pDM += pDm; mDM += mDm; trSum += tr; if (i < n) continue; }
    else { pDM = pDM - pDM / n + pDm; mDM = mDM - mDM / n + mDm; trSum = trSum - trSum / n + tr; }
    const pdi = 100 * pDM / (trSum || 1), mdi = 100 * mDM / (trSum || 1);
    const dx = 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1);
    dxPrev = i === n ? dx : (dxPrev * (n - 1) + dx) / n;
  }
  return dxPrev;
}
function zscoreOf(arr) {
  const n = arr.length; if (n < 8) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return sd === 0 ? 0 : (arr[n - 1] - m) / sd;
}
function pctileRank(arr, v) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted.filter(x => x <= v).length / sorted.length;
}
function atrPctOf(d1bars, n = 14) {
  if (d1bars.length < n + 1) return null;
  let sum = 0;
  for (let i = d1bars.length - n; i < d1bars.length; i++) {
    const b = d1bars[i], p = d1bars[i - 1];
    const tr = Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
    sum += tr / p.c;
  }
  return sum / n * 100;
}

/* ---------------- 历史K线加载（冻结时点） ---------------- */
function loadD1(freezeMs) {
  const db = histDb();
  const rows = db.prepare(`
    SELECT date(ts/1000,'unixepoch','+8 hours') d, MIN(o) o, MAX(h) h, MIN(l) l,
           (SELECT c FROM klines k2 WHERE k2.symbol=k1.symbol AND k2.ts=(SELECT MAX(ts) FROM klines k3 WHERE k3.symbol=k1.symbol AND date(k3.ts/1000,'unixepoch','+8 hours')=date(k1.ts/1000,'unixepoch','+8 hours'))) c,
           SUM(v) v
    FROM klines k1 WHERE symbol='BTCUSDT' AND ts < ? GROUP BY d ORDER BY d
  `).all(freezeMs);
  return rows.map(r => ({ d: r.d, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
}
function loadH1(freezeMs, lookbackDays = 30) {
  const db = histDb();
  const from = freezeMs - lookbackDays * 86400000;
  return db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' AND ts>=? AND ts<? ORDER BY ts").all(from, freezeMs);
}
function loadFunding(freezeMs, n = 90) {
  const db = histDb();
  return db.prepare("SELECT ts, rate FROM funding WHERE ts < ? ORDER BY ts DESC LIMIT ?").all(freezeMs, n).reverse();
}
function loadFgi(freezeMs) {
  const db = histDb();
  const r = db.prepare("SELECT value FROM fgi WHERE ts < ? ORDER BY ts DESC LIMIT 1").get(Math.floor(freezeMs / 1000));
  return r ? r.value : null;
}

/* ---------------- 1. 行情体制（闸门） ---------------- */
// 返回 { regime: TREND_UP|TREND_DOWN|RANGE|STORM, adx, bbw, volPct, fundZ, detail }
function marketRegime(d1bars, fundingRates) {
  const closes = d1bars.map(b => b.c);
  const adx = adxOf(d1bars);
  // 布林带宽（20日）
  let bbw = null;
  if (closes.length >= 20) {
    const seg = closes.slice(-20);
    const mid = seg.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(seg.reduce((a, b) => a + (b - mid) ** 2, 0) / 20);
    bbw = sd ? ((mid + 2 * sd) - (mid - 2 * sd)) / mid * 100 : 0;
  }
  // 波动率分位（近 120 日 ATR%）
  let volPct = null;
  if (d1bars.length >= 30) {
    const atrSeries = [];
    for (let i = 29; i < d1bars.length; i++) {
      const seg = d1bars.slice(i - 13, i + 1);
      let sum = 0;
      for (let j = 1; j < seg.length; j++) {
        const b = seg[j], p = seg[j - 1];
        const tr = Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
        sum += tr / p.c;
      }
      atrSeries.push(sum / 14 * 100);
    }
    const cur = atrSeries[atrSeries.length - 1];
    volPct = pctileRank(atrSeries, cur);
  }
  const s7 = sma(closes, 7), s25 = sma(closes, 25), s99 = sma(closes, 99);
  const price = closes[closes.length - 1];
  const slope = s7 && s25 ? (s7 - s25) / s25 * 100 : 0;
  const fundZ = fundingRates.length >= 10 ? zscoreOf(fundingRates.map(r => r.rate)) : 0;
  const s25Slope = s25 && closes.length >= 26 ? (s25 / sma(closes.slice(0, -1), 25) - 1) * 100 : 0;

  let regime;
  const storm = (volPct != null && volPct >= 0.95) || (bbw != null && bbw >= 9);
  if (storm) regime = 'STORM';
  else if (adx != null && adx >= 25 && s7 > s25 && s25 > s99) regime = 'TREND_UP';
  else if (adx != null && adx >= 25 && s7 < s25 && s25 < s99) regime = 'TREND_DOWN';
  else if (adx != null && adx < 18 && bbw != null && bbw < 6) regime = 'RANGE';
  else if (s7 > s25 && s25 > s99) regime = 'TREND_UP';       // 弱趋势也认多头排列
  else if (s7 < s25 && s25 < s99) regime = 'TREND_DOWN';
  else regime = 'RANGE';

  return { regime, adx: adx ? +adx.toFixed(1) : null, bbw: bbw ? +bbw.toFixed(2) : null, volPct: volPct != null ? +(volPct * 100).toFixed(0) : null, fundZ: +fundZ.toFixed(2), slope: +slope.toFixed(2), price, s7: s7 && +s7.toFixed(0), s25: s25 && +s25.toFixed(0), s99: s99 && +s99.toFixed(0), s25Slope: +s25Slope.toFixed(2) };
}

/* ---------------- 2. 多周期共振（日/4H/1H） ---------------- */
function tfDirection(bars, tfHours) {
  // 聚合到 tf 周期，看 SMA(周期) 斜率 + MACD
  const buckets = [];
  for (const b of bars) {
    const key = Math.floor(b.ts / (tfHours * 3600000));
    let bk = buckets[buckets.length - 1];
    if (!bk || bk.key !== key) { bk = { key, o: b.o, h: b.h, l: b.l, c: b.c }; buckets.push(bk); }
    else { bk.h = Math.max(bk.h, b.h); bk.l = Math.min(bk.l, b.l); bk.c = b.c; }
  }
  if (buckets.length < 40) return null;
  const closes = buckets.map(b => b.c);
  const s = sma(closes, Math.max(3, Math.round(20 * 24 / tfHours)));
  const [, , hist] = macdOf(closes, 12, 26, 9);
  const sPrev = sma(closes.slice(0, -1), Math.max(3, Math.round(20 * 24 / tfHours)));
  const slope = s && sPrev ? (s - sPrev) / sPrev * 100 : 0;
  const dir = slope > 0.05 || (hist != null && hist > 0 && slope > 0) ? 1 : slope < -0.05 || (hist != null && hist < 0 && slope < 0) ? -1 : 0;
  return dir;
}

/* ---------------- 3. 实时资金面（w1.db） ---------------- */
function crowdCheck(symbol = 'BTC') {
  try {
    const db = w1Db();
    const snap = db.prepare("SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 1").get();
    let out = { lsr: null, lsrWhale: null, funding: null, oiChange: null };
    if (snap) {
      const arr = JSON.parse(snap.payload).data || [];
      const b = arr.find(x => (x.symbol || '').toUpperCase() === (symbol + 'USDT').toUpperCase()) || arr.find(x => (x.symbol || '').toUpperCase() === symbol.toUpperCase());
      if (b) {
        out.lsr = b.long_short_ratio_4h != null ? +b.long_short_ratio_4h : null;
        out.funding = b.avg_funding_rate_by_oi != null ? +b.avg_funding_rate_by_oi : null;
        out.oiChange = b.open_interest_change_24h != null ? +b.open_interest_change_24h : null;
      }
    }
    // 鲸鱼多空比（lsr_rankings whale mode）
    const wr = db.prepare("SELECT payload FROM lsr_rankings WHERE mode='whale' ORDER BY ts DESC LIMIT 1").get();
    if (wr) {
      try {
        const d = JSON.parse(wr.payload);
        const b = (d.data || []).find(x => x.symbol === symbol + 'USDT') || (d.data || []).find(x => x.symbol === symbol);
        if (b && b.whale_ratio != null) out.lsrWhale = +b.whale_ratio;
      } catch {}
    }
    // AI 共识
    const con = db.prepare("SELECT payload FROM consensus ORDER BY ts DESC LIMIT 1").get();
    if (con) {
      try {
        const arr = JSON.parse(con.payload);
        const c = arr.find(x => x.symbol === symbol + 'USDT') || arr.find(x => (x.display_symbol || '') === symbol);
        if (c) out.consensus = { decision: c.decision, bias: c.trust_adjusted_bias, confidence: c.confidence };
      } catch {}
    }
    // 恐惧贪婪
    const fg = db.prepare("SELECT value FROM fear_greed ORDER BY ts DESC LIMIT 1").get();
    if (fg) out.fgi = fg.value;
    return out;
  } catch { return { lsr: null, lsrWhale: null, funding: null, oiChange: null }; }
}

/* ---------------- 4. 方向综合评分 ---------------- */
// 返回 { score(-10~10), direction, label, pos_base, reasons[], regime, tf, crowd }
function directionScore(freezeMs) {
  const d1 = loadD1(freezeMs);
  if (d1.length < 60) return null;
  const h1 = loadH1(freezeMs);
  const funding = loadFunding(freezeMs);
  const fgiHist = loadFgi(freezeMs);
  const rg = marketRegime(d1, funding);
  const closes = d1.map(b => b.c);
  const price = closes[closes.length - 1];
  let score = 0; const reasons = [];

  // --- 技术面（权重最高 ±6）---
  // 体制
  if (rg.regime === 'TREND_UP') { score += 2.0; reasons.push(`体制:上升趋势 ADX${rg.adx} +2.0`); }
  else if (rg.regime === 'TREND_DOWN') { score -= 2.0; reasons.push(`体制:下降趋势 ADX${rg.adx} -2.0`); }
  else if (rg.regime === 'STORM') { score -= 0.5; reasons.push('体制:风暴高波动 -0.5'); }
  // RSI
  const rsi = rsiOf(closes);
  if (rsi != null) {
    if (rsi < 28) { score += 1.5; reasons.push(`RSI ${rsi.toFixed(0)} 超卖 +1.5`); }
    else if (rsi > 72) { score -= 1.5; reasons.push(`RSI ${rsi.toFixed(0)} 超买 -1.5`); }
  }
  // MACD
  const [, , hist] = macdOf(closes);
  if (hist != null) {
    if (hist > 0) { score += 1.0; reasons.push(`MACD 多头 ${hist.toFixed(1)} +1.0`); }
    else { score -= 1.0; reasons.push(`MACD 空头 ${hist.toFixed(1)} -1.0`); }
  }
  // 均线排列
  const s7 = sma(closes, 7), s25 = sma(closes, 25), s99 = sma(closes, 99);
  if (s7 && s25 && s99) {
    if (s7 > s25 && s25 > s99) { score += 1.0; reasons.push('均线多头排列 +1.0'); }
    else if (s7 < s25 && s25 < s99) { score -= 1.0; reasons.push('均线空头排列 -1.0'); }
  }
  // 多周期共振（日/4H/1H）
  const tfD = tfDirection(h1, 24);
  const tf4 = tfDirection(h1, 4);
  const tf1 = tfDirection(h1, 1);
  const tfScore = (tfD || 0) + (tf4 || 0) + (tf1 || 0);
  if (tfScore >= 2) { score += 1.5; reasons.push(`多周期共振向上(${tfD}/${tf4}/${tf1}) +1.5`); }
  else if (tfScore <= -2) { score -= 1.5; reasons.push(`多周期共振向下(${tfD}/${tf4}/${tf1}) -1.5`); }
  // 20日动量极端
  const mom20 = closes.length >= 21 ? (price / closes[closes.length - 21] - 1) * 100 : null;
  if (mom20 != null) {
    if (mom20 < -12) { score += 0.8; reasons.push(`20日超跌 ${mom20.toFixed(1)}% +0.8`); }
    else if (mom20 > 12) { score -= 0.8; reasons.push(`20日过热 ${mom20.toFixed(1)}% -0.8`); }
  }

  // --- 资金面（±3）---
  const fundZ = rg.fundZ;
  if (fundZ > 2) { score -= 1.5; reasons.push(`资金费率过热 z=${fundZ} 多拥挤 -1.5`); }
  else if (fundZ < -2) { score += 1.5; reasons.push(`资金费率负 z=${fundZ} 空拥挤 +1.5`); }
  else if (fundZ > 1.2) { score -= 0.5; reasons.push(`资金费率偏高 z=${fundZ} -0.5`); }
  else if (fundZ < -1.2) { score += 0.5; reasons.push(`资金费率偏低 z=${fundZ} +0.5`); }
  // FGI（历史）
  if (fgiHist != null) {
    if (fgiHist < 20) { score += 1.0; reasons.push(`FGI ${fgiHist} 极度恐惧 +1.0`); }
    else if (fgiHist < 30) { score += 0.5; reasons.push(`FGI ${fgiHist} 恐惧 +0.5`); }
    else if (fgiHist > 80) { score -= 1.0; reasons.push(`FGI ${fgiHist} 极度贪婪 -1.0`); }
  }

  // --- 判定 ---
  let direction = null, label = '⚡ 观望', pos_base = 0;
  if (score >= 3.2) { direction = 'long'; label = '🚀 强烈看多'; pos_base = 12; }
  else if (score >= 2.0) { direction = 'long'; label = '📈 看多'; pos_base = 8; }
  else if (score >= 1.2) { direction = 'long'; label = '↗️ 谨慎看多'; pos_base = 3; }
  else if (score <= -3.2) { direction = 'short'; label = '🛑 强烈看空'; pos_base = 12; }
  else if (score <= -2.0) { direction = 'short'; label = '📉 看空'; pos_base = 8; }
  else if (score <= -1.2) { direction = 'short'; label = '↘️ 谨慎看空'; pos_base = 3; }

  // 体制闸门：RANGE/STORM 不追信号（震荡只做两端，风暴禁手）
  if (direction && (rg.regime === 'STORM')) { direction = null; label = '⚡ 观望'; pos_base = 0; reasons.push('体制闸门:风暴期禁手'); }
  else if (direction && rg.regime === 'RANGE' && Math.abs(score) < 2.5) {
    // 震荡市允许两端的强反转信号
    const rsiV = rsiOf(closes);
    const atExtreme = rsiV != null && (rsiV < 32 || rsiV > 68);
    if (!atExtreme) { direction = null; label = '⚡ 观望'; pos_base = 0; reasons.push('体制闸门:震荡市无极端不追'); }
  }

  return { score: +score.toFixed(2), direction, label, pos_base, reasons, regime: rg, tf: { d: tfD, h4: tf4, h1: tf1 }, fgi: fgiHist, fundingZ: fundZ, price };
}

/* ---------------- 5. 智能仓位（10000U 当 50000U 用，爆仓价可控） ----------------
 * 核心：止损距离 = max(ATR×mult, 价×0.6%)
 *      爆仓距离 = 止损距离 × 1.2（永远先止损，不爆仓）
 *      等效杠杆 = 1 / 爆仓距离      → 实际保证金% = 等效杠杆 × 真实账户 / 100x
 *      名义 = 视同账户 × pos_pct%    → pos_pct = 等效杠杆 × VIRTUAL/100x / VIRTUAL... 
 * 简化推导：保证金 = 名义/等效杠杆 → 实际占用% = (VIRTUAL×pos%/等效杠杆)/REAL
 *          令 止损% = stopDist/price → 等效杠杆 L = 1/(stopDist×1.2/price)
 *          pos% = L × REAL / VIRTUAL / 100 × 100 ... 直接算：
 *          名义 = VIRTUAL × pos_pct% ; 保证金 = 名义/L ; 要求 保证金 ≤ REAL×maxUse
 *          → pos_pct = min(12, REAL×maxUse×L/VIRTUAL×100)
 */
function smartPosition(rg, pos_base, price, fgiHist) {
  const mult = pos_base >= 8 ? 2.0 : pos_base >= 3 ? 1.5 : 1.2;
  const atr = rg.atrPct != null ? rg.atrPct : 1.8;
  let stopDist = Math.max(atr * mult, 0.6);
  // 震荡市收窄止损（快进快出），趋势市放宽（吃足趋势）
  if (rg.regime === 'RANGE') stopDist = Math.min(stopDist, atr * 1.2);
  if (rg.regime === 'TREND_UP' || rg.regime === 'TREND_DOWN') stopDist = Math.max(stopDist, atr * 2.2);
  stopDist = Math.min(stopDist, 4.5);          // 硬上限，防止止损太远
  const liqDist = stopDist * 1.2;              // 爆仓价 = 止损价之外 20%
  const effLev = 1 / (liqDist / 100);          // 等效杠杆（爆仓距离的倒数）
  const maxUse = 0.9;                          // 单笔最多占用真实账户 90% 保证金
  let posPct = Math.min(12, REAL_ACCOUNT * maxUse * effLev / VIRTUAL_ACCOUNT * 100);
  // 强度上限
  posPct = Math.min(posPct, pos_base);
  // FGI 折扣
  let fgiDisc = 1;
  if (fgiHist != null) {
    if (fgiHist <= 20) fgiDisc = 0.3;
    else if (fgiHist <= 30) fgiDisc = 0.5;
    else if (fgiHist <= 45) fgiDisc = 0.7;
    else if (fgiHist >= 80) fgiDisc = 0.7;
  }
  posPct = Math.round(posPct * fgiDisc * 100) / 100;
  posPct = Math.min(12, Math.max(0, posPct));
  // 实际占用（10000U 账户）
  const marginUsed = REAL_ACCOUNT * posPct / 100;
  const notional = VIRTUAL_ACCOUNT * posPct / 100;
  const liqPxOff = liqDist / 100;
  return {
    pos_pct: posPct,                 // 视同仓位%（基于 50000U）
    margin_used: +marginUsed.toFixed(2),  // 实际占用真实账户的保证金 U
    margin_pct_real: +(posPct * VIRTUAL_ACCOUNT / REAL_ACCOUNT).toFixed(1), // 实际占用真实账户 %
    notional: Math.round(notional),  // 名义仓位 U（50000U 视角）
    eff_leverage: +effLev.toFixed(1),// 等效杠杆（爆仓距离控制后）
    stop_dist_pct: +stopDist.toFixed(2),
    liq_dist_pct: +liqDist.toFixed(2),
    liq_px_off: +liqPxOff.toFixed(4),
    fgi_discount: fgiDisc,
    note: posPct > 0 ? `10000U 当 50000U 用: 名义${Math.round(notional)}U, 等效杠杆${effLev.toFixed(1)}x, 爆仓价距入场 ${liqDist.toFixed(1)}%` : '观望'
  };
}

/* ---------------- 6. 完整信号（历史模式） ---------------- */
function signalAt(freezeMs, symbol = 'BTC') {
  const sc = directionScore(freezeMs);
  if (!sc) return null;
  const pos = smartPosition(sc.regime, sc.pos_base, sc.price, sc.fgi);
  // 实时资金面补充（历史模式跳过）
  return {
    ts: freezeMs, date: new Date(freezeMs).toISOString().slice(0, 10),
    price: sc.price, direction: sc.direction, label: sc.label,
    score: sc.score, pos_base: sc.pos_base,
    pos_pct: pos.pos_pct, margin_used: pos.margin_used, notional: pos.notional,
    eff_leverage: pos.eff_leverage, stop_dist_pct: pos.stop_dist_pct,
    liq_dist_pct: pos.liq_dist_pct, liq_px_off: pos.liq_px_off,
    fgi: sc.fgi, funding_z: sc.fundingZ,
    regime: sc.regime.regime, adx: sc.regime.adx, bbw: sc.regime.bbw,
    vol_pct: sc.regime.volPct, tf: sc.tf,
    reasons: sc.reasons, note: pos.note
  };
}

/* ---------------- 7. 实盘模式（含实时资金面 + 智能仓位 + 实仓标注） ---------------- */
function liveSignal(symbol = 'BTC') {
  const now = Date.now();
  const sc = directionScore(now);
  if (!sc) return { ok: false, error: '数据不足' };
  const crowd = crowdCheck(symbol);
  // 实时资金面叠加进评分（AI共识 ±0.8 / LSR 极端 ±0.8 / 实时FGI）
  let finalScore = sc.score;
  const extra = [];
  if (crowd.consensus) {
    const b = crowd.consensus.bias || 0;
    if (b > 0.05) { finalScore += 0.6; extra.push(`AI共识偏多 ${b.toFixed(2)} +0.6`); }
    else if (b < -0.05) { finalScore -= 0.6; extra.push(`AI共识偏空 ${b.toFixed(2)} -0.6`); }
  }
  if (crowd.lsrWhale != null) {
    if (crowd.lsrWhale > 2.5) { finalScore -= 0.8; extra.push(`鲸鱼多空比 ${crowd.lsrWhale.toFixed(2)} 极端偏多(警惕) -0.8`); }
    else if (crowd.lsrWhale < 0.4) { finalScore += 0.8; extra.push(`鲸鱼多空比 ${crowd.lsrWhale.toFixed(2)} 极端偏空(机会) +0.8`); }
  }
  if (crowd.oiChange != null && crowd.oiChange > 8 && crowd.funding && crowd.funding > 0.0005) {
    finalScore -= 0.5; extra.push(`OI暴增+正费率 多头过热 -0.5`);
  }
  // 用叠加后的分数重判方向
  let direction = sc.direction, label = sc.label, pos_base = sc.pos_base;
  if (finalScore >= 3.2) { direction = 'long'; label = '🚀 强烈看多'; pos_base = 12; }
  else if (finalScore >= 2.0) { direction = 'long'; label = '📈 看多'; pos_base = 8; }
  else if (finalScore >= 1.2) { direction = 'long'; label = '↗️ 谨慎看多'; pos_base = 3; }
  else if (finalScore <= -3.2) { direction = 'short'; label = '🛑 强烈看空'; pos_base = 12; }
  else if (finalScore <= -2.0) { direction = 'short'; label = '📉 看空'; pos_base = 8; }
  else if (finalScore <= -1.2) { direction = 'short'; label = '↘️ 谨慎看空'; pos_base = 3; }
  else { direction = null; label = '⚡ 观望'; pos_base = 0; }
  if (direction && sc.regime.regime === 'STORM') { direction = null; label = '⚡ 观望'; pos_base = 0; }

  const fgiReal = crowd.fgi != null ? crowd.fgi : sc.fgi;
  const pos = smartPosition(sc.regime, pos_base, sc.price, fgiReal);
  // 止损/止盈/爆仓价（共享 buildOrder，实盘=回测同公式）
  const ord = direction ? buildOrder(sc.price, direction, pos) : null;
  let entry = ord ? ord.entry : sc.price, stop = ord ? ord.stop : null, t1 = ord ? ord.t1 : null, t2 = ord ? ord.t2 : null, liqPx = ord ? ord.liqPx : null;
  return {
    ok: true, ts: now, symbol,
    price: sc.price, direction, label, score: +finalScore.toFixed(2),
    pos_base, pos_pct: pos.pos_pct, margin_used: pos.margin_used,
    margin_pct_real: pos.margin_pct_real, notional: pos.notional,
    eff_leverage: pos.eff_leverage, fgi_discount: pos.fgi_discount,
    entry: entry && Math.round(entry), stop: stop && Math.round(stop),
    target1: t1 && Math.round(t1), target2: t2 && Math.round(t2),
    liq_px: liqPx && Math.round(liqPx), liq_dist_pct: pos.liq_dist_pct,
    regime: sc.regime.regime, adx: sc.regime.adx, bbw: sc.regime.bbw, vol_pct: sc.regime.volPct,
    tf: sc.tf, funding_z: sc.fundingZ, crowd,
    reasons: [...sc.reasons, ...extra], note: pos.note,
    // 实仓标注（会员跟单）：10000U 账户实际开仓
    real: direction ? {
      account: REAL_ACCOUNT,
      margin: pos.margin_used,                       // 实际占用保证金 U
      notional: pos.notional,                        // 名义 U（视同 50000U 仓位）
      qty_btc: +(pos.notional / entry).toFixed(6),   // 实际 BTC 数量（100x 下）
      eff_lev: pos.eff_leverage,
      liq_price: Math.round(liqPx),
      risk_usd: +(pos.margin_used).toFixed(2)        // 爆仓最大损失 = 保证金
    } : null
  };
}

module.exports = { signalAt, liveSignal, marketRegime, directionScore, smartPosition, buildOrder, REAL_ACCOUNT, VIRTUAL_ACCOUNT, LEVER };

/* ---------------- 8. 共享建仓（实盘/回测同公式，杜绝漂移） ---------------- */
function buildOrder(price, direction, pos) {
  const stopDist = pos.stop_dist_pct / 100;
  let entry = price, stop, t1, t2, liqPx;
  if (direction === 'long') { stop = entry * (1 - stopDist); liqPx = entry * (1 - pos.liq_px_off); t1 = entry * (1 + stopDist * 1.5); t2 = entry * (1 + stopDist * 2.5); }
  else { stop = entry * (1 + stopDist); liqPx = entry * (1 + pos.liq_px_off); t1 = entry * (1 - stopDist * 1.5); t2 = entry * (1 - stopDist * 2.5); }
  return { entry, stop, t1, t2, liqPx };
}
