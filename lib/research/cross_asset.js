'use strict';
const { cached, mean, std, clamp } = require('./util');

function corr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  const cov = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const sx = Math.sqrt(x.reduce((s, v) => s + (v - mx) * (v - mx), 0));
  const sy = Math.sqrt(y.reduce((s, v) => s + (v - my) * (v - my), 0));
  return sx && sy ? +(cov / (sx * sy)).toFixed(2) : null;
}

function compute(db) {
  return cached('research:cross-asset', 5 * 60 * 1000, () => {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 30 * 86400;
    const rows = db.prepare('SELECT symbol,ts,price,asset_class,grp,name_zh FROM asset_prices WHERE ts>=? ORDER BY symbol,ts').all(from);
    if (!rows.length) return { ok: false, error: 'no_data' };
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.symbol)) by.set(r.symbol, { symbol: r.symbol, meta: r, days: new Map() });
      const m = by.get(r.symbol);
      const d = new Date(Number(r.ts) * 1000).toISOString().slice(0, 10);
      m.days.set(d, Number(r.price));
    }
    const series = [];
    for (const m of by.values()) {
      const days = Array.from(m.days.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      if (days.length < 6) continue;
      const closes = days.map(x => x[1]);
      const ret = (n) => closes.length > n && closes[closes.length - 1 - n] > 0 ? (closes[closes.length - 1] - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n] * 100 : null;
      const rets = closes.slice(1).map((c, i) => closes[i] > 0 ? (c - closes[i]) / closes[i] * 100 : 0);
      series.push({
        symbol: m.symbol, name: m.meta.name_zh || m.symbol, cls: m.meta.asset_class || m.meta.grp || 'other', exchange: m.meta.exchange,
        last: closes[closes.length - 1], ret_1d: ret(1), ret_5d: ret(5), ret_20d: ret(20), rets
      });
    }
    const btc = series.find(x => x.symbol === 'BTC-USDT-SWAP') || series.find(x => /^BTC/.test(x.symbol));
    for (const s of series) s.corr_btc_20d = btc && s.symbol !== btc.symbol ? corr(s.rets.slice(-20), btc.rets.slice(-20)) : null;
    const riskAssets = series.filter(s => /equity|stock|crypto|index/i.test(s.cls) || /BTC|ETH|SOL/.test(s.symbol));
    const defensives = series.filter(s => /XAU|XAG|UVXY|gold|silver|volatility/i.test(s.symbol + ' ' + s.cls));
    const breadth = riskAssets.length ? riskAssets.filter(s => (s.ret_5d || 0) > 0).length / riskAssets.length : 0.5;
    const defAvg = defensives.length ? mean(defensives.map(s => s.ret_5d || 0)) : 0;
    const riskOn = clamp(Math.round(50 + (breadth - 0.5) * 100 - defAvg * 1.5), 0, 100);
    return {
      ok: true, as_of: now,
      coverage: { days: 30, symbols: series.length, from: new Date(from * 1000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      risk_on_score: riskOn,
      breadth_5d_pct: +(100 * breadth).toFixed(0),
      defensives_5d_avg: +defAvg.toFixed(2),
      top_5d: series.slice().sort((a, b) => (b.ret_5d || -999) - (a.ret_5d || -999)).slice(0, 8),
      bottom_5d: series.slice().sort((a, b) => (a.ret_5d || 999) - (b.ret_5d || 999)).slice(0, 8),
      rows: series.sort((a, b) => Math.abs(b.ret_5d || 0) - Math.abs(a.ret_5d || 0)),
      notes: '跨资产价格来自 OKX 代币化合约/指数（67 标的，约 2 个月 5m）；风险偏好分 = 风险资产 5 日广度 - 防御资产强度；corr 为 20 日收益相关。'
    };
  });
}

module.exports = { compute, corr };
