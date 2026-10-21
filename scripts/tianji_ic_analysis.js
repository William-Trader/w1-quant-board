'use strict';
// TIANJI 因子 IC 检验 v2 — 机构级：验证每维是否真有预测力（edge）
// 数据源: 回测报告 JSON（data/tianji_bt_latest.json 或参数指定）
// 方法: ① Spearman 秩相关（IC） ② 分层胜率（正分/负分样本对比）
// 判定: |IC|≥0.03 且样本≥30 才有初步 edge；IC 接近 0 = 该维度是噪声
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const reportPath = process.argv[2] || path.join(ROOT, 'data', 'tianji_bt_latest.json');

const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const trades = (rep.trades || []).filter(t => t.status === 'WIN' || t.status === 'LOSS');
const n = trades.length;

const DIMS = ['news', 'tech', 'fund', 'con', 'qib'];
const NAMES = { news: '消息面', tech: '技术面', fund: '资金面', con: 'KOL共识', qib: '清算技术' };

function spearman(xs, ys) {
  const nn = xs.length;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(nn);
    for (let i = 0; i < nn; i++) {
      let j = i;
      while (j + 1 < nn && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / nn, my = ry.reduce((a, b) => a + b, 0) / nn;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < nn; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx * dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

console.log(`样本: ${n} 笔已结算 (${trades.filter(t => t.status === 'WIN').length}W/${trades.filter(t => t.status === 'LOSS').length}L)`);
console.log(`数据源: ${reportPath}\n`);
console.log('维度      | 样本 | IC(秩相关) | 正分胜率 | 负分胜率 | 分层差 | 判定');
for (const d of DIMS) {
  const vals = trades.map(t => Number(t[d] || 0));
  const pnls = trades.map(t => Number(t.pnlUsd || 0));
  if (n < 30) { console.log(`${NAMES[d].padEnd(8)} | ${String(n).padStart(4)} | 样本不足，跳过`); continue; }
  const ic = spearman(vals, pnls);
  const pos = trades.filter(t => Number(t[d] || 0) > 0.3);
  const neg = trades.filter(t => Number(t[d] || 0) < -0.3);
  const posWR = pos.length ? pos.filter(t => t.status === 'WIN').length / pos.length * 100 : null;
  const negWR = neg.length ? neg.filter(t => t.status === 'WIN').length / neg.length * 100 : null;
  const diff = posWR != null && negWR != null ? posWR - negWR : null;
  const edge = Math.abs(ic) >= 0.03 && diff != null && diff >= 10;
  console.log(`${NAMES[d].padEnd(8)} | ${String(n).padStart(4)} | ${ic.toFixed(3).padStart(9)} | ${posWR != null ? posWR.toFixed(1) + '%' : '—'.padStart(4)} | ${negWR != null ? negWR.toFixed(1) + '%' : '—'.padStart(4)} | ${diff != null ? diff.toFixed(1) + 'pp' : '—'.padStart(4)} | ${edge ? '✅ 有edge' : (Math.abs(ic) < 0.03 ? '⚠️ 噪声' : '弱')}`);
}
console.log('\n说明: IC=信号得分与未来收益的秩相关；正分胜率应显著高于负分胜率才算有预测力');
