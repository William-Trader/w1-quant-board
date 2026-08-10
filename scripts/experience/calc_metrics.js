// calc_metrics.js — 在现有 results 上重算全部回测指标（含索提诺/卡玛/恢复因子/期望/年化/波动率/交易风格）
// 用法: node scripts/experience/calc_metrics.js
'use strict';
const fs = require('fs');
const PUBLIC = '/home/ubuntu/w1-board/public/experience.json';
const DATA_OUT = '/home/ubuntu/w1-board/data/experience_blind.json';
const PRINCIPAL = 10000;

const d = JSON.parse(fs.readFileSync(PUBLIC, 'utf8'));
const results = d.results;
const S = d.summary;
const pnls = results.map(r => r.pnl);
const rets = pnls.map(p => p / PRINCIPAL);

// ---- 基础 ----
const total_pnl = S.total_pnl;
const settled = results.filter(r => r.hit !== null);
const wins = settled.filter(r => r.hit).length;
const acc = Math.round(wins / settled.length * 100);
const total_ret_pct = total_pnl / PRINCIPAL * 100;

// ---- 时间跨度（年）----
const dates = results.map(r => r.date).sort();
const t0 = new Date(dates[0] + 'T00:00:00Z').getTime();
const t1 = new Date(dates[dates.length - 1] + 'T00:00:00Z').getTime();
const years = (t1 - t0) / (365.25 * 86400000) + 14 / 365.25; // 含14天持有期

// ---- 年化收益率 ----
const cagr = total_pnl > -PRINCIPAL ? (Math.pow(1 + total_pnl / PRINCIPAL, 1 / years) - 1) * 100 : -100;

// ---- 波动率（单场收益 std × sqrt(365/14) 年化）----
const meanR = rets.reduce((s, x) => s + x, 0) / rets.length;
const stdR = Math.sqrt(rets.reduce((s, x) => s + (x - meanR) ** 2, 0) / rets.length);
const vol_ann = stdR * Math.sqrt(365 / 14) * 100;

// ---- 夏普（年化，无风险=0）----
const sharpe = stdR > 0 ? meanR / stdR * Math.sqrt(365 / 14) : null;

// ---- 索提诺（只惩罚下行）----
const downDev = Math.sqrt(rets.reduce((s, x) => s + (x < 0 ? x * x : 0), 0) / rets.length);
const sortino = downDev > 0 ? meanR / downDev * Math.sqrt(365 / 14) : null;

// ---- 最大回撤（净值曲线，用 S.equity）----
const eq = S.equity;
let peak = eq[0], max_dd = 0;
for (const v of eq) { if (v > peak) peak = v; const dd = peak - v; if (dd > max_dd) max_dd = dd; }
const max_dd_pct = peak > 0 ? max_dd / peak * 100 : 0;

// ---- 卡玛 = 年化 / 最大回撤% ----
const calmar = max_dd_pct > 0 ? cagr / max_dd_pct : null;

// ---- 恢复因子 = 净利润 / 最大回撤金额 ----
const recovery = max_dd > 0 ? total_pnl / max_dd : null;

// ---- 盈亏比（Profit Factor）----
const wl = pnls.filter(p => p > 0), ls = pnls.filter(p => p < 0);
const grossWin = wl.reduce((s, x) => s + x, 0);
const grossLoss = Math.abs(ls.reduce((s, x) => s + x, 0));
const profit_factor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : null);

// ---- 期望值（每笔，u）----
const winRate = settled.length ? wins / settled.length : 0;
const avg_win = wl.length ? grossWin / wl.length : 0;
const avg_loss = ls.length ? -grossLoss / ls.length : 0;
const expectancy = winRate * avg_win + (1 - winRate) * avg_loss;

// ---- 最大单笔盈/亏（万u口径）----
const max_win = wl.length ? Math.max.apply(null, wl) : 0;
const max_loss = ls.length ? Math.min.apply(null, ls) : 0;

// ---- 连胜/连亏 ----
let cur = 0, bestWin = 0, bestLoss = 0;
for (const r of results) {
  if (r.hit === true || r.hit === false) {
    if (r.hit) { cur = cur > 0 ? cur + 1 : 1; if (cur > bestWin) bestWin = cur; }
    else { cur = cur < 0 ? cur - 1 : -1; if (cur < bestLoss) bestLoss = cur; }
  }
}

// ---- 交易风格 ----
const longs = results.filter(r => r.cls.startsWith('long')).length;
const shorts = results.filter(r => r.cls.startsWith('short')).length;
const flats = results.filter(r => r.cls.startsWith('flat')).length;
const posArr = results.filter(r => r.pos > 0).map(r => r.pos);
const avg_pos = posArr.length ? posArr.reduce((s, x) => s + x, 0) / posArr.length : 0;
// 出手频率：平均间隔天数
let gapSum = 0, gapN = 0;
for (let i = 1; i < results.length; i++) {
  const a = new Date(results[i - 1].date + 'T00:00:00Z').getTime();
  const b = new Date(results[i].date + 'T00:00:00Z').getTime();
  gapSum += (b - a) / 86400000; gapN++;
}
const avg_gap = gapN ? Math.round(gapSum / gapN) : 0;
const dirBalance = Math.max(longs, shorts) / (longs + shorts || 1);
let styleTag;
if (avg_pos >= 8) styleTag = '重仓进攻型';
else if (avg_pos >= 5) styleTag = '稳健波段型';
else styleTag = '轻仓试探型';
const styleDesc = `${styleTag} · 多${longs}/空${shorts}/观望${flats} · 平均仓位${avg_pos.toFixed(1)}% · 约${avg_gap}天一出手 · 14日持仓`;

// ---- 汇总写回 ----
S.metrics = {
  sharpe: sharpe != null ? +sharpe.toFixed(2) : null,
  sortino: sortino != null ? +sortino.toFixed(2) : null,
  calmar: calmar != null ? +calmar.toFixed(2) : null,
  recovery: recovery != null ? +recovery.toFixed(2) : null,
  expectancy: Math.round(expectancy),
  cagr: +cagr.toFixed(1),
  vol_ann: +vol_ann.toFixed(1),
  max_dd: Math.round(max_dd),
  max_dd_pct: +max_dd_pct.toFixed(1),
  profit_factor: profit_factor != null ? +profit_factor.toFixed(2) : null,
  win_rate: acc,
  avg_win: Math.round(avg_win), avg_loss: Math.round(avg_loss),
  max_win, max_loss, avg_pnl: Math.round(total_pnl / results.length),
  win_streak: bestWin, loss_streak: -bestLoss,
  style: styleDesc, style_tag: styleTag,
  longs, shorts, flats, avg_pos: +avg_pos.toFixed(1), avg_gap
};
d.summary = S;
for (const f of [DATA_OUT, PUBLIC]) fs.writeFileSync(f, JSON.stringify(d, null, 1));
console.log('✅ metrics 重算完成:');
console.log(JSON.stringify(S.metrics, null, 1));
console.log(`  年化 ${cagr.toFixed(1)}% | 波动率 ${vol_ann.toFixed(1)}% | 索提诺 ${sortino.toFixed(2)} | 卡玛 ${calmar.toFixed(2)} | 恢复 ${recovery.toFixed(2)} | 期望 ${Math.round(expectancy)}u/笔`);
console.log(`  风格: ${styleDesc}`);
