'use strict';
// β1 御风 · 中低频趋势引擎回测战绩 v4（2026-08-12 15m 精确执行定案）
// 4h 分析（信号/评分/regime/ATR）+ 15m 执行（入场次根4h开盘、出场15m精确触发）
// 锁定参数: entry_th=3.0 risk_pct=4.25% stop_atr=2.8 t1_rr=0.8 t1_pct=60% trail_atr=2.5 time_bars=10 min_r=0.5 lev_cap=50 cooldown=3 cons_only=1 dd_fuse=6 use15m=1
const STATS = {
  engine: 'dir-v4',
  name: 'β1 御风 · 中低频趋势引擎',
  version: 'v4 15m精确执行 · 2020全段',
  params: { entry_th: 3.0, risk_pct: 4.25, stop_atr: 2.8, t1_rr: 0.8, t1_pct: 60, trail_atr: 2.5, time_bars: 10, min_r: 0.5, lev_cap: 50, cooldown: 3, cons_only: 1, compound: 1, dd_fuse: 6, use15m: 1 },
  train: { period: '2020-01-01 ~ 2025-12-31', win_rate: 68.1, sharpe: 3.9, total_ret_pct: 841343.8, cagr_pct: 350.4, max_dd_pct: 5.7, trades: 863, profit_factor: 4.63 },
  test:  { period: '2026-01-01 ~ 2026-08-11', win_rate: 68.1, sharpe: 8.72, total_ret_pct: 61.6, cagr_pct: 119.5, max_dd_pct: 4.5, trades: 47, profit_factor: 4.52 },
  full:  { period: '2020-01-01 ~ 2026-08-11', win_rate: 68.1, sharpe: 4.06, total_ret_pct: 1360047.8, cagr_pct: 321.4, max_dd_pct: 4.5, trades: 910, profit_factor: 4.63 },
  walkforward: { windows: 14, win_rates: [77.6,70.4,75.3,66.1,62.1,74.1,57.3,73.7,66.1,74.2,56.5,55.6,72.5,42.9], min_window: 42.9, cagr_rates: [655,1091,1731,1086,95,122,377,592,123,281,77,93,132,65], note: '14段半年滚动验证（2020-2026），年化全部为正，样本外2026胜率68.1%' },
  robustness: { neighbor_combo: 2187, pass_50: 1711, pass_60: 1512, pass_pct_50: 78, median: 79.3, sharpe_pass: 92, dd_pass_25: 53, note: '7参数±1档邻域，中位年化79.3%，78%组合年化≥50%，宽阔参数高原非尖峰过拟合' },
  methodology: '4h分析+15m精确执行（v4：信号4h收盘确认→次根4h开盘入场；出场/止盈/止损/吊灯在15m粒度精确触发）；复利模式+缩放式回撤熔断（风险4.25%/笔，回撤>3.6%×0.5、>6%×0.2）；Walk-Forward 14×6月验证（覆盖至2026-08）+ 邻域稳健性2187组合；数据源 hist.db BTCUSDT 1h+15m K线 2020-01-01~2026-08-11；10000u复利滚动'
};
function stats() { return STATS; }
module.exports = { stats };
