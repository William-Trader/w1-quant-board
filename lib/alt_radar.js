'use strict';
// ============================================================
// lib/alt_radar.js — 山寨异动系统 v1.0（2026-10-31）
//
// 目标：市场监测群新增两类消息
//   ① 山寨异动：15m/1h/4h 价格、OI、量变、费率、主动买卖、LSR、清算多维打分
//   ② 热门山寨：按「流动性 × 动量 × 持仓变化」排 Top，低频推送
//
// 原则：
//   - 只覆盖 futures_markets 前 50 中的山寨（有 OI/价格历史，数据可复算）
//   - 排除主流币、稳定币、代币化股票/指数（SPCX/GOOGL/SOXL 等）
//   - 至少 2 个独立触发才推；单币 30min 冷却；全系统 2 条/小时、10 条/天
//   - 23:00–08:00 只推评分 ≥80 的强异动；热门榜夜间不推
//   - 每条都带样本数、数据时间与评分，便于回算与调阈值
// ============================================================

const { warn, debug } = require('./log');
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const alertsLib = require('./alerts');
const { store } = require('./store');

const TZ = 'Asia/Shanghai';
const MAJORS = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK', 'SUI', 'XAU']);
const STABLE = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'USDS', 'PYUSD', 'RLUSD', 'USDD', 'FRAX']);
// 代币化股票/指数/商品（Coinglass 会混进 futures_markets）
const BLOCK = new Set([
  'SPCX', 'GOOGL', 'GOOG', 'SNDK', 'SOXL', 'SKHYNIX', 'INTC', 'TSLA', 'MSTR', 'CRWD', 'NVDA', 'AAPL',
  'MSFT', 'AMZN', 'META', 'NFLX', 'AMD', 'COIN', 'HOOD', 'PLTR', 'ORCL', 'JPM', 'GS', 'SPX', 'NDX',
  'BTCDOM', 'XAUT', 'PAXG', 'CL', 'BZ', 'MU', 'BRENTOIL', 'WTI', 'USOIL', 'GOLD', 'SILVER', 'EUR', 'GBP', 'JPY'
]);
const LOOKBACKS = { r15: 900, r1h: 3600, r4h: 4 * 3600 };
const MIN_OI_USD = 20e6;
const MIN_LIQ_USD = 10e6;
const ANOMALY_MIN_SCORE = 45;
const QUIET_SCORE = 80;

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function fmtPrice(v) {
  if (v == null) return '—';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 10) return v.toFixed(2);
  if (v >= 1) return v.toFixed(3);
  return v.toPrecision(4);
}
function fmtPct(v, d = 2) { return v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`; }
function fmtUsd(v) {
  if (v == null) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Number(v).toFixed(0)}`;
}
function timeFmt(sec) {
  try { return new Date(sec * 1000).toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return '—'; }
}
function isAlt(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/USDT$/, '');
  if (!s || MAJORS.has(s) || STABLE.has(s) || BLOCK.has(s)) return false;
  // 法币对：USDBRL / EURUSD / GBPJPY 等（必须放在稳定币之后，避免误杀 USDT/USDC）
  if (/^(USD|EUR|GBP|JPY|AUD|CAD|CHF|CNY|HKD|SGD)[A-Z]{2,4}$/.test(s)) return false;
  if (!/^[A-Z0-9]{2,15}$/.test(s)) return false;
  return true;
}

// 从 futures_markets 历史构建每个币的 5min 价格/OI 序列
function buildSeries(rows) {
  const by = new Map();
  for (const r of rows) {
    let p; try { p = JSON.parse(r.payload); } catch (e) { continue; }
    const arr = Array.isArray(p.data) ? p.data : [];
    for (const c of arr) {
      const sym = String(c.symbol || '').toUpperCase();
      if (!sym) continue;
      if (!by.has(sym)) by.set(sym, []);
      by.get(sym).push({ ts: Number(r.ts), price: Number(c.current_price), oi: Number(c.open_interest_usd) });
    }
  }
  for (const arr of by.values()) arr.sort((a, b) => a.ts - b.ts);
  return by;
}

// 回溯收益率：取最新样本与「目标时间点之前最近样本」
function retAt(series, lookbackSec) {
  if (!Array.isArray(series) || series.length < 3) return null;
  const last = series[series.length - 1];
  if (!last || !(last.price > 0)) return null;
  const target = last.ts - lookbackSec;
  let ref = null;
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i].ts <= target) { ref = series[i]; break; }
  }
  if (!ref || !(ref.price > 0)) return null;
  // 允许 5min 对齐误差；差太多说明历史缺口，不用
  if (last.ts - ref.ts > lookbackSec + 600) return null;
  return (last.price / ref.price - 1) * 100;
}

function lsrMapFromRanking(db) {
  const map = new Map();
  try {
    const row = store.latestLsr(db, 'trader');
    const arr = row && row.data && row.data.data ? row.data.data : [];
    for (const c of arr) {
      const sym = String(c.symbol || '').toUpperCase().replace(/USDT$/, '');
      if (!sym) continue;
      map.set(sym, c);
    }
  } catch (e) { debug('[alt_radar] lsr map err:', e.message); }
  return map;
}

function computeMetrics(sym, series, latest, lsr) {
  const oi = Number(latest.open_interest_usd) || 0;
  const liqNotional = lsr ? (Number(lsr.long_notional) || 0) + (Number(lsr.short_notional) || 0) : 0;
  const liquidity = Math.max(oi, liqNotional);
  if (liquidity < MIN_OI_USD && liqNotional < MIN_LIQ_USD) return null;

  const r15 = retAt(series, LOOKBACKS.r15);
  const r1h = retAt(series, LOOKBACKS.r1h);
  const r4h = retAt(series, LOOKBACKS.r4h);
  const chg24 = Number(latest.price_change_percent_24h);
  const oiChg = Number(latest.open_interest_change_percent_24h);
  const volChg = Number(latest.volume_change_percent_24h);
  const fund = Number(latest.avg_funding_rate_by_oi);
  const lv = Number(latest.long_volume_usd_24h) || 0;
  const sv = Number(latest.short_volume_usd_24h) || 0;
  const taker = lv > 0 && sv > 0 ? lv / sv : null;
  const liq24 = Number(latest.liquidation_usd_24h) || 0;
  const longLiq = Number(latest.long_liquidation_usd_24h) || 0;
  const shortLiq = Number(latest.short_liquidation_usd_24h) || 0;
  const lsrAcc = Number(latest.long_short_ratio_4h) || null;
  const lsrNotional = lsr && lsr.ratio != null ? Number(lsr.ratio) : null;
  const lsrDelta30 = lsr && lsr.delta_30m != null ? Number(lsr.delta_30m) : null;
  const whaleRatio = lsr && lsr.whale_ratio != null ? Number(lsr.whale_ratio) : null;
  const traders = lsr && lsr.ov_total_traders != null ? Number(lsr.ov_total_traders) : null;

  return {
    symbol: sym,
    price: Number(latest.current_price),
    chg24: Number.isFinite(chg24) ? chg24 : null,
    r15, r1h, r4h,
    oi, oiChg: Number.isFinite(oiChg) ? oiChg : null,
    volChg: Number.isFinite(volChg) ? volChg : null,
    fund: Number.isFinite(fund) ? fund : null,
    taker,
    liq24, longLiq, shortLiq,
    lsrAcc, lsrNotional, lsrDelta30, whaleRatio, traders,
    liquidity,
    samples: series ? series.length : 0
  };
}

function scoreAnomaly(m) {
  const tags = [];
  const strong = [];
  if (m.r15 != null && Math.abs(m.r15) >= 2.5) { tags.push(m.r15 > 0 ? '急涨15m' : '急跌15m'); if (Math.abs(m.r15) >= 5) strong.push('r15'); }
  if (m.r1h != null && Math.abs(m.r1h) >= 4) { tags.push(m.r1h > 0 ? '急涨1h' : '急跌1h'); if (Math.abs(m.r1h) >= 8) strong.push('r1h'); }
  if (m.r4h != null && Math.abs(m.r4h) >= 8) { tags.push(m.r4h > 0 ? '急涨4h' : '急跌4h'); }
  if (m.oiChg != null && Math.abs(m.oiChg) >= 10) { tags.push(m.oiChg > 0 ? '增仓' : '减仓'); if (Math.abs(m.oiChg) >= 20) strong.push('oi'); }
  if (m.volChg != null && Math.abs(m.volChg) >= 50) tags.push(m.volChg > 0 ? '放量' : '缩量');
  if (m.fund != null && m.fund >= 0.06) { tags.push('费率极端多'); strong.push('fund'); }
  else if (m.fund != null && m.fund <= -0.04) { tags.push('费率极端空'); strong.push('fund'); }
  if (m.taker != null && m.taker >= 1.8) tags.push('主动买强');
  else if (m.taker != null && m.taker <= 0.55) tags.push('主动卖强');
  if (m.lsrAcc != null && m.lsrAcc >= 1.6) tags.push('账户偏多');
  else if (m.lsrAcc != null && m.lsrAcc <= 0.6) tags.push('账户偏空');
  if (m.lsrNotional != null && m.lsrNotional >= 2) tags.push('持仓拥挤多');
  else if (m.lsrNotional != null && m.lsrNotional <= 0.5) tags.push('持仓拥挤空');
  if (m.liq24 >= 5e6) {
    const denom = m.longLiq + m.shortLiq;
    if (denom > 0) {
      const imb = (m.longLiq - m.shortLiq) / denom;
      if (Math.abs(imb) >= 0.6) tags.push(imb > 0 ? '多头爆仓' : '空头爆仓');
    }
  }

  if (!(tags.length >= 2 || strong.length >= 1)) return null;

  const score = 100 * (
    0.30 * clamp01(Math.max(
      Math.abs(m.r15 || 0) / 5,
      Math.abs(m.r1h || 0) / 8,
      Math.abs(m.r4h || 0) / 15
    )) +
    0.20 * clamp01(Math.abs(m.oiChg || 0) / 20) +
    0.15 * clamp01(Math.abs(m.volChg || 0) / 100) +
    0.15 * clamp01(Math.abs(m.fund || 0) / 0.08) +
    0.10 * clamp01(m.taker == null ? 0 : Math.abs(m.taker - 1) / 1) +
    0.10 * clamp01(m.lsrAcc == null ? 0 : Math.abs(m.lsrAcc - 1) / 1)
  );
  return Object.assign({}, m, { tags, score: +score.toFixed(0) });
}

function hotScore(m) {
  const liq = Math.max(m.liquidity || 0, 0);
  return +(100 * (
    0.40 * clamp01(Math.log10(1 + liq / 1e8) / 2) +
    0.25 * clamp01(Math.abs(m.chg24 || 0) / 20) +
    0.20 * clamp01(Math.abs(m.oiChg || 0) / 30) +
    0.15 * clamp01(Math.abs(m.volChg || 0) / 100)
  )).toFixed(0);
}

function compute(db) {
  const now = Math.floor(Date.now() / 1000);
  let rows = [];
  try { rows = db.prepare('SELECT ts,payload FROM futures_markets WHERE ts>=? ORDER BY ts ASC').all(now - LOOKBACKS.r4h - 600); }
  catch (e) { return { ok: false, error: e.message, as_of: now, hot: [], anomalies: [] }; }
  if (!rows.length) return { ok: true, as_of: now, hot: [], anomalies: [], universe: 0, note: 'no futures snapshots' };
  const seriesMap = buildSeries(rows);
  const lastRow = rows[rows.length - 1];
  let latest = [];
  try { latest = JSON.parse(lastRow.payload).data || []; } catch (e) {}
  const lsrMap = lsrMapFromRanking(db);
  const metrics = [];
  for (const c of latest) {
    const sym = String(c.symbol || '').toUpperCase();
    if (!isAlt(sym)) continue;
    const m = computeMetrics(sym, seriesMap.get(sym), c, lsrMap.get(sym));
    if (m && m.price > 0) metrics.push(m);
  }
  const hot = metrics.map(m => Object.assign({}, m, { hot_score: hotScore(m) }))
    .sort((a, b) => b.hot_score - a.hot_score).slice(0, 8);
  const anomalies = metrics.map(scoreAnomaly).filter(Boolean)
    .sort((a, b) => b.score - a.score).slice(0, 6);
  return { ok: true, as_of: Number(lastRow.ts), hot, anomalies, universe: metrics.length, samples: rows.length };
}

function formatAnomaly(a) {
  const line1 = `• ${a.symbol} $${fmtPrice(a.price)} ｜ 15m ${fmtPct(a.r15)} / 1h ${fmtPct(a.r1h)} / 24h ${fmtPct(a.chg24)}`;
  const parts = [];
  if (a.oi) parts.push(`OI ${fmtUsd(a.oi)}(${fmtPct(a.oiChg, 1)})`);
  if (a.volChg != null) parts.push(`量变 ${fmtPct(a.volChg, 0)}`);
  if (a.fund != null) parts.push(`费率 ${Number(a.fund).toFixed(3)}%/8h`);
  if (a.lsrAcc != null) parts.push(`账户LSR ${Number(a.lsrAcc).toFixed(2)}`);
  if (a.lsrNotional != null) parts.push(`名义LSR ${Number(a.lsrNotional).toFixed(2)}`);
  if (a.taker != null) parts.push(`主买/卖 ${Number(a.taker).toFixed(2)}`);
  const line2 = `  ${parts.join('｜')}`;
  const line3 = `  标签：${a.tags.join(' · ')}｜评分 ${a.score}`;
  return [line1, line2, line3].join('\n');
}

function formatHot(h) {
  const parts = [`$${fmtPrice(h.price)}`, `24h ${fmtPct(h.chg24)}`, `OI ${fmtUsd(h.oi)}`];
  if (h.oiChg != null) parts.push(`OI变 ${fmtPct(h.oiChg, 1)}`);
  if (h.volChg != null) parts.push(`量变 ${fmtPct(h.volChg, 0)}`);
  if (h.lsrNotional != null) parts.push(`名义LSR ${Number(h.lsrNotional).toFixed(2)}`);
  return `• ${h.symbol} ${parts.join('｜')}｜热度 ${h.hot_score}`;
}

function quietNow(nowSec) {
  const h = Number(new Date(nowSec * 1000).toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  return h >= 23 || h < 8;
}
function allowPush(db, maxHour, maxDay) {
  let arr = [];
  try { arr = JSON.parse(kvGet(db, 'alt:push:times', '[]')); } catch (e) { arr = []; }
  const now = Date.now();
  arr = (Array.isArray(arr) ? arr : []).filter(t => now - t < 86400000);
  const hourCount = arr.filter(t => now - t < 3600000).length;
  return { ok: hourCount < maxHour && arr.length < maxDay, arr };
}
function markPush(db) {
  let arr = [];
  try { arr = JSON.parse(kvGet(db, 'alt:push:times', '[]')); } catch (e) { arr = []; }
  const now = Date.now();
  arr = (Array.isArray(arr) ? arr : []).filter(t => now - t < 86400000);
  arr.push(now);
  kvSet(db, 'alt:push:times', JSON.stringify(arr));
}

async function pushDigest(ctx, anomalies) {
  const { db, env } = ctx;
  const msg = [
    `🔥【W1·山寨异动】${anomalies.length} 个`,
    '━━━━━━━━━━━━',
    ...anomalies.map(formatAnomaly),
    `📡 Coinglass 5min · ${timeFmt(Math.floor(Date.now() / 1000))} 北京｜样本 ${anomalies[0] ? anomalies[0].samples : '—'}｜仅研究，不构成投资建议`
  ].join('\n');
  const ids = [];
  for (const a of anomalies) {
    try {
      const rec = alertsLib.record(db, {
        dedup_key: 'alt:anomaly:' + a.symbol,
        rule: 'alt_radar',
        severity: a.score >= 70 ? 'P1' : 'P2',
        symbol: a.symbol,
        title: `山寨异动 ${a.symbol} 评分 ${a.score}`,
        detail: formatAnomaly(a),
        payload: { score: a.score, tags: a.tags, r15: a.r15, r1h: a.r1h, oiChg: a.oiChg, fund: a.fund }
      });
      ids.push(rec.id);
    } catch (e) {}
  }
  try {
    const ok = await pushToGroup(env, db, msg, 'monitor');
    if (ok) {
      if (ids.length) alertsLib.markNotified(db, ids);
      for (const a of anomalies) kvSet(db, 'alt:last:' + a.symbol, Date.now());
      markPush(db);
    }
    return ok;
  } catch (e) { warn('[alt_radar] anomaly push:', e.message); return false; }
}

async function pushHot(ctx, hot) {
  const { db, env } = ctx;
  const msg = [
    `🔥【W1·热门山寨】Top ${hot.length}`,
    '━━━━━━━━━━━━',
    ...hot.map(formatHot),
    `📡 Coinglass 5min · ${timeFmt(Math.floor(Date.now() / 1000))} 北京｜按 流动性×动量×持仓变化 排序｜仅研究`
  ].join('\n');
  try {
    let rec = null;
    try { rec = alertsLib.record(db, { dedup_key: 'alt:hot', rule: 'alt_radar', severity: 'P2', title: '热门山寨 Top', detail: msg, payload: {} }); } catch (e) {}
    const ok = await pushToGroup(env, db, msg, 'monitor');
    if (ok) { if (rec) alertsLib.markNotified(db, [rec.id]); kvSet(db, 'alt:hot:last', Date.now()); kvSet(db, 'alt:hot:sig', hot.map(h => h.symbol).join(',')); markPush(db); }
    return ok;
  } catch (e) { warn('[alt_radar] hot push:', e.message); return false; }
}

async function scan(ctx) {
  const { db } = ctx;
  const data = compute(db);
  if (!data.ok) return { skipped: true, reason: data.error };
  kvSet(db, 'alt_radar:last_scan', Math.floor(Date.now() / 1000));
  kvSet(db, 'alt_radar:last_result', JSON.stringify({ as_of: data.as_of, hot: data.hot, anomalies: data.anomalies, universe: data.universe }));
  const now = Math.floor(Date.now() / 1000);
  const quiet = quietNow(now);
  let pushed = { anomaly: 0, hot: 0 };

  // 1) 异动：逐币 30min 冷却 + 分数门槛 + 全局配额
  const candidates = data.anomalies.filter(a => {
    const last = Number(kvGet(db, 'alt:last:' + a.symbol, 0) || 0);
    return a.score >= ANOMALY_MIN_SCORE && Date.now() - last >= 30 * 60 * 1000;
  });
  const anomalyPick = quiet ? candidates.filter(a => a.score >= QUIET_SCORE).slice(0, 4) : candidates.slice(0, 5);
  if (anomalyPick.length) {
    const cap = allowPush(db, 2, 10);
    if (cap.ok) {
      const ok = await pushDigest(ctx, anomalyPick);
      if (ok) pushed.anomaly = anomalyPick.length;
    } else { debug('[alt_radar] 全局配额已满，异动跳过'); }
  }

  // 2) 热门榜：60min 一次；Top 集合变化或满 4h 才重推；夜间不推
  if (!quiet && data.hot.length) {
    const last = Number(kvGet(db, 'alt:hot:last', 0) || 0);
    const sig = data.hot.map(h => h.symbol).join(',');
    const prevSig = kvGet(db, 'alt:hot:sig', '');
    const due = Date.now() - last >= 60 * 60 * 1000;
    const should = due && (sig !== prevSig || Date.now() - last >= 4 * 3600 * 1000 || !last);
    if (should) {
      const cap = allowPush(db, 2, 10);
      if (cap.ok) { const ok = await pushHot(ctx, data.hot); if (ok) pushed.hot = data.hot.length; }
    }
  }
  return { ok: true, universe: data.universe, anomalies: data.anomalies.length, hot: data.hot.length, pushed };
}

let cache = { ts: 0, data: null };
function status(db) {
  if (cache.data && Date.now() - cache.ts < 60000) return cache.data;
  const data = compute(db);
  cache = { ts: Date.now(), data };
  return data;
}

module.exports = {
  scan, status, compute, isAlt, retAt, computeMetrics, scoreAnomaly, hotScore, formatAnomaly, formatHot,
  MAJORS, BLOCK, STABLE, ANOMALY_MIN_SCORE, QUIET_SCORE
};
