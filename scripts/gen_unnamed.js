#!/usr/bin/env node
'use strict';
// 无名 · 数据文件生成（experience_2020_unnamed.json）
const fs = require('fs');
const bt = require('/home/ubuntu/w1-board/scripts/bt_unnamed.js');
const CFG = { entry_n: 48, exit_n: 18, atr_add: 0.5, max_add: 3, lev: 1.5, hard_stop: 15, adx_min: 18 };
const S0 = Date.UTC(2020, 0, 1), E_ALL = Date.UTC(2026, 7, 11, 23, 59);
const TS = Date.UTC(2026, 0, 1), TE = Date.UTC(2026, 7, 11, 23, 59);

const full = bt.run(Object.assign({}, CFG, { startTs: S0, endTs: E_ALL }));
const test = bt.run(Object.assign({}, CFG, { startTs: TS, endTs: TE }));

// 平均年化（每年重置 1 万）
const yearly = [];
for (let y = 2020; y <= 2026; y++) {
  const S = Date.UTC(y, 0, 1), En = y === 2026 ? Date.UTC(2026, 7, 11, 23, 59) : Date.UTC(y + 1, 0, 1) - 1;
  const r = bt.run(Object.assign({}, CFG, { startTs: S, endTs: En }));
  yearly.push({ year: y, trades: r.trades, win_rate: r.win_rate, total_ret_pct: +(((r.equity - 10000) / 10000) * 100).toFixed(1), max_dd_pct: r.max_dd_pct });
}
const avgYearly = +(yearly.reduce((a, b) => a + b.total_ret_pct, 0) / yearly.length).toFixed(1);

const out = {
  generated: '2026-08-12',
  caliber: 'unnamed_v2_donchian',
  engine: 'unnamed-donchian-v2',
  name: 'β2 观澜',
  total: { trades: full.trades, win_rate: full.win_rate, period: '2020-01 ~ 2026-08' },
  combined: { trades: full.trades, win_rate: full.win_rate, profit_factor: full.profit_factor, max_dd_pct: full.max_dd_pct, sharpe: full.sharpe, avg_hold_days: full.avg_hold_days, total_ret_pct: full.total_ret_pct, cagr_pct: full.cagr_pct, by_reason: full.by_reason, by_dir: full.by_dir },
  full: { trades: full.trades, win_rate: full.win_rate, profit_factor: full.profit_factor, max_dd_pct: full.max_dd_pct, sharpe: full.sharpe, total_ret_pct: full.total_ret_pct, cagr_pct: full.cagr_pct, avg_hold_days: full.avg_hold_days, equity: full.equity },
  windows: (() => {
    // 14 个半年窗口（2020H1 ~ 2026H2）
    const wins = [];
    let wIdx = 1;
    for (let y = 2020; y <= 2026; y++) {
      for (const h of [0, 6]) {
        const S = Date.UTC(y, h, 1);
        const E = h === 0 ? Date.UTC(y, 6, 1) - 1 : (y === 2026 ? Date.UTC(2026, 7, 11, 23, 59) : Date.UTC(y + 1, 0, 1) - 1);
        const r = bt.run(Object.assign({}, CFG, { startTs: S, endTs: E }));
        const wd = ((r.equity - 10000) / 10000) * 100;
        wins.push({ name: 'T' + wIdx++, period: (S === Date.UTC(2020, 0, 1) ? '2020-01' : new Date(S).toISOString().slice(0, 7)) + ' ~ ' + new Date(E).toISOString().slice(0, 7), withdrawn_total: 0, withdrawn_count: 0, trades: r.trades, settled: r.trades, wins: 0, losses: 0, win_rate: r.win_rate, profit_factor: r.profit_factor, sharpe: r.sharpe, total_ret_pct: +wd.toFixed(1), max_dd_pct: r.max_dd_pct, equity: r.equity, events: [] });
      }
    }
    return wins;
  })(),
  dir_v1: {
    engine: 'unnamed-donchian-v2', name: 'β2 观澜', version: 'v1',
    params: CFG,
    train: { trades: full.trades - test.trades, win_rate: null },
    test: { trades: test.trades, win_rate: test.win_rate, profit_factor: test.profit_factor, max_dd_pct: test.max_dd_pct, total_ret_pct: test.total_ret_pct, cagr_pct: test.cagr_pct },
    full: { trades: full.trades, win_rate: full.win_rate, profit_factor: full.profit_factor, max_dd_pct: full.max_dd_pct, total_ret_pct: full.total_ret_pct, cagr_pct: full.cagr_pct, sharpe: full.sharpe, avg_hold_days: full.avg_hold_days },
    avg_yearly_return_pct: avgYearly,
    yearly,
    methodology: '低频类现货大趋势：唐奇安通道 48 日突破入场（大牛做多/大熊做空）+ ADX≥18 过滤假突破，每涨 0.5×ATR 加仓（最多3份），20 日通道离场让利润奔跑，1.5x 杠杆，单笔硬止损 15%，含双边成本 8bps'
  }
};
fs.writeFileSync('/home/ubuntu/w1-board/public/experience_2020_unnamed.json', JSON.stringify(out, null, 1));
console.log('experience_2020_unnamed.json written');
console.log('full:', JSON.stringify({ trades: full.trades, win: full.win_rate, pf: full.profit_factor, dd: full.max_dd_pct, ret: full.total_ret_pct }));
console.log('avg_yearly:', avgYearly + '%');
console.log('yearly:', yearly.map(y => y.year + ':' + y.total_ret_pct + '%').join(' '));
