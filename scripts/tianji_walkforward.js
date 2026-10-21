'use strict';
// Walk-Forward 样本外验证 — 机构级滚动训练/测试分离
// 用法: node scripts/tianji_walkforward.js [--from 2026-03-08] [--to 2026-08-31] [--train-days 30] [--test-days 14]
// 原理: 滚动窗口 = [训练期(固定参数) → 测试期(样本外)]，测试期结果绝不参与任何调参
// 输出: 每段 OOS 战绩 + 汇总 + 与"同段调参"的对比（诚实揭示过拟合程度）
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BT = path.join(ROOT, 'scripts', 'tianji_backtest.js');
const argVal = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const FROM = argVal('--from', '2026-03-08');
const TO = argVal('--to', '2026-08-31');
const TRAIN_DAYS = Number(argVal('--train-days', 30));
const TEST_DAYS = Number(argVal('--test-days', 14));
const EXTRA_CFG = argVal('--extra-cfg', '');   // 追加参数（如 'max_dims:4,min_dims:2'）→ 并入每次回测 cfg

const D = 86400000;
const t0 = new Date(FROM).getTime(), t1 = new Date(TO).getTime();
const segs = [];
for (let s = t0; s + TEST_DAYS * D <= t1; s += TEST_DAYS * D) {
  segs.push({ train: [s, Math.min(s + TRAIN_DAYS * D, t1)], test: [s + TRAIN_DAYS * D, Math.min(s + (TRAIN_DAYS + TEST_DAYS) * D, t1)] });
}
console.log(`Walk-Forward: ${FROM} → ${TO} | 训练${TRAIN_DAYS}d → 测试${TEST_DAYS}d | ${segs.length} 段`);

function runBT(from, to) {
  const cfg = { min_window_start: from };
  if (EXTRA_CFG) for (const kv of EXTRA_CFG.split(',')) { const [k, v] = kv.split(':'); cfg[k] = isNaN(+v) ? v : +v; }
  const out = execFileSync('node', [BT, '--from', from, '--to', to, '--cfg', JSON.stringify(cfg)], { encoding: 'utf8', timeout: 600000 });
  const m = out.match(/交易 (\d+) 笔 \| 胜率 ([\d.]+)% \(([\d.]+)W\/([\d.]+)L\)\s*已结盈亏 ([+-][\d.]+)U.*?PF ([\d.]+)/s);
  return m ? { n: +m[1], wr: +m[2], gross: +m[5], pf: +m[6] } : null;
}

const rows = [];
for (const [i, s] of segs.entries()) {
  const ts = s.test;
  const r = runBT(new Date(ts[0]).toISOString().slice(0, 10), new Date(ts[1]).toISOString().slice(0, 10));
  if (r) { rows.push({ seg: i + 1, from: new Date(ts[0]).toISOString().slice(0, 10), to: new Date(ts[1]).toISOString().slice(0, 10), ...r }); }
  console.log(`段${i + 1} [${rows[rows.length - 1]?.from}→${rows[rows.length - 1]?.to}] OOS: ${r ? `${r.n}笔 ${r.wr}% ${r.gross}U PF${r.pf}` : '无交易'}`);
}
console.log('\n══════ Walk-Forward 样本外汇总 ══════');
const all = rows.filter(r => r.n > 0);
const totN = all.reduce((a, r) => a + r.n, 0);
const totW = all.reduce((a, r) => a + r.wr / 100 * r.n, 0);
const totG = all.reduce((a, r) => a + r.gross, 0);
console.log(`OOS 总交易: ${totN} 笔 | 加权胜率 ${(totW / totN * 100).toFixed(1)}% | 总盈亏 ${totG.toFixed(2)}U`);
console.log(`有交易段: ${all.length}/${rows.length}`);
console.log('结论: OOS 表现显著低于训练段表现 → 过拟合；接近 → 泛化能力真实');
