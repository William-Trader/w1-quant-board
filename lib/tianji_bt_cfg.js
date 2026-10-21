'use strict';
// ═══════════════════════════════════════════════════════════
// TIANJI 回测参数定义（共享：回测引擎 scripts/tianji_backtest.js 与
// API routes.js 统一从此处取默认值，保证前端表单与引擎口径一致）
// 默认值 = 实盘当前 CFG（lib/tianji.js） + 实盘执行口径（okx_executor）
// ═══════════════════════════════════════════════════════════
const DEFAULTS = {
  // ── 数据完整边界（news 8/02 起 · consensus 8/11 起 → 全五维最早 8/11） ──
  min_window_start: '2026-08-11', // 回测窗口下限（早于该日期会降维，强制锁此边界）

  // ── 信号维度权重（五维）2026-08-31 对齐实盘 lib/tianji.js ──
  macro_weight: 0.2,   // 消息面（方向一致性风险开关）
  tech_weight: 1.2,    // 技术面
  fund_weight: 0.8,    // 资金面
  con_weight: 0.3,     // KOL共识
  qibao_weight: 1.6,   // 清算技术因子（历史胜率最高维度）

  // ── 信号阈值 / 频率 ──
  min_score: 4.0,      // 综合分阈值（-9~+9）
  short_min_score: 4.0, // 空头门槛（2026-08-31 v2 与多头对称；历史放宽=亏损主因）
  short_qib_min: -1.0, // 空头 qibao 强约束（回测 G 最优：66%胜率 多空双赚）
  min_dims: 3,         // 至少 N 维同向（2026-08-31 对齐实盘：2维烂单全砍）
  max_dims: 4,         // 高维上限（2026-08-31 升级：未来函数修复后重新验证，4维OOS转正 +73U，PF1.41）
  cooldown_h: 6,       // 每币每方向冷却（小时）
  daily_limit: 5,      // 每日推单上限（对齐实盘）
  min_rr: 2.0,         // 最低盈亏比

  // ── 止盈止损计划 ──
  atr_mult: 2.5,       // 止损 = ATR × N
  stop_floor_pct: 0.8, // 止损距离保底 %
  stop_cap_pct: 5.0,   // 止损距离封顶 %
  t1_mult: 1.2,        // T1 距离 = 止损距离 × N（60% 落袋）
  t2_mult: 2.4,        // T2 距离 = 止损距离 × N（40% 博波段）
  max_hold_h: 48,      // 持仓超时（小时）

  // ── 仓位 / 资金 ──
  pos_pct_low: 3,      // 仓位档 1（score < mid）%
  pos_pct_mid: 5,      // 仓位档 2（score ≥ mid）%
  pos_pct_high: 8,     // 仓位档 3（score ≥ high）%
  score_mid: 5.5,      // 档 2 阈值
  score_high: 7.0,     // 档 3 阈值
  pos_scale: 1.0,      // 仓位倍数（前端主输入：整体缩放仓位档）
  leverage: 50,        // 杠杆档位（2026-08-22 用户决策：恢复 50x 档位；全仓下强平看整体杠杆，档位仅下单上限）
  max_total_lev: 15,   // 全账户名义/权益上限（任意叠加下强平距离 6.2% > 止损 5%）
  max_per_symbol_per_day: 1,  // 每币每日最多 1 单（分散化：防单一币种反复入场，2026-08-22 回测 LINK 43% 问题）
  dd_lev: true,          // 回撤熔断（2026-08-22 方案B）：账户回撤越大整体杠杆越低
  dd_scales: [[3, 1.0], [7, 0.7], [12, 0.5], [100, 0.2]],  // 回撤% → 杠杆缩放（≥12% 接近暂停）
  max_same_symbol_positions: 1, // 单币并发持仓 ≤1（同一币种不重复开仓）
  risk_pct: 3.0,       // 单笔风险%（风险定仓：notional = 净值×risk%×pos_mult÷止损距离；与实盘 calcSize 同口径）
  pos_mult: 1.5,       // 风险定仓倍数（与 okx:pos_mult 同步）
  capital: 1000,       // 起始净值（实盘 1000u 复利基准）
  compound: true,      // 复利（名义 = 净值×pos%×杠杆）
  fgi_discount: true,  // FGI 仓位折扣（≤20 三折/≤30 五折/≥85 四折/≥70 七折）

  // ── 回测范围（前端主输入） ──
  symbols: null,       // 币种列表（null=全部 9 币；前端多选）

  // ── 成本 ──
  cost_bps: 8,         // 双边总成本 bps（铁律）

  // ── 门控开关（实盘全部开启） ──
  weekend_gate: false, // 周末风控（实盘已永久关闭 2026-08-22 老板指令）
  trend_gate: true,    // 趋势门控（SMA 排列只拦明确反向）
  breakout_gate: true, // 突破门控（近8根高低点 ±0.2%）
  momentum_gate: true, // 动量确认（做多需 15m/1h 不为双负）
  fgi_gate: true,      // FGI 门控（≥85 不做多 / ≤15 不做空）
  xau_short_ban: true, // 黄金只做多
  pullback_short: false, // 反抽空分支（2026-08-26 实验性：大周期超买回落未破位时，结构止损试空）
  news_gate: true,     // 突发新闻密集 / 明确利空利多压制
  burst_news_limit: 3, // 突发新闻条数阈值

  // ── 数据 / 引擎 ──
  llm: false,          // LLM AI 审查（veto 否决）
  news: true,          // 真实消息面维度（news_hist）
  tick: '4h',          // K线粒度：4h（标准）| 5m（复现实盘：tech/门控按 5m，对齐实盘 30×5min 快照）
  logic: 'current',    // 打分逻辑版本：current（现版：否定词/去噪/log2/连续qibao居中）| v0814（8/14-19实盘版：直接加权/无去噪/档位qibao/无量能确认）
};

// ═════ 参数预设（前端按钮 + 引擎 --preset 复用） ═════
const PRESETS = {
  live: { name: '实盘默认', note: '= 当前实盘 CFG（8/20 后）', params: {} },
  conservative: { name: '保守', note: '低杠杆·低仓位·低频率', params: { daily_limit: 2, pos_pct_low: 1.5, pos_pct_mid: 2.5, pos_pct_high: 4, leverage: 20, max_total_lev: 15 } },
  aggressive: { name: '激进', note: '高杠杆·高仓位·高频率', params: { daily_limit: 5, pos_pct_low: 5, pos_pct_mid: 8, pos_pct_high: 12, leverage: 100, max_total_lev: 60, atr_mult: 3, t2_mult: 3.0, fgi_discount: false } },
  // 考古自 signal_track + tianji.js 备份（closepush 8/17 版 + 逐单反推）：8/14-19 实盘真实参数
  replay_0814: {
    name: '复现 8/14-19 实盘', note: '考古参数：min_dims=3 · min_rr=1.5 · atr×2.0 · T1=1.5×/T2=2.5× · 权重 .8/1.0/1.0/.6/1.2 · 无XAU禁空',
    params: { min_dims: 3, min_rr: 1.5, atr_mult: 2.0, t1_mult: 1.5, t2_mult: 2.5,
      macro_weight: 0.8, tech_weight: 1.0, fund_weight: 1.0, con_weight: 0.6, qibao_weight: 1.2,
      xau_short_ban: false, llm: false, tick: '5m', logic: 'v0814', news_gate: false,
      trend_gate: false, breakout_gate: false },
  },
};

module.exports = { DEFAULTS, PRESETS };
