'use strict';
const { warn } = require('../log');
// ============================================================
// FRED 经济数据库封装 v1.0（2026-08-14）
//  - 需要 FRED_API_KEY（免费注册，env 配置）；未配置时自动跳过
//  - 机构级经济指标：GDP/CPI/失业率/利率/货币供应等
//  - 采集每日一次，数据本地缓存
// ============================================================
const BASE = 'https://api.stlouisfed.org/fred';

// 关注的核心宏观系列（group: 分类, freq: 更新频率建议）
const SERIES = [
  // 利率与货币
  { id: 'DFF',    zh: '联邦基金利率', en: 'Fed Funds Rate', grp: '利率', unit: '%' },
  { id: 'FEDFUNDS', zh: '联邦基金利率(月)', en: 'Fed Funds (M)', grp: '利率', unit: '%' },
  { id: 'T10Y2Y', zh: '10Y-2Y利差', en: '10Y-2Y Spread', grp: '利率', unit: '%' },
  { id: 'BAMLH0A0HYM2', zh: '高收益债信用利差', en: 'HY OAS', grp: '信用', unit: '%' },
  { id: 'T10Y3M', zh: '10Y-3M利差', en: '10Y-3M Spread', grp: '利率', unit: '%' },
  { id: 'M2SL',   zh: 'M2货币供应', en: 'M2 Money Supply', grp: '货币', unit: 'B$' },
  { id: 'DGS10',  zh: '10年美债收益率', en: '10Y Treasury', grp: '利率', unit: '%' },
  { id: 'DGS2',   zh: '2年美债收益率', en: '2Y Treasury', grp: '利率', unit: '%' },
  { id: 'DGS30',  zh: '30年美债收益率', en: '30Y Treasury', grp: '利率', unit: '%' },
  // 通胀
  { id: 'CPIAUCSL', zh: 'CPI同比', en: 'CPI YoY', grp: '通胀', unit: 'idx' },
  { id: 'CPILFESL', zh: '核心CPI同比', en: 'Core CPI YoY', grp: '通胀', unit: 'idx' },
  { id: 'PCEPI',  zh: 'PCE物价', en: 'PCE Price', grp: '通胀', unit: 'idx' },
  // 经济
  { id: 'GDP',    zh: 'GDP', en: 'GDP', grp: '经济', unit: 'B$' },
  { id: 'UNRATE', zh: '失业率', en: 'Unemployment', grp: '经济', unit: '%' },
  { id: 'PAYEMS', zh: '非农就业', en: 'Nonfarm Payrolls', grp: '经济', unit: 'K' },
  { id: 'DTWEXBGS', zh: '美元指数(广义)', en: 'DXY (Broad)', grp: '汇率', unit: 'idx' },
  // 市场
  { id: 'VIXCLS', zh: 'VIX收盘', en: 'VIX Close', grp: '市场', unit: 'idx' },
  { id: 'SP500',  zh: '标普500', en: 'S&P 500', grp: '市场', unit: 'idx' },
];

/** 获取某系列最新值 + 近 N 个观测点（api_key 为空返回 null） */
async function latestObservations(env, seriesId, limit = 5) {
  const key = env.FRED_API_KEY || '';
  if (!key) return null;
  const url = `${BASE}/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=${limit}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`fred_http_${res.status}`);
    const j = await res.json();
    const obs = (j.observations || []).filter(o => o.value !== '.').slice(0, limit);
    return obs.map(o => ({ date: o.date, value: Number(o.value) }));
  } catch (e) {
    warn(`[fred] ${seriesId} 获取失败: ${e.message}`);
    return null;
  } finally { clearTimeout(timer); }
}

/** 批量拉取全部关注系列（串行，间隔 1s 保守） */
async function collectAll(env) {
  const key = env.FRED_API_KEY || '';
  if (!key) return { ok: false, skipped: 'no_key' };
  const out = {};
  for (const s of SERIES) {
    const obs = await latestObservations(env, s.id, 3);
    if (obs && obs.length) out[s.id] = { ...s, observations: obs };
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: true, ts: Date.now(), series: out };
}

module.exports = { SERIES, latestObservations, collectAll };
