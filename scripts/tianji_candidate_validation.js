'use strict';
// 候选专家双验证 — 机构级进化准入门槛
// 用法: node scripts/tianji_candidate_validation.js
// 对跑赢基准的候选权重做:
//   ① Walk-forward OOS 验证（滚动分段，候选权重固定，看样本外是否稳定跑赢）
//   ② 与基准的配对对比（同段同口径）
// 通过 → 可提升先验；不通过 → 判定为小样本运气，保持当前CFG锁定
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const BT = path.join(ROOT, 'scripts', 'tianji_backtest.js');
const CANDIDATES = [
  { id: 'e_current', name: '当前CFG', w: { macro_weight: 0.2, tech_weight: 1.2, fund_weight: 0.8, con_weight: 0.3, qibao_weight: 1.6 } },
  { id: 'e_conserv', name: '保守', w: { macro_weight: 0.2, tech_weight: 0.8, fund_weight: 0.8, con_weight: 0.3, qibao_weight: 1.2 } },
  { id: 'e_equal',   name: '五维等权', w: { macro_weight: 0.82, tech_weight: 0.82, fund_weight: 0.82, con_weight: 0.82, qibao_weight: 0.82 } },
];
function runBT(cfg, from, to) {
  try {
    const out = execFileSync('node', [BT, '--from', from, '--to', to, '--cfg', JSON.stringify({ min_window_start: from, ...cfg })], { encoding: 'utf8', timeout: 600000 });
    const m = out.match(/交易 (\d+) 笔 \| 胜率 ([\d.]+)% \(([\d.]+)W\/([\d.]+)L\)\s*已结盈亏 ([+-][\d.]+)U.*?PF ([\d.]+)/s);
    return m ? { n: +m[1], wr: +m[2], gross: +m[5], pf: +m[6] } : { n: 0, wr: 0, gross: 0, pf: 0 };
  } catch (e) { return { n: 0, wr: 0, gross: 0, pf: 0 }; }
}
const D = 86400000;
const t0 = new Date('2026-04-01').getTime(), t1 = new Date('2026-08-31').getTime();
const segs = [];
for (let s = t0; s + 45 * D <= t1; s += 45 * D) {
  segs.push([s, Math.min(s + 45 * D, t1)]);
}
console.log('══════ 候选专家 Walk-Forward OOS 验证 ══════');
console.log(`分段: ${segs.length} 段 × 45天（4/1→8/31）\n`);
const acc = {};
for (const [i, seg] of segs.entries()) {
  const from = new Date(seg[0]).toISOString().slice(0, 10), to = new Date(seg[1]).toISOString().slice(0, 10);
  const line = [`段${i + 1} [${from}→${to}]`];
  for (const c of CANDIDATES) {
    const r = runBT(c.w, from, to);
    if (!acc[c.id]) acc[c.id] = { n: 0, w: 0, gross: 0, pfSum: 0, segs: 0 };
    acc[c.id].n += r.n; acc[c.id].w += r.wr / 100 * r.n; acc[c.id].gross += r.gross;
    if (r.pf > 0) { acc[c.id].pfSum += r.pf; acc[c.id].segs++; }
    line.push(`${c.name}: ${r.n}笔 ${r.wr}% ${r.gross}U PF${r.pf}`);
  }
  console.log(line.join(' | '));
}
console.log('\n--- 汇总（OOS 全段累加）---');
for (const c of CANDIDATES) {
  const a = acc[c.id];
  console.log(`${c.name.padEnd(10)}: ${a.n}笔 | 加权胜率 ${(a.w / Math.max(a.n, 1) * 100).toFixed(1)}% | 总盈亏 ${a.gross.toFixed(2)}U | 平均PF ${(a.pfSum / Math.max(a.segs, 1)).toFixed(2)}`);
}
const base = acc['e_current'], cons = acc['e_conserv'], eq = acc['e_equal'];
console.log('\n--- 判定 ---');
console.log(`保守 vs 基准: ${cons.gross > base.gross ? '跑赢 +' + (cons.gross - base.gross).toFixed(1) + 'U' : '跑输 ' + (base.gross - cons.gross).toFixed(1) + 'U'}`);
console.log(`等权 vs 基准: ${eq.gross > base.gross ? '跑赢 +' + (eq.gross - base.gross).toFixed(1) + 'U' : '跑输 ' + (base.gross - eq.gross).toFixed(1) + 'U'}`);
console.log('结论: 仅在 OOS 多段稳定跑赢基准的候选才有资格进化；单段/全段样本<30 一律判定样本不足');
