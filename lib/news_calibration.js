'use strict';
// 消息面「历史校准」v1（2026-10-31）
// 用历史新闻 + BTC 5m K线回测每类别的 4h 方向命中率与超额收益，据此按收缩(shrinkage)推导校准权重，
// 样本越多越信任实测，样本不足回退基础权重，防弱信号过拟合。只读 DB，不发外部请求。
// 结果落盘 data/news_calibration.json，供采集评分与前端「情报校准摘要」读取。

const fs = require('fs');
const path = require('path');
const np = require('./news_points');

const FILE = path.join(__dirname, '..', 'data', 'news_calibration.json');

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return d && d.weights ? d : null;
  } catch (e) { return null; }
}

function save(report) {
  try { fs.writeFileSync(FILE, JSON.stringify(report, null, 2)); return true; }
  catch (e) { return false; }
}

function weightsOf() {
  const c = load();
  return c ? c.weights : null;
}

function pct(a, b) { return b ? (a / b - 1) * 100 : null; }

function makePriceLookup(kl) {
  const px = kl.map(r => ({ ts: Math.floor(Number(r.ts) / 1000), c: Number(r.c) })).filter(r => r.c > 0);
  return function (ts) {
    let lo = 0, hi = px.length - 1, ans = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (px[m].ts <= ts) { ans = px[m]; lo = m + 1; } else hi = m - 1; }
    return ans ? ans.c : null;
  };
}

function calibrate(db, opts) {
  opts = opts || {};
  const days = Math.max(7, Math.min(90, Number(opts.days) || 30));
  const horizonHours = Math.max(1, Math.min(24, Number(opts.horizonHours) || 4));
  const minSamples = Math.max(5, Number(opts.minSamples) || 20);
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;

  const kl = db.prepare("SELECT ts,c FROM klines WHERE symbol='BTC' AND interval='5m' AND ts>=? ORDER BY ts").all((since - 86400) * 1000);
  const priceAt = makePriceLookup(kl);

  let rows = [];
  try {
    rows = db.prepare("SELECT id,title,content,source,ts FROM news WHERE ts>=? ORDER BY ts").all(since);
  } catch (e) { rows = []; }

  const items = [];
  for (const r of rows) {
    const it = { title: r.title, content: r.content, ts: r.ts, source: r.source };
    np.scoreRule(it);
    items.push(it);
  }

  const cat = {};
  let used = 0;
  for (const it of items) {
    const p0 = priceAt(it.ts + 60);
    const p4 = priceAt(it.ts + horizonHours * 3600);
    if (p0 == null || p4 == null) continue;
    const ret = pct(p4, p0);
    const c = it.category || 'market';
    const rec = cat[c] = cat[c] || { n: 0, dirN: 0, dirHit: 0, rets: [] };
    rec.n++; rec.rets.push(ret);
    if (Math.abs(it.score || 0) >= 0.15) {
      rec.dirN++;
      if ((it.score > 0 && ret > 0) || (it.score < 0 && ret < 0)) rec.dirHit++;
    }
    used++;
  }

  const weights = {};
  const categories = [];
  for (const key of Object.keys(np.CATEGORIES)) {
    const base = np.CATEGORIES[key];
    const c = cat[key];
    const n = c ? c.n : 0;
    const dirN = c ? c.dirN : 0;
    const hitRate = dirN >= 3 ? c.dirHit / dirN : null;
    const excess = c && c.rets.length ? +(c.rets.reduce((s, v) => s + v, 0) / c.rets.length).toFixed(3) : null;
    let factor = 1;
    if (hitRate != null && dirN >= minSamples) {
      const shrink = dirN / (dirN + 30);
      factor = 1 + shrink * (hitRate - 0.5) / 0.5;
      factor = Math.max(0.4, Math.min(1.6, factor));
    }
    const w = +(base.weight * factor).toFixed(3);
    weights[key] = w;
    categories.push({
      category: key, label: base.label, base_weight: base.weight, cal_weight: w,
      factor: +factor.toFixed(3), n, dirN,
      hit_rate: hitRate == null ? null : +(hitRate * 100).toFixed(1),
      excess_4h: excess
    });
  }

  return {
    as_of: now, days, horizon_hours: horizonHours, min_samples: minSamples,
    news_total: items.length, matched: used, kline_bars: kl.length,
    method: 'shrunk_hit_rate', weights, categories
  };
}

function run(db, opts) {
  const report = calibrate(db, opts);
  save(report);
  return report;
}

module.exports = { load, save, weightsOf, calibrate, run };

