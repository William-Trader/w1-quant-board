// lib/market_analyzer.js — 威廉分析系统 v7（大升级）
// 技术面：多周期 K线（1h/4h/1d）→ VWAP / ROC / MACD / 多周期 RSI / 三级别布林带深度 / 多周期趋势共振
// 资金面：OI/费率/LSR/FGI（保留） + 市值/ETH-BTC 宽度（保留）
// 输出：quadrants（评分+信号+状态）+ indicators（指标深度）
'use strict';
const https = require('https');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', () => { reject(new Error('timeout')); });
  });
}

// ---------- 指标工具 ----------
function sma(arr, n) { const out = []; let s = 0; for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= n) s -= arr[i - n]; out.push(i >= n - 1 ? s / n : null); } return out; }
function ema(arr, n) { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; }
function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(50);
  for (let i = n; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - n + 1; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d > 0) g += d; else l -= d; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sg = ema(line, sig);
  return { line, signal: sg, hist: line.map((v, i) => v - sg[i]) };
}
function rocArr(closes, n = 12) {
  const out = new Array(closes.length).fill(0);
  for (let i = n; i < closes.length; i++) out[i] = closes[i - n] > 0 ? (closes[i] / closes[i - n] - 1) * 100 : 0;
  return out;
}
function vwapOf(bars, dayStartTs) {
  // 从 dayStart 起累计
  let cv = 0, cq = 0, n = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].t < dayStartTs) break;
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    cv += tp * bars[i].v; cq += bars[i].v; n++;
  }
  return cq > 0 ? cv / cq : null;
}
function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const out = closes.map((_, i) => {
    if (mid[i] == null) return null;
    const seg = closes.slice(i - n + 1, i + 1);
    const sd = Math.sqrt(seg.reduce((a, b) => a + (b - mid[i]) ** 2, 0) / n);
    const up = mid[i] + k * sd, lo = mid[i] - k * sd;
    const pctB = (up - lo) === 0 ? 0.5 : (closes[i] - lo) / (up - lo);
    const bw = mid[i] === 0 ? 0 : (up - lo) / mid[i] * 100;
    return { mid: mid[i], up, lo, pctB, bw };
  });
  return out;
}
function drawdownFromHigh(arr, lookback = 60) {
  const slice = arr.slice(-lookback);
  const high = Math.max(...slice);
  const cur = arr[arr.length - 1];
  return high > 0 ? (cur / high - 1) * 100 : 0;
}

// ---------- 主分析 ----------
async function fetchMarketAnalysis(db) {
  const engine = require('./engine');
  const bc = await httpGet('https://api.blockchair.com/bitcoin/stats').catch(() => null);
  const btc = bc && bc.data ? bc.data : {};
  const btcPrice = btc.market_price_usd || 0;
  const btcMcap = btc.market_cap_usd || 0;
  const btcDom = btc.market_dominance_percentage || 0;

  // 各币价格 + 合约深度数据（futures 快照全字段）
  let ethPrice = 0, solPrice = 0;
  const futs = { btc: null, eth: null, sol: null, fundingHist: [] };
  try {
    const rows = db.prepare('SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 30').all();
    for (let ri = 0; ri < rows.length; ri++) {
      const d = JSON.parse(rows[ri].payload).data || [];
      const b = d.find(c => c.symbol === 'BTC');
      if (b && futs.fundingHist.length < 30 && b.avg_funding_rate_by_oi != null) futs.fundingHist.push(b.avg_funding_rate_by_oi);
      if (ri === 0) {
        const eth = d.find(c => c.symbol === 'ETH');
        const sol = d.find(c => c.symbol === 'SOL');
        if (b) futs.btc = b;
        if (eth) { ethPrice = eth.current_price || 0; futs.eth = eth; }
        if (sol) { solPrice = sol.current_price || 0; futs.sol = sol; }
      }
    }
  } catch (e) {}
  // KOL 共识（BTC）
  let kol = null;
  try {
    const r = db.prepare('SELECT payload FROM consensus ORDER BY ts DESC LIMIT 1').get();
    if (r) {
      const p = JSON.parse(r.payload);
      const items = p && typeof p === 'object' ? Object.values(p) : [];
      const b = items.find(x => (x.symbol || '').toUpperCase().startsWith('BTC'));
      if (b) kol = { decision: b.decision, bias: b.trust_adjusted_bias, conf: b.confidence };
    }
  } catch (e) {}
  const totalMcap = btcDom > 0 ? (btcMcap / (btcDom / 100)) : 0;
  const ethMcapEst = ethPrice * 120000000;
  const stableMcapEst = 160e9;
  const total3 = totalMcap - btcMcap - ethMcapEst - stableMcapEst;
  const ethBtc = btcPrice > 0 ? ethPrice / btcPrice : 0;
  const solBtc = btcPrice > 0 ? solPrice / btcPrice : 0;

  // ========== 多周期 K线（gate，30min 缓存） ==========
  let h1 = [], h4 = [], d1 = [];
  try {
    h1 = await engine.getKL('BTC', '1h');
    h4 = await engine.getKL('BTC', '4h', 200);
    d1 = await engine.getKL('BTC', '1d', 300);
  } catch (e) {}
  const c1 = h1.map(b => b.c);
  const curPrice = c1.length ? c1[c1.length - 1] : (btcPrice || 0);
  const btcChg = btc.market_price_usd_change_24h_percentage || 0;

  // ---------- 指标深度 ----------
  const ind = { vwap: null, pctB: {}, bw: {}, rsi: {}, roc: 0, macd_hist: 0, ema_trend: {}, trend_multi: 0, oi: null, liq: null, funding_z: null, lsr: null, kol: null };
  if (h1.length > 60) {
    // VWAP（当日）
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const vw = vwapOf(h1, Math.floor(dayStart.getTime() / 1000)); // K线 ts 为秒
    ind.vwap = vw;
    // 布林带三级别
    for (const [tf, bars] of [['1h', h1], ['4h', h4], ['1d', d1]]) {
      if (!bars || bars.length < 30) continue;
      const b = bollinger(bars.map(x => x.c), 20, 2);
      const last = b[b.length - 1];
      if (last) { ind.pctB[tf] = +last.pctB.toFixed(2); ind.bw[tf] = +last.bw.toFixed(2); }
    }
    // RSI 多周期
    for (const [tf, bars] of [['1h', h1], ['4h', h4], ['1d', d1]]) {
      if (!bars || bars.length < 20) continue;
      const r = rsi(bars.map(x => x.c), 14);
      ind.rsi[tf] = +r[r.length - 1].toFixed(1);
    }
    // ROC + MACD
    const rv = rocArr(c1, 12);
    ind.roc = +rv[rv.length - 1].toFixed(2);
    const mc = macd(c1);
    ind.macd_hist = +mc.hist[mc.hist.length - 1].toFixed(1);
    // 多周期 EMA 排列
    for (const [tf, bars] of [['1h', h1], ['4h', h4], ['1d', d1]]) {
      if (!bars || bars.length < 60) continue;
      const cc = bars.map(x => x.c);
      const e20 = ema(cc, 20), e50 = ema(cc, 50);
      const i = cc.length - 1;
      ind.ema_trend[tf] = e20[i] > e50[i] ? 'up' : 'down';
    }
    const arr = Object.values(ind.ema_trend);
    if (arr.length === 3) ind.trend_multi = arr.filter(x => x === 'up').length === 3 ? 1 : arr.filter(x => x === 'down').length === 3 ? -1 : 0;
    else if (arr.length === 2) ind.trend_multi = arr[0] === arr[1] ? (arr[0] === 'up' ? 0.6 : -0.6) : 0;
  }

  // ========== 多因子综合评分 v7 ==========
  let score = 0;
  const signals = [];
  const sma60 = c1.length >= 60 ? sma(c1, 60)[c1.length - 1] : null;
  const sma7 = c1.length >= 7 ? sma(c1, 7)[c1.length - 1] : null;
  const sma30 = c1.length >= 30 ? sma(c1, 30)[c1.length - 1] : null;
  const ddHigh = drawdownFromHigh(c1.length >= 60 ? c1 : [curPrice], 60);

  // 因子A：价格趋势（1.2）
  if (sma60 && curPrice > 0) {
    const off = (curPrice - sma60) / sma60 * 100;
    let a = Math.max(-1, Math.min(1, off / 4));
    if (sma7 != null && sma30 != null) {
      const short = (sma7 - sma30) / sma30 * 100;
      if (short > 0.5) a += 0.15; else if (short < -0.5) a -= 0.15;
    }
    score += Math.max(-1, Math.min(1, a)) * 1.2;
    signals.push(`价格${off >= 0 ? '+' : ''}${off.toFixed(1)}% vs 1h-60均线`);
  }

  // 因子B：回撤（1.0）
  if (ddHigh < -8) { score -= 1.0; signals.push(`距高点回撤 ${ddHigh.toFixed(1)}%`); }
  else if (ddHigh < -4) { score -= 0.6; signals.push(`距高点回撤 ${ddHigh.toFixed(1)}%`); }
  else if (ddHigh < -2) { score -= 0.3; signals.push(`距高点回撤 ${ddHigh.toFixed(1)}%`); }
  else if (ddHigh > 2) { score += 0.5; signals.push(`创近期新高 +${ddHigh.toFixed(1)}%`); }

  // 因子C：FGI（1.0）
  let fgi = null;
  try { const f = db.prepare('SELECT value FROM fear_greed ORDER BY ts DESC LIMIT 1').get(); if (f) fgi = Number(f.value); } catch (e) {}
  if (fgi != null) {
    score += ((fgi - 50) / 50) * 1.0;
    signals.push(`FGI ${fgi}（${fgi <= 25 ? '极度恐惧' : fgi <= 45 ? '恐惧' : fgi <= 55 ? '中性' : fgi <= 75 ? '贪婪' : '极度贪婪'}）`);
  }

  // 因子D：24h 动量（0.6）
  if (btcChg >= 2) { score += 0.6; signals.push(`24h +${btcChg.toFixed(1)}%`); }
  else if (btcChg <= -2) { score -= 0.6; signals.push(`24h ${btcChg.toFixed(1)}%`); }
  else signals.push(`24h ${btcChg >= 0 ? '+' : ''}${btcChg.toFixed(1)}%（平盘）`);

  // 因子E：市场宽度（0.8）
  if (ethBtc > 0) {
    if (ethBtc < 0.025) { score -= 0.8; signals.push(`ETH/BTC ${ethBtc.toFixed(4)}（山寨深度受挫）`); }
    else if (ethBtc < 0.04) { score -= 0.4; signals.push(`ETH/BTC ${ethBtc.toFixed(4)}（偏弱）`); }
    else if (ethBtc > 0.06) { score += 0.5; signals.push(`ETH/BTC ${ethBtc.toFixed(4)}（偏强）`); }
    else signals.push(`ETH/BTC ${ethBtc.toFixed(4)}（中性）`);
  }

  // 因子F：市值方向（0.6）
  if (c1.length >= 30) {
    const old = c1[0];
    const mcapChg = old > 0 ? (curPrice - old) / old * 100 : 0;
    if (mcapChg >= 3) { score += 0.6; signals.push(`市值方向 +${mcapChg.toFixed(1)}%（近30h）`); }
    else if (mcapChg <= -3) { score -= 0.6; signals.push(`市值方向 ${mcapChg.toFixed(1)}%（近30h）`); }
  }

  // 因子G：动量强度（新增 0.8）——ROC + MACD 同向
  if (ind.roc !== 0 || ind.macd_hist !== 0) {
    let g = 0;
    const rocN = Math.max(-1, Math.min(1, ind.roc / 2));
    const macN = Math.max(-1, Math.min(1, ind.macd_hist / 15));
    g = 0.6 * rocN + 0.4 * macN;
    if (Math.sign(ind.roc) === Math.sign(ind.macd_hist) && ind.roc !== 0) g *= 1.2;
    score += Math.max(-1, Math.min(1, g)) * 0.8;
    signals.push(`动量 ROC${ind.roc >= 0 ? '+' : ''}${ind.roc.toFixed(1)}% MACD柱${ind.macd_hist >= 0 ? '+' : ''}${ind.macd_hist.toFixed(1)}`);
  }

  // 因子H：VWAP 偏离（新增 0.7）
  if (ind.vwap && curPrice > 0) {
    const offV = (curPrice / ind.vwap - 1) * 100;
    const h = Math.max(-1, Math.min(1, offV / 1.5));
    score += h * 0.7;
    signals.push(`价格 ${offV >= 0 ? '+' : ''}${offV.toFixed(1)}% vs 日内VWAP`);
  }

  // 因子I：布林带深度（新增 0.8）——三级别 %B 均值
  const pctBs = Object.values(ind.pctB);
  if (pctBs.length) {
    const avgB = pctBs.reduce((a, b) => a + b, 0) / pctBs.length;
    const bi = Math.max(-1, Math.min(1, (avgB - 0.5) * 2.5));
    score += bi * 0.8;
    const bwTxt = Object.entries(ind.bw).map(([k, v]) => `${k}带宽${v.toFixed(1)}%`).join(' ');
    const deep = avgB > 0.9 ? '（贴近上轨，强势）' : avgB < 0.1 ? '（贴近下轨，超卖）' : '';
    signals.push(`布林带深度 %B均值 ${avgB.toFixed(2)}${deep}｜${bwTxt}`);
  }

  // 因子J：多周期趋势共振（新增 1.0）
  if (ind.trend_multi !== 0) {
    score += ind.trend_multi * 1.0;
    signals.push(`多周期共振 ${ind.trend_multi > 0 ? '1h/4h/1d 多头排列' : '1h/4h/1d 空头排列'}`);
  } else {
    signals.push(`多周期共振 分歧（无一致方向）`);
  }

  // 合约深度数据入 indicators
  if (futs.btc) {
    ind.oi = { usd: futs.btc.open_interest_usd ? Math.round(futs.btc.open_interest_usd / 1e9 * 10) / 10 : null, chg_24h: futs.btc.open_interest_change_percent_24h };
    ind.liq = { long_24h: futs.btc.long_liquidation_usd_24h, short_24h: futs.btc.short_liquidation_usd_24h, long_1h: futs.btc.long_liquidation_usd_1h, short_1h: futs.btc.short_liquidation_usd_1h };
    ind.lsr = { m5: futs.btc.long_short_ratio_5m, h4: futs.btc.long_short_ratio_4h, h24: futs.btc.long_short_ratio_24h };
    if (futs.fundingHist.length >= 5) {
      const arr = futs.fundingHist, m = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
      ind.funding_z = sd === 0 ? 0 : +(((arr[0] - m) / sd).toFixed(2));
    }
  }
  ind.kol = kol;

  // 因子K：OI 方向（0.8）——增仓上涨=新多进场；减仓=离场信号
  if (futs.btc && futs.btc.open_interest_change_percent_24h != null) {
    const oiChg = Number(futs.btc.open_interest_change_percent_24h);
    const oiK = Math.max(-1, Math.min(1, oiChg / 3));
    const priceUp = curPrice > 0 && btcPrice > 0 && (curPrice / btcPrice - 1) > 0.002;
    score += oiK * 0.8;
    signals.push(`OI ${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(1)}%${priceUp ? '（增仓上涨）' : ''}`);
  }

  // 因子L：清算失衡（0.7）——多头爆仓占优=下杀尾部（被动卖盘），空头爆仓占优=被动买盘推涨（波动放大，非确定性反转）
  if (futs.btc && futs.btc.long_liquidation_usd_24h != null) {
    const lL = Number(futs.btc.long_liquidation_usd_24h), sL = Number(futs.btc.short_liquidation_usd_24h);
    const tot = lL + sL;
    if (tot > 0) {
      const longPct = lL / tot;
      const liqScore = longPct > 0.65 ? 0.7 : longPct < 0.35 ? -0.7 : 0;
      score += liqScore;
      signals.push(`清算多爆${(longPct * 100).toFixed(0)}%（24h $${(tot / 1e6).toFixed(0)}M）`);
    }
  }

  // 因子M：费率热度 z（0.6）
  if (ind.funding_z != null) {
    const fz = Math.max(-1, Math.min(1, ind.funding_z / 2));
    score += fz * 0.6;
    signals.push(`费率z ${ind.funding_z >= 0 ? '+' : ''}${ind.funding_z.toFixed(2)}`);
  }

  // 因子N：KOL 共识（0.8）
  if (kol && kol.bias != null) {
    const kb = Math.max(-1, Math.min(1, kol.bias * 8));
    score += kb * 0.8;
    signals.push(`KOL ${kol.decision === 'long' ? '偏多' : kol.decision === 'short' ? '偏空' : '中性'}（bias ${kol.bias >= 0 ? '+' : ''}${kol.bias.toFixed(3)}）`);
  }

  // 因子O：LSR 拥挤（0.7）——极端多空比反向
  if (futs.btc && futs.btc.long_short_ratio_4h != null) {
    const l4 = Number(futs.btc.long_short_ratio_4h);
    let ls = 0;
    if (l4 > 1.35) ls = -0.7; else if (l4 > 1.15) ls = -0.35;
    else if (l4 < 0.72) ls = 0.7; else if (l4 < 0.88) ls = 0.35;
    score += ls;
    signals.push(`LSR4h ${l4.toFixed(2)}${l4 > 1.3 ? '（散户拥挤做多→反向）' : l4 < 0.75 ? '（散户拥挤做空→反向）' : ''}`);
  }

  // ============ 状态判定 ============
  let state, state_en;
  if (score >= 2.2) { state = 'BTC 主导牛市'; state_en = 'BTC Dominant Bull'; }
  else if (score >= 1.2) { state = '结构性牛市'; state_en = 'Structural Bull'; }
  else if (score >= 0.4) { state = '震荡偏多'; state_en = 'Range Bullish'; }
  else if (score > -0.4) { state = '震荡观望'; state_en = 'Range Neutral'; }
  else if (score > -1.2) { state = '弱势下跌'; state_en = 'Weak Decline'; }
  else if (score > -2.2) { state = '熊市'; state_en = 'Bear Market'; }
  else { state = '深度熊市'; state_en = 'Deep Bear'; }

  const quadrants = {
    btc_price_dir: btcChg >= 2 ? 'up' : btcChg <= -2 ? 'down' : 'side',
    btc_dom_dir: btcDom > 0 ? (btcDom >= 60 ? 'up' : btcDom <= 50 ? 'down' : 'side') : 'side',
    state, state_en,
    btc_price_chg_24h: btcChg,
    score: Math.round(score * 100) / 100,
    signals, fgi,
    drawdown_pct: Math.round(ddHigh * 100) / 100,
    indicators: ind
  };

  return {
    ts: Math.floor(Date.now() / 1000),
    btc: { price: btcPrice, mcap: btcMcap, dominance: btcDom, chg_24h: btcChg },
    eth: { price: ethPrice, mcap_est: ethMcapEst },
    sol: { price: solPrice },
    market: {
      total_mcap: totalMcap, total3: total3, stablecoin_mcap_est: stableMcapEst,
      eth_btc_ratio: ethBtc, sol_btc_ratio: solBtc
    },
    quadrants: quadrants
  };
}

module.exports = { fetchMarketAnalysis };
