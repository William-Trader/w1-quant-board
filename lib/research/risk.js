'use strict';
const { cached, mean, std } = require('./util');

function compute(db) {
  return cached('research:risk', 60 * 1000, () => {
    const rows = db.prepare('SELECT ts,equity,pnl,open_count FROM equity_history ORDER BY ts').all();
    if (!rows.length) return { ok: false, error: 'no_equity' };
    const eq = rows.map(r => Number(r.equity));
    const current = eq[eq.length - 1], peak = Math.max.apply(null, eq);
    const dd = peak > 0 ? (current / peak - 1) * 100 : 0;
    const byDay = new Map();
    for (const r of rows) {
      const d = new Date(Number(r.ts) * 1000).toISOString().slice(0, 10);
      byDay.set(d, Number(r.equity));
    }
    const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const rets = [];
    for (let i = 1; i < days.length; i++) if (days[i - 1][1] > 0) rets.push((days[i][1] - days[i - 1][1]) / days[i - 1][1]);
    const sorted = rets.slice().sort((a, b) => a - b);
    const var95 = sorted.length ? sorted[Math.floor(0.05 * (sorted.length - 1))] : null;
    const tail = var95 == null ? [] : sorted.filter(x => x <= var95);
    const cvar = tail.length ? mean(tail) : null;
    const volAnn = std(rets) * Math.sqrt(365) * 100;
    const sharpe = std(rets) ? mean(rets) / std(rets) * Math.sqrt(365) : null;

    const sig = db.prepare('SELECT strategy,status,pnl_pct,symbol,direction,entry,stop,target1,notional_usd,pushed_at FROM signal_track').all();
    const by = {};
    for (const s of sig) {
      const k = s.strategy || 'unknown';
      if (!by[k]) by[k] = { strategy: k, n: 0, wins: 0, losses: 0, open: 0, pnl: [] };
      const b = by[k]; b.n++;
      if (s.status === 'WIN') { b.wins++; b.pnl.push(Number(s.pnl_pct) || 0); }
      else if (s.status === 'LOSS') { b.losses++; b.pnl.push(Number(s.pnl_pct) || 0); }
      else if (s.status === 'OPEN') b.open++;
    }
    const strategies = Object.values(by).map(b => {
      const wins = b.pnl.filter(x => x > 0), losses = b.pnl.filter(x => x <= 0);
      return {
        strategy: b.strategy, n: b.n, wins: b.wins, losses: b.losses, open: b.open,
        win_rate_pct: (b.wins + b.losses) ? +(100 * b.wins / (b.wins + b.losses)).toFixed(1) : null,
        avg_pnl_pct: b.pnl.length ? +mean(b.pnl).toFixed(2) : null,
        profit_factor: losses.length ? +(wins.reduce((s, x) => s + x, 0) / Math.abs(losses.reduce((s, x) => s + x, 0))).toFixed(2) : null
      };
    }).sort((a, b) => b.n - a.n);
    const open = db.prepare("SELECT symbol,direction,entry,stop,target1,notional_usd,pushed_at FROM signal_track WHERE status='OPEN' ORDER BY pushed_at DESC").all();
    return {
      ok: true, as_of: Math.floor(Date.now() / 1000),
      summary: {
        current_equity: +current.toFixed(2), peak_equity: +peak.toFixed(2), drawdown_pct: +dd.toFixed(2),
        var95_pct: var95 == null ? null : +(var95 * 100).toFixed(2),
        cvar95_pct: cvar == null ? null : +(cvar * 100).toFixed(2),
        annual_vol_pct: +volAnn.toFixed(1), sharpe: sharpe == null ? null : +sharpe.toFixed(2),
        days: days.length
      },
      strategies, open_positions: open,
      equity_curve: eq.slice(-500),
      notes: 'VaR/CVaR 基于日频净值收益；Sharpe 未扣无风险利率；样本为 2026-08 起的实盘虚拟净值。'
    };
  });
}
module.exports = { compute };
