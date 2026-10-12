// W1 核心纯函数不变量测试（2026-10-12 · 工程化补强）
// 只测纯函数不变量（性质），不依赖数据库/网络/实盘，可安全反复运行。
const assert = require('assert');
const { sma, atr, bollinger, trendFilter, stopScale, fgiDiscount, structLevels } = require('../lib/signal');
const { ema, zscore, pctileRank } = require('../lib/regime');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  PASS', name); }
  catch (e) { failed++; console.error('  FAIL', name, '->', e.message); }
}

console.log('== W1 核心纯函数不变量测试 ==');

t('ema: 输出长度与输入一致，首元素等于首值', () => {
  const a = [1, 2, 3, 4, 5];
  const e = ema(a, 3);
  assert.strictEqual(e.length, a.length);
  assert.strictEqual(e[0], a[0]);
  assert.ok(e.every(x => Number.isFinite(x)));
});
t('ema: 常数序列输出恒等于该常数', () => {
  const e = ema([7, 7, 7, 7, 7], 3);
  assert.ok(e.every(x => Math.abs(x - 7) < 1e-9));
});
t('ema: 上升序列末值介于首末之间', () => {
  const a = [1, 2, 3, 4, 5];
  const e = ema(a, 3);
  assert.ok(e[e.length - 1] > a[0] && e[e.length - 1] < a[a.length - 1]);
});

t('zscore: 样本不足(<5)返回 0', () => {
  assert.strictEqual(zscore([1, 2, 3]), 0);
  assert.strictEqual(zscore([]), 0);
});
t('zscore: 常数序列返回 0（标准差为 0）', () => {
  assert.strictEqual(zscore([5, 5, 5, 5, 5, 5]), 0);
});
t('zscore: 最新值高于均值时为正', () => {
  assert.ok(zscore([1, 1, 1, 1, 1, 10]) > 0);
});

t('pctileRank: 样本不足(<20)返回 null', () => {
  assert.strictEqual(pctileRank([1, 2, 3]), null);
});
t('pctileRank: 递增序列末值为最大 -> 1', () => {
  const arr = Array.from({ length: 30 }, (_, i) => i);
  assert.strictEqual(pctileRank(arr), 1);
});
t('pctileRank: 递减序列末值为最小 -> 1/n', () => {
  const arr = Array.from({ length: 20 }, (_, i) => i).reverse();
  assert.ok(Math.abs(pctileRank(arr) - 1 / 20) < 1e-9);
});

t('structLevels: high >= low', () => {
  const lv = structLevels([5, 20, 3, 15, 10], 3);
  assert.ok(lv.high >= lv.low);
});

t('bollinger: upper>mid>lower 且 pos 在 [0,1]', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const b = bollinger(closes);
  assert.ok(b.upper > b.mid && b.mid > b.lower);
  assert.ok(b.pos >= 0 && b.pos <= 1);
});

t('stopScale: 波动率越高止损倍数非降', () => {
  assert.ok(stopScale(7) >= stopScale(4));
  assert.ok(stopScale(4) >= stopScale(1));
});
t('fgiDiscount: 越恐惧折扣越狠且不超过 1', () => {
  assert.ok(fgiDiscount({ value: 15 }) <= fgiDiscount({ value: 40 }));
  assert.ok(fgiDiscount({ value: 40 }) <= fgiDiscount({ value: 60 }));
  assert.ok(fgiDiscount({ value: 60 }) <= 1);
});

console.log('结果: ' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
