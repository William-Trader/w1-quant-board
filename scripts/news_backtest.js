'use strict';
// 消息面事件驱动回测 v1（2026-10-31）
// 用途：验证「多空权重点占比」与后续 1h / 4h / 24h 收益的方向一致性，并单独复盘典型事件
// （美联储鹰派、交易所被盗）。只读本地 DB，不发外部请求。
// 运行：node scripts/news_backtest.js [--days 30]

const path = require('path');
const Database = require('better-sqlite3');
const np = require('../lib/news_points');

const DB = process.env.W1_DB || path.join(__dirname, '..', 'data', 'w1.db');
const days = (() => {
  const i = process.argv.indexOf('--days');
  return i > 0 ? Math.max(1, Number(process.argv[i + 1]) || 30) : 30;
})();

const db = new Database(DB, { readonly: true, fileMustExist: true });
const now = Math.floor(Date.now() / 1000);
const since = now - days * 86400;

function pct(a, b) { return b ? (a / b - 1) * 100 : null; }

// 1) K线：BTC 5m
const kl = db.prepare("SELECT ts, c FROM klines WHERE symbol='BTC' AND interval='5m' AND ts>=? ORDER BY ts").all((since - 86400) * 1000);
const px = kl.map(r => ({ ts: Math.floor(Number(r.ts) / 1000), c: Number(r.c) })).filter(r => r.c > 0);
function priceAt(ts) {
  // 二分找最近 <= ts 的收盘
  let lo = 0, hi = px.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (px[m].ts <= ts) { ans = px[m]; lo = m + 1; } else hi = m - 1; }
  return ans ? ans.c : null;
}

// 2) 新闻：近 N 天
let rows = [];
try {
  rows = db.prepare("SELECT id,title,content,source,ts,sentiment,influence,bull_share,score,category FROM news WHERE ts>=? ORDER BY ts").all(since);
} catch (e) {
  rows = db.prepare("SELECT id,title,content,source,ts,sentiment,influence FROM news WHERE ts>=? ORDER BY ts").all(since);
}
// 统一用新框架重算（旧数据只有 sentiment/influence）
const items = [];
for (const r of rows) {
  const it = { title: r.title, content: r.content, ts: r.ts, source: r.source };
  np.scoreRule(it);
  items.push({ ...r, ...it, old_sentiment: r.sentiment, old_influence: r.influence });
}

// 3) 单条事件的前瞻收益
const HORIZONS = [1, 4, 24];
const buckets = { strong_bear: [], bear: [], neutral: [], bull: [], strong_bull: [] };
function bucketOf(score) {
  if (score <= -0.5) return 'strong_bear';
  if (score <= -0.15) return 'bear';
  if (score < 0.15) return 'neutral';
  if (score < 0.5) return 'bull';
  return 'strong_bull';
}
const catStats = {};
let used = 0;
for (const it of items) {
  const p0 = priceAt(it.ts);
  const p0next = priceAt(it.ts + 60); // 事件后 1 分钟，避免落在当根未收盘
  if (!p0 || !p0next) continue;
  const rec = { t: it.ts, title: it.title, score: it.score || 0, share: it.bull_share, influence: it.influence, category: it.category };
  let any = false;
  for (const h of HORIZONS) {
    const p = priceAt(it.ts + h * 3600);
    if (p) { rec['r' + h] = +pct(p, p0next).toFixed(3); any = true; }
  }
  if (!any) continue;
  used++;
  const b = bucketOf(rec.score);
  buckets[b].push(rec);
  const c = catStats[rec.category] = catStats[rec.category] || { category: rec.category, n: 0, r1: [], r4: [], r24: [], dirHit: 0, dirN: 0 };
  c.n++;
  for (const h of HORIZONS) if (rec['r' + h] != null) c['r' + h].push(rec['r' + h]);
  if (rec.r4 != null && Math.abs(rec.score) >= 0.15) {
    c.dirN++;
    if ((rec.score > 0 && rec.r4 > 0) || (rec.score < 0 && rec.r4 < 0)) c.dirHit++;
  }
}

const avg = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3) : null;
const baseline = (h) => { const all = items.map(it => { const p0 = priceAt(it.ts + 60), p = priceAt(it.ts + h * 3600); return p0 && p ? pct(p, p0) : null; }).filter(v => v != null); return avg(all); };
const base = { 1: baseline(1), 4: baseline(4), 24: baseline(24) };
console.log('基准（全体新闻等权）:', base, '\n');
const med = a => a.length ? +a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(3) : null;
function summarize(arr, h) {
  const rs = arr.map(x => x['r' + h] != null ? x['r' + h] - (base[h] || 0) : null).filter(v => v != null);
  const dirN = rs.length;
  const hit = arr.filter(x => x['r' + h] != null && Math.abs(x.score) >= 0.15 && ((x.score > 0 && x['r' + h] > 0) || (x.score < 0 && x['r' + h] < 0))).length;
  const dirTotal = arr.filter(x => x['r' + h] != null && Math.abs(x.score) >= 0.15).length;
  return { n: dirN, avg: avg(rs), med: med(rs), hit: dirTotal ? +(hit / dirTotal * 100).toFixed(1) : null };
}

console.log(`\n=== W1 消息面权重点回测 · 最近 ${days} 天 ===`);
console.log(`新闻 ${items.length} 条 · 可匹配价格 ${used} 条 · BTC 5m K线 ${px.length} 根\n`);
console.log('score 分桶        样本  1h超额%  4h超额% 24h超额%  4h命中%');
for (const [k, arr] of Object.entries(buckets)) {
  const s1 = summarize(arr, 1), s4 = summarize(arr, 4), s24 = summarize(arr, 24);
  console.log(`${k.padEnd(14)} ${String(s4.n).padStart(5)} ${String(s1.avg).padStart(9)} ${String(s4.avg).padStart(9)} ${String(s24.avg).padStart(9)} ${String(s4.hit).padStart(8)}`);
}

console.log('\n按类别（4h）：');
console.log('category      样本  4h均值%  方向命中%  类别权重');
for (const [k, c] of Object.entries(catStats).sort((a, b) => b[1].n - a[1].n)) {
  const s4 = avg(c.r4);
  const hit = c.dirN ? +(c.dirHit / c.dirN * 100).toFixed(1) : null;
  console.log(`${k.padEnd(14)} ${String(c.n).padStart(5)} ${String(s4).padStart(8)} ${String(hit).padStart(10)}  ${np.CATEGORIES[k] ? np.CATEGORIES[k].weight : '-'}`);
}

// 4) 典型事件复盘
function caseReport(label, re) {
  const hit = items.filter(it => re.test((it.title || '') + ' ' + (it.content || '').slice(0, 200)));
  console.log(`\n--- ${label} · 命中 ${hit.length} 条 ---`);
  const best = hit.map(it => {
    const p0 = priceAt(it.ts + 60);
    if (!p0) return null;
    const r1 = priceAt(it.ts + 3600), r4 = priceAt(it.ts + 4 * 3600), r24 = priceAt(it.ts + 24 * 3600);
    return { ts: it.ts, title: it.title, score: it.score, share: it.bull_share, cat: it.category, r1: r1 ? +pct(r1, p0).toFixed(2) : null, r4: r4 ? +pct(r4, p0).toFixed(2) : null, r24: r24 ? +pct(r24, p0).toFixed(2) : null };
  }).filter(Boolean);
  best.sort((a, b) => (b.r4 == null ? -999 : Math.abs(b.r4)) - (a.r4 == null ? -999 : Math.abs(a.r4)));
  for (const b of best.slice(0, 5)) {
    console.log(`${new Date(b.ts * 1000).toISOString().slice(5, 16)}  score=${String(b.score).padStart(5)} 多占比=${b.share}% 1h=${b.r1}% 4h=${b.r4}% 24h=${b.r24}%  ${String(b.title).slice(0, 52)}`);
  }
}
caseReport('美联储 / 利率', /(美联储|FOMC|鲍威尔|加息|降息|鹰派|鸽派|利率决议)/i);
caseReport('币安 / 被盗 / 黑客', /(币安|Binance|被盗|黑客|攻击|exploit|hack)/i);

// 5) 日度聚合 IC：每日加权 score（按多空权重与影响度） vs 次日 BTC 收益
const daily = {};
for (const it of items) {
  const d = new Date(it.ts * 1000).toISOString().slice(0, 10);
  const w = (Number(it.bull_w) || 0) + (Number(it.bear_w) || 0);
  if (!w) continue;
  const s = daily[d] = daily[d] || { sum: 0, w: 0 };
  s.sum += it.score * w; s.w += w;
}
const pairs = [];
for (const d of Object.keys(daily)) {
  const t0 = Date.parse(d + 'T00:00:00Z') / 1000;
  const p0 = priceAt(t0 + 3600), p1 = priceAt(t0 + 25 * 3600);
  if (!p0 || !p1) continue;
  pairs.push({ d, score: daily[d].w ? daily[d].sum / daily[d].w : 0, ret: pct(p1, p0) });
}
if (pairs.length >= 3) {
  const xs = pairs.map(p => p.score), ys = pairs.map(p => p.ret);
  const mx = avg(xs), my = avg(ys);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < pairs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  const corr = vx && vy ? cov / Math.sqrt(vx * vy) : 0;
  const hit = pairs.filter(p => (p.score > 0 && p.ret > 0) || (p.score < 0 && p.ret < 0)).length;
  console.log(`\n日度 IC：${pairs.length} 天 · corr(加权score, 次日BTC收益)=${corr.toFixed(3)} · 方向命中=${(hit / pairs.length * 100).toFixed(1)}%`);
}

db.close();
