'use strict';
const { cached, ema, std, mean, percentile, pctRank, clamp } = require('./util');

const MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK', 'SUI'];

function latestFutures(db) {
  const row = db.prepare('SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 1').get();
  if (!row) return { ts: null, map: {} };
  try {
    const p = JSON.parse(row.payload);
    const arr = (p && p.data) || [];
    const map = {};
    for (const c of arr) if (c && c.symbol) map[c.symbol] = c;
    return { ts: row.ts || null, map };
  } catch (e) { return { ts: null, map: {} }; }
}

function fundingStats(db, symbol) {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare('SELECT ts,funding_rate FROM funding_history WHERE symbol=? AND ts>=? ORDER BY ts').all(symbol, now - 90 * 86400);
  if (!rows.length) return { latest: null, z: 0, abs_pct: null, n: 0 };
  const vals = rows.map(r => Number(r.funding_rate) || 0);
  const recent = vals.slice(-Math.min(vals.length, 30 * 48)); // 约 30 天（5min 采样约 48/天）
  const latest = vals[vals.length - 1];
  const m = mean(recent), s = std(recent);
  const z = s > 0 ? (latest - m) / s : 0;
  const absPct = pctRank(vals.map(Math.abs), Math.abs(latest));
  return { latest: +latest.toFixed(6), z: +z.toFixed(2), abs_pct: absPct == null ? null : +(100 * absPct).toFixed(0), n: vals.length };
}

function lsrStats(db, symbol) {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare('SELECT ts,ratio,trader_ratio,whale_ratio FROM lsr_history WHERE (symbol=? OR symbol=?) AND ts>=? ORDER BY ts').all(symbol, symbol + 'USDT', now - 30 * 86400);
  if (!rows.length) return { ratio: null, pct: null, n: 0 };
  const latest = rows[rows.length - 1];
  const ratio = Number(latest.ratio || latest.trader_ratio || 0);
  const vals = rows.map(r => Number(r.ratio || r.trader_ratio || 0)).filter(v => v > 0);
  return { ratio: +ratio.toFixed(3), pct: vals.length ? +(100 * pctRank(vals, ratio)).toFixed(0) : null, n: vals.length };
}

function liquidationStats(db) {
  const rows = db.prepare("SELECT exchange,payload FROM liquidation l1 WHERE ts=(SELECT MAX(ts) FROM liquidation l2 WHERE l2.exchange=l1.exchange)").all();
  const map = {};
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      for (const c of (p.data || [])) {
        const sym = String(c.symbol || '').replace(/USDT$/, '');
        if (!sym) continue;
        if (!map[sym]) map[sym] = { long: 0, short: 0, total: 0, exchanges: 0 };
        const l = Number(c.long_liquidation_usd_24h || 0), s = Number(c.short_liquidation_usd_24h || 0);
        map[sym].long += l; map[sym].short += s; map[sym].total += l + s; map[sym].exchanges++;
      }
    } catch (e) {}
  }
  return map;
}

function priceContext(db, symbol) {
  const rows = db.prepare("SELECT ts,c FROM klines WHERE symbol=? AND interval='4h' ORDER BY ts DESC LIMIT 60").all(symbol);
  if (rows.length < 25) return { ema20: null, price: null, vol_pct: null };
  const closes = rows.reverse().map(r => Number(r.c));
  const e = ema(closes, 20);
  const rets = closes.map((c, i) => i ? Math.log(c / closes[i - 1]) : 0).slice(1);
  const vol = std(rets);
  const vols = [];
  for (let i = 30; i <= closes.length; i++) vols.push(std(rets.slice(Math.max(0, i - 30), i)));
  return { ema20: e[e.length - 1], price: closes[closes.length - 1], vol_pct: vols.length ? pctRank(vols, vols[vols.length - 1]) : null };
}

function stressScore(c) {
  const fund = clamp(Math.abs(c.funding_z || 0) * 33, 0, 100);
  const oi = clamp(Math.abs(c.oi_change_24h || 0) * 10, 0, 100);
  const lsr = clamp(Math.abs((c.lsr_ratio || 1) - 1) * 250, 0, 100);
  const liq = clamp(c.liq_imbalance_pct || 0, 0, 100);
  const vol = clamp((c.vol_pct || 0) * 100, 0, 100);
  return +(0.30 * fund + 0.20 * oi + 0.20 * lsr + 0.20 * liq + 0.10 * vol).toFixed(1);
}

function trappedSide(c) {
  const fundZ = c.funding_z || 0, lsr = c.lsr_ratio || 1, px = c.price, ema20 = c.ema20;
  if (fundZ > 1 && lsr > 1.15 && px != null && ema20 != null && px < ema20) return '多头拥挤 + 价格走弱：多头被套';
  if (fundZ < -1 && lsr < 0.85 && px != null && ema20 != null && px > ema20) return '空头拥挤 + 价格走强：空头被套';
  if (fundZ > 1 && lsr > 1.15) return '多头拥挤（价格尚未走弱）';
  if (fundZ < -1 && lsr < 0.85) return '空头拥挤（价格尚未走强）';
  return '无显著错配';
}

function validation(db) {
  const now = Math.floor(Date.now() / 1000);
  const f = db.prepare('SELECT ts,funding_rate FROM funding_history WHERE symbol=? AND ts>=? ORDER BY ts').all('BTC', now - 45 * 86400);
  const k = db.prepare("SELECT ts,c FROM klines WHERE symbol='BTC' AND interval='4h' AND ts>=? ORDER BY ts").all((now - 45 * 86400) * 1000);
  if (f.length < 200 || k.length < 100) return { samples: 0 };
  const buckets = new Map();
  for (const r of f) { const b = Math.floor(Number(r.ts) / 14400) * 14400; if (!buckets.has(b)) buckets.set(b, []); buckets.get(b).push(Number(r.funding_rate) || 0); }
  const series = Array.from(buckets.entries()).map(([b, arr]) => ({ ts: b, v: mean(arr) })).sort((a, b) => a.ts - b.ts);
  const kts = k.map(x => Number(x.ts) / 1000), kc = k.map(x => Number(x.c));
  const pairs = [];
  for (let i = 180; i < series.length - 1; i++) {
    const win = series.slice(i - 180, i).map(x => x.v);
    const sd = std(win);
    if (!(sd > 0)) continue;
    const z = (series[i].v - mean(win)) / sd;
    const idx = kts.findIndex(t => t >= series[i].ts);
    if (idx < 0 || idx + 1 >= kc.length) continue;
    const fwd = (kc[idx + 1] - kc[idx]) / kc[idx] * 100;
    pairs.push({ z, fwd });
  }
  if (pairs.length < 20) return { samples: pairs.length };
  const zs = pairs.map(p => p.z), fs = pairs.map(p => p.fwd);
  const mz = mean(zs), mf = mean(fs);
  const cov = pairs.reduce((s, p) => s + (p.z - mz) * (p.fwd - mf), 0);
  const corr = cov / Math.sqrt(zs.reduce((s, z) => s + (z - mz) * (z - mz), 0) * fs.reduce((s, f) => s + (f - mf) * (f - mf), 0) || 1);
  const high = pairs.filter(p => Math.abs(p.z) > 1.5), normal = pairs.filter(p => Math.abs(p.z) <= 1.5);
  return {
    samples: pairs.length,
    corr_funding_z_vs_fwd_4h: +corr.toFixed(3),
    high_stress_n: high.length,
    high_stress_avg_abs_move: high.length ? +mean(high.map(p => Math.abs(p.fwd))).toFixed(3) : null,
    normal_avg_abs_move: normal.length ? +mean(normal.map(p => Math.abs(p.fwd))).toFixed(3) : null
  };
}

function compute(db) {
  return cached('research:positioning', 2 * 60 * 1000, () => {
    const fut = latestFutures(db);
    const liq = liquidationStats(db);
    const rows = [];
    for (const sym of MAJORS) {
      const f = fundingStats(db, sym);
      const l = lsrStats(db, sym);
      const px = priceContext(db, sym);
      const c = fut.map[sym] || {};
      const q = liq[sym] || { long: 0, short: 0, total: 0, exchanges: 0 };
      const liqImb = q.total > 0 ? Math.abs(q.long - q.short) / q.total * 100 : 0;
      const rec = {
        symbol: sym,
        price: px.price != null ? +px.price.toFixed(2) : (c.current_price != null ? Number(c.current_price) : null),
        ema20: px.ema20 != null ? +px.ema20.toFixed(2) : null,
        funding: f.latest, funding_z: f.z, funding_pct: f.abs_pct,
        oi_change_24h: c.open_interest_change_percent_24h != null ? +Number(c.open_interest_change_percent_24h).toFixed(2) : null,
        oi_usd: c.open_interest_usd != null ? Number(c.open_interest_usd) : null,
        lsr_ratio: l.ratio, lsr_pct: l.pct,
        liq_long_24h: q.long, liq_short_24h: q.short, liq_imbalance_pct: +liqImb.toFixed(1),
        vol_pct: px.vol_pct == null ? null : +(100 * px.vol_pct).toFixed(0)
      };
      rec.stress = stressScore(rec);
      rec.trapped = trappedSide(rec);
      rows.push(rec);
    }
    rows.sort((a, b) => b.stress - a.stress);
    return {
      ok: true, as_of: Math.floor(Date.now() / 1000),
      market: {
        avg_stress: +(mean(rows.map(r => r.stress))).toFixed(1),
        high_stress: rows.filter(r => r.stress >= 70).map(r => r.symbol),
        max: rows[0] ? { symbol: rows[0].symbol, stress: rows[0].stress, trapped: rows[0].trapped } : null
      },
      rows,
      validation: validation(db),
      notes: '压力分 = 30% 费率z + 20% OI变化 + 20% LSR偏离 + 20% 清算偏斜 + 10% 波动分位；仅代表仓位拥挤/脆弱度，不构成方向建议。'
    };
  });
}

module.exports = { compute, stressScore, trappedSide };
