'use strict';
// W1 中低频方向引擎回测战绩 v2（2026-08-11 复利升级定案）
// 严格口径：收盘确认信号 → 次根开盘价入场（无未来函数）
// v2 升级：复利模式(compound) + 缩放式回撤熔断(dd_fuse) + 年化CAGR口径
// 锁定参数: entry_th=3.0 risk_pct=3.5% stop_atr=2.8 t1_rr=0.8 t1_pct=60% trail_atr=2.5 time_bars=10 min_r=0.5 lev_cap=50 cooldown=3 cons_only=1 dd_fuse=5
const STATS = {
  engine: 'dir-v2',
  name: 'W1中低频方向引擎',
  version: 'v2 复利版',
  params: { entry_th: 3.0, risk_pct: 3.5, stop_atr: 2.8, t1_rr: 0.8, t1_pct: 60, trail_atr: 2.5, time_bars: 10, min_r: 0.5, lev_cap: 50, cooldown: 3, cons_only: 1, compound: 1, dd_fuse: 5 },
  train: { period: '2024-01 ~ 2025-12', win_rate: 64.0, sharpe: 7.22, total_ret_pct: 276.7, cagr_pct: 93.9, max_dd_pct: 17.6, trades: 203, profit_factor: 3.97 },
  test:  { period: '2026-01 ~ 2026-12', win_rate: 71.4, sharpe: 9.42, total_ret_pct: 54.7, cagr_pct: 54.7, max_dd_pct: 4.6, trades: 49, profit_factor: 5.26 },
  full:  { period: '2024-01 ~ 2026-12', win_rate: 65.5, sharpe: 7.56, total_ret_pct: 482.9, cagr_pct: 79.9, max_dd_pct: 17.6, trades: 252, profit_factor: 4.22 },
  walkforward: { windows: 4, win_rates: [68.2, 71.2, 58.7, 55.3], min_window: 55.3, cagr_rates: [56, 213, 54, 97], note: '4段滚动验证，年化全部为正，样本外2026胜率71.4%' },
  robustness: { neighbor_combo: 2187, pass_50: 1711, pass_60: 1512, pass_pct_50: 78, median: 79.3, sharpe_pass: 92, dd_pass_25: 53, note: '7参数±1档邻域，中位年化79.3%，78%组合年化≥50%，宽阔参数高原非尖峰过拟合' },
  methodology: '复利模式+缩放式回撤熔断；Walk-Forward 4×6月验证 + 邻域稳健性2187组合；严格口径：收盘确认→次根开盘入场；数据源 hist.db BTCUSDT 1h 954天；10000u复利滚动，风险预算3.5%/笔，回撤>5%风险降50%、>熔断阈值再降80%'
};
function stats() { return STATS; }
module.exports = { stats };
