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
function bars(db, symbol, interval, limit) {
  const rows = db.prepare('SELECT ts,o,h,l,c FROM klines WHERE symbol=? AND interval=? ORDER BY ts DESC LIMIT ?').all(symbol, interval, limit || 120);
  return rows.reverse().map(r => ({ ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
}
function latestFgi(db) {
  const rows = db.prepare('SELECT ts,value,classification FROM fear_greed ORDER BY ts DESC LIMIT 2').all();
  return rows.length ? rows.map(r => ({ ts: Number(r.ts), value: Number(r.value), classification: r.classification })) : [];
}
function etfStats(db) {
  try {
    const row = db.prepare('SELECT payload FROM etf_archive ORDER BY ts DESC LIMIT 1').get();
    const p = row ? JSON.parse(row.payload) : null;
    const s = (p && p.series) || [];
    const last = s.slice(-3).map(x => Number(x.value) || 0);
    const prev = s.slice(-6, -3).map(x => Number(x.value) || 0);
    return { sum: +last.reduce((a, b) => a + b, 0).toFixed(1), prev: +prev.reduce((a, b) => a + b, 0).toFixed(1), n: last.length };
  } catch (e) { return { sum: 0, prev: 0, n: 0 }; }
}
function events(db) {
  try {
    const row = db.prepare('SELECT payload FROM economic_calendar ORDER BY ts DESC LIMIT 1').get();
    const p = row ? JSON.parse(row.payload) : null;
    const now = Math.floor(Date.now() / 1000);
    return ((p && p.future) || []).map(e => {
        const raw = (e.date && e.time) ? new Date(e.date + 'T' + e.time + ':00+08:00').getTime() / 1000 : Number(e.ts);
        const ts = isFinite(raw) ? raw : Number(e.ts);
        return { ts, time: e.time, date: e.date, title: e.title_zh || e.title, impact: e.impact, country: e.country, countdown_sec: ts - now, blackout: Math.abs(ts - now) <= 3600 };
      }).filter(e => e.ts >= now - 3600 && e.ts <= now + 86400).sort((a, b) => a.ts - b.ts);
  } catch (e) { return []; }
}
function newsWindow(db, from, to) {
  const rows = db.prepare('SELECT ts,source,title,sentiment,influence FROM news WHERE ts>=? AND ts<? ORDER BY influence DESC, ts DESC').all(from, to);
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
    return { price: Number(btc.price), long_price: Number(btc.long_max_pain_liq_price), short_price: Number(btc.short_max_pain_liq_price), long_usd: Number(btc.long_max_pain_liq_level), short_usd: Number(btc.short_max_pain_liq_level) };
  } catch (e) { return null; }
}
function atr14(rows) {
  if (rows.length < 15) return null;
  let sum = 0;
  for (let i = rows.length - 14; i < rows.length; i++) {
    const prev = rows[i - 1].c;
    sum += Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - prev), Math.abs(prev - rows[i].l));
  }
  return sum / 14;
}
function sessionLevels(db, symbol) {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const rows = db.prepare("SELECT ts,h,l FROM klines WHERE symbol=? AND interval='5m' AND ts>=? ORDER BY ts").all(symbol, start.getTime());
  const out = {};
  const defs = [['asia', 0, 7], ['london', 7, 12], ['ny', 12, 21], ['late', 21, 24]];
  for (const [name, a, b] of defs) {
    const seg = rows.filter(r => { const h = new Date(Number(r.ts)).getUTCHours(); return h >= a && h < b; });
    out[name] = seg.length ? { high: Math.max.apply(null, seg.map(r => Number(r.h))), low: Math.min.apply(null, seg.map(r => Number(r.l))), bars: seg.length } : null;
  }
  return out;
}
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let cov = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
  return sx && sy ? +(cov / Math.sqrt(sx * sy)).toFixed(2) : null;
}
function pct(n, d) { return n == null || !isFinite(n) ? null : +Number(n).toFixed(d == null ? 2 : d); }
function sanitizeSymbols(input) {
  return String(input || 'BTC,ETH,SOL').split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{2,12}$/.test(s)).slice(0, 8);
}
function ensureSnapshot(db) { try { db.exec('CREATE TABLE IF NOT EXISTS today_snapshots (date TEXT PRIMARY KEY, ts INTEGER, bias TEXT, score REAL, price REAL, payload TEXT)'); } catch (e) {} }

function compute(db, opts = {}) {
  const deep = !!opts.deep;
  const symbols = sanitizeSymbols(opts.symbols);
  const accountSize = Math.max(100, Math.min(10000000, Number(opts.accountSize) || 1000));
  const key = 'research:today2:' + (deep ? 'deep' : 'basic') + ':' + symbols.join('-') + ':' + accountSize;
  return cached(key, 60 * 1000, () => {
    const now = Math.floor(Date.now() / 1000);
    const fut = latestFutures(db);
    const btc = fut.map.BTC || {};
    const b = bars(db, 'BTC', '4h', 120);
    const closes = b.map(x => x.c);
    const e20 = ema(closes, 20), e60 = ema(closes, 60);
    const ema20 = e20.length ? e20[e20.length - 1] : null, ema60 = e60.length ? e60[e60.length - 1] : null;
    const price = btc.current_price != null ? Number(btc.current_price) : (closes.length ? closes[closes.length - 1] : null);
    const chg = btc.price_change_percent_24h != null ? Number(btc.price_change_percent_24h) : null;
    const hi20 = b.length ? Math.max.apply(null, b.slice(-120).map(x => x.h)) : null;
    const lo20 = b.length ? Math.min.apply(null, b.slice(-120).map(x => x.l)) : null;
    const fgiArr = latestFgi(db), fgi = fgiArr[0] || null, fgiPrev = fgiArr[1] || null;
    const etf = etfStats(db);
    const evs = events(db);
    const newsNow = newsWindow(db, now - 6 * 3600, now);
    const newsPrev = newsWindow(db, now - 12 * 3600, now - 6 * 3600);
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
    const newsScore = newsNow.total ? clamp((newsNow.counts.bullish - newsNow.counts.bearish) / newsNow.total, -1, 1) * 0.5 : 0;
    const highEvents = evs.filter(e => e.impact === 'high');
    const eventRisk = highEvents.length ? 1 : 0;
    let deepData = null, posScore = 0, posRows = [];
    if (deep) {
      try {
        const p = require('./positioning').compute(db);
        posRows = (p && p.rows) || [];
        const row = posRows.find(x => x.symbol === 'BTC');
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
    const support = lo20 != null && ema20 != null ? Math.min(lo20, ema20) : (lo20 || ema20);
    const resistance = hi20 != null && ema20 != null ? Math.max(hi20, ema20) : (hi20 || ema20);
    const atr = atr14(b);
    const stopPct = atr && price ? clamp(1.5 * atr / price * 100, 0.5, 8) : null;
    const maxLoss = accountSize * 0.01;
    const positionSize = stopPct ? +(maxLoss / (stopPct / 100)).toFixed(0) : null;
    const sess = sessionLevels(db, 'BTC');
    const e20Prev = e20.length > 6 ? e20[e20.length - 7] : null, e60Prev = e60.length > 6 ? e60[e60.length - 7] : null;
    const prevRegime = e20Prev != null && e60Prev != null ? (e20Prev > e60Prev ? 'trend_up' : 'trend_down') : null;
    const watch = symbols.map(sym => {
      const c = fut.map[sym] || {};
      const sb = bars(db, sym, '4h', 120);
      const sh = sb.length ? Math.max.apply(null, sb.slice(-120).map(x => x.h)) : null;
      const sl = sb.length ? Math.min.apply(null, sb.slice(-120).map(x => x.l)) : null;
      const px = c.current_price != null ? Number(c.current_price) : (sb.length ? sb[sb.length - 1].c : null);
      const near = px != null && sh != null && sl != null ? (Math.abs(px - sh) / px < 0.005 ? 'near_resistance' : Math.abs(px - sl) / px < 0.005 ? 'near_support' : 'wait') : 'nodata';
      const stress = (posRows.find(x => x.symbol === sym) || {}).stress;
      return {
        symbol: sym, price: pct(px), change_24h: pct(c.price_change_percent_24h), support: pct(sl), resistance: pct(sh),
        state: highEvents.some(e => e.blackout) ? 'avoid' : (px != null && sh != null && px > sh ? 'breakout' : px != null && sl != null && px < sl ? 'breakdown' : near),
        trigger: near === 'near_resistance' ? pct(sh) : near === 'near_support' ? pct(sl) : null,
        invalidation: near === 'near_resistance' ? pct(sl) : near === 'near_support' ? pct(sh) : null,
        stress: stress == null ? null : stress
      };
    });
    const sources = [];
    const addAge = (name, ts, threshold) => { const age = ts ? Math.max(0, now - Number(ts)) : null; sources.push({ name, age_sec: age, status: age == null ? 'empty' : age > threshold ? 'stale' : 'ok', threshold }); };
    try { addAge('futures_markets', fut.ts, 5400); } catch (e) {}
    try { addAge('funding_history', db.prepare('SELECT MAX(ts) m FROM funding_history').get().m, 900); } catch (e) {}
    try { addAge('liquidation', db.prepare('SELECT MAX(ts) m FROM liquidation').get().m, 5400); } catch (e) {}
    try { addAge('news', db.prepare('SELECT MAX(ts) m FROM news').get().m, 14400); } catch (e) {}
    try { addAge('fear_greed', fgi ? fgi.ts : null, 108000); } catch (e) {}
    try { addAge('etf_archive', db.prepare('SELECT MAX(ts) m FROM etf_archive').get().m, 7200); } catch (e) {}
    try { addAge('cgpro_snapshots', db.prepare('SELECT MAX(ts) m FROM cgpro_snapshots').get().m, 3600); } catch (e) {}
    const scenarios = [];
    if (price != null && resistance != null) scenarios.push({ type: 'up', text: '若放量站稳 ' + pct(resistance) + '，关注突破后的回踩确认；追高需控制仓位。' });
    if (price != null && support != null) scenarios.push({ type: 'down', text: '若跌破 ' + pct(support) + '，短线风险偏好下降，先看是否快速收回。' });
    if (wall) scenarios.push({ type: 'liq', text: '上方空头清算墙约 ' + pct(wall.short_price) + '，下方多头清算墙约 ' + pct(wall.long_price) + '；穿墙前不宜重仓。' });
    const checklist = [];
    if (highEvents.length) checklist.push('事件窗口：' + highEvents.slice(0, 2).map(e => (e.time || '') + ' ' + (e.title || '')).join('；') + '，事件前避免追单。');
    if (deep && posRows.length) { const r = posRows.find(x => x.symbol === 'BTC'); if (r) checklist.push('仓位：BTC 压力分 ' + r.stress + '，' + (r.trapped || '无显著错配') + '；费率 z=' + (r.funding_z == null ? '—' : r.funding_z) + '。'); }
    if (support != null && resistance != null) checklist.push('关键位：支撑 ' + pct(support) + ' / 阻力 ' + pct(resistance) + '；区间内不追涨杀跌。');
    if (stopPct) checklist.push('风险预算：按 1% 账户风险，止损约 ' + stopPct.toFixed(1) + '%，名义仓位约 ' + positionSize + '。');
    if (stale) checklist.push('数据提示：FGI 已 ' + Math.round((now - (fgi ? fgi.ts : now)) / 3600) + ' 小时未更新，降低情绪分权重。');
    const flags = [];
    if (highEvents.length) flags.push('今日有 ' + highEvents.length + ' 个高影响事件');
    if (fgi && (fgi.value <= 25 || fgi.value >= 75)) flags.push('FGI 极端：' + fgi.value + ' ' + (fgi.classification || ''));
    if (wall && price != null) { const up = Math.abs(wall.short_price - price) / price * 100, dn = Math.abs(price - wall.long_price) / price * 100; if (up < 1.5) flags.push('距上方清算墙仅 ' + up.toFixed(1) + '%'); if (dn < 1.5) flags.push('距下方清算墙仅 ' + dn.toFixed(1) + '%'); }
    if (stale) flags.push('部分数据 stale');
    if (!deep) flags.push('会员可解锁仓位压力与告警');
    ensureSnapshot(db);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const payload = JSON.stringify({ bias: biasCode, score: +score.toFixed(2), confidence, price, headline: biasZh + '（置信 ' + confidence + '%）' });
      db.prepare('INSERT OR REPLACE INTO today_snapshots(date,ts,bias,score,price,payload) VALUES(?,?,?,?,?,?)').run(date, now, biasCode, +score.toFixed(2), price, payload);
    } catch (e) {}
    return {
      ok: true, as_of: now, symbol: 'BTC', deep, symbols: watch,
      bias: { code: biasCode, label_zh: biasZh, label_en: biasCode === 'long' ? 'Bullish' : biasCode === 'short' ? 'Bearish' : 'Neutral', score: +score.toFixed(2), confidence },
      headline: biasZh + '（置信 ' + confidence + '%）' + (resistance ? '：上方 ' + pct(resistance) + '，下方 ' + pct(support) : '') + (highEvents.length ? '；今日有高影响事件' : ''),
      price: pct(price), change_24h: pct(chg), regime, fgi: fgi ? { value: fgi.value, classification: fgi.classification, age_sec: now - fgi.ts, change: fgiPrev ? fgi.value - fgiPrev.value : null } : null,
      etf_3d: etf, news: { total: newsNow.total, counts: newsNow.counts, top: newsNow.top, prev_total: newsPrev.total, prev_counts: newsPrev.counts },
      events: evs.slice(0, 8), key_levels: { support: pct(support), resistance: pct(resistance), ema20: pct(ema20), ema60: pct(ema60), liquidation_long: wall ? pct(wall.long_price) : null, liquidation_short: wall ? pct(wall.short_price) : null },
      sessions: sess, watch, risk_budget: { account_size: accountSize, risk_pct: 1, max_loss: +maxLoss.toFixed(2), stop_pct: pct(stopPct), position_size: positionSize, atr: pct(atr), corr_btc_eth: (() => { const eb = bars(db, 'ETH', '4h', 40).map(x => x.c); return correlation(closes.slice(-40), eb); })() },
      delta: { price_24h_pct: pct(chg), ema20_change_pct: e20Prev ? pct((ema20 - e20Prev) / e20Prev * 100) : null, ema60_change_pct: e60Prev ? pct((ema60 - e60Prev) / e60Prev * 100) : null, fgi_change: fgiPrev ? fgi.value - fgiPrev.value : null, etf_3d_change: pct(etf.sum - etf.prev), news_balance_change: newsPrev.total ? pct((newsNow.counts.bullish - newsNow.counts.bearish) - (newsPrev.counts.bullish - newsPrev.counts.bearish)) : null, regime_prev: prevRegime },
      scenarios, checklist, risk_flags: flags, components: { trend: pct(trendN), sentiment: pct(sent), flow: pct(flow), news: pct(newsScore), positioning: pct(posScore) },
      data_trust: sources,
      deep: deepData ? { positioning: deepData.positioning ? { market: deepData.positioning.market, rows: deepData.positioning.rows.slice(0, 6) } : null, alerts: deepData.alerts } : null,
      notes: '规则化盘前/盘中简报：趋势、情绪、ETF 流、新闻、仓位、事件风险、关键位与风险预算；不构成交易建议。'
    };
  });
}
function review(db, date) {
  try {
    const snap = db.prepare('SELECT * FROM today_snapshots WHERE date=?').get(String(date));
    if (!snap) return { ok: false, error: 'no_snapshot' };
    const dayStart = new Date(String(date) + 'T00:00:00+08:00').getTime();
    const rows = db.prepare("SELECT ts,o,c FROM klines WHERE symbol='BTC' AND interval='5m' AND ts>=? AND ts<? ORDER BY ts").all(dayStart, dayStart + 86400 * 1000);
    if (rows.length < 2) return { ok: false, error: 'no_ohlc' };
    const open = Number(rows[0].o), close = Number(rows[rows.length - 1].c);
    const ret = (close - open) / open * 100;
    const hit = snap.bias === 'long' ? ret > 0 : snap.bias === 'short' ? ret < 0 : Math.abs(ret) < 1;
    return { ok: true, date: String(date), snapshot: { bias: snap.bias, score: snap.score, price: snap.price, ts: snap.ts }, day: { open, close, ret_pct: +ret.toFixed(2) }, hit, note: '按偏多/偏空方向与当日涨跌判定；中性按 ±1% 内算命中。' };
  } catch (e) { return { ok: false, error: e.message }; }
}
function answer(db, question) {
  const q = String(question || '').toLowerCase();
  const t = compute(db, { deep: false });
  if (!t.ok) return { ok: false, error: 'no_brief' };
  if (q.indexOf('为什么') >= 0 || q.indexOf('原因') >= 0) return { ok: true, answer: t.headline + '。评分构成：趋势 ' + t.components.trend + '、新闻 ' + t.components.news + '、情绪 ' + t.components.sentiment + '、ETF 流 ' + t.components.flow + '。' };
  if (q.indexOf('关键') >= 0 || q.indexOf('支撑') >= 0 || q.indexOf('阻力') >= 0) return { ok: true, answer: '支撑 ' + t.key_levels.support + '，阻力 ' + t.key_levels.resistance + '；下方清算墙 ' + t.key_levels.liquidation_long + '，上方 ' + t.key_levels.liquidation_short + '。' };
  if (q.indexOf('事件') >= 0 || q.indexOf('什么时') >= 0) return { ok: true, answer: t.events.length ? t.events.slice(0, 3).map(e => (e.time || '') + ' ' + (e.title || '') + '（' + e.impact + '）').join('；') : '未来 24h 无高影响事件。' };
  if (q.indexOf('失效') >= 0 || q.indexOf('止损') >= 0) return { ok: true, answer: '当前判断的失效条件：跌破 ' + t.key_levels.support + '；风险预算止损约 ' + t.risk_budget.stop_pct + '%，名义仓位参考 ' + t.risk_budget.position_size + '。' };
  if (q.indexOf('风险') >= 0) return { ok: true, answer: (t.risk_flags || []).join('；') || '暂无明显风险标记。' };
  return { ok: true, answer: t.headline + '。可问：为什么、关键位、事件、止损/失效、风险。' };
}
module.exports = { compute, review, answer };
