'use strict';
// 置换检验（Permutation Test）— 机构级统计显著性验证
// 用法: node scripts/tianji_permutation.js [--report data/tianji_bt_latest.json] [--n 5000]
// 原理: 对回测交易收益序列做符号置换（随机翻转盈亏）+ bootstrap 重抽，
//       统计"随机运气下达到或超过真实战绩"的概率 → p-value
// 判定: p<0.05 统计显著 | p<0.01 高度显著 | p>=0.05 样本量不足/不显著
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argVal = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const reportPath = argVal('--report', path.join(ROOT, 'data', 'tianji_bt_latest.json'));
const N = Number(argVal('--n', 5000));

const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const trades = (rep.trades || []).filter(t => t.status === 'WIN' || t.status === 'LOSS');
const n = trades.length;
if (!n) { console.log('无已结算交易，无法检验'); process.exit(1); }

const pnls = trades.map(t => Number(t.pnlUsd || 0));
const wins = pnls.filter(p => p > 0).length;
const winRate = wins / n;
const totalPnl = pnls.reduce((a, b) => a + b, 0);
const realPF = (() => {
  const g = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const l = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  return l > 0 ? g / l : null;
})();

// ── 检验1: 符号置换（Sign-flip permutation）──
// 原假设: 信号无信息，盈亏方向随机。翻转随机子集的符号，重算胜率/总盈亏
let cntWR = 0, cntPnl = 0, cntPF = 0;
for (let i = 0; i < N; i++) {
  const perm = pnls.map(p => (Math.random() < 0.5 ? p : -p));
  const w = perm.filter(p => p > 0).length / n;
  const tp = perm.reduce((a, b) => a + b, 0);
  const g = perm.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const l = Math.abs(perm.filter(p => p < 0).reduce((a, b) => a + b, 0));
  const pf = l > 0 ? g / l : null;
  if (w >= winRate) cntWR++;
  if (tp >= totalPnl) cntPnl++;
  if (pf != null && realPF != null && pf >= realPF) cntPF++;
}
const pWR = cntWR / N, pPnl = cntPnl / N, pPF = cntPF / N;

// ── 检验2: Bootstrap 95% CI（有放回重抽收益序列）──
const bsWins = [], bsPnl = [];
for (let i = 0; i < N; i++) {
  const sample = Array.from({ length: n }, () => pnls[Math.floor(Math.random() * n)]);
  bsWins.push(sample.filter(p => p > 0).length / n);
  bsPnl.push(sample.reduce((a, b) => a + b, 0));
}
bsWins.sort((a, b) => a - b); bsPnl.sort((a, b) => a - b);
const ci = (arr) => [arr[Math.floor(N * 0.025)], arr[Math.floor(N * 0.975)]];

console.log('══════ 置换检验 · 统计显著性 ══════');
console.log(`样本: ${n} 笔已结算 (${wins}W/${n - wins}L) | 胜率 ${(winRate * 100).toFixed(1)}% | 总盈亏 +${totalPnl.toFixed(2)}U | PF ${realPF ? realPF.toFixed(2) : '∞'}`);
console.log(`报告: ${rep.builtAt} | 窗口: ${rep.window ? rep.window.start.slice(0, 10) : '?'} → ${rep.window ? rep.window.end.slice(0, 10) : '?'}`);
console.log('--- 检验1: 符号置换（原假设=信号无信息）---');
console.log(`p(胜率≥${(winRate * 100).toFixed(0)}% | 随机) = ${pWR.toFixed(4)}`);
console.log(`p(总盈亏≥+${totalPnl.toFixed(0)}U | 随机) = ${pPnl.toFixed(4)}`);
console.log(`p(PF≥${realPF ? realPF.toFixed(1) : '∞'} | 随机) = ${pPF.toFixed(4)}`);
console.log('--- 检验2: Bootstrap 95% CI ---');
console.log(`胜率 95%CI: [${(ci(bsWins)[0] * 100).toFixed(1)}%, ${(ci(bsWins)[1] * 100).toFixed(1)}%]`);
console.log(`总盈亏 95%CI: [${ci(bsPnl)[0].toFixed(2)}U, ${ci(bsPnl)[1].toFixed(2)}U]`);
const verdict = pPnl < 0.05 ? '✅ 统计显著（p<0.05，非运气）' : '⚠️ 不显著（样本量不足，尚不能证明优于随机）';
console.log(`判定: ${verdict}`);
console.log('说明: 机构标准要求 p<0.05 且样本≥30；当前样本<30 时即使 p 小也要谨慎解读');
