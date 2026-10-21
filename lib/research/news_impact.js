'use strict';
const { cached, mean } = require('./util');

function agg(items) {
  const r1 = items.map(x => x.ret_1h).filter(v => v != null);
  const r4 = items.map(x => x.ret_4h).filter(v => v != null);
  const dir = items.filter(x => x.sentiment === 'bullish' || x.sentiment === 'bearish');
  let hit = 0;
  for (const x of dir) {
    if (x.sentiment === 'bullish' && x.ret_1h > 0) hit++;
    else if (x.sentiment === 'bearish' && x.ret_1h < 0) hit++;
  }
  return {
    n: items.length,
    directional_n: dir.length,
    hit_rate_pct: dir.length ? +(100 * hit / dir.length).toFixed(1) : null,
    avg_ret_1h_pct: r1.length ? +mean(r1).toFixed(3) : null,
    avg_abs_1h_pct: r1.length ? +mean(r1.map(Math.abs)).toFixed(3) : null,
    avg_abs_4h_pct: r4.length ? +mean(r4.map(Math.abs)).toFixed(3) : null
  };
}

function compute(db) {
  return cached('research:news-impact', 5 * 60 * 1000, () => {
    const now = Math.floor(Date.now() / 1000);
    const days = 30, from = now - days * 86400;
    const bars = db.prepare("SELECT ts,c FROM klines WHERE symbol='BTC' AND interval='5m' AND ts>=? ORDER BY ts").all(from * 1000);
    if (bars.length < 200) return { ok: false, error: 'no_klines' };
    const ts = bars.map(b => Number(b.ts)), close = bars.map(b => Number(b.c));
    const rows = db.prepare('SELECT ts,source,sentiment,title,url,influence FROM news WHERE ts>=? ORDER BY ts DESC').all(from);
    const H = { m15: 3, m60: 12, h4: 48 };
    const bySource = {}, bySentiment = {}, items = [];
    function idxAt(t) {
      let lo = 0, hi = ts.length - 1, ans = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] >= t) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
      return ans;
    }
    for (const n of rows) {
      const i = idxAt(Number(n.ts) * 1000);
      if (i < 0) continue;
      const entry = close[i];
      if (!(entry > 0)) continue;
      const rets = {};
      for (const k of Object.keys(H)) { const j = i + H[k]; rets[k] = j < close.length ? (close[j] - entry) / entry * 100 : null; }
      if (rets.m60 == null) continue;
      const rec = { ts: Number(n.ts), source: n.source, sentiment: n.sentiment || 'neutral', title: n.title, url: n.url, influence: n.influence, ret_15m: rets.m15, ret_1h: rets.m60, ret_4h: rets.h4 };
      items.push(rec);
      (bySource[n.source] || (bySource[n.source] = [])).push(rec);
      (bySentiment[rec.sentiment] || (bySentiment[rec.sentiment] = [])).push(rec);
    }
    return {
      ok: true, as_of: now,
      coverage: { from: new Date(from * 1000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), news: rows.length, evaluated: items.length, bars: bars.length },
      by_source: Object.entries(bySource).map(([source, arr]) => Object.assign({ source }, agg(arr))).sort((a, b) => b.n - a.n),
      by_sentiment: Object.entries(bySentiment).map(([sentiment, arr]) => Object.assign({ sentiment }, agg(arr))),
      top: items.filter(x => x.ts >= now - 7 * 86400).sort((a, b) => Math.abs(b.ret_1h) - Math.abs(a.ret_1h)).slice(0, 8),
      notes: '以 BTC 5m K线为基准，新闻后 15m/1h/4h 收益；hit_rate 只统计 bullish/bearish 且方向一致的样本。新闻样本仅约 30 天。'
    };
  });
}

module.exports = { compute, agg };
