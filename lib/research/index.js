'use strict';
function overview(db) {
  const r = require('./regime_lab').compute();
  const p = require('./positioning').compute(db);
  const c = require('./cross_asset').compute(db);
  const n = require('./news_impact').compute(db);
  const k = require('./risk').compute(db);
  return {
    ok: true, as_of: Math.floor(Date.now() / 1000),
    regime: r.ok ? { current: r.current, top: r.regimes.slice(0, 3) } : { error: r.error },
    positioning: p.ok ? { market: p.market, top: p.rows.slice(0, 6) } : { error: p.error },
    cross_asset: c.ok ? { risk_on_score: c.risk_on_score, breadth_5d_pct: c.breadth_5d_pct, top: c.top_5d.slice(0, 5) } : { error: c.error },
    news: n.ok ? { coverage: n.coverage, top: (n.top || []).slice(0, 3) } : { error: n.error },
    risk: k.ok ? { summary: k.summary, strategies: k.strategies.slice(0, 5) } : { error: k.error }
  };
}
module.exports = { overview };
