'use strict';
// 专家池影子评估 — 机构级进化依据
// 用法: node scripts/tianji_expert_pool.js
// 原理: 8 组候选权重各自独立跑全量历史回测（同窗口/同成本/同门控），
//       输出对比表。跑赢当前CFG(e_current)的候选 → 可进化为影子权重候选；
//       全部跑不赢 → 进化门控保持锁定（当前CFG是最优先验）。
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const BT = path.join(ROOT, 'scripts', 'tianji_backtest.js');
const EXPERTS = [
  { id: 'e_current', name: '当前CFG', w: { macro_weight: 0.2, tech_weight: 1.2, fund_weight: 0.8, con_weight: 0.3, qibao_weight: 1.6 } },
  { id: 'e_tech',    name: '技术主导', w: { macro_weight: 0.2, tech_weight: 1.6, fund_weight: 0.6, con_weight: 0.2, qibao_weight: 1.4 } },
  { id: 'e_qib',     name: '清算主导', w: { macro_weight: 0.1, tech_weight: 1.0, fund_weight: 0.6, con_weight: 0.2, qibao_weight: 2.0 } },
  { id: 'e_balance', name: '均衡',     w: { macro_weight: 0.5, tech_weight: 1.0, fund_weight: 1.0, con_weight: 0.5, qibao_weight: 1.0 } },
  { id: 'e_conserv', name: '保守',     w: { macro_weight: 0.2, tech_weight: 0.8, fund_weight: 0.8, con_weight: 0.3, qibao_weight: 1.2 } },
  { id: 'e_fund',    name: '资金主导', w: { macro_weight: 0.2, tech_weight: 0.8, fund_weight: 1.4, con_weight: 0.3, qibao_weight: 1.4 } },
  { id: 'e_news',    name: '消息增强', w: { macro_weight: 0.8, tech_weight: 1.0, fund_weight: 0.8, con_weight: 0.5, qibao_weight: 1.2 } },
  { id: 'e_equal',   name: '五维等权', w: { macro_weight: 0.82, tech_weight: 0.82, fund_weight: 0.82, con_weight: 0.82, qibao_weight: 0.82 } },
];
function runBT(cfg) {
  try {
    const out = execFileSync('node', [BT, '--from', '2026-03-08', '--to', '2026-08-31', '--cfg', JSON.stringify({ min_window_start: '2026-03-08', ...cfg })], { encoding: 'utf8', timeout: 600000 });
    const m = out.match(/交易 (\d+) 笔 \| 胜率 ([\d.]+)% \(([\d.]+)W\/([\d.]+)L\)\s*已结盈亏 ([+-][\d.]+)U.*?PF ([\d.]+)/s);
    const dd = out.match(/最大回撤 ([\d.]+)%/);
    return m ? { n: +m[1], wr: +m[2], w: +m[3], l: +m[4], gross: +m[5], pf: +m[6], dd: dd ? +dd[1] : null } : null;
  } catch (e) { return null; }
}
console.log('══════ 专家池影子评估 · 全量 3-08→8-31 ══════');
console.log('专家'.padEnd(12), '笔数', '胜率', '盈亏', 'PF', '回撤');
const rows = [];
for (const e of EXPERTS) {
  const r = runBT(e.w);
  rows.push({ ...e, ...r });
  console.log(e.name.padEnd(12), r ? `${String(r.n).padStart(4)} ${String(r.wr).padStart(6)}% ${String(r.gross).padStart(9)}U ${String(r.pf).padStart(6)} ${r.dd != null ? r.dd.toFixed(1) + '%' : '—'}` : 'ERR');
}
const base = rows[0];
const better = rows.slice(1).filter(r => r && r.gross > base.gross && r.pf > base.pf);
console.log('\n--- 判定 ---');
console.log(`基准 e_current: ${base.n}笔 ${base.wr}% ${base.gross}U PF${base.pf}`);
console.log(`跑赢基准的专家: ${better.length ? better.map(b => b.name + '(' + b.gross + 'U/PF' + b.pf + ')').join(', ') : '无'}`);
console.log(better.length ? '✅ 存在候选专家 → 可进化为影子权重（需 walk-forward + 显著性双验证后切换）' : '⚠️ 无一跑赢 → 当前CFG为最优先验，进化门控保持锁定（默认=当前CFG，样本不足不学习）');
