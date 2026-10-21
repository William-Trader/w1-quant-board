'use strict';
const { cached, ema, clamp } = require('./util');

function latestFutures(db) {
  const row = db.prepare('SELECT ts,payload FROM futures_markets ORDER BY ts DESC LIMIT 1').get();
  if (!row) return { ts: null, map: {} };
  try {
    const p = JSON.parse(row.payload);
    const map = {};
    for (const c of (p.data || [])) if (c && c.symbol) map[c.symbol] = c;
    return { ts: Number(row.ts), map };
  } catch (e) { return { ts: null, map: {} }; }
}
function btcBars(db) {
  const rows = db.prepare("SELECT ts,o,h,l,c FROM klines WHERE symbol='BTC' AND interval='4h' ORDER BY ts DESC LIMIT 120").all();
  return rows.reverse().map(r => ({ ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
}
function latestFgi(db) {
  const r = db.prepare('SELECT ts,value,classification FROM fear_greed ORDER BY ts DESC LIMIT 1').get();
  return r ? { ts: Number(r.ts), value: Number(r.value), classification: r.classification } : null;
}
function etf3(db) {
  try {
    const row = db.prepare('SELECT payload FROM etf_archive ORDER BY ts DESC LIMIT 1').get();
    const p = row ? JSON.parse(row.payload) : null;
    const s = (p && p.series) || [];
    const last = s.slice(-3).map(x => Number(x.value) || 0);
    return { sum: +last.reduce((a, b) => a + b, 0).toFixed(1), n: last.length };
  } catch (e) { return { sum: 0, n: 0 }; }
}
function nextEvents(db) {
  try {
    const row = db.prepare('SELECT payload FROM economic_calendar ORDER BY ts DESC LIMIT 1').get();
    const p = row ? JSON.parse(row.payload) : null;
    const now = Math.floor(Date.now() / 1000);
    const future = (p && p.future) || [];
    return future.filter(e => Number(e.ts) >= now - 3600 && Number(e.ts) <= now + 86400)
      .sort((a, b) => Number(a.ts) - Number(b.ts))
      .map(e => ({ ts: Number(e.ts), time: e.time, date: e.date, title: e.title_zh || e.title, impact: e.impact, country: e.country }));
  } catch (e) { return []; }
}
function newsWindow(db) {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare('SELECT ts,source,title,sentiment,influence FROM news WHERE ts>=? ORDER BY influence DESC, ts DESC').all(now - 6 * 3600);
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const r of rows) counts[r.sentiment || 'neutral'] = (counts[r.sentiment || 'neutral'] || 0) + 1;
  return { total: rows.length, counts, top: rows.slice(0, 5) };
}
function maxPain(db) {
  try {
    const row = db.prepare("SELECT payload FROM cgpro_snapshots WHERE endpoint='liq_max_pain' ORDER BY ts DESC LIMIT 1").get();
    const p = row ? JSON.parse(row.payload) : null;
    const btc = (p && p.data || []).find(x => x.symbol === 'BTC');
    if (!btc) return null;
    return {
      price: Number(btc.price),
      long_price: Number(btc.long_max_pain_liq_price),
      short_price: Number(btc.short_max_pain_liq_price),
      long_usd: Number(btc.long_max_pain_liq_level),
      short_usd: Number(btc.short_max_pain_liq_level)
    };
  } catch (e) { return null; }
}
function pct(n, digits) { return n == null || !isFinite(n) ? null : +Number(n).toFixed(digits == null ? 2 : digits); }

function compute(db, opts = {}) {
  const deep = !!opts.deep;
  return cached('research:today:' + (deep ? 'deep' : 'basic'), 60 * 1000, () => {
    const now = Math.floor(Date.now() / 1000);
    const fut = latestFutures(db);
    const btc = fut.map.BTC || {};
    const bars = btcBars(db);
    const closes = bars.map(b => b.c);
    const e20 = closes.length >= 20 ? ema(closes, 20) : [];
    const e60 = closes.length >= 60 ? ema(closes, 60) : [];
    const ema20 = e20.length ? e20[e20.length - 1] : null;
    const ema60 = e60.length ? e60[e60.length - 1] : null;
    const price = btc.current_price != null ? Number(btc.current_price) : (closes.length ? closes[closes.length - 1] : null);
    const chg = btc.price_change_percent_24h != null ? Number(btc.price_change_percent_24h) : null;
    const high20 = bars.length ? Math.max.apply(null, bars.slice(-120).map(b => b.h)) : null;
    const low20 = bars.length ? Math.min.apply(null, bars.slice(-120).map(b => b.l)) : null;
    const fgi = latestFgi(db);
    const etf = etf3(db);
    const events = nextEvents(db);
    const news = newsWindow(db);
    const wall = maxPain(db);

    let regime = null;
    try { const r = require('./regime_lab').compute(); if (r && r.ok) regime = r.current; } catch (e) {}

    let trend = 0;
    if (price != null && ema20 != null) trend += price > ema20 ? 1 : -1;
    if (ema20 != null && ema60 != null) trend += ema20 > ema60 ? 1 : -1;
    if (regime && regime.regime === 'trend_up') trend += 1;
    else if (regime && regime.regime === 'trend_down') trend -= 1;
    const trendN = clamp(trend / 3, -1, 1);
    const sent = fgi ? (fgi.value <= 25 ? 0.5 : fgi.value >= 75 ? -0.5 : 0) : 0;
    const flow = etf.sum > 0 ? 0.5 : etf.sum < 0 ? -0.5 : 0;
    const newsScore = news.total ? clamp((news.counts.bullish - news.counts.bearish) / news.total, -1, 1) * 0.5 : 0;
    const highEvents = events.filter(e => e.impact === 'high');
    const eventRisk = highEvents.length ? 1 : 0;

    let deepData = null;
    let posScore = 0;
    if (deep) {
      try {
        const p = require('./positioning').compute(db);
        const row = p && p.rows ? p.rows.find(x => x.symbol === 'BTC') : null;
        if (row) {
          if (row.trapped && row.trapped.indexOf('多头') >= 0) posScore = -0.5;
          else if (row.trapped && row.trapped.indexOf('空头') >= 0) posScore = 0.5;
          if (row.stress >= 70 && posScore) posScore *= 1.2;
        }
        deepData = { positioning: p, alerts: require('../alerts').stats(db) };
      } catch (e) {}
    }

    const score = clamp(0.45 * trendN + 0.20 * newsScore + 0.15 * sent + 0.15 * flow + 0.05 * posScore, -1, 1);
    const biasCode = score >= 0.2 ? 'long' : score <= -0.2 ? 'short' : 'neutral';
    const biasZh = biasCode === 'long' ? '偏多' : biasCode === 'short' ? '偏空' : '中性';
    const stale = fgi ? (now - fgi.ts > 36 * 3600) : true;
    let confidence = 55 + Math.abs(score) * 30 - (stale ? 15 : 0) - (eventRisk ? 8 : 0) + (deep ? 5 : 0);
    confidence = Math.round(clamp(confidence, 25, 88));

    const support = low20 != null && ema20 != null ? Math.min(low20, ema20) : (low20 || ema20);
    const resistance = high20 != null && ema20 != null ? Math.max(high20, ema20) : (high20 || ema20);
    const scenarios = [];
    if (price != null && resistance != null) scenarios.push({ type: 'up', text: '若放量站稳 ' + pct(resistance) + '，关注突破后的回踩确认；追高需控制仓位。' });
    if (price != null && support != null) scenarios.push({ type: 'down', text: '若跌破 ' + pct(support) + '，短线风险偏好下降，先看是否快速收回。' });
    if (wall) scenarios.push({ type: 'liq', text: '上方空头清算墙约 ' + pct(wall.short_price) + '，下方多头清算墙约 ' + pct(wall.long_price) + '；穿墙前不宜重仓。' });

    const checklist = [];
    if (highEvents.length) checklist.push('事件窗口：' + highEvents.slice(0, 2).map(e => (e.time || '') + ' ' + (e.title || '')).join('；') + '，事件前避免追单。');
    if (deep && deepData && deepData.positioning) {
      const r = deepData.positioning.rows.find(x => x.symbol === 'BTC');
      if (r) checklist.push('仓位：BTC 压力分 ' + r.stress + '，' + (r.trapped || '无显著错配') + '；费率 z=' + (r.funding_z == null ? '—' : r.funding_z) + '。');
      const high = deepData.positioning.rows.filter(x => x.stress >= 70).slice(0, 3);
      if (high.length) checklist.push('高压币种：' + high.map(x => x.symbol + '(' + x.stress + ')').join(' / ') + '，注意连锁清算。');
    }
    if (support != null && resistance != null) checklist.push('关键位：支撑 ' + pct(support) + ' / 阻力 ' + pct(resistance) + '；区间内不追涨杀跌。');
    if (stale) checklist.push('数据提示：FGI 已 ' + Math.round((now - (fgi ? fgi.ts : now)) / 3600) + ' 小时未更新，降低对情绪分的权重。');

    const flags = [];
    if (highEvents.length) flags.push('今日有 ' + highEvents.length + ' 个高影响事件');
    if (fgi && (fgi.value <= 25 || fgi.value >= 75)) flags.push('FGI 极端：' + fgi.value + ' ' + (fgi.classification || ''));
    if (wall && price != null) {
      const up = Math.abs(wall.short_price - price) / price * 100;
      const dn = Math.abs(price - wall.long_price) / price * 100;
      if (up < 1.5) flags.push('距上方清算墙仅 ' + up.toFixed(1) + '%');
      if (dn < 1.5) flags.push('距下方清算墙仅 ' + dn.toFixed(1) + '%');
    }
    if (stale) flags.push('部分数据 stale');
    if (!deep) flags.push('会员可解锁仓位压力与告警');

    return {
      ok: true, as_of: now, symbol: 'BTC', deep,
      bias: { code: biasCode, label_zh: biasZh, label_en: biasCode === 'long' ? 'Bullish' : biasCode === 'short' ? 'Bearish' : 'Neutral', score: +score.toFixed(2), confidence },
      headline: biasZh + '（置信 ' + confidence + '%）' + (resistance ? '：上方 ' + pct(resistance) + '，下方 ' + pct(support) : '') + (highEvents.length ? '；今日有高影响事件' : ''),
      price: pct(price), change_24h: pct(chg), regime, fgi: fgi ? { value: fgi.value, classification: fgi.classification, age_sec: now - fgi.ts } : null,
      etf_3d: etf, news: { total: news.total, counts: news.counts, top: news.top }, events: events.slice(0, 6),
      key_levels: { support: pct(support), resistance: pct(resistance), ema20: pct(ema20), ema60: pct(ema60), liquidation_long: wall ? pct(wall.long_price) : null, liquidation_short: wall ? pct(wall.short_price) : null },
      scenarios, checklist, risk_flags: flags,
      components: { trend: pct(trendN), sentiment: pct(sent), flow: pct(flow), news: pct(newsScore), positioning: pct(posScore) },
      deep: deepData ? { positioning: deepData.positioning ? { market: deepData.positioning.market, rows: deepData.positioning.rows.slice(0, 6) } : null, alerts: deepData.alerts } : null,
      notes: '规则化盘前/盘中简报：趋势、情绪、ETF 流、新闻、仓位与事件风险加权；不构成交易建议。'
    };
  });
}
module.exports = { compute };
