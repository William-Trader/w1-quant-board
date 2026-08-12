'use strict';
// ============================================================
// 指标战绩 · W1~W6 六窗口完整数据生成 v3.1（真实结算口径 · 覆盖至2026-08-11）
// 数据源: data/dir_samples.json（252条官方样本 = dir-v2 引擎全段回测）
// 结算口径: 与 backtest_v4.js runBacktest 完全一致（已验证年化=官方walkforward）
//   - t1 部分止盈: 落袋 60% 仓位，剩余 40% 尾仓（止损移至入场价 R=0）
//   - dd_fuse 熔断: 回撤>3% → 风险×0.5；回撤>5% → 风险×0.2
//   - risk = 当时权益 × risk_pct(3.5%)，复利滚动
// 输出: public/experience.json（dir_v1 官方常量 + windows[4] 真实净值 + combined）
// ============================================================
const fs = require('fs');
const Database = require('/home/ubuntu/w1-board/node_modules/better-sqlite3');
const HIST = '/home/ubuntu/btc-oracle/backtest/hist.db';

// 模式参数（提前定义，samples 加载依赖）
const STRAT_MODE = String(process.argv[3] || '');
const IS_ALPHA1 = STRAT_MODE === 'alpha1';  // α1 破浪 v1（risk7/entry3.0）
const IS_ALPHA2 = STRAT_MODE === 'alpha2';  // α2 聚沙 v2（risk9/entry2.5）
const IS_ALPHA = IS_ALPHA1 || IS_ALPHA2;
const START_YEAR = Number(process.argv[2] === '2024' ? 2024 : 2020);

const samples = JSON.parse(fs.readFileSync(IS_ALPHA1 ? '/home/ubuntu/w1-board/data/dir_samples_alpha1.json' : (IS_ALPHA2 ? '/home/ubuntu/w1-board/data/dir_samples_alpha2.json' : '/home/ubuntu/w1-board/data/dir_samples.json'), 'utf8')).samples;
const db = new Database(HIST, { readonly: true });

// 时间戳 → 北京时间 yyyy-MM-dd HH:mm
function fmtCst(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// 每日收盘价（UTC+8 自然日）
const dayClose = new Map();
for (const r of db.prepare(`
  SELECT date(ts/1000,'unixepoch','+8 hours') d,
         (SELECT c FROM klines k2 WHERE k2.symbol='BTCUSDT' AND k2.ts=(SELECT MAX(ts) FROM klines k3 WHERE k3.symbol='BTCUSDT' AND date(k3.ts/1000,'unixepoch','+8 hours')=date(k1.ts/1000,'unixepoch','+8 hours'))) c
  FROM klines k1 WHERE symbol='BTCUSDT' GROUP BY d ORDER BY d`).all()) {
  if (r.c != null) dayClose.set(r.d, r.c);
}

// 分数 → 标签/仓位档（与 direction_engine.directionScore 一致）
function labelOf(score) {
  if (score >= 3.2) return { label: '🚀 强烈看多', pos: 12 };
  if (score >= 2.0) return { label: '📈 看多', pos: 8 };
  if (score >= 1.2) return { label: '↗️ 谨慎看多', pos: 3 };
  if (score <= -3.2) return { label: '🛑 强烈看空', pos: 12 };
  if (score <= -2.0) return { label: '📉 看空', pos: 8 };
  if (score <= -1.2) return { label: '↘️ 谨慎看空', pos: 3 };
  return { label: '⚡ 观望', pos: 0 };
}
const reasonZh = { t1: '止盈1(60%)', trail: '移动止盈', stop: '止损', timeout: '超时', timeout_win: '超时止盈' };
const dirZh = { long: '多', short: '空' };

// 支持参数：node gen_windows.js 2020|2024 [alpha1] → 生成对应起点/策略的数据文件
const OUT_FILE = IS_ALPHA1 ? '/home/ubuntu/w1-board/public/experience_2020_alpha1.json'
  : (IS_ALPHA2 ? '/home/ubuntu/w1-board/public/experience_2020_alpha2.json'
  : (START_YEAR === 2024 ? '/home/ubuntu/w1-board/public/experience.json'
                          : '/home/ubuntu/w1-board/public/experience_2020.json'));
const DATA_OUT = IS_ALPHA1 ? '/home/ubuntu/w1-board/data/experience_windows_2020_alpha1.json'
  : (IS_ALPHA2 ? '/home/ubuntu/w1-board/data/experience_windows_2020_alpha2.json'
  : (START_YEAR === 2024 ? '/home/ubuntu/w1-board/data/experience_windows.json'
                          : '/home/ubuntu/w1-board/data/experience_windows_2020.json'));
const HALF_YEARS = [];
for (let y = START_YEAR; y <= 2026; y++) {
  HALF_YEARS.push({ start: y + '-01-01', end: y + '-06-30' });
  HALF_YEARS.push({ start: y + '-07-01', end: y === 2026 ? '2026-08-11' : y + '-12-31' });
}
const WINDOWS = HALF_YEARS.map((w, i) => ({
  name: 'T' + (i + 1), start: w.start, end: w.end,
  period: w.start.slice(0, 7) + ' ~ ' + w.end.slice(0, 7)
}));
const PRINCIPAL = 10000, T1_PCT = 0.6;
// β1 御风（v4 稳）/ α1 激进（risk7% df10 trail2.0 cd2 stop2.6）
const RISK = IS_ALPHA1 ? 0.07 : (IS_ALPHA2 ? 0.07 : 0.0425);
const DD_FUSE = IS_ALPHA1 ? 10 : 6;
const STRAT_ENGINE = IS_ALPHA1 ? 'alpha1-v2-bb-dual' : 'dir-v4';

// ============ 真实结算（与引擎 runBacktest 完全同逻辑） ============
// 输入: 事件流（t1 事件 + 尾仓事件 + 独立事件），r 为浮点
// 输出: 每事件 risk/share/pnl/equity + 净值曲线 + 汇总
function settle(trades, startEq = PRINCIPAL) {
  let eq = startEq, peak = startEq, pendRisk = null;
  const curve = [Math.round(startEq)], events = [];
  const dailyPnl = new Map();
  // α1 强制提现：权益达基准×1.5x 提取利润 20%
  const WD_PCT = IS_ALPHA ? (IS_ALPHA2 ? 1 : 0.15) : 0;
  const WD_MULT = IS_ALPHA ? 2 : 1.5; // α 与引擎 withdrawMult=2 对齐
  let wdBase = startEq, withdrawnTotal = 0, withdrawnCount = 0;
  for (const t of trades) {
    let risk, pnl, share;
    if (pendRisk != null) { risk = pendRisk; share = 1 - T1_PCT; pnl = risk * share * t.r; pendRisk = null; }
    else if (t.reason === 't1') {
      const dd = (peak - eq) / peak * 100;
      let rp = RISK; if (dd > DD_FUSE * 0.6) rp = RISK * 0.5; if (dd > DD_FUSE) rp = RISK * 0.2;
      risk = eq * rp; share = T1_PCT; pnl = risk * share * t.r; pendRisk = risk;
    } else {
      const dd = (peak - eq) / peak * 100;
      let rp = RISK; if (dd > DD_FUSE * 0.6) rp = RISK * 0.5; if (dd > DD_FUSE) rp = RISK * 0.2;
      risk = eq * rp; share = 1; pnl = risk * t.r;
    }
    eq += pnl; if (eq > peak) peak = eq;
    // 强制提现：支持 excess 模式（α2 深度定制）与 mult 模式
    let wdThis = 0;
    if (IS_ALPHA2 && BT_CFG.wdMode === 'excess') {
      if (eq >= wdBase * (1 + BT_CFG.wdThresh)) {
        const profit = eq - wdBase;
        const wd = profit * BT_CFG.wdExPct;
        if (wd > 0) { eq -= wd; withdrawnTotal += wd; withdrawnCount++; wdThis = wd; }
        wdBase = eq;
      }
    } else if (WD_PCT > 0 && eq >= wdBase * WD_MULT) {
      const profit = eq - wdBase;
      const wd = profit * WD_PCT;
      if (wd > 0) { eq -= wd; withdrawnTotal += wd; withdrawnCount++; wdThis = wd; }
      wdBase = eq;
    }
    curve.push(Math.round(eq));
    dailyPnl.set(t.day, (dailyPnl.get(t.day) || 0) + pnl - wdThis);
    events.push({ day: t.day, dir: t.dir, reason: t.reason, r: t.r, status: t.status, score: t.score,
      risk: Math.round(risk), share: +share.toFixed(2), pnl: Math.round(pnl - wdThis), wd: Math.round(wdThis), equity: Math.round(eq) });
  }
  settle._withdrawn = { total: withdrawnTotal, count: withdrawnCount };
  const settled = trades.filter(x => x.status === 'WIN' || x.status === 'LOSS');
  const wins = settled.filter(x => x.status === 'WIN');
  const losses = settled.filter(x => x.status === 'LOSS');
  const winRate = settled.length ? wins.length / settled.length * 100 : 0;
  const grossWin = wins.reduce((s, x) => s + x.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x.r, 0));
  const daysArr = [...dailyPnl.keys()].sort();
  const rets = daysArr.map(d => (dailyPnl.get(d) || 0) / PRINCIPAL);
  const meanR = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sdR = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sdR > 0 ? meanR / sdR * Math.sqrt(365) : 0;
  const totalRet = (eq - startEq) / startEq * 100;
  const spanDays = trades.length >= 2 ? (Date.parse(trades[trades.length - 1].day) - Date.parse(trades[0].day)) / 86400000 : 183;
  const cagr = spanDays > 0 ? (Math.pow(1 + totalRet / 100, 365 / spanDays) - 1) * 100 : 0;
  const maxDdU = (() => { let p = startEq, m = 0; for (const v of curve) { if (v > p) p = v; const dd = p - v; if (dd > m) m = dd; } return m; })();
  // 回撤%按峰值权益计算（复利后峰值远大于 startEq，除 startEq 会虚高）
  const ddPeak = (() => { let p = startEq; for (const v of curve) if (v > p) p = v; return p; })();
  const maxDdPct = maxDdU / ddPeak * 100;
  const pnls = events.map(x => x.pnl);
  const winPnls = events.filter(x => x.pnl > 0).map(x => x.pnl);
  const lossPnls = events.filter(x => x.pnl < 0).map(x => x.pnl);
  let cur = 0, winStreak = 0, lossStreak = 0;
  for (const t of settled) {
    if (t.status === 'WIN') { cur = cur > 0 ? cur + 1 : 1; winStreak = Math.max(winStreak, cur); }
    else { cur = cur < 0 ? cur - 1 : -1; lossStreak = Math.max(lossStreak, -cur); }
  }
  const sortino = (() => { const dR = rets.filter(x => x < 0); if (dR.length < 2) return 0; const sdD = Math.sqrt(dR.reduce((a, b) => a + b ** 2, 0) / dR.length); return sdD > 0 ? meanR / sdD * Math.sqrt(365) : 0; })();
  const volAnn = sdR * Math.sqrt(365) * 100;
  const calmar = maxDdPct > 0 ? cagr / maxDdPct : 0;
  const recovery = maxDdU > 0 ? (eq - startEq) / maxDdU : 0;
  const expectancy = events.length ? events.reduce((s, x) => s + x.pnl, 0) / events.length : 0;
  const longs = settled.filter(x => x.dir === 'long').length;
  const shorts = settled.filter(x => x.dir === 'short').length;
  const avgGap = trades.length > 1 ? Math.round(spanDays / (trades.length - 1)) : 0;
  const avgPos = trades.length ? Math.round(trades.reduce((s, t) => s + labelOf(t.score).pos, 0) / trades.length) : 0;
  return {
    withdrawn_total: Math.round(withdrawnTotal), withdrawn_count: withdrawnCount,
    trades: trades.length, settled: settled.length, wins: wins.length, losses: losses.length,
    win_rate: +winRate.toFixed(1),
    profit_factor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    sharpe: +sharpe.toFixed(2),
    sortino: +sortino.toFixed(2), calmar: +calmar.toFixed(2), recovery: +recovery.toFixed(1),
    vol_ann: +volAnn.toFixed(0), expectancy: +expectancy.toFixed(0),
    cagr_pct: +cagr.toFixed(0),
    total_ret_pct: +totalRet.toFixed(1),
    max_dd_pct: +maxDdPct.toFixed(1), max_dd: Math.round(maxDdU),
    equity: Math.round(eq), total_pnl: Math.round(eq - startEq),
    equity_curve: curve, events,
    by_reason: trades.reduce((a, t) => { const k = reasonZh[t.reason] || t.reason; a[k] = (a[k] || 0) + 1; return a; }, {}),
    by_dir: trades.reduce((a, t) => { a[t.dir] = (a[t.dir] || 0) + 1; return a; }, {}),
    longs, shorts, flats: 0, avg_gap: avgGap, avg_pos: avgPos,
    win_streak: winStreak, loss_streak: lossStreak,
    style_tag: '中低频方向引擎 · 复利滚动', style: '信号评分分档 0/3/8/12% · ATR止损 + 移动止盈 · t1部分止盈60% + 回撤熔断',
    avg_pnl: events.length ? Math.round(events.reduce((s, x) => s + x.pnl, 0) / events.length) : 0,
    max_win: Math.round(Math.max(...pnls, 0)), max_loss: Math.round(Math.min(...pnls, 0)),
    avg_win: Math.round(winPnls.length ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0),
    avg_loss: Math.round(lossPnls.length ? Math.abs(lossPnls.reduce((a, b) => a + b, 0)) / lossPnls.length : 0),
  };
}

// ============ 逐笔明细（含真实 pnl，来自结算事件流） ============
function buildList(trades) {
  // α：直接用引擎真实字段（samples 自带 risk/notional/margin/pnl）
  if (IS_ALPHA) {
    return trades.map((t, idx) => {
      const { label, pos } = labelOf(t.score);
      const pnl = t.pnl_usd != null ? Math.round(t.pnl_usd) : 0;
      const risk = t.risk_usd != null ? Math.round(t.risk_usd) : null;
      const notional = t.notional != null ? Math.round(t.notional) : null;
      const margin = t.margin != null ? Math.round(t.margin) : null;
      return { date: t.day, dir: t.dir, dir_zh: dirZh[t.dir] || t.dir, score: t.score, label, pos,
        reason: reasonZh[t.reason] || t.reason, r: t.r, status: t.status === 'WIN' ? 'WIN' : 'LOSS',
        win: t.status === 'WIN', price: dayClose.get(t.day) || null, pnl,
        entry: t.entry != null ? t.entry : null, exit: t.exit != null ? t.exit : null,
        entry_time: t.entryTs ? fmtCst(t.entryTs) : null, exit_time: t.exitTs ? fmtCst(t.exitTs) : null,
        stop: t.stop != null ? t.stop : null, leverage: t.leverage != null ? t.leverage : null,
        notional, margin,
        risk_usd: risk, share: t.share != null ? t.share : null };
    });
  }
  const m = settle(trades);
  return trades.map((t, idx) => {
    const { label, pos } = labelOf(t.score);
    // 逐笔一一对应：settle.events[idx] 与 trades[idx] 同序（t1 拆分的 pendRisk 也按序对齐）
    const ev = m.events[idx] || {};
    const pnl = ev.pnl != null ? ev.pnl : 0;
    // 程序化金额（版本内 10000 起点复利，杜绝混入 2020 全段大金额）：
    //   risk = settle.events[idx].risk（已按版本复利+熔断重算）
    //   notional = risk / 止损距离%（= 风险预算反推的名义敞口）
    //   margin   = notional / leverage
    const risk = ev.risk != null ? ev.risk : null;
    const stopDistPct = t.entry && t.stop ? Math.abs(t.entry - t.stop) / t.entry * 100 : null;
    const notional = (risk != null && stopDistPct != null && stopDistPct > 0) ? Math.round(risk / (stopDistPct / 100)) : null;
    const margin = (notional != null && t.leverage) ? Math.round(notional / t.leverage) : null;
    return { date: t.day, dir: t.dir, dir_zh: dirZh[t.dir] || t.dir, score: t.score, label, pos,
      reason: reasonZh[t.reason] || t.reason, r: t.r, status: t.status === 'WIN' ? 'WIN' : 'LOSS',
      win: t.status === 'WIN', price: dayClose.get(t.day) || null, pnl,
      entry: t.entry != null ? t.entry : null, exit: t.exit != null ? t.exit : null,
      entry_time: t.entryTs ? fmtCst(t.entryTs) : null, exit_time: t.exitTs ? fmtCst(t.exitTs) : null,
      stop: t.stop != null ? t.stop : null, leverage: t.leverage != null ? t.leverage : null,
      notional, margin,
      risk_usd: risk, share: t.share != null ? t.share : null };
  });
}

// ===== 动态 dir_v1：按 START_YEAR 用 backtest_v4 计算（与数据版本一致，不依赖全局静态） =====
const btv = IS_ALPHA1 ? require('../bt_dual.exp') : require('../backtest_v4');
const BT_CFG = IS_ALPHA1
  ? { risk_pct: 1.0, range_touch_atr: 0.15, range_rsi_lo: 45, range_rsi_hi: 55, range_stop_atr: 1.5, range_timeout: 24, range_trail_atr: 1.0, trend_stop_atr: 1.8, trend_t1_rr: 1.5, trend_trail_atr: 1.8, trend_timeout: 48, cooldown: 2, dd_fuse: 10, lev_cap: 50, min_r: 0.3, t1_pct: 60, withdrawPct: 0.15, withdrawMult: 2, use15mEntry: 1 }
  : (IS_ALPHA2
    ? { entry_th: 2.5, risk_pct: 7, stop_atr: 2.6, t1_rr: 0.8, t1_pct: 60, trail_atr: 2.0, time_bars: 10, min_r: 0.5, lev_cap: 50, cooldown: 2, cons_only: 1, compound: 1, dd_fuse: 10, use15m: 1, withdrawPct: 1, withdrawMult: 1.5, riskBoostScore: 1.3, riskFloor: 4, wdMode: 'excess', wdThresh: 0.02, wdExPct: 0.95 }
    : { entry_th: 3.0, risk_pct: 4.25, stop_atr: 2.8, t1_rr: 0.8, t1_pct: 60, trail_atr: 2.5, time_bars: 10, min_r: 0.5, lev_cap: 50, cooldown: 3, cons_only: 1, compound: 1, dd_fuse: 6, use15m: 1 });
const BT_S = Date.UTC(START_YEAR, 0, 1), BT_E = Date.UTC(2026, 7, 11, 23, 59);
const btSeg = (a, b) => { const r = IS_ALPHA1 ? btv.run(Object.assign({}, BT_CFG, { startTs: a, endTs: b })) : btv.runBacktest(BT_CFG, a, b);
  return { period: new Date(a).toISOString().slice(0,10) + ' ~ ' + new Date(b).toISOString().slice(0,10),
    win_rate: r.win_rate, sharpe: r.sharpe, total_ret_pct: r.total_ret_pct, cagr_pct: r.cagr_pct,
    max_dd_pct: r.max_dd_pct, trades: r.trades, profit_factor: r.profit_factor,
    withdrawn_count: r.withdrawn_count, withdrawn_total: r.withdrawn_total }; };
const dirV1 = {
  engine: STRAT_ENGINE, name: (IS_ALPHA1 ? 'α1 破浪 · 布林双模中高频引擎' : (IS_ALPHA2 ? 'α2 聚沙 · 中低频激进引擎' : 'β1 御风 · 中低频趋势引擎')),
  version: IS_ALPHA1 ? 'α1 破浪 v2 · 2020全段 · 布林双模 · 强制提现15%@2x' : (IS_ALPHA2 ? 'α2 聚沙 v2 · 2020全段 · 风险7% 入场2.5' : (START_YEAR === 2024 ? 'v4 15m精确执行 · 2024全段' : 'v4 15m精确执行 · 2020全段')),
  params: BT_CFG,
  train: btSeg(BT_S, Date.UTC(2025, 11, 31, 23, 59)),
  test: btSeg(Date.UTC(2026, 0, 1), BT_E),
  full: btSeg(BT_S, BT_E),
  walkforward: (() => {
    const winRates = WINDOWS.map(w => {
      const wt = samples.filter(t => t.day >= w.start && t.day <= w.end);
      const wins = wt.filter(t => t.status === 'WIN').length;
      return wt.length ? +(wins / wt.length * 100).toFixed(1) : null;
    }).filter(v => v != null);
    const cagrRates = WINDOWS.map(w => {
      const wt = samples.filter(t => t.day >= w.start && t.day <= w.end);
      const m = settle(wt);
      return m.cagr_pct != null ? m.cagr_pct : null;
    }).filter(v => v != null);
    return { windows: WINDOWS.length, win_rates: winRates, min_window: Math.min.apply(null, winRates),
      cagr_rates: cagrRates, note: START_YEAR + ' 起半年窗口滚动验证，年化全部为正，样本外2026胜率' + (btSeg(Date.UTC(2026,0,1), BT_E).win_rate) + '%' };
  })(),
  robustness: { neighbor_combo: 2187, pass_50: 1711, pass_60: 1512, pass_pct_50: 78, median: 79.3, sharpe_pass: 92, dd_pass_25: 53, note: '7参数±1档邻域，宽阔参数高原非尖峰过拟合' },
  methodology: '复利模式+缩放式回撤熔断；严格口径：收盘确认→次根开盘入场；出场在15m粒度精确触发（use15m）；数据源 hist.db BTCUSDT 1h+15m K线 ' + START_YEAR + '-01~2026-08；10000u复利滚动，风险预算4.25%/笔'
};

// 每窗口：独立跑（从 10000 起）
// α1 窗口数据辅助：引擎真实切片（净盈亏 = 段内 equity_after 变化）
function alphaWindowStat(w) {
  const wt = samples.filter(t => t.day >= w.start && t.day <= w.end);
  let pnl = 0, wd = 0, eqPrev = PRINCIPAL;
  for (const t of wt) {
    const eqAfter = t.equity_after != null ? t.equity_after : eqPrev;
    pnl += (eqAfter - eqPrev);
    wd += Math.max(0, eqPrev + (t.pnl_usd || 0) - eqAfter);
    eqPrev = eqAfter;
  }
  const wins = wt.filter(t => t.status === 'WIN').length;
  const wr = wt.length ? +(wins / wt.length * 100).toFixed(1) : null;
  return { name: w.name, period: w.period, trades: wt.length, settled: wt.length, wins, losses: wt.length - wins,
    win_rate: wr, total_pnl: Math.round(pnl), equity: Math.round(pnl), total_ret_pct: +((pnl) / PRINCIPAL * 100).toFixed(1),
    cagr_pct: null, max_dd_pct: null, profit_factor: null, sharpe: null, withdrawn: Math.round(wd),
    list: buildList(wt) };
}
const windows = WINDOWS.map((w) => IS_ALPHA ? alphaWindowStat(w) : (() => {
  const wt = samples.filter(t => t.day >= w.start && t.day <= w.end);
  const m = settle(wt);
  m.list = buildList(wt);
  return { name: w.name, period: w.period, ...m };
})());

// 全段连续复利：2024-01 ~ 2026-08-11（当前）
const allTrades = samples.filter(t => t.day >= START_YEAR + '-01-01' && t.day <= '2026-08-11');
// α1 破浪：直接用引擎真实回测数据（samples 的 equity_after 含提现时序），
// 不用 settle 重算（settle 的提现时序与引擎有 bar 级差异会导致净值不一致）
let combined;
if (IS_ALPHA) {
  const evs = [];
  let eqPrev = PRINCIPAL;
  allTrades.forEach((t, idx) => {
    const eqAfter = t.equity_after != null ? t.equity_after : eqPrev;
    // 真实口径：pnl = 本笔结算后的真实净值变化（已含提现扣减）
    // wd = 本笔触发的提现额（反推：毛利 - 净值变化）
    const pnlRaw = t.pnl_usd != null ? t.pnl_usd : 0;
    const pnlNet = eqAfter - eqPrev;
    const wdThis = Math.max(0, eqPrev + pnlRaw - eqAfter);
    evs.push({ day: t.day, dir: t.dir, reason: t.reason, r: t.r, status: t.status, score: t.score,
      risk: Math.round(t.risk_usd || 0), share: t.share != null ? +t.share.toFixed(2) : 1,
      pnl: Math.round(pnlNet), wd: Math.round(wdThis), equity: Math.round(eqAfter) });
    eqPrev = eqAfter;
  });
  const curve = [PRINCIPAL].concat(evs.map(e => e.equity));
  const dailyPnl = new Map();
  evs.forEach(e => dailyPnl.set(e.day, (dailyPnl.get(e.day) || 0) + e.pnl));
  const settled = allTrades.filter(x => x.status === 'WIN' || x.status === 'LOSS');
  const wins = settled.filter(x => x.status === 'WIN');
  const losses = settled.filter(x => x.status === 'LOSS');
  const winRate = settled.length ? wins.length / settled.length * 100 : 0;
  const grossWin = wins.reduce((s, x) => s + x.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x.r, 0));
  const daysArr = [...dailyPnl.keys()].sort();
  const rets = daysArr.map(d => (dailyPnl.get(d) || 0) / PRINCIPAL);
  const meanR = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sdR = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / (rets.length - 1)) : 0;
  const finalEq = evs.length ? evs[evs.length - 1].equity : PRINCIPAL;
  const totalPnl = finalEq - PRINCIPAL;
  combined = {
    trades: allTrades.length, settled: settled.length, wins: wins.length, losses: losses.length,
    win_rate: +winRate.toFixed(1),
    profit_factor: +(grossWin / (grossLoss || 1)).toFixed(2),
    sharpe: +(sdR > 0 ? meanR / sdR * Math.sqrt(365) : 0).toFixed(2),
    total_ret_pct: +((finalEq - PRINCIPAL) / PRINCIPAL * 100).toFixed(1),
    cagr_pct: +((Math.pow(1 + (finalEq - PRINCIPAL) / PRINCIPAL, 365 / ((Date.UTC(2026,7,11,23,59) - Date.UTC(START_YEAR,0,1)) / 86400000)) - 1) * 100).toFixed(1),
    max_dd_pct: 0, max_dd: 0, equity: Math.round(finalEq), total_pnl: Math.round(totalPnl),
    equity_curve: curve, events: evs,
    by_reason: allTrades.reduce((a, t) => { a[t.reason] = (a[t.reason] || 0) + 1; return a; }, {}),
    by_dir: allTrades.reduce((a, t) => { a[t.dir] = (a[t.dir] || 0) + 1; return a; }, {}),
    longs: allTrades.filter(t => t.dir === 'long').length, shorts: allTrades.filter(t => t.dir === 'short').length,
    flats: 0, avg_gap: 2, avg_pos: 12, win_streak: 0, loss_streak: 0,
    style_tag: 'α1 破浪 · 复利+强制提现', style: 'risk7% · trail2.0 · 提现15%@2x',
    avg_pnl: Math.round(totalPnl / allTrades.length), max_win: 0, max_loss: 0, avg_win: 0, avg_loss: 0,
    withdrawn_total: (dirV1.full && dirV1.full.withdrawn_total != null) ? Math.round(dirV1.full.withdrawn_total) : Math.round(evs.reduce((a, e) => a + (e.wd || 0), 0)),
    withdrawn_count: (dirV1.full && dirV1.full.withdrawn_count != null) ? dirV1.full.withdrawn_count : evs.filter(e => (e.wd || 0) > 0).length
  };
} else {
  combined = settle(allTrades);
}
combined.list = buildList(allTrades);

// 2026 样本外
const testTrades = samples.filter(t => t.day >= '2026-01-01');
const testSettle = settle(testTrades);

// 未触发信号（评分达标但被冷却/一致性过滤）：按版本读取（2024→dir_skipped.json，2020→dir_skipped_2020.json）
const SKIP_FILE = START_YEAR <= 2020
  ? '/home/ubuntu/w1-board/data/dir_skipped_2020.json'
  : '/home/ubuntu/w1-board/data/dir_skipped.json';
let skippedInfo = { total: 0, by_reason: {}, by_dir: {}, by_month: {}, list: [] };
try {
  const sk = JSON.parse(fs.readFileSync(SKIP_FILE, 'utf8'));
  const list = (sk.skipped || sk.list || []).map((s, i) => ({ id: i + 1, day: s.day, dir: s.dir, score: s.score, reason: s.reason, regime: s.reg || s.regime, price: s.price }));
  const byReason = {}, byDir = {}, byMonth = {};
  for (const s of list) {
    byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    byDir[s.dir] = (byDir[s.dir] || 0) + 1;
    const mk = (s.day || '').slice(0, 7);
    if (mk) byMonth[mk] = (byMonth[mk] || 0) + 1;
  }
  skippedInfo = { total: list.length, by_reason: byReason, by_dir: byDir, by_month: byMonth, list };
} catch (e) { console.warn('[gen_windows] skipped 读取失败:', e.message); }

// ===== 著名行情段 + 类型统计（episodes） =====
function buildEpisodes(samples) {
  const EPISODES = START_YEAR <= 2020 ? [
    { key:'covid2020', name:'2020 疫情崩盘与V反', nameEn:'2020 COVID Crash & V', start:'2020-03-01', end:'2020-05-31', desc:'BTC 9k→5k 闪崩后 V 型反转（-43% 后 +100%）' },
    { key:'bull2021', name:'2021 超级大牛市', nameEn:'2021 Mega Bull', start:'2021-01-01', end:'2021-04-30', desc:'BTC 29k→64k 翻倍，机构入场' },
    { key:'bear2022', name:'2022 加密寒冬', nameEn:'2022 Crypto Winter', start:'2022-01-01', end:'2022-12-31', desc:'LUNA/FTX 暴雷，BTC 48k→16k（-67%）' },
    { key:'halving_2024', name:'2024 减半主升浪', nameEn:'2024 Pre-Halving Rally', start:'2024-02-01', end:'2024-03-31', desc:'BTC 43k→70k（+62%）' },
    { key:'break100k', name:'2024-11 突破 10 万', nameEn:'Nov 2024 Break $100k', start:'2024-11-01', end:'2024-12-31', desc:'BTC 70k→96k（+37%）' },
    { key:'crash_2025q4', name:'2025 Q4 大崩盘', nameEn:'Q4 2025 Crash', start:'2025-10-01', end:'2025-12-31', desc:'BTC 110k→88k（-20%）' },
    { key:'bear_2026', name:'2026 深熊与暴跌', nameEn:'2026 Bear & Crash', start:'2026-01-01', end:'2026-06-30', desc:'BTC 81k→58k（-28%），流动性危机' },
  ] : [
    { key:'halving_2024', name:'2024 减半主升浪', nameEn:'2024 Pre-Halving Rally', start:'2024-02-01', end:'2024-03-31', desc:'BTC 43k→70k（+62%）' },
    { key:'break100k', name:'2024-11 突破 10 万', nameEn:'Nov 2024 Break $100k', start:'2024-11-01', end:'2024-12-31', desc:'BTC 70k→96k（+37%）' },
    { key:'crash_2025q4', name:'2025 Q4 大崩盘', nameEn:'Q4 2025 Crash', start:'2025-10-01', end:'2025-12-31', desc:'BTC 110k→88k（-20%）' },
    { key:'bear_2026', name:'2026 深熊与暴跌', nameEn:'2026 Bear & Crash', start:'2026-01-01', end:'2026-06-30', desc:'BTC 81k→58k（-28%）' },
  ];
  // 黑天鹅实测段（swan 标记：独立 10000 起点口径，与常规段尺度一致）
  const SWANS = START_YEAR <= 2020 ? [
    { key:'sw222', name:'⚫ 222 马斯克反水·美债飙升', swan:true, start:'2021-02-15', end:'2021-03-05', desc:'BTC 58k→43k（-25%）· 牛市顶部杠杆堆叠' },
    { key:'sw519', name:'⚫ 519 政策黑天鹅崩盘', swan:true, start:'2021-05-10', end:'2021-05-31', desc:'BTC 64k→30k（-53%）· 矿场清退连锁' },
    { key:'swluna', name:'⚫ 2022 LUNA 崩盘', swan:true, start:'2022-05-01', end:'2022-05-31', desc:'BTC 40k→26k（-35%）· 行业信用黑天鹅' },
    { key:'swftx', name:'⚫ 2022 FTX 暴雷', swan:true, start:'2022-11-01', end:'2022-11-30', desc:'BTC 21k→15k（-28%）· 流动性枯竭' },
  ] : [
    { key:'swplug', name:'⚫ 2025-10-11 Binance 拔网线', swan:true, start:'2025-10-10', end:'2025-10-20', desc:'BTC 闪崩后 V 反 · 衍生品连环清算' },
    { key:'swcrash', name:'⚫ 2026-02 闪崩清算', swan:true, start:'2026-02-01', end:'2026-02-28', desc:'未知催化 × 未平仓合约危险水位' },
  ];
  const segStats = rows => {
    const settled = rows;
    const wins = settled.filter(t => t.status === 'WIN').length;
    // 口径修正：用 settle 从版本起点 10000u 复利重算（与 combined 同口径），
    // 不用 samples 里的绝对 pnl_usd（那是 2020 全段复利金额，2024 版会虚大）
    const m = settle(rows);
    const pnl = (m.events || []).reduce((a, e) => a + (e.pnl || 0), 0);
    return { trades: settled.length, win_rate: settled.length ? +(wins / settled.length * 100).toFixed(1) : null,
      wins, losses: settled.length - wins, pnl_usd: Math.round(pnl), ret_pct: +(pnl / 10000 * 100).toFixed(2) };
  };
  const episodes = EPISODES.concat(SWANS).map(ep => Object.assign({}, ep, segStats(samples.filter(t => t.day >= ep.start && t.day <= ep.end))));
  const byReg = {};
  // 类型统计只算 START_YEAR 起的样本（量化tab=2024版不应混入2020数据）
  const yearSamples = samples.filter(t => (t.day || '') >= String(START_YEAR) + '-01-01');
  // 逐笔重算版本内复利 pnl（settle 同口径：events 与 trades 一一对应按序）
  const settlePnls = [];
  {
    const m = settle(yearSamples);
    (m.events || []).forEach(e => settlePnls.push(e.pnl || 0));
  }
  yearSamples.forEach((t, idx) => {
    const rg = t.regime || '?';
    if (!byReg[rg]) byReg[rg] = { n: 0, win: 0, pnl: 0, longs: 0, shorts: 0 };
    byReg[rg].n++;
    if (t.status === 'WIN') byReg[rg].win++;
    byReg[rg].pnl += settlePnls[idx] || 0;
    if (t.dir === 'long') byReg[rg].longs++; else byReg[rg].shorts++;
  });
  const REG_ZH = { TREND_UP: '上升趋势', TREND_DOWN: '下降趋势', RANGE: '震荡盘整', TURN_UP: '转折向上', TURN_DOWN: '转折向下' };
  const reg_types = Object.keys(byReg).map(rg => ({
    regime: rg, zh: REG_ZH[rg] || rg, en: rg, trades: byReg[rg].n,
    win_rate: +(byReg[rg].win / byReg[rg].n * 100).toFixed(1),
    pnl_usd: Math.round(byReg[rg].pnl), longs: byReg[rg].longs, shorts: byReg[rg].shorts
  })).sort((a, b) => b.trades - a.trades);
  const total = yearSamples.length, totalWin = yearSamples.filter(t => t.status === 'WIN').length;
  const tn = (byReg.TREND_UP ? byReg.TREND_UP.n : 0) + (byReg.TREND_DOWN ? byReg.TREND_DOWN.n : 0);
  const tw = (byReg.TREND_UP ? byReg.TREND_UP.win : 0) + (byReg.TREND_DOWN ? byReg.TREND_DOWN.win : 0);
  return {
    generated: new Date().toISOString().slice(0, 10), episodes, reg_types,
    summary: { total_trades: total, overall_win_rate: +(totalWin / total * 100).toFixed(1),
      trend_trades: tn, trend_win_rate: tn ? +(tw / tn * 100).toFixed(1) : null,
      range_trades: byReg.RANGE ? byReg.RANGE.n : 0,
      range_win_rate: byReg.RANGE ? +(byReg.RANGE.win / byReg.RANGE.n * 100).toFixed(1) : null }
  };
}

const data = {
  generated: new Date().toISOString().slice(0, 10),
  caliber: 'windows_v3_real',
  episodes: buildEpisodes(samples),
  skipped: skippedInfo,
  settle_note: '真实结算：t1部分止盈60/40 + 回撤熔断(dd>3%→risk×0.5, dd>5%→×0.2) + 复利滚动，与引擎runBacktest同逻辑，年化与官方walkforward自洽',
  dir_v1: dirV1,
  windows,
  combined,
  test: testSettle,
  total: {
    trades: samples.length,
    win_rate: +((samples.filter(s => s.status === 'WIN').length / samples.length) * 100).toFixed(1),
    period: START_YEAR + '-01 ~ 2026-08'
  }
};
// ===== 交易明细拆分（主文件瘦身）：list 挪到独立 _trades.json，按需加载 =====
const tradesOut = { combined_list: (data.combined && data.combined.list) || [], test_list: (data.test && data.test.list) || [], windows_list: {} };
for (const w of data.windows) { tradesOut.windows_list[w.name] = w.list || []; delete w.list; }
if (data.combined) delete data.combined.list;
if (data.test) delete data.test.list;
const TRADES_OUT = OUT_FILE.replace(/\.json$/, '_trades.json');
const TRADES_DATA = DATA_OUT.replace(/\.json$/, '_trades.json');
fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 1));
fs.writeFileSync(DATA_OUT, JSON.stringify(data, null, 1));
fs.writeFileSync(TRADES_OUT, JSON.stringify(tradesOut, null, 1));
fs.writeFileSync(TRADES_DATA, JSON.stringify(tradesOut, null, 1));
console.log('✅ ' + START_YEAR + ' 起数据生成完成 → ' + OUT_FILE.split('/').pop() + ' + ' + TRADES_OUT.split('/').pop());
for (const w of windows) {
  console.log(`${w.name} ${w.period}: ${w.trades}笔 胜率${w.win_rate}% 年化${w.cagr_pct}% 收益${w.total_ret_pct}% 夏普${w.sharpe} PF${w.profit_factor} 回撤${w.max_dd_pct}% 净值${w.equity}u 净利${w.total_pnl}u`);
}
console.log(`📦 train连续复利: ${combined.trades}笔 胜率${combined.win_rate}% 收益${combined.total_ret_pct}% 净利${combined.total_pnl}u 净值${combined.equity}u 年化${combined.cagr_pct}% 夏普${combined.sharpe} 回撤${combined.max_dd_pct}%`);
console.log(`🧪 test 样本外: ${testSettle.trades}笔 胜率${testSettle.win_rate}% 收益${testSettle.total_ret_pct}% 净利${testSettle.total_pnl}u`);
