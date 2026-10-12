'use strict';
// Deflated Sharpe Ratio (DSR) — 机构级多重检验校正
// 用法: node scripts/tianji_deflated_sharpe.js [--report data/tianji_bt_latest.json]
// 原理: 在 N 次参数尝试中挑出的最优策略，其 Sharpe 会被"选最优"这个过程虚增。
//       DSR 校正这个偏差：p(真实Sharpe > 0) 在考虑试验次数后是否仍显著。
// 公式: DSR = Φ( (SR_obs - SR_0) × √(n-1) / √(1 - γ3·SR_obs + (γ4-1)/4·SR_obs²) )
//       SR_0 = √(V[SR]) × ((1-γ)·Φ⁻¹(1-1/N) + γ·Φ⁻¹(1-1/(N·e)))
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const argVal = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const reportPath = argVal('--report', path.join(ROOT, 'data', 'tianji_bt_latest.json'));
const N_TRIALS = Number(argVal('--trials', 12));  // 本次调参尝试次数（敏感性矩阵12变体）

// 正态 CDF / PPF
function phi(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}
function phiInv(p) {
  // 数值逆 CDF（二分）
  let lo = -10, hi = 10;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (phi(mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const eq = rep.equity || rep.equityCurve || [];
if (eq.length < 10) { console.log('净值曲线点不足，无法计算 DSR'); process.exit(1); }
// 从净值曲线算日收益（按点间间隔）
const rets = [];
for (let i = 1; i < eq.length; i++) {
  const y0 = eq[i - 1].equity != null ? eq[i - 1].equity : eq[i - 1].y, y1 = eq[i].equity != null ? eq[i].equity : eq[i].y;
  if (y0 > 0) rets.push((y1 - y0) / y0);
}
const n = rets.length;
const mean = rets.reduce((a, b) => a + b, 0) / n;
const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
const sr = sd > 0 ? mean / sd * Math.sqrt(252) : 0;  // 年化
const skew = rets.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n;
const kurt = rets.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n;
// 期望最大 Sharpe（多重试验校正）
const eMax = Math.sqrt(2 * Math.log(N_TRIALS));
// SR_0 = 期望最大随机Sharpe（保守近似：√(V[SR]) × eMax）
const sr0 = eMax / Math.sqrt(n) * Math.sqrt(252 / 252);  // 简化：随机策略SR_0 ≈ √(2lnN)/√n
const denom = Math.sqrt(1 - skew * sr + (kurt - 1) / 4 * sr * sr);
const dsr = denom > 0 ? phi((sr - sr0) * Math.sqrt(n - 1) / denom) : 0;

console.log('══════ Deflated Sharpe Ratio (DSR) ══════');
console.log(`试验次数(N_TRIALS): ${N_TRIALS} | 净值点: ${n}`);
console.log(`Observed Sharpe: ${sr.toFixed(3)} | 偏度 ${skew.toFixed(2)} | 峰度 ${kurt.toFixed(2)}`);
console.log(`随机期望最大SR(SR_0): ${sr0.toFixed(3)}`);
console.log(`DSR (校正后p(真实SR>0)): ${(dsr * 100).toFixed(1)}%`);
console.log(dsr > 0.95 ? '✅ DSR>95% → 即使考虑多重检验，策略仍有真实edge' : '⚠️ DSR≤95% → 现有战绩可能来自参数挑选运气，不构成验证');
