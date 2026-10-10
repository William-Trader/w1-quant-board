'use strict';
// ============================================================
// W1 中低频方向判断引擎 v1.0（2026-08-11 William 老板指令）
// 目标：大方向看准 · 高盈亏比 · 胜率>67% · 夏普>1
//   - 行情类型判断（regime2）：趋势/震荡/转折 + 波动率档位
//   - 方向评分（4h级别，日线定方向，宁缺毋滥）
//   - 智能仓位管理：风险预算制，10000u 当 50000u 用
//     爆仓价 = 保证金% 精确反推，保证止损先于爆仓触发
//   - 全系统数据可用：K线/费率/OI/LSR/FGI/清算
// 只用截止时点数据（严禁未来函数），与回测同口径
// ============================================================

// ---------- 指标工具（纯函数，全序列） ----------
function smaArr(arr, n) {
  const out = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= n) s -= arr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function emaArr(arr, n) {
  const k = 2 / (n + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}
function rsiArr(closes, n = 14) {
  const out = new Array(closes.length).fill(50);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g = g * (n - 1) / n + d; else g = g * (n - 1) / n;
    if (d < 0) l = l * (n - 1) / n - d; else l = l * (n - 1) / n;
    if (i >= n) {
      const rs = l === 0 ? 100 : g / l;
      out[i] = 100 - 100 / (1 + rs);
    }
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
  const out = new Array(bars.length).fill(0);
  let pDM = 0, mDM = 0, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    const pDm = up > dn && up > 0 ? up : 0;
    const mDm = dn > up && dn > 0 ? dn : 0;
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
function zscoreOf(arr) {
  if (arr.length < 5) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  return sd === 0 ? 0 : (arr[arr.length - 1] - m) / sd;
}
function pctileRank(arr, v) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted.filter(x => x <= v).length / sorted.length;
}

// ---------- 行情类型判断（regime2）----------
// 输入: 日线 + 4h K线（截至 freezeIdx）
// 输出: { type: TREND_UP|TREND_DOWN|RANGE|TURN, vol_level: LOW|MID|HIGH, adx, bbw_pct, ... }
function classifyRegime(d1, h4, freezeIdxH4) {
  const dc = d1.map(b => b.c);
  const n = dc.length;
  if (n < 60) return { type: 'RANGE', vol_level: 'MID', adx: 0, bbw_pct: 50, reason: 'data' };
  const last = n - 1;
  const e20 = emaArr(dc, 20), e50 = emaArr(dc, 50), e200 = emaArr(dc, 200);
  const adx = adxArr(d1, 14);
  const adxv = adx[last] || 0;
  const adxSlope = adxv - (adx[last - 5] || 0);
  // 布林带宽分位（日线）
  const bbs = [];
  for (let i = 50; i <= last; i++) {
    const seg = dc.slice(i - 20 + 1, i + 1);
    const m = seg.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
    if (sd > 0) bbs.push((4 * sd) / dc[i]);
  }
  const curBbw = bbs.length ? (4 * Math.sqrt(dc.slice(-20).reduce((a, b) => a + (b - smaArr(dc, 20)[last]) ** 2, 0) / 20)) / dc[last] : 0;
  const bbwPct = pctileRank(bbs, curBbw);
  // 波动率档位（ATR%分位）
  const atrD = atrArr(d1, 14);
  const atrPct = atrD[last] / dc[last] * 100;
  const atrHist = [];
  for (let i = 30; i <= last; i++) atrHist.push(atrD[i] / dc[i] * 100);
  const atrPctile = pctileRank(atrHist, atrPct);
  const volLevel = atrPctile >= 0.75 ? 'HIGH' : atrPctile <= 0.3 ? 'LOW' : 'MID';
  // 均线排列
  const up = e20[last] > e50[last] && e50[last] > e200[last];
  const dn = e20[last] < e50[last] && e50[last] < e200[last];
  // 转折检测：20/50 金叉死叉 + ADX 低位
  const crossUp = e20[last] > e50[last] && e20[last - 1] <= e50[last - 1];
  const crossDn = e20[last] < e50[last] && e20[last - 1] >= e50[last - 1];
  let type;
  if (adxv >= 25 && up && adxSlope > -1) type = 'TREND_UP';
  else if (adxv >= 25 && dn && adxSlope < 1) type = 'TREND_DOWN';
  else if (crossUp && adxv < 25) type = 'TURN_UP';
  else if (crossDn && adxv < 25) type = 'TURN_DOWN';
  else if (adxv < 20) type = 'RANGE';
  else type = adxv >= 25 ? (up ? 'TREND_UP' : dn ? 'TREND_DOWN' : 'RANGE') : 'RANGE';
  // 4h 短趋势（辅助）
  const h4c = h4.map(b => b.c);
  const e20h = emaArr(h4c, 20), e50h = emaArr(h4c, 50);
  const i4 = h4c.length - 1;
  const h4Up = e20h[i4] > e50h[i4];
  return { type, vol_level: volLevel, adx: +adxv.toFixed(1), bbw_pct: bbwPct != null ? +(bbwPct * 100).toFixed(0) : null, atr_pct: +atrPct.toFixed(2), atr_pctile: atrPctile != null ? +(atrPctile * 100).toFixed(0) : null, h4_up: h4Up };
}

// ---------- 方向评分（4h 级别，日线定方向）----------
// 输入: d1日线 + h4 4hK线 + 资金面快照（费率z/OI/LSR/FGI/清算）
// 输出: { score, dir: long|short|flat, confidence, factors: [...] }
function scoreDirection(d1, h4, snaps) {
  const dc = d1.map(b => b.c);
  const hc = h4.map(b => b.c);
  const n = dc.length, last = n - 1;
  if (n < 60 || hc.length < 60) return { score: 0, dir: 'flat', confidence: 0, factors: [] };
  let score = 0;
  const factors = [];
  const px = dc[last];
  // ===== 趋势因子（日线，权重最高）=====
  const e20 = emaArr(dc, 20), e50 = emaArr(dc, 50), e200 = emaArr(dc, 200);
  const adx = adxArr(d1, 14)[last] || 0;
  const up = e20[last] > e50[last] && e50[last] > e200[last];
  const dn = e20[last] < e50[last] && e50[last] < e200[last];
  if (up && adx >= 20) { score += 2.0; factors.push(`日线多头排列 ADX${adx.toFixed(0)} +2.0`); }
  else if (dn && adx >= 20) { score -= 2.0; factors.push(`日线空头排列 ADX${adx.toFixed(0)} -2.0`); }
  else if (e20[last] > e50[last]) { score += 0.6; factors.push('日线EMA20>50 +0.6'); }
  else if (e20[last] < e50[last]) { score -= 0.6; factors.push('日线EMA20<50 -0.6'); }
  // 价格 vs 日线EMA200（牛熊分界）
  if (px > e200[last]) { score += 0.8; factors.push('日线EMA200上方 +0.8'); }
  else { score -= 0.8; factors.push('日线EMA200下方 -0.8'); }
  // ===== 动量因子（4h）=====
  const rsi4 = rsiArr(hc, 14)[hc.length - 1];
  const macd4 = macdArr(hc);
  const mh = macd4.hist[hc.length - 1];
  const mhPrev = macd4.hist[hc.length - 2];
  if (mh > 0 && mhPrev <= 0) { score += 1.2; factors.push(`4h MACD金叉 +1.2`); }
  else if (mh < 0 && mhPrev >= 0) { score -= 1.2; factors.push(`4h MACD死叉 -1.2`); }
  else if (mh > 0) { score += 0.4; factors.push(`4h MACD多头 +0.4`); }
  else if (mh < 0) { score -= 0.4; factors.push(`4h MACD空头 -0.4`); }
  // RSI 背离检测（4h，简化版：价格新低 RSI 不新低 = 底背离）
  const rsiA = rsiArr(hc, 14);
  const lo4 = Math.min(...hc.slice(-40));
  const loIdx = hc.lastIndexOf(lo4);
  const rsiAtLo = rsiA[loIdx];
  const curRsi = rsiA[hc.length - 1];
  if (px > lo4 * 1.01 && lo4 < hc.slice(-40)[0] && curRsi > rsiAtLo + 3) { score += 0.8; factors.push('4h底背离 +0.8'); }
  // ===== 资金面因子 =====
  if (snaps) {
    const { fundingZ, oiChg, lsrTrader, lsrWhale, fgi, liqLongPct } = snaps;
    // 费率 z（月化聚合）：极端正=多头拥挤（逆势空），极端负=空头拥挤（逆势多）
    if (fundingZ != null) {
      if (fundingZ >= 2.0) { score -= 0.8; factors.push(`费率z ${fundingZ.toFixed(1)} 多头拥挤 -0.8`); }
      else if (fundingZ <= -2.0) { score += 0.8; factors.push(`费率z ${fundingZ.toFixed(1)} 空头拥挤 +0.8`); }
    }
    // OI：增仓上涨=新多进场确认趋势；增仓下跌=新空进场
    if (oiChg != null) {
      if (oiChg > 3 && up) { score += 0.6; factors.push(`OI +${oiChg.toFixed(0)}% 增仓上涨 +0.6`); }
      else if (oiChg > 3 && dn) { score -= 0.6; factors.push(`OI +${oiChg.toFixed(0)}% 增仓下跌 -0.6`); }
      else if (oiChg < -5) { score -= 0.3; factors.push(`OI ${oiChg.toFixed(0)}% 减仓离场 -0.3`); }
    }
    // LSR 双维度：极端反向
    if (lsrTrader != null) {
      if (lsrTrader > 2.0) { score -= 1.0; factors.push(`LSR散户 ${lsrTrader.toFixed(2)} 极端做多 -1.0`); }
      else if (lsrTrader < 0.5) { score += 1.0; factors.push(`LSR散户 ${lsrTrader.toFixed(2)} 极端做空 +1.0`); }
    }
    if (lsrWhale != null) {
      if (lsrWhale > 2.0) { score -= 0.8; factors.push(`LSR鲸鱼 ${lsrWhale.toFixed(2)} 极端做多 -0.8`); }
      else if (lsrWhale < 0.5) { score += 0.8; factors.push(`LSR鲸鱼 ${lsrWhale.toFixed(2)} 极端做空 +0.8`); }
    }
    // FGI 反向（极端情绪）
    if (fgi != null) {
      if (fgi <= 20) { score += 1.0; factors.push(`FGI ${fgi} 极度恐惧 +1.0`); }
      else if (fgi <= 30) { score += 0.5; factors.push(`FGI ${fgi} 恐惧 +0.5`); }
      else if (fgi >= 85) { score -= 1.0; factors.push(`FGI ${fgi} 极度贪婪 -1.0`); }
      else if (fgi >= 70) { score -= 0.5; factors.push(`FGI ${fgi} 贪婪 -0.5`); }
    }
    // 清算失衡：多头爆仓多=下杀尾部（反弹概率），空头爆仓多=逼空
    if (liqLongPct != null) {
      if (liqLongPct > 0.7) { score += 0.7; factors.push(`清算多头占${(liqLongPct * 100).toFixed(0)}% 下杀尾部 +0.7`); }
      else if (liqLongPct < 0.3) { score -= 0.7; factors.push(`清算空头占${((1 - liqLongPct) * 100).toFixed(0)}% 逼空 -0.7`); }
    }
  }
  const dir = score >= 2.5 ? 'long' : score <= -2.5 ? 'short' : 'flat';
  const confidence = Math.min(1, Math.abs(score) / 5);
  return { score: +score.toFixed(2), dir, confidence: +confidence.toFixed(2), factors };
}

// ---------- 智能仓位管理（10000u 当 50000u 用）----------
// 核心：风险预算制 + 爆仓价反推
//   risk_usd = 本金 × risk_pct（默认2%）
//   止损距离 stopDist%（按ATR×乘数，行情类型自适应）
//   名义仓位 = risk_usd / (stopDist%)   ← 同样风险下，止损越紧名义越大
//   爆仓距离 = 100 / 杠杆            ← 保证金% = 100/杠杆，价格反向走到保证金%即爆仓
//   约束：爆仓距离 ≥ stopDist × 1.3（止损先触发，留缓冲）
//   → 杠杆 = min(100 / (stopDist × 1.3), 上限)
//   保证金 = 名义 / 杠杆（占本金%）
// 示例：本金10000u，风险2%=200u，止损2% → 名义=10000u，杠杆=100/(2×1.3)=38x，保证金=263u(2.63%)
//   → 等于用2.63%保证金控制10000u名义（10000u当38000u用），爆仓价=止损价外30%缓冲
function positionPlan(principal, riskPct, stopDistPct, regime, volLevel, signalScore) {
  // 止损乘数：行情类型自适应
  let mult = 1.0;
  if (regime === 'TREND_UP' || regime === 'TREND_DOWN') mult = 1.2;      // 趋势市放宽止损防洗出
  else if (regime === 'RANGE') mult = 0.85;                              // 震荡市收紧止损
  else if (regime === 'TURN_UP' || regime === 'TURN_DOWN') mult = 1.0;
  if (volLevel === 'HIGH') mult *= 1.25;                                 // 高波动放大止损
  else if (volLevel === 'LOW') mult *= 0.8;
  // 信号强度加成：信号越强止损可略宽（吃足行情），但仓位风险不变
  const confMult = signalScore >= 4 ? 1.1 : signalScore >= 3 ? 1.05 : 1.0;
  const effStopDist = Math.max(0.8, Math.min(6, stopDistPct * mult * confMult));
  // 风险金额
  const riskUsd = principal * riskPct / 100;
  // 名义仓位（u）
  const notional = riskUsd / (effStopDist / 100);
  // 爆仓缓冲：1.3倍止损距离
  const liqDist = effStopDist * 1.3;
  const leverage = Math.min(100, Math.floor(100 / liqDist * 10) / 10);
  // 保证金（u + 占本金%）
  const margin = notional / leverage;
  const marginPct = margin / principal * 100;
  // 爆仓价
  const liqOffsetPct = 100 / leverage;
  return {
    principal, risk_pct: riskPct, risk_usd: +riskUsd.toFixed(0),
    stop_dist_pct: +effStopDist.toFixed(2),
    notional_usd: +notional.toFixed(0),           // 名义仓位（u）
    notional_multiple: +(notional / principal).toFixed(1),  // 名义/本金倍数（10000u当几倍用）
    leverage: +leverage.toFixed(1),
    margin_usd: +margin.toFixed(0),               // 实际占用保证金（u）
    margin_pct: +marginPct.toFixed(2),            // 占本金%
    liq_dist_pct: +liqOffsetPct.toFixed(2),       // 爆仓距离%
    liq_buffer: +((liqDist - effStopDist) / effStopDist).toFixed(2), // 爆仓缓冲倍数
  };
}

module.exports = { smaArr, emaArr, rsiArr, atrArr, adxArr, macdArr, zscoreOf, classifyRegime, scoreDirection, positionPlan };
