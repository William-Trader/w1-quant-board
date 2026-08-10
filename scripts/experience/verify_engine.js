// 验证统一引擎 vs 已存 50 场结果
const eng = require('/home/ubuntu/w1-board/lib/experience_engine');
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('public/experience.json', 'utf8'));
const results = d.results;
let ok = 0, warn = 0, fail = [];
const labelFix = {  // 原10场人工修正标签（历史口径，引擎分应一致但标签可能不同）
  '2025-08-31': '↘️ 谨慎看空','2025-12-31': '↗️ 谨慎看多',
  '2026-03-10': '🚀 强烈看多','2026-07-31': '↘️ 谨慎看空'
};
for (const r of results) {
  const freeze = new Date(r.date + 'T23:59:59+08:00').getTime();
  const a = eng.analyze(freeze);
  if (!a) { fail.push(`${r.date}: analyze 返回 null`); continue; }
  const j = eng.judge(a);
  // 对比分（允许 volr 口径微小差异 ±0.5）
  const scoreDiff = Math.abs(j.score - r.score);
  const posMatch = j.pos === r.pos;
  const dirMatch = (labelFix[r.date] ? labelFix[r.date].includes('多') === j.label.includes('多') && labelFix[r.date].includes('空') === j.label.includes('空') : j.label === r.label);
  // 重算 chg14/pnl 对比
  const chg14 = Math.round((a.price / r.price - 1) * 1000) / 10; // 同口径
  const pnlCalc = r.pos > 0 ? Math.round((r.label.includes('多') ? 1 : -1) * r.pos * (r.chg14 || 0) * 100) : 0;
  const cap = r.pos * 100;
  const pnlCap = pnlCalc < 0 ? Math.max(pnlCalc, -cap) : pnlCalc;
  const pnlMatch = r.pnl === pnlCap || (r.hit === null && r.pnl === 0);
  const status = scoreDiff <= 0.5 && posMatch && dirMatch && pnlMatch ? '✅' : '⚠️';
  if (status === '✅') ok++; else { warn++; fail.push(`${r.date}: 引擎score=${j.score} vs 存${r.score} | pos=${j.pos}vs${r.pos} | label=${j.label} vs ${r.label} | pnl引擎=${pnlCap} vs 存${r.pnl}`); }
}
console.log(`比对完成: ✅一致 ${ok} | ⚠️差异 ${warn} / ${results.length}`);
if (warn) { console.log('--- 差异明细 ---'); fail.forEach(f => console.log(' ', f)); }
