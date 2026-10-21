'use strict';
// 参数敏感性扫描 — 机构级稳健性验证
// 用法: node scripts/tianji_sensitivity.js
// 原理: 在全量历史窗口(3-08→8-31)上，逐一扰动关键参数 ±20%，观察绩效变化
//       若小扰动导致绩效剧烈塌方 → 参数峰值过拟合；若绩效平稳 → 稳健泛化
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const BT = path.join(ROOT, 'scripts', 'tianji_backtest.js');

function runBT(cfg) {
  try {
    const out = execFileSync('node', [BT, '--from', '2026-03-08', '--to', '2026-08-31', '--cfg', JSON.stringify({ min_window_start: '2026-03-08', ...cfg })], { encoding: 'utf8', timeout: 600000 });
    const m = out.match(/交易 (\d+) 笔 \| 胜率 ([\d.]+)% \(([\d.]+)W\/([\d.]+)L\)\s*已结盈亏 ([+-][\d.]+)U.*?PF ([\d.]+)/s);
    return m ? { n: +m[1], wr: +m[2], gross: +m[5], pf: +m[6] } : null;
  } catch (e) { return null; }
}

const base = { min_score: 4.0, tech_weight: 1.2, fund_weight: 0.8, qibao_weight: 1.6, atr_mult: 2.5, min_dims: 3, max_dims: 3 };
const variants = {
  '基准 (当前CFG)': base,
  'min_score 4.0→3.2 (-20%)': { ...base, min_score: 3.2 },
  'min_score 4.0→4.8 (+20%)': { ...base, min_score: 4.8 },
  'qibao_weight 1.6→1.28 (-20%)': { ...base, qibao_weight: 1.28 },
  'qibao_weight 1.6→1.92 (+20%)': { ...base, qibao_weight: 1.92 },
  'tech_weight 1.2→0.96 (-20%)': { ...base, tech_weight: 0.96 },
  'tech_weight 1.2→1.44 (+20%)': { ...base, tech_weight: 1.44 },
  'fund_weight 0.8→0.64 (-20%)': { ...base, fund_weight: 0.64 },
  'fund_weight 0.8→0.96 (+20%)': { ...base, fund_weight: 0.96 },
  'atr_mult 2.5→2.0 (-20%)': { ...base, atr_mult: 2.0 },
  'atr_mult 2.5→3.0 (+20%)': { ...base, atr_mult: 3.0 },
  'min_dims 3→2': { ...base, min_dims: 2 },
  'max_dims 3→4': { ...base, max_dims: 4 },
};
console.log('══════ 参数敏感性扫描 · 全量窗口 3-08→8-31 ══════');
console.log('变体'.padEnd(28), '笔数', '胜率', '盈亏', 'PF');
const results = [];
for (const [name, cfg] of Object.entries(variants)) {
  const r = runBT(cfg);
  results.push({ name, ...r });
  console.log(name.padEnd(28), r ? `${String(r.n).padStart(3)} ${String(r.wr).padStart(5)}% ${String(r.gross).padStart(9)}U ${String(r.pf).padStart(6)}` : 'ERR');
}
// 稳健性判定
const baseR = results[0];
const sane = results.slice(1).filter(r => r && r.n > 0);
const pnlArr = sane.map(r => r.gross);
const maxPnl = Math.max(...pnlArr), minPnl = Math.min(...pnlArr);
const spread = maxPnl - minPnl;
console.log('\n--- 稳健性判定 ---');
console.log(`基准: ${baseR.n}笔 ${baseR.wr}% ${baseR.gross}U PF${baseR.pf}`);
console.log(`扰动变体盈亏区间: [${minPnl.toFixed(1)}U, ${maxPnl.toFixed(1)}U] | 跨度 ${spread.toFixed(1)}U`);
const posCnt = pnlArr.filter(p => p > 0).length;
console.log(`盈利变体: ${posCnt}/${pnlArr.length}`);
console.log(posCnt >= pnlArr.length * 0.6 ? '✅ 相对稳健（多数扰动仍盈利，非参数峰值）' : '⚠️ 敏感（扰动即变差 → 参数峰值过拟合信号）');
