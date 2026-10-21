'use strict';
// TIANJI 进化影子监控 — 每日查看进化引擎状态
// 用法: node scripts/tianji_evo_monitor.js
const { openDb } = require('../lib/db');
const { evoStatus, loadEvo } = require('../lib/tianji_evo');
const db = openDb({ dataDir: './data' });
const evo = loadEvo(db);
const st = evoStatus(db);
console.log('══════ TIANJI 进化引擎状态 ══════');
console.log(`已结算样本 n=${st.n} | 门控阈值 ${st.minN} | 学习率 η=${st.eta}`);
console.log(`当前混合权重: ${JSON.stringify(st.mixedWeights)}`);
console.log('（门控期内 = 当前CFG，实盘行为与已验证基线一致）');
console.log('\n--- 专家影子战绩（晋升候选评估）---');
for (const e of st.experts) {
  const wr = e.perf.trades ? (e.perf.correct / e.perf.trades * 100).toFixed(1) : '—';
  console.log(`  ${e.name.padEnd(8)} 概率${(e.prob * 100).toFixed(1).padStart(5)}% | 影子 ${String(e.perf.trades).padStart(3)}笔 胜率${String(wr).padStart(5)}% 盈亏${e.perf.pnl >= 0 ? '+' : ''}${e.perf.pnl.toFixed(1)}U`);
}
console.log(`\n晋升记录: ${st.promotions ? st.promotions.length : 0} 次`);
if (st.promotions && st.promotions.length) st.promotions.forEach(p => console.log(`  ${p.ts} ${p.name}: 胜率${p.curWR}%→${p.newWR}%`));
console.log('\n判定: 任一专家影子≥30笔且胜率≥当前+5pp且盈亏>当前 → 自动晋升(先验→0.5)');
console.log('      当前样本不足 → 门控锁定，影子持续积累');
db.close();
