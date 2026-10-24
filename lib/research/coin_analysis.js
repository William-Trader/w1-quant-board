'use strict';
const { cached, ema, clamp } = require('./util');
const ind = require('../indicators');

function bars(db, sym, interval, limit) {
  const rows = db.prepare('SELECT ts,o,h,l,c,v FROM klines WHERE symbol=? AND interval=? ORDER BY ts DESC LIMIT ?').all(sym, interval, limit || 220);
  return rows.reverse().map(r => ({ ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }));
}
function futMap(db) {
  const row = db.prepare('SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 1').get();
  if (!row) return {};
  try { const p = JSON.parse(row.payload); const m = {}; for (const c of (p.data || [])) if (c && c.symbol) m[c.symbol] = c; return m; } catch (e) { return {}; }
}
function lsr(db, sym) {
  const rows = db.prepare('SELECT ratio,trader_ratio,whale_ratio FROM lsr_history WHERE (symbol=? OR symbol=?) ORDER BY ts DESC LIMIT 1').all(sym, sym + 'USDT');
  return rows[0] || null;
}
function liq(db, sym) {
  const rows = db.prepare("SELECT exchange,payload FROM liquidation l1 WHERE ts=(SELECT MAX(ts) FROM liquidation l2 WHERE l2.exchange=l1.exchange)").all();
  let long = 0, short = 0, ex = 0;
  for (const r of rows) {
    try { const p = JSON.parse(r.payload); for (const c of (p.data || [])) { if (String(c.symbol || '').replace(/USDT$/, '') !== sym) continue; long += Number(c.long_liquidation_usd_24h || 0); short += Number(c.short_liquidation_usd_24h || 0); ex++; } } catch (e) {}
  }
  return { long, short, exchanges: ex };
}
function maxPain(db, sym) {
  try {
    const row = db.prepare("SELECT payload FROM cgpro_snapshots WHERE endpoint='liq_max_pain' ORDER BY ts DESC LIMIT 1").get();
    const p = row ? JSON.parse(row.payload) : null; const hit = (p && p.data || []).find(x => String(x.symbol).toUpperCase() === sym);
    return hit ? { long_price: Number(hit.long_max_pain_liq_price), short_price: Number(hit.short_max_pain_liq_price), long_usd: Number(hit.long_max_pain_liq_level), short_usd: Number(hit.short_max_pain_liq_level) } : null;
  } catch (e) { return null; }
}
function pct(n, d) { return n == null || !isFinite(n) ? null : +Number(n).toFixed(d == null ? 2 : d); }
function pnum(n) { return n == null || !isFinite(n) ? null : +Number(n).toFixed(2); }

function compute(db, symbol) {
  const sym = String(symbol || 'BTC').toUpperCase().replace(/USDT$/, '');
  return cached('research:coin:' + sym, 60 * 1000, () => {
    const b = bars(db, sym, '4h', 220);
    if (b.length < 30) return { ok: false, error: 'no_klines', symbol: sym };
    const closes = b.map(x => x.c);
    const e20 = ind.ema(closes, 20), e50 = ind.ema(closes, 50), e200 = ind.ema(closes, 200);
    const r14 = ind.rsi(closes, 14), a14 = ind.atr(b, 14), adx = ind.adxCalc(b, 14);
    const macd = (() => { const a = ind.ema(closes, 12), c = ind.ema(closes, 26); return a[a.length - 1] - c[c.length - 1]; })();
    const price = closes[closes.length - 1];
    const hi20 = Math.max.apply(null, b.slice(-20).map(x => x.h)), lo20 = Math.min.apply(null, b.slice(-20).map(x => x.l));
    const hi60 = Math.max.apply(null, b.slice(-60).map(x => x.h)), lo60 = Math.min.apply(null, b.slice(-60).map(x => x.l));
    const f = futMap(db)[sym] || {};
    const l = lsr(db, sym) || {};
    const q = liq(db, sym);
    const wall = maxPain(db, sym);
    let score = 0;
    if (price > e20[e20.length - 1]) score++; else score--;
    if (e20[e20.length - 1] > e50[e50.length - 1]) score++; else score--;
    if (e50[e50.length - 1] > e200[e200.length - 1]) score++; else score--;
    if (r14[r14.length - 1] > 55) score += 0.5; else if (r14[r14.length - 1] < 45) score -= 0.5;
    if (macd > 0) score += 0.5; else score -= 0.5;
    const techScore = +clamp(score / 4, -1, 1).toFixed(2);
    const trend = techScore >= 0.35 ? '偏多' : techScore <= -0.35 ? '偏空' : '震荡';
    const scenarios = [];
    scenarios.push('若站稳 ' + pct(hi20) + '，上看 ' + pct(hi60) + '；跌破 ' + pct(lo20) + ' 则回到 ' + pct(lo60) + ' 区间。');
    if (wall) scenarios.push('上方空头清算墙 ' + pct(wall.short_price) + '，下方多头清算墙 ' + pct(wall.long_price) + '。');
    return {
      ok: true, as_of: Math.floor(Date.now() / 1000), symbol: sym, price: pct(price), change_24h: pct(f.price_change_percent_24h),
      trend, tech_score: techScore, confidence: Math.round(50 + Math.abs(techScore) * 35),
      indicators: { ema20: pct(e20[e20.length - 1]), ema50: pct(e50[e50.length - 1]), ema200: pct(e200[e200.length - 1]), rsi14: pct(r14[r14.length - 1], 1), atr14: pct(a14[a14.length - 1]), adx14: pct(adx[adx.length - 1], 1), macd: pct(macd, 3) },
      levels: { support20: pct(lo20), resistance20: pct(hi20), support60: pct(lo60), resistance60: pct(hi60), liquidation_long: wall ? pct(wall.long_price) : null, liquidation_short: wall ? pct(wall.short_price) : null },
      positioning: { funding: f.avg_funding_rate_by_oi == null ? null : pct(f.avg_funding_rate_by_oi, 6), oi_change_24h: pct(f.open_interest_change_percent_24h), oi_usd: f.open_interest_usd == null ? null : Number(f.open_interest_usd), lsr_ratio: l.ratio == null ? null : pct(l.ratio, 3), liq_long_24h: q.long, liq_short_24h: q.short, exchanges: q.exchanges },
      scenarios, summary: sym + ' ' + trend + '（技术分 ' + techScore + '）：RSI ' + pct(r14[r14.length - 1], 1) + '，ADX ' + pct(adx[adx.length - 1], 1) + '，关键区间 ' + pct(lo20) + '–' + pct(hi20) + '。',
      notes: '技术分析基于 4h K 线与本地仓位数据；不构成交易建议。'
    };
  });
}
module.exports = { compute };
