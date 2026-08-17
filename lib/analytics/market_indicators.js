'use strict';
const { debug } = require('../log');
// ============================================================
// 全球资产 10 大经典市场指标引擎 v1.0（2026-08-14）
//  对话式 AI 做不到的：真实数据 + 历史阈值判定 + 状态分级
//  1. CNN 恐惧贪婪指数    2. VIX 恐慌    3. HY 信用利差
//  4. 收益率曲线 10Y-2Y   5. 美元指数    6. 美联储资产负债表
//  7. M2 同比             8. 稳定币供应  9. 50DMA 市场宽度
//  10. BTC⇄纳指相关性
// ============================================================
const { kvGet } = require('../db');
const okx = require('../marketdata/okx_market');

const _cache = { ts: 0, cnn: null };
const STOCKS = ['SPY-USDT-SWAP','QQQ-USDT-SWAP','NVDA-USDT-SWAP','AAPL-USDT-SWAP','MSFT-USDT-SWAP','TSLA-USDT-SWAP','META-USDT-SWAP','AMZN-USDT-SWAP','GOOGL-USDT-SWAP','AMD-USDT-SWAP','MU-USDT-SWAP','SNDK-USDT-SWAP','WDC-USDT-SWAP','MRVL-USDT-SWAP','AVGO-USDT-SWAP','QCOM-USDT-SWAP','ARM-USDT-SWAP','ASML-USDT-SWAP','AMAT-USDT-SWAP','KLAC-USDT-SWAP','LRCX-USDT-SWAP','CRM-USDT-SWAP','ORCL-USDT-SWAP','NFLX-USDT-SWAP','COIN-USDT-SWAP','MSTR-USDT-SWAP','PLTR-USDT-SWAP','SMCI-USDT-SWAP','TSM-USDT-SWAP','IBM-USDT-SWAP','JNJ-USDT-SWAP','KO-USDT-SWAP','CVX-USDT-SWAP','COST-USDT-SWAP','UNH-USDT-SWAP','LLY-USDT-SWAP','ISRG-USDT-SWAP','HOOD-USDT-SWAP','SHOP-USDT-SWAP','SNOW-USDT-SWAP','DELL-USDT-SWAP','CRWD-USDT-SWAP','RIOT-USDT-SWAP','SONY-USDT-SWAP','SAMSUNG-USDT-SWAP','SKHY-USDT-SWAP','XIAOMI-USDT-SWAP','IWM-USDT-SWAP','SMH-USDT-SWAP','XLE-USDT-SWAP'];

/** CNN 恐惧贪婪（缓存 30min） */
async function cnnFng() {
  if (_cache.cnn && Date.now() - _cache.ts < 30 * 60 * 1000) return _cache.cnn;
  const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Referer': 'https://www.cnn.com/markets/fear-and-greed' },
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error('cnn_http_' + r.status);
  const j = await r.json();
  const f = j.fear_and_greed || {};
  _cache.cnn = { score: f.score, rating: f.rating, prev: f.previous_close, week: f.previous_1_week, month: f.previous_1_month, ts: Date.now() };
  _cache.ts = Date.now();
  return _cache.cnn;
}

/** FRED 系列最新值 + 前值（从 macro_snapshot 读） */
function fredSeries(db, id) {
  try {
    if (!db) return { err: 'no_db' };
    const row = db.prepare('SELECT payload FROM macro_snapshot ORDER BY ts DESC LIMIT 1').get();
    if (!row) return { err: 'no_snapshot' };
    const p = JSON.parse(row.payload);
    const s = (p.series || {})[id];
    if (!s || !s.observations || !s.observations.length) return { err: 'no_series_' + id };
    const obs = s.observations;
    return { value: obs[0].value, prev: obs.length > 1 ? obs[1].value : null, date: obs[0].date };
  } catch (e) { return { err: e.message }; }
}

/** M2 同比（需要近 13 个月观测；collectFred 取 3 条不够 → 单独拉） */
async function fredSeriesDeep(db, id, limit = 14) {
  try {
    const { loadEnv } = require('../env');
    const env = loadEnv();
    if (!env.FRED_API_KEY) return null;
    const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${env.FRED_API_KEY}&file_type=json&sort_order=desc&limit=${limit}`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const j = await r.json();
    const obs = (j.observations || []).filter(o => o.value !== '.').map(o => ({ date: o.date, value: Number(o.value) }));
    if (obs.length < 2) return null;
    return { value: obs[0].value, prev: obs[1].value, date: obs[0].date, series: obs };
  } catch (e) { debug('[mi] get:', e.message); return null; }
}

/** 50DMA 市场宽度：多少标的上方 50 日均线（OKX K线，30min 缓存） */
const _wCache = { ts: 0, data: null };
async function widthAbove50DMA() {
  if (_wCache.data && Date.now() - _wCache.ts < 30 * 60 * 1000) return _wCache.data;
  let above = 0, total = 0;
  for (const inst of STOCKS) {
    try {
      const kl = await okx.candles(inst, '1D', 60);
      if (!kl || kl.length < 55) continue;
      const closes = kl.map(k => k.c);
      const sma50 = closes.slice(-50).reduce((s, v) => s + v, 0) / 50;
      if (closes[closes.length - 1] > sma50) above++;
      total++;
    } catch (e) { debug('[mi] series:', e.message); }
    await new Promise(r => setTimeout(r, 200));
  }
  const out = total ? { above, total, pct: above / total * 100 } : null;
  if (out) { _wCache.data = out; _wCache.ts = Date.now(); }
  return out;
}

/** 状态分级（通用：值越低越恐慌/越低风险 vs 反向指标） */
function level(value, low, high, reverse = false) {
  // 归一化到 0-100
  let v = (value - low) / (high - low) * 100;
  v = Math.max(0, Math.min(100, v));
  if (reverse) v = 100 - v;
  if (v >= 80) return { z: 'extreme_high', label: '极端', en: 'Extreme' };
  if (v >= 60) return { z: 'high', label: '偏高', en: 'High' };
  if (v > 40) return { z: 'mid', label: '中性', en: 'Mid' };
  if (v > 20) return { z: 'low', label: '偏低', en: 'Low' };
  return { z: 'extreme_low', label: '极端', en: 'Extreme' };
}

/** 10 大指标主函数 */
async function buildIndicators(db) {
  const out = [];
  // 1. CNN 恐惧贪婪
  try {
    const c = await cnnFng();
    const trend = c.score > (c.prev || c.score) ? 1 : c.score < (c.prev || c.score) ? -1 : 0;
    out.push({
      id: 'cnn_fng', name: 'CNN 恐惧贪婪指数', nameEn: 'CNN Fear & Greed',
      value: Math.round(c.score), unit: '', date: new Date(c.ts).toISOString().slice(0, 10),
      prev: c.prev != null ? Math.round(c.prev) : null, trend,
      state: c.score >= 75 ? '极度贪婪' : c.score >= 60 ? '贪婪' : c.score >= 45 ? '中性偏多' : c.score >= 35 ? '中性' : c.score >= 25 ? '恐惧' : '极度恐惧',
      signal: c.score >= 75 ? '历史极值区，追高风险大，警惕均值回归' : c.score >= 60 ? '市场贪婪，顺势但控制回撤' : c.score >= 35 ? '情绪中性，正常仓位' : c.score >= 25 ? '恐惧升温，关注超跌机会' : '极度恐惧，历史统计偏向中期机会',
      score: c.score, hist: { week: c.week != null ? Math.round(c.week) : null, month: c.month != null ? Math.round(c.month) : null }
    });
  } catch (e) { out.push({ id: 'cnn_fng', name: 'CNN 恐惧贪婪指数', error: e.message }); }

  // 2-5. FRED 系列
  const fredMap = [
    ['VIXCLS', 'VIX 恐慌指数', 'VIX', 12, 35, false, 'VIX<15 自满，>30 恐慌'],
    ['BAMLH0A0HYM2', 'HY 信用利差', 'HY OAS', 3, 8, false, '信用利差是风险偏好的最快指标'],
    ['T10Y2Y', '收益率曲线 10Y-2Y', '10Y-2Y', -0.5, 1.0, false, '倒挂=衰退预警，陡峭=宽松预期'],
    ['DTWEXBGS', '美元指数（广义）', 'DXY', 110, 140, true, '美元走强压制风险资产'],
  ];
  for (const [id, name, short, low, high, rev, tip] of fredMap) {
    const f = fredSeries(db, id);
    if (f && f.value != null) {
      const lv = level(f.value, low, high, rev);
      out.push({
        id, name, nameEn: short, value: f.value, unit: id === 'VIXCLS' || id === 'T10Y2Y' || id === 'DTWEXBGS' ? '' : '%', date: f.date,
        prev: f.prev, trend: f.prev != null ? (f.value > f.prev ? 1 : f.value < f.prev ? -1 : 0) : 0,
        state: lv.label, score: 100 - (rev ? 100 - lvRaw(f.value, low, high) : lvRaw(f.value, low, high)),
        signal: tip, level: lv
      });
    } else {
      out.push({ id, name, error: f && f.err ? 'FRED:' + f.err : '待 FRED 采集' });
    }
  }
  function lvRaw(value, low, high) { return Math.max(0, Math.min(100, (value - low) / (high - low) * 100)); }

  // 6. 美联储资产负债表 WALCL（万亿）
  const walcl = await fredSeriesDeep(db, 'WALCL', 3);
  if (walcl) {
    const v = walcl.value / 1e6; // 百万 → 万亿
    const p = walcl.prev != null ? walcl.prev / 1e6 : null;
    const chg = p ? (v - p) / p * 100 : null;
    out.push({
      id: 'WALCL', name: '美联储资产负债表', nameEn: 'Fed Balance Sheet',
      value: +v.toFixed(2), unit: '万亿美元', date: walcl.date,
      prev: p != null ? +p.toFixed(2) : null, trend: chg != null ? (chg > 0.01 ? 1 : chg < -0.01 ? -1 : 0) : 0,
      state: chg != null ? (chg > 0 ? '扩张' : '收缩') : '—', score: chg != null ? (chg > 0 ? 70 : 30) : 50,
      signal: chg != null ? (chg > 0 ? `扩表 ${chg.toFixed(2)}%（周），流动性宽松利好风险资产` : `缩表 ${chg.toFixed(2)}%（周），流动性收紧压制风险资产`) : '数据采集中'
    });
  } else out.push({ id: 'WALCL', name: '美联储资产负债表', error: '待 FRED 采集' });

  // 7. M2 同比
  const m2 = await fredSeriesDeep(db, 'M2SL', 14);
  if (m2 && m2.series && m2.series.length >= 13) {
    const now = m2.series[0].value, year = m2.series[12].value;
    const yoy = (now / year - 1) * 100;
    out.push({
      id: 'M2_YOY', name: 'M2 货币供应同比', nameEn: 'M2 YoY',
      value: +yoy.toFixed(2), unit: '%', date: m2.series[0].date,
      prev: null, trend: yoy > 0 ? 1 : -1,
      state: yoy > 8 ? '高增长' : yoy > 2 ? '正常扩张' : yoy > 0 ? '低增长' : '收缩',
      score: Math.max(0, Math.min(100, 50 + yoy * 4)), signal: `M2 同比 ${yoy.toFixed(1)}%：${yoy > 8 ? '流动性强劲' : yoy > 2 ? '货币环境正常' : yoy > 0 ? '货币偏紧' : '货币收缩'}`
    });
  } else out.push({ id: 'M2_YOY', name: 'M2 货币供应同比', error: '待数据积累（需 13 个月）' });

  // 8. 稳定币供应（kv fund:stablecoin）
  try {
    const sc = kvGet(db, 'fund:stablecoin', null);
    if (sc && sc.total) {
      const d = sc.totalPrevDay ? (sc.total / sc.totalPrevDay - 1) * 100 : null;
      const w = sc.totalPrevWeek ? (sc.total / sc.totalPrevWeek - 1) * 100 : null;
      out.push({
        id: 'STABLECOIN', name: '稳定币总供应', nameEn: 'Stablecoin Supply',
        value: +(sc.total / 1e9).toFixed(1), unit: '亿美元', date: new Date(sc.ts * 1000).toISOString().slice(0, 10),
        prev: sc.totalPrevDay ? +(sc.totalPrevDay / 1e9).toFixed(1) : null,
        trend: d != null ? (d > 0.05 ? 1 : d < -0.05 ? -1 : 0) : 0,
        state: d != null ? (d > 0.2 ? '增发·资金进场' : d < -0.2 ? '赎回·资金离场' : '平稳') : '—',
        score: d != null ? Math.max(0, Math.min(100, 50 + d * 40)) : 50,
        signal: d != null ? `24h ${d >= 0 ? '+' : ''}${d.toFixed(2)}% / 7d ${w != null ? (w >= 0 ? '+' : '') + w.toFixed(2) + '%' : '—'}：${d > 0.2 ? '场外资金进场' : d < -0.2 ? '资金离场' : '流动性平稳'}` : null
      });
    } else out.push({ id: 'STABLECOIN', name: '稳定币总供应', error: '数据采集中' });
  } catch (e) { debug('[mi] stablecoin:', e.message); out.push({ id: 'STABLECOIN', name: '稳定币总供应', error: '数据采集中' }); }

  // 9. 50DMA 市场宽度
  try {
    const w = await widthAbove50DMA();
    if (w && w.total >= 10) {
      out.push({
        id: 'WIDTH50', name: '50日均线上方占比', nameEn: '% Above 50DMA',
        value: +w.pct.toFixed(1), unit: '%', date: new Date().toISOString().slice(0, 10),
        prev: null, trend: null,
        state: w.pct >= 70 ? '强势市场' : w.pct >= 55 ? '偏强' : w.pct >= 40 ? '震荡' : w.pct >= 25 ? '偏弱' : '弱势市场',
        score: w.pct, signal: `${w.above}/${w.total} 标的上方 50 日均线：${w.pct >= 70 ? '市场宽度强劲，趋势延续概率高' : w.pct < 40 ? '宽度差，反弹脆弱' : '宽度中性'}`
      });
    } else out.push({ id: 'WIDTH50', name: '50日均线上方占比', error: '计算中（需个股K线）' });
  } catch (e) { debug('[mi] width50:', e.message); out.push({ id: 'WIDTH50', name: '50日均线上方占比', error: '计算失败' }); }

  // 10. BTC⇄纳指 20日相关性
  try {
    const kb = await okx.candles('BTC-USDT-SWAP', '1D', 25);
    const kq = await okx.candles('QQQ-USDT-SWAP', '1D', 25);
    if (kb && kq && kb.length > 15 && kq.length > 15) {
      const rb = [], rq = [];
      const n = Math.min(kb.length, kq.length);
      for (let i = 1; i < n; i++) { rb.push(kb[kb.length - n + i].c / kb[kb.length - n + i - 1].c - 1); rq.push(kq[kq.length - n + i].c / kq[kq.length - n + i - 1].c - 1); }
      const corr = pearson(rb, rq);
      if (corr != null) {
        out.push({
          id: 'BTC_QQQ', name: 'BTC⇄纳指相关性（20日）', nameEn: 'BTC-Nasdaq Corr',
          value: +corr.toFixed(2), unit: '', date: new Date().toISOString().slice(0, 10),
          prev: null, trend: null,
          state: corr > 0.7 ? '高度联动' : corr > 0.4 ? '联动' : corr > 0.1 ? '弱联动' : '分化',
          score: Math.max(0, Math.min(100, (corr + 1) * 50)),
          signal: corr > 0.7 ? '加密=高风险资产，纳指跌 BTC 难独善其身' : corr > 0.4 ? 'BTC 跟随美股方向，做单需看纳指' : corr < 0.1 ? 'BTC 与美股脱钩，独立行情（避险/叙事驱动）' : '弱联动，关注切换'
        });
      } else out.push({ id: 'BTC_QQQ', name: 'BTC⇄纳指相关性', error: '计算中' });
    } else out.push({ id: 'BTC_QQQ', name: 'BTC⇄纳指相关性', error: 'K线不足' });
  } catch (e) { debug('[mi] btc_qqq:', e.message); out.push({ id: 'BTC_QQQ', name: 'BTC⇄纳指相关性', error: '计算失败' }); }

  // 综合情绪分（可用指标加权平均）
  const scored = out.filter(x => x.score != null && !x.error);
  const composite = scored.length ? Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length) : null;
  return { ts: Date.now(), composite, compositeState: composite != null ? (composite >= 70 ? '高风险偏好' : composite >= 55 ? '偏风险' : composite >= 45 ? '中性' : composite >= 30 ? '偏避险' : '避险') : '—', indicators: out, scored: scored.length, total: 10 };
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  const a = x.slice(-n), b = y.slice(-n);
  const mx = a.reduce((s, v) => s + v, 0) / n, my = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const u = a[i] - mx, v = b[i] - my; num += u * v; dx += u * u; dy += v * v; }
  if (!dx || !dy) return null;
  return num / Math.sqrt(dx * dy);
}

module.exports = { buildIndicators };
