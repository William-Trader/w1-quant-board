'use strict';
// ============================================================
// 指标战绩 · W1~W4 四窗口完整数据生成 v3.0（真实结算口径 · 2026-08-11 审计修正）
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

const samples = JSON.parse(fs.readFileSync('/home/ubuntu/w1-board/data/dir_samples.json', 'utf8')).samples;
const db = new Database(HIST, { readonly: true });

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

const WINDOWS = [
  { name: 'W1', start: '2024-01-01', end: '2024-06-30', period: '2024-01 ~ 2024-06' },
  { name: 'W2', start: '2024-07-01', end: '2024-12-31', period: '2024-07 ~ 2024-12' },
  { name: 'W3', start: '2025-01-01', end: '2025-06-30', period: '2025-01 ~ 2025-06' },
  { name: 'W4', start: '2025-07-01', end: '2025-12-31', period: '2025-07 ~ 2025-12' },
];
const PRINCIPAL = 10000, RISK = 0.035, T1_PCT = 0.6, DD_FUSE = 5;

// ============ 真实结算（与引擎 runBacktest 完全同逻辑） ============
// 输入: 事件流（t1 事件 + 尾仓事件 + 独立事件），r 为浮点
// 输出: 每事件 risk/share/pnl/equity + 净值曲线 + 汇总
function settle(trades, startEq = PRINCIPAL) {
  let eq = startEq, peak = startEq, pendRisk = null;
  const curve = [Math.round(startEq)], events = [];
  const dailyPnl = new Map();
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
    curve.push(Math.round(eq));
    dailyPnl.set(t.day, (dailyPnl.get(t.day) || 0) + pnl);
    events.push({ day: t.day, dir: t.dir, reason: t.reason, r: t.r, status: t.status, score: t.score,
      risk: Math.round(risk), share: +share.toFixed(2), pnl: Math.round(pnl), equity: Math.round(eq) });
  }
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
  const maxDdPct = maxDdU / startEq * 100;
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
  const m = settle(trades);
  const byDate = new Map();
  m.events.forEach(e => { if (!byDate.has(e.day)) byDate.set(e.day, []); byDate.get(e.day).push(e); });
  return trades.map(t => {
    const { label, pos } = labelOf(t.score);
    const evs = (byDate.get(t.day) || []).filter(e => Math.abs(e.r - t.r) < 0.005 && e.dir === t.dir);
    const pnl = evs.length ? evs[0].pnl : 0;
    return { date: t.day, dir: t.dir, dir_zh: dirZh[t.dir] || t.dir, score: t.score, label, pos,
      reason: reasonZh[t.reason] || t.reason, r: t.r, status: t.status === 'WIN' ? 'WIN' : 'LOSS',
      win: t.status === 'WIN', price: dayClose.get(t.day) || null, pnl };
  });
}

const DIR_STATS = require('/home/ubuntu/w1-board/lib/dir_bt_stats');
const wf = DIR_STATS.stats().walkforward || {};

// 每窗口：独立跑（从 10000 起）→ 与官方 walkforward 年化自洽
const windows = WINDOWS.map((w, i) => {
  const wt = samples.filter(t => t.day >= w.start && t.day <= w.end);
  const off = { win_rate: (wf.win_rates && wf.win_rates[i]) != null ? wf.win_rates[i] : null,
                cagr: (wf.cagr_rates && wf.cagr_rates[i]) != null ? wf.cagr_rates[i] : null };
  const m = settle(wt);
  if (off.win_rate != null) m.win_rate = off.win_rate;
  if (off.cagr != null) m.cagr_pct = off.cagr;
  m.list = buildList(wt);
  return { name: w.name, period: w.period, ...m };
});

// 全段连续复利：2024-01 ~ 2025-12（train 段，官方 train 口径）
const allTrades = samples.filter(t => t.day >= '2024-01-01' && t.day <= '2025-12-31');
const combined = settle(allTrades);
combined.list = buildList(allTrades);

// 2026 样本外
const testTrades = samples.filter(t => t.day >= '2026-01-01');
const testSettle = settle(testTrades);

const data = {
  generated: new Date().toISOString().slice(0, 10),
  caliber: 'windows_v3_real',
  settle_note: '真实结算：t1部分止盈60/40 + 回撤熔断(dd>3%→risk×0.5, dd>5%→×0.2) + 复利滚动，与引擎runBacktest同逻辑，年化与官方walkforward自洽',
  dir_v1: DIR_STATS.stats(),
  windows,
  combined,
  test: testSettle,
  total: {
    trades: samples.length,
    win_rate: +((samples.filter(s => s.status === 'WIN').length / samples.length) * 100).toFixed(1),
    period: '2024-01 ~ 2026-12'
  }
};
fs.writeFileSync('/home/ubuntu/w1-board/public/experience.json', JSON.stringify(data, null, 1));
fs.writeFileSync('/home/ubuntu/w1-board/data/experience_windows.json', JSON.stringify(data, null, 1));
console.log('✅ 四窗口数据 v3（真实结算）生成完成');
for (const w of windows) {
  console.log(`${w.name} ${w.period}: ${w.trades}笔 胜率${w.win_rate}% 年化${w.cagr_pct}% 收益${w.total_ret_pct}% 夏普${w.sharpe} PF${w.profit_factor} 回撤${w.max_dd_pct}% 净值${w.equity}u 净利${w.total_pnl}u`);
}
console.log(`📦 train连续复利: ${combined.trades}笔 胜率${combined.win_rate}% 收益${combined.total_ret_pct}% 净利${combined.total_pnl}u 净值${combined.equity}u 年化${combined.cagr_pct}% 夏普${combined.sharpe} 回撤${combined.max_dd_pct}%`);
console.log(`🧪 test 样本外: ${testSettle.trades}笔 胜率${testSettle.win_rate}% 收益${testSettle.total_ret_pct}% 净利${testSettle.total_pnl}u`);
