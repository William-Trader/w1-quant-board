'use strict';
const { debug } = require('../log');
// ============================================================
// 全球资产数据处理引擎 v1.0（2026-08-14）
//  - 不做价格展示，做数据加工：波动率/异动/相关性变化/相对强弱
//  - 输入：OKX K线（1D 90根）+ asset_prices 快照
//  - 输出：机构级决策数据（z-score 异动、联动变化、强弱排名）
// ============================================================
const okx = require('../marketdata/okx_market');

const CORE = [
  ['BTC-USDT-SWAP', 'BTC', '比特币'],
  ['ETH-USDT-SWAP', 'ETH', '以太坊'],
  ['SPY-USDT-SWAP', 'SPY', '标普500'],
  ['QQQ-USDT-SWAP', 'QQQ', '纳指100'],
  ['XAU-USDT-SWAP', 'XAU', '黄金'],
  ['XAG-USDT-SWAP', 'XAG', '白银'],
  ['CL-USDT-SWAP', 'CL', 'WTI原油'],
  ['XCU-USDT-SWAP', 'XCU', '铜'],
  ['NVDA-USDT-SWAP', 'NVDA', '英伟达'],
  ['MSTR-USDT-SWAP', 'MSTR', '微策略'],
];

function std(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  const a = x.slice(-n), b = y.slice(-n);
  const mx = a.reduce((s, v) => s + v, 0) / n, my = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - mx, v = b[i] - my; num += u * v; dx += u * u; dy += v * v; }
  if (!dx || !dy) return null;
  return num / Math.sqrt(dx * dy);
}
function returns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}

/** 30/90 日收益序列（缓存 30 分钟） */
const _cache = { ts: 0, data: null };
async function series() {
  if (_cache.data && Date.now() - _cache.ts < 30 * 60 * 1000) return _cache.data;
  const out = [];
  for (const [inst, sym, zh] of CORE) {
    try {
      const kl = await okx.candles(inst, '1D', 95);
      if (!kl || kl.length < 40) continue;
      const closes = kl.map(k => k.c);
      out.push({ inst, sym, zh, closes });
    } catch (e) { debug('[asset_analytics] idx:', e.message); }
    await new Promise(r => setTimeout(r, 250));
  }
  _cache.data = out;
  _cache.ts = Date.now();
  return out;
}

/** 构建完整数据处理结果 */
async function buildAnalytics(db) {
  const list = await series();
  const assets = {};
  for (const a of list) {
    const c = a.closes;
    const ret = returns(c);
    const last = c[c.length - 1];
    const ret30 = c.length > 30 ? last / c[c.length - 30] - 1 : null;
    const ret90 = last / c[0] - 1;
    const annVol = std(ret.slice(-30)) * Math.sqrt(365) * 100;
    assets[a.sym] = { inst: a.inst, zh: a.zh, last, ret30: ret30 != null ? ret30 * 100 : null, ret90: ret90 * 100, annVol };
  }

  // 1. 波动率排名（年化）
  const volatility = Object.values(assets).filter(a => a.annVol != null)
    .sort((x, y) => y.annVol - x.annVol)
    .map(a => ({ sym: a.sym, zh: a.zh, vol: +a.annVol.toFixed(1), ret30: a.ret30 != null ? +a.ret30.toFixed(2) : null }));

  // 2. 相关性矩阵（30日）与相关性变化（30日 vs 90日）
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const ra = returns(a.closes), rb = returns(b.closes);
      const c30 = pearson(ra.slice(-30), rb.slice(-30));
      const c90 = pearson(ra, rb);
      if (c30 == null) continue;
      const shift = c90 != null ? +(c30 - c90).toFixed(2) : null;
      pairs.push({
        a: a.sym, b: b.sym, aZh: a.zh, bZh: b.zh,
        corr30: +c30.toFixed(2), corr90: c90 != null ? +c90.toFixed(2) : null, shift
      });
    }
  }
  // 显著联动变化（做单核心）
  const correlationShift = pairs
    .filter(p => p.shift != null && Math.abs(p.shift) >= 0.12)
    .sort((x, y) => Math.abs(y.shift) - Math.abs(x.shift))
    .map(p => ({ ...p, note: p.shift > 0 ? '联动增强' : '联动减弱' }));

  // 3. 异动检测：30日收益 z-score（相对核心资产池）
  const rets30 = Object.values(assets).map(a => a.ret30).filter(v => v != null);
  const m30 = rets30.reduce((s, v) => s + v, 0) / rets30.length;
  const s30 = std(rets30) || 1;
  const anomalies = Object.values(assets)
    .filter(a => a.ret30 != null)
    .map(a => ({ sym: a.sym, zh: a.zh, ret30: +a.ret30.toFixed(2), z: +((a.ret30 - m30) / s30).toFixed(2) }))
    .filter(a => Math.abs(a.z) >= 1.3)
    .sort((x, y) => Math.abs(y.z) - Math.abs(x.z));

  // 4. 相对强弱：各资产 30 日收益 vs 标普
  const spy30 = assets.SPY ? assets.SPY.ret30 : null;
  const relativeStrength = Object.values(assets)
    .filter(a => a.ret30 != null && spy30 != null)
    .map(a => ({ sym: a.sym, zh: a.zh, ret30: +a.ret30.toFixed(2), vsSPY: +(a.ret30 - spy30).toFixed(2) }))
    .sort((x, y) => y.vsSPY - x.vsSPY);

  // 5. BTC 联动视图（做单最重要）
  const btcLinks = pairs.filter(p => p.a === 'BTC' || p.b === 'BTC')
    .map(p => ({ pair: p.a === 'BTC' ? p.b : p.a, pairZh: p.a === 'BTC' ? p.bZh : p.aZh, corr30: p.corr30, shift: p.shift }))
    .sort((x, y) => Math.abs(y.corr30) - Math.abs(x.corr30));

  // 6. 市场状态判定（数据处理结论）
  const upN = volatility.filter(v => v.ret30 != null && v.ret30 > 0).length;
  const state = {
    riskOn: upN >= volatility.length * 0.6,
    breadth30: `${upN}/${volatility.length}`,
    mostVolatile: volatility[0] ? { zh: volatility[0].zh, vol: volatility[0].vol } : null,
    strongest: relativeStrength[0] ? { zh: relativeStrength[0].zh, vsSPY: relativeStrength[0].vsSPY } : null,
    weakest: relativeStrength[relativeStrength.length - 1] ? { zh: relativeStrength[relativeStrength.length - 1].zh, vsSPY: relativeStrength[relativeStrength.length - 1].vsSPY } : null,
    btcTopLink: btcLinks[0] ? { zh: btcLinks[0].pairZh, corr: btcLinks[0].corr30 } : null
  };

  // 7. 市场情绪指数（0-100）：VIX代理反转 + 标普 + FGI + 30日宽度 + KOL
  let sentiment = 50;
  const parts = [];
  // 资产池平均波动率 → 波动率体制
  const avgVol = volatility.length ? volatility.reduce((s, v) => s + v.vol, 0) / volatility.length : null;
  let volRegime = 'unknown';
  if (avgVol != null) {
    if (avgVol < 35) volRegime = 'low';
    else if (avgVol < 60) volRegime = 'med';
    else volRegime = 'high';
  }
  // 30日宽度
  const breadth30 = upN / Math.max(1, volatility.length);
  sentiment += (breadth30 - 0.5) * 60; // ±30
  parts.push(`宽度${Math.round(breadth30 * 100)}%`);
  // FGI（从本地库）
  let fgi = null;
  try {
    const fgRow = db.prepare('SELECT value FROM fear_greed ORDER BY ts DESC LIMIT 1').get();
    if (fgRow) fgi = fgRow.value;
  } catch (e) { debug('[asset_analytics] seg:', e.message); }
  if (fgi != null) { sentiment += (fgi - 50) * 0.35; parts.push(`FGI ${fgi}`); }
  // KOL 净方向（本地 kol_signals 24h）
  try {
    const kol = db.prepare("SELECT direction FROM kol_signals WHERE ts >= ?").all(Math.floor(Date.now() / 1000) - 86400);
    if (kol.length >= 2) {
      const net = kol.reduce((s, k) => s + (k.direction === 'bullish' ? 1 : k.direction === 'bearish' ? -1 : 0), 0) / kol.length;
      sentiment += net * 15;
      parts.push(`KOL ${net > 0 ? '+' : ''}${(net * 100).toFixed(0)}%`);
    }
  } catch (e) { debug('[asset_analytics] corr:', e.message); }
  sentiment = Math.max(0, Math.min(100, Math.round(sentiment)));
  const sentLevel = sentiment >= 75 ? '极度贪婪' : sentiment >= 60 ? '贪婪' : sentiment >= 45 ? '中性偏多' : sentiment >= 35 ? '中性' : sentiment >= 25 ? '中性偏空' : sentiment >= 15 ? '恐惧' : '极度恐惧';

  // 8. 做单雷达（规则引擎综合结论）
  const riskOn = state.riskOn;
  let mode = '观望', posHint = '0-20%', riskLevel = '中';
  if (volRegime === 'high' && riskOn) { mode = '趋势市·顺势'; posHint = '30-50%'; riskLevel = '高'; }
  else if (volRegime === 'high' && !riskOn) { mode = '高波动·防御'; posHint = '0-15%'; riskLevel = '极高'; }
  else if (volRegime === 'low' && riskOn) { mode = '低波·区间'; posHint = '20-40%'; riskLevel = '低'; }
  else if (volRegime === 'low' && !riskOn) { mode = '低波·观望'; posHint = '0-20%'; riskLevel = '中'; }
  else if (riskOn) { mode = '震荡偏多'; posHint = '20-40%'; riskLevel = '中'; }
  else { mode = '震荡防御'; posHint = '10-25%'; riskLevel = '高'; }
  const radar = { mode, posHint, riskLevel, sentiment, sentLevel, volRegime, avgVol: avgVol != null ? +avgVol.toFixed(0) : null, parts };

  // 9. 未来 48h 高影响事件（金十经济日历）
  let events48h = [];
  try {
    const ec = db.prepare('SELECT payload FROM economic_calendar ORDER BY ts DESC LIMIT 1').get();
    if (ec) {
      const p = JSON.parse(ec.payload);
      const now = Math.floor(Date.now() / 1000);
      events48h = (p.future || [])
        .filter(e => e.ts && e.ts > now && e.ts < now + 48 * 3600)
        .map(e => ({ ts: e.ts, time: e.time || '', title: e.title_zh || e.title || '', impact: e.impact || 'low' }))
        .slice(0, 10);
    }
  } catch (e) { debug('[asset_analytics] hist:', e.message); }

  return {
    ts: Date.now(),
    state,
    radar,
    volatility,
    correlationShift,
    anomalies,
    relativeStrength,
    btcLinks,
    corrMatrix: pairs,
    events48h
  };
}

module.exports = { buildAnalytics, CORE };
