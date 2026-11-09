'use strict';
// 全球宏观决策台（v5.3）：把 FRED 快照 + 本地指标缓存合成“体制 + 评分卡 + 核心引擎”，并提供历史复验。
// 所有分数都是 0-100；压力类越高越紧，环境类越高越友好。缺数据返回 null，不造数。

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const avg = (arr) => { const a = arr.filter(v => v != null && isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };

function parse(row) { try { return row ? JSON.parse(row.payload) : null; } catch (e) { return null; } }

function build(db) {
  const miRow = db.prepare('SELECT payload,ts FROM macro_indicators_cache ORDER BY ts DESC LIMIT 1').get();
  const msRow = db.prepare('SELECT payload,ts FROM macro_snapshot ORDER BY ts DESC LIMIT 1').get();
  const mi = parse(miRow) || { indicators: [] };
  const ms = parse(msRow) || { series: {} };
  const ind = {};
  for (const i of mi.indicators || []) ind[i.id] = i;
  const series = (id) => {
    const s = ms.series && ms.series[id];
    const obs = s && Array.isArray(s.observations) ? s.observations.map(o => Number(o.value)).filter(v => isFinite(v)) : [];
    return obs;
  };
  const val = (id) => { const a = series(id); return a.length ? a[0] : null; };
  const prev = (id) => { const a = series(id); return a.length > 1 ? a[1] : null; };
  const indVal = (id) => ind[id] && ind[id].value != null ? Number(ind[id].value) : null;
  const indScore = (id) => ind[id] && ind[id].score != null ? Number(ind[id].score) : null;

  const dgs10 = val('DGS10'), dgs2 = val('DGS2'), cpi = val('CPIAUCSL'), cpiPrev = prev('CPIAUCSL');
  const unrate = val('UNRATE'), sp500 = val('SP500'), spPrev = prev('SP500');
  const m2 = val('M2SL'), m2Prev = prev('M2SL'), walcl = val('WALCL');
  const hyg = val('BAMLH0A0HYM2'), usd = val('DTWEXBGS');
  const vix = indVal('VIXCLS'), fng = indVal('cnn_fng'), width = indVal('WIDTH50');
  const btcQqq = indVal('BTC_QQQ'), stableScore = indScore('STABLECOIN');

  // CPI 月增年化（FRED 最新两点；不足 12 点时用月环比年化）
  const cpiYoY = (cpi != null && cpiPrev) ? (Math.pow(cpi / cpiPrev, 12) - 1) * 100 : null;
  const growth = avg([
    width != null ? width : null,
    fng != null ? fng : null,
    (sp500 != null && spPrev) ? clamp(50 + (sp500 / spPrev - 1) * 1200) : null,
    unrate != null ? clamp(100 - (unrate - 3) * 12) : null
  ]);
  const inflation = cpiYoY != null ? clamp((cpiYoY - 2) / 5 * 100) : null;
  const liquidity = avg([
    (m2 != null && m2Prev) ? clamp(50 + (m2 / m2Prev - 1) * 2400) : null,
    stableScore,
    (usd != null) ? clamp(100 - (usd - 100) * 2) : null,
    walcl != null ? 60 : null
  ]);
  const realRate = (dgs10 != null && cpiYoY != null) ? dgs10 - cpiYoY : null;
  const ratePressure = realRate != null ? clamp((realRate + 1) / 4 * 100) : null;
  const riskAppetite = avg([fng, vix != null ? clamp(100 - (vix - 10) * 4) : null, width, btcQqq != null ? clamp(btcQqq * 100) : null]);
  const cryptoEnv = avg([stableScore, width, fng, btcQqq != null ? clamp(btcQqq * 100) : null]);

  // 体制：增长 × 通胀 四象限
  let regime = '数据积累中', regimeEn = 'collecting', conf = null;
  if (growth != null && inflation != null) {
    if (growth >= 50 && inflation >= 50) { regime = '再通胀'; regimeEn = 'reflation'; }
    else if (growth >= 50 && inflation < 50) { regime = '金发女孩'; regimeEn = 'goldilocks'; }
    else if (growth < 50 && inflation >= 50) { regime = '滞胀'; regimeEn = 'stagflation'; }
    else { regime = '衰退/通缩'; regimeEn = 'recession'; }
    conf = Math.round(clamp(50 + Math.abs(growth - 50) * 0.7 + Math.abs(inflation - 50) * 0.5, 50, 95));
  }

  const hyNorm = hyg != null ? clamp((hyg - 2) / 6 * 100) : null;
  const usdPressure = usd != null ? clamp((usd - 100) / 30 * 100) : null;
  const engines = [
    { key: 'inflation', name: '通胀压力', value: inflation != null ? Math.round(inflation) : null, note: cpiYoY != null ? 'CPI 年化 ' + cpiYoY.toFixed(2) + '%' : '—' },
    { key: 'rate', name: '利率压力', value: ratePressure != null ? Math.round(ratePressure) : null, note: realRate != null ? '实际利率 ' + realRate.toFixed(2) + '%' : '—' },
    { key: 'dollar', name: '美元压力', value: usdPressure != null ? Math.round(usdPressure) : null, note: usd != null ? '广义美元 ' + usd.toFixed(1) : '—' },
    { key: 'credit', name: '信用压力', value: hyNorm != null ? Math.round(hyNorm) : null, note: hyg != null ? 'HY 利差 ' + hyg.toFixed(2) + '%' : '—' },
    { key: 'liquidity', name: '流动性压力', value: liquidity != null ? Math.round(100 - liquidity) : null, note: m2 != null && m2Prev ? 'M2 环比 ' + ((m2 / m2Prev - 1) * 100).toFixed(2) + '%' : '—' },
    { key: 'growth', name: '增长压力', value: growth != null ? Math.round(100 - growth) : null, note: unrate != null ? '失业率 ' + unrate.toFixed(1) + '%' : '—' }
  ];

  // 历史复验：宏观缓存 composite 日度 → BTC 未来 7 日收益
  let backtest = null;
  try {
    const rows = db.prepare('SELECT ts,payload FROM macro_indicators_cache WHERE ts>=? ORDER BY ts').all(Math.floor(Date.now() / 1000) - 90 * 86400);
    const byDay = {};
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload);
        if (p.composite == null) continue;
        const d = new Date(r.ts * 1000).toISOString().slice(0, 10);
        byDay[d] = Number(p.composite);
      } catch (e) {}
    }
    const kl = db.prepare("SELECT ts,c FROM klines WHERE symbol='BTC' AND interval='5m' AND ts>=? ORDER BY ts").all((Date.now() - 120 * 86400 * 1000));
    const dayClose = {};
    for (const k of kl) { const d = new Date(Number(k.ts)).toISOString().slice(0, 10); dayClose[d] = Number(k.c); }
    const days = Object.keys(byDay).sort();
    const pairs = [];
    for (let i = 0; i < days.length; i++) {
      const d = days[i], c0 = dayClose[d];
      if (!c0) continue;
      const t7 = new Date(Date.parse(d + 'T00:00:00Z') + 7 * 86400 * 1000).toISOString().slice(0, 10);
      const c7 = dayClose[t7];
      if (c7) pairs.push({ score: byDay[d], ret: (c7 / c0 - 1) * 100 });
    }
    if (pairs.length >= 5) {
      const xs = pairs.map(p => p.score), ys = pairs.map(p => p.ret);
      const mx = avg(xs), my = avg(ys);
      let cov = 0, vx = 0, vy = 0;
      for (const p of pairs) { cov += (p.score - mx) * (p.ret - my); vx += (p.score - mx) ** 2; vy += (p.ret - my) ** 2; }
      const corr = vx && vy ? cov / Math.sqrt(vx * vy) : 0;
      const hi = pairs.filter(p => p.score >= 60), lo = pairs.filter(p => p.score <= 40);
      backtest = {
        days: pairs.length,
        corr: +corr.toFixed(3),
        high: { n: hi.length, avg_ret: hi.length ? +(hi.reduce((s, p) => s + p.ret, 0) / hi.length).toFixed(2) : null, hit: hi.length ? Math.round(hi.filter(p => p.ret > 0).length / hi.length * 100) : null },
        low: { n: lo.length, avg_ret: lo.length ? +(lo.reduce((s, p) => s + p.ret, 0) / lo.length).toFixed(2) : null, hit: lo.length ? Math.round(lo.filter(p => p.ret < 0).length / lo.length * 100) : null },
        note: 'composite 日度 vs BTC 未来 7 日收益；仅 30 天样本'
      };
    }
  } catch (e) { backtest = null; }

  return {
    ok: true,
    as_of: miRow ? miRow.ts : null,
    macro_ts: msRow ? msRow.ts : null,
    regime, regime_en: regimeEn, confidence: conf,
    growth: growth != null ? Math.round(growth) : null,
    inflation: inflation != null ? Math.round(inflation) : null,
    scores: {
      risk_appetite: riskAppetite != null ? Math.round(riskAppetite) : null,
      usd_liquidity: liquidity != null ? Math.round(liquidity) : null,
      real_rate_pressure: ratePressure != null ? Math.round(ratePressure) : null,
      crypto_env: cryptoEnv != null ? Math.round(cryptoEnv) : null
    },
    engines,
    inputs: { cpi_yoy: cpiYoY != null ? +cpiYoY.toFixed(2) : null, dgs10, dgs2, unrate, vix, fng, width, usd, hy: hyg, btc_qqq: btcQqq },
    backtest
  };
}

module.exports = { build };
