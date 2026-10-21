'use strict';
// 市场风险舱：不依赖任何策略/实盘历史，只用 BTC 价格数据计算波动与回撤。
const { openRO, cached, mean, std } = require('./util');
const HIST = '/home/ubuntu/btc-oracle/backtest/hist.db';

function loadDaily() {
  const db = openRO(HIST);
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT ts,c FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
    const byDay = new Map();
    for (const r of rows) {
      const d = new Date(Number(r.ts)).toISOString().slice(0, 10);
      byDay.set(d, Number(r.c));
    }
    return Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(x => ({ date: x[0], close: x[1] }));
  } catch (e) { return []; }
  finally { try { db.close(); } catch (e) {} }
}

function compute() {
  return cached('research:market-risk', 5 * 60 * 1000, () => {
    const days = loadDaily();
    if (days.length < 30) return { ok: false, error: 'no_price_data' };
    const closes = days.map(d => d.close);
    const current = closes[closes.length - 1], peak = Math.max.apply(null, closes);
    const dd = peak > 0 ? (current / peak - 1) * 100 : 0;
    const rets = [];
    for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    const sorted = rets.slice().sort((a, b) => a - b);
    const var95 = sorted.length ? sorted[Math.floor(0.05 * (sorted.length - 1))] : null;
    const tail = var95 == null ? [] : sorted.filter(x => x <= var95);
    const cvar = tail.length ? mean(tail) : null;
    const volAnn = std(rets) * Math.sqrt(365) * 100;
    const sharpe = std(rets) ? mean(rets) / std(rets) * Math.sqrt(365) : null;
    const lookback = (n) => closes.length > n ? (current / closes[closes.length - 1 - n] - 1) * 100 : null;
    return {
      ok: true, as_of: Math.floor(Date.now() / 1000),
      summary: {
        symbol: 'BTC',
        current_equity: +current.toFixed(2),
        peak_equity: +peak.toFixed(2),
        drawdown_pct: +dd.toFixed(2),
        var95_pct: var95 == null ? null : +(var95 * 100).toFixed(2),
        cvar95_pct: cvar == null ? null : +(cvar * 100).toFixed(2),
        annual_vol_pct: +volAnn.toFixed(1),
        sharpe: sharpe == null ? null : +sharpe.toFixed(2),
        days: days.length,
        ret_7d_pct: lookback(7) == null ? null : +lookback(7).toFixed(2),
        ret_30d_pct: lookback(30) == null ? null : +lookback(30).toFixed(2),
        ret_90d_pct: lookback(90) == null ? null : +lookback(90).toFixed(2)
      },
      strategies: [],
      open_positions: [],
      equity_curve: closes.slice(-500),
      notes: '市场风险舱只使用 BTC 日线计算波动、回撤、VaR/CVaR；不含任何策略/实盘记录。'
    };
  });
}
module.exports = { compute };
