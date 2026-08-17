// lib/regime.js — 市场体制分类器（总开关）
// 每 15 分钟更新一次，结果写 kv('signal:regime') 供所有模块使用
// 体制: TREND(趋势) / RANGE(震荡) / STORM(风暴禁言) / OFF(过渡不给新单)
'use strict';
const { debug, warn, info } = require('./log');
const { kvGet, kvSet } = require('./db');

function ema(arr, n) { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; }
function adxCalc(bars, n = 14) {
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
function bbWidthPct(d1c, n = 20) {
  // 当前布林带宽 / 近 120 日分位数
  const band = (arr, i) => {
    if (i < n - 1) return null;
    const seg = arr.slice(i - n + 1, i + 1);
    const m = seg.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    const last = arr[i];
    return sd === 0 ? 0 : ((m + 2 * sd) - (m - 2 * sd)) / last;
  };
  const i = d1c.length - 1;
  const cur = band(d1c, i);
  if (cur == null) return null;
  const hist = [];
  for (let j = Math.max(n - 1, d1c.length - 120); j <= i; j++) { const b = band(d1c, j); if (b != null) hist.push(b); }
  if (hist.length < 30) return null;
  const sorted = [...hist].sort((a, b) => a - b);
  const rank = sorted.filter(x => x <= cur).length / sorted.length;
  return rank;
}
function zscore(arr) {
  const n = arr.length;
  if (n < 5) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return sd === 0 ? 0 : (arr[n - 1] - m) / sd;
}
function pctileRank(arr) {
  const n = arr.length;
  if (n < 20) return null;
  const v = arr[n - 1];
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted.filter(x => x <= v).length / n;
}

// 从 gate 拉日线（缓存 1 小时）
let d1Cache = { ts: 0, data: null };
async function fetchD1All(symbols) {
  if (Date.now() - d1Cache.ts < 3600 * 1000 && d1Cache.data) return d1Cache.data;
  const out = {};
  const to = Math.floor(Date.now() / 1000);
  const from = to - 150 * 86400;
  await Promise.all(symbols.map(async (sym) => {
    try {
      const r = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym}_USDT&interval=1d&from=${from}&to=${to}`, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) return;
      const arr = await r.json();
      out[sym] = arr.map(c => ({ t: +c[0], o: +c[5], h: +c[3], l: +c[4], c: +c[2], v: +c[6] })).sort((a, b) => a.t - b.t);
    } catch (e) { debug('[regime] kline err:', e.message); }
  }));
  d1Cache = { ts: Date.now(), data: out };
  return out;
}

// 主入口: 计算体制
async function classify(ctx, symbols) {
  const { db } = ctx;
  const now = Date.now();
  const d1map = await fetchD1All(symbols);
  // 用 BTC 判定全局体制（主流币高度相关）
  const sym = symbols.includes('BTC') ? 'BTC' : (symbols[0] || 'BTC');
  const bars = d1map[sym];
  if (!bars || bars.length < 40) {
    return { ok: false, regime: 'OFF', reason: '日线数据不足', ts: now };
  }
  const d1c = bars.map(b => b.c);
  const A = adxCalc(bars);
  const last = bars.length - 1;
  const adxv = A[last];
  const adxSlope = adxv - A[last - 5];
  const bbw = bbWidthPct(d1c);
  // 资金费率 z（近 30 日）: 优先 funding_history（与回测同口径），不足时退回 futures_markets 快照
  let fundingZ = 0, fundingN = 0;
  try {
    const rows = db.prepare('SELECT funding_rate FROM funding_history WHERE symbol=? ORDER BY ts DESC LIMIT 288').all(sym);
    const rates = rows.map(r => r.funding_rate);
    if (rates.length >= 10) { fundingZ = zscore(rates); fundingN = rates.length; }
    else {
      const snap = db.prepare('SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 30').all();
      const srates = [];
      for (const r of snap) {
        try { const d = JSON.parse(r.payload).data || []; const b = d.find(x => x.symbol === sym); if (b && b.avg_funding_rate_by_oi != null) srates.push(b.avg_funding_rate_by_oi); } catch (e) { debug('[regime] funding parse err:', e.message); }
      }
      if (srates.length >= 10) { fundingZ = zscore(srates); fundingN = srates.length; }
    }
  } catch (e) { debug('[regime] funding err:', e.message); }
  // 1h realized vol 分位（用日线 ATR% 近似 + 30 日）
  const atrPct = bars.slice(-30).map((_, j) => { const i = last - 29 + j; if (i < 1) return 0; const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)); return tr / bars[i].c; });
  const volPct = pctileRank(atrPct);

  let regime;
  const storm = (volPct != null && volPct >= 0.95) || (bbw != null && bbw >= 0.95);
  if (storm) regime = 'STORM';
  else if (adxv >= 22 && adxSlope > 0) regime = 'TREND';
  else if (adxv < 18 && bbw != null && bbw < 0.6) regime = 'RANGE';
  else regime = 'OFF';

  // 滞后处理: 连续 2 次 raw 一致才切换（修正版状态机）
  // 旧实现用 effective 作比较基准 → 一旦进入某体制永远切不出去（streak 无限累加）
  // 新实现：记录 last_raw，只有 raw 连续 2 次等于候选体制才写入 effective
  const prev = JSON.parse(kvGet(db, 'signal:regime', '{}') || '{}');
  const prevEff = prev.regime;          // 上次生效体制
  const prevRaw = prev.raw;             // 上次原始计算值
  let effective, streak;
  if (prevRaw === regime) {
    // raw 连续出现：达到 2 次则确认切换，否则维持
    streak = (prev.raw_streak || 0) + 1;
    effective = streak >= 2 ? regime : prevEff;
  } else {
    // raw 变化：重新计数，维持旧体制
    streak = 1;
    effective = prevEff || regime; // 首次运行直接生效
  }
  const out = {
    ok: true, regime: effective, raw: regime,
    adx: +adxv.toFixed(1), adx_slope: +adxSlope.toFixed(2),
    bbw_pct: bbw != null ? +(bbw * 100).toFixed(1) : null,
    funding_z: +fundingZ.toFixed(2),
    vol_pct: volPct != null ? +(volPct * 100).toFixed(1) : null,
    raw_streak: streak, ts: now,
    updated: new Date(now).toISOString().slice(0, 19)
  };
  kvSet(db, 'signal:regime', JSON.stringify(out));
  return out;
}

module.exports = { classify, adxCalc, ema, zscore, pctileRank };
