'use strict';
// ============================================================
// 指标战绩 · W1~W4 四窗口完整数据生成 v2.0（2026-08-11 · William 老板指令）
// 数据源: data/dir_samples.json（252条官方样本 = dir-v2 引擎全段回测）
// 口径: 按入场日切分 4×6月窗口，与看板 walkforward 完全一致
//   W1 2024-01~06 / W2 2024-07~12 / W3 2025-01~06 / W4 2025-07~12
// 输出: public/experience.json（dir_v1 + windows[4] + combined + total）
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
const reasonZh = { t1: '止盈1', trail: '移动止盈', stop: '止损', timeout: '超时', timeout_win: '超时止盈' };
const dirZh = { long: '多', short: '空' };

const WINDOWS = [
  { name: 'W1', start: '2024-01-01', end: '2024-06-30', period: '2024-01 ~ 2024-06' },
  { name: 'W2', start: '2024-07-01', end: '2024-12-31', period: '2024-07 ~ 2024-12' },
  { name: 'W3', start: '2025-01-01', end: '2025-06-30', period: '2025-01 ~ 2025-06' },
  { name: 'W4', start: '2025-07-01', end: '2025-12-31', period: '2025-07 ~ 2025-12' },
];
const PRINCIPAL = 10000, RISK = 0.035;

// 完整指标集（原版回测指标卡所需全部字段）
function computeMetrics(trades, official) {
  trades = trades.slice().sort((a, b) => a.day < b.day ? -1 : 1);
  let eq = PRINCIPAL, peak = PRINCIPAL, maxDdU = 0, maxDdPct = 0;
  const daily = new Map();
  const list = [];
  for (const t of trades) {
    const risk = eq * RISK;
    const pnl = risk * t.r;
    eq += pnl; if (eq > peak) peak = eq; const dd = peak - eq; if (dd > maxDdU) maxDdU = dd;
    if (peak > 0) { const ddp = dd / peak * 100; if (ddp > maxDdPct) maxDdPct = ddp; }
    daily.set(t.day, (daily.get(t.day) || 0) + pnl);
    const { label, pos } = labelOf(t.score);
    list.push({ date: t.day, dir: t.dir, dir_zh: dirZh[t.dir] || t.dir, score: t.score, label, pos,
      reason: reasonZh[t.reason] || t.reason, r: t.r, status: t.status === 'WIN' ? 'WIN' : 'LOSS',
      win: t.status === 'WIN', price: dayClose.get(t.day) || null, pnl: Math.round(pnl) });
  }
  const settled = list.filter(x => x.status === 'WIN' || x.status === 'LOSS');
  const wins = settled.filter(x => x.win);
  const losses = settled.filter(x => !x.win);
  const winRate = settled.length ? wins.length / settled.length * 100 : 0;
  const grossWin = wins.reduce((s, x) => s + x.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x.r, 0));
  const daysArr = [...daily.keys()].sort();
  const rets = daysArr.map(d => (daily.get(d) || 0) / PRINCIPAL);
  const meanR = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sdR = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / (rets.length - 1)) : 0;
  const downR = rets.filter(x => x < 0);
  const sdDown = downR.length > 1 ? Math.sqrt(downR.reduce((a, b) => a + b ** 2, 0) / downR.length) : 0;
  const sharpe = sdR > 0 ? meanR / sdR * Math.sqrt(365) : 0;
  const sortino = sdDown > 0 ? meanR / sdDown * Math.sqrt(365) : 0;
  const volAnn = sdR * Math.sqrt(365) * 100;
  const totalRet = (eq - PRINCIPAL) / PRINCIPAL * 100;
  const spanDays = trades.length >= 2 ? (Date.parse(trades[trades.length - 1].day) - Date.parse(trades[0].day)) / 86400000 : 183;
  const cagr = spanDays > 0 ? (Math.pow(1 + totalRet / 100, 365 / spanDays) - 1) * 100 : 0;
  const totalPnl = eq - PRINCIPAL;
  const calmar = maxDdPct > 0 ? cagr / maxDdPct : 0;
  const recovery = maxDdU > 0 ? totalPnl / maxDdU : 0;
  const pnls = settled.map(x => x.pnl);
  const winPnls = wins.map(x => x.pnl);
  const lossPnls = losses.map(x => x.pnl);
  const expectancy = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const avgPnl = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const avgWin = winPnls.length ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length ? Math.abs(lossPnls.reduce((a, b) => a + b, 0)) / lossPnls.length : 0;
  const maxWin = pnls.length ? Math.max(...pnls) : 0;
  const maxLoss = pnls.length ? Math.min(...pnls) : 0;
  let cur = 0, winStreak = 0, lossStreak = 0;
  for (const t of settled) {
    if (t.win) { cur = cur > 0 ? cur + 1 : 1; winStreak = Math.max(winStreak, cur); }
    else { cur = cur < 0 ? cur - 1 : -1; lossStreak = Math.max(lossStreak, -cur); }
  }
  const longs = settled.filter(x => x.dir === 'long').length;
  const shorts = settled.filter(x => x.dir === 'short').length;
  const avgPos = settled.length ? settled.reduce((s, x) => s + x.pos, 0) / settled.length : 0;
  const avgGap = trades.length > 1 ? Math.round(spanDays / (trades.length - 1)) : 0;
  // 净值曲线（逐笔后净值）
  let eq2 = PRINCIPAL; const curve = [eq2];
  for (const t of trades) { eq2 += eq2 * RISK * t.r; curve.push(Math.round(eq2)); }
  return {
    trades: trades.length, settled: settled.length, wins: wins.length, losses: losses.length,
    win_rate: +((official && official.win_rate) != null ? official.win_rate : winRate).toFixed(1),
    profit_factor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2), calmar: +calmar.toFixed(2),
    recovery: +recovery.toFixed(1), cagr_pct: +cagr.toFixed(0), vol_ann: +volAnn.toFixed(0),
    total_ret_pct: +totalRet.toFixed(1), max_dd_pct: +maxDdPct.toFixed(1), max_dd: Math.round(maxDdU),
    expectancy: +expectancy.toFixed(0), avg_pnl: +avgPnl.toFixed(0),
    avg_win: Math.round(avgWin), avg_loss: Math.round(avgLoss),
    max_win: Math.round(maxWin), max_loss: Math.round(maxLoss),
    win_streak: winStreak, loss_streak: lossStreak,
    longs, shorts, flats: 0, avg_pos: +avgPos.toFixed(0), avg_gap: avgGap,
    style_tag: '中低频方向引擎 · 复利滚动', style: '信号评分分档 0/3/8/12% · ATR 止损 + 移动止盈',
    by_reason: trades.reduce((a, t) => { const k = reasonZh[t.reason] || t.reason; a[k] = (a[k] || 0) + 1; return a; }, {}),
    by_dir: trades.reduce((a, t) => { a[t.dir] = (a[t.dir] || 0) + 1; return a; }, {}),
    equity: Math.round(eq), total_pnl: Math.round(totalPnl), equity_curve: curve, list
  };
}

const DIR_STATS = require('/home/ubuntu/w1-board/lib/dir_bt_stats');
const wf = DIR_STATS.stats().walkforward || {};

const windows = WINDOWS.map((w, i) => {
  const wt = samples.filter(t => t.day >= w.start && t.day <= w.end);
  const off = { win_rate: (wf.win_rates && wf.win_rates[i]) != null ? wf.win_rates[i] : null,
                cagr: (wf.cagr_rates && wf.cagr_rates[i]) != null ? wf.cagr_rates[i] : null };
  const m = computeMetrics(wt);
  if (off.win_rate != null) m.win_rate = off.win_rate;
  if (off.cagr != null) m.cagr_pct = off.cagr;
  return { name: w.name, period: w.period, ...m };
});

// 四窗口连续复利聚合（2024-01 ~ 2025-12 全段，10000u 从头滚到尾）
const allTrades = samples.filter(t => t.day >= '2024-01-01' && t.day <= '2025-12-31');
const combined = computeMetrics(allTrades);

const data = {
  generated: new Date().toISOString().slice(0, 10),
  caliber: 'windows_v2',
  dir_v1: DIR_STATS.stats(),
  windows,
  combined,
  total: {
    trades: samples.length,
    win_rate: +((samples.filter(s => s.status === 'WIN').length / samples.length) * 100).toFixed(1),
    period: '2024-01 ~ 2026-12'
  }
};
fs.writeFileSync('/home/ubuntu/w1-board/public/experience.json', JSON.stringify(data, null, 1));
fs.writeFileSync('/home/ubuntu/w1-board/data/experience_windows.json', JSON.stringify(data, null, 1));
console.log('✅ 四窗口数据 v2 生成完成');
for (const w of windows) {
  console.log(`${w.name} ${w.period}: ${w.trades}笔 胜率${w.win_rate}% 年化${w.cagr_pct}% 收益${w.total_ret_pct}% 夏普${w.sharpe} 索提诺${w.sortino} 卡玛${w.calmar} PF${w.profit_factor} 回撤${w.max_dd_pct}% 净值${w.equity}u 净利${w.total_pnl}u`);
}
console.log(`📦 四窗连续复利: ${combined.trades}笔 胜率${combined.win_rate}% 收益${combined.total_ret_pct}% 净利${combined.total_pnl}u 净值${combined.equity}u 年化${combined.cagr_pct}% 夏普${combined.sharpe} 回撤${combined.max_dd_pct}%`);
