// W1 核心引擎回归测试（2026-08-21）
// 纯函数、只读、不碰数据库/实盘/网络，可安全反复运行
// 运行: node --test tests/signal.core.test.js  或  node tests/signal.core.test.js
const assert = require('assert');
const {
  sma, atr, structLevels, trendFilter, bollinger, stopScale, fgiDiscount
} = require('../lib/signal');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { failed++; console.error('  ❌', name, '→', e.message); }
}

console.log('== W1 signal 核心纯函数回归测试 ==\n');

/* ---------- sma 简单移动平均 ---------- */
t('sma 正确计算最近 n 根均值', () => {
  assert.strictEqual(sma([1, 2, 3, 4, 5], 3), 4);          // (3+4+5)/3
  assert.strictEqual(sma([10, 20], 2), 15);
});
t('sma 数据不足返回 null', () => {
  assert.strictEqual(sma([1, 2], 3), null);
  assert.strictEqual(sma([], 3), null);
});

/* ---------- atr 平均真实波幅 ---------- */
t('atr 计算相邻差绝对值的均值', () => {
  // [10,12,14,11] → 相邻差 |12-10|=2,|14-12|=2,|11-14|=3 → 平均 2.333
  const a = atr([10, 12, 14, 11], 3);
  assert.ok(Math.abs(a - 2.3333) < 0.001, 'atr 应≈2.333');
});
t('atr 数据不足返回 null', () => {
  assert.strictEqual(atr([1, 2], 3), null);
  assert.strictEqual(atr([1], 14), null);
});

/* ---------- structLevels 结构高低点 ---------- */
t('structLevels 返回近 n 根高低点', () => {
  const lv = structLevels([5, 20, 3, 15, 10], 3);           // 近3根 [3,15,10]
  assert.strictEqual(lv.high, 15);
  assert.strictEqual(lv.low, 3);
});
t('structLevels 数据不足返回 null', () => {
  assert.strictEqual(structLevels([1], 20), null);
});

/* ---------- trendFilter 多级 SMA 趋势 ---------- */
t('trendFilter 上升趋势识别为 long', () => {
  const arr = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
  assert.strictEqual(trendFilter(arr), 'long');
});
t('trendFilter 下降趋势识别为 short', () => {
  const arr = Array.from({ length: 30 }, (_, i) => 300 - i * 2);
  assert.strictEqual(trendFilter(arr), 'short');
});
t('trendFilter 数据不足返回 neutral', () => {
  assert.strictEqual(trendFilter([1, 2, 3]), 'neutral');
  assert.strictEqual(trendFilter(null), 'neutral');
  assert.strictEqual(trendFilter(undefined), 'neutral');
});
t('trendFilter 振荡序列返回 neutral', () => {
  const arr = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
  assert.strictEqual(trendFilter(arr), 'neutral');
});

/* ---------- bollinger 布林带 ---------- */
t('bollinger 轨道顺序正确（upper>mid>lower）', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const b = bollinger(closes);
  assert.ok(b && b.upper > b.mid && b.mid > b.lower);
  assert.ok(b.widthPct > 0);
  assert.ok(b.pos >= 0 && b.pos <= 1, 'pos 应在 0~1');
});
t('bollinger 数据不足返回 null', () => {
  assert.strictEqual(bollinger([1, 2, 3]), null);
  assert.strictEqual(bollinger('bad'), null);
  assert.strictEqual(bollinger(null), null);
});
t('bollinger 平坦序列带宽≈0', () => {
  const closes = Array.from({ length: 30 }, () => 100);
  const b = bollinger(closes);
  assert.ok(Math.abs(b.widthPct) < 1e-6, '平坦序列带宽应≈0');
});

/* ---------- stopScale 波动率分档 ---------- */
t('stopScale 分档正确', () => {
  assert.strictEqual(stopScale(7), 1.7);   // >=6
  assert.strictEqual(stopScale(6), 1.7);
  assert.strictEqual(stopScale(4), 1.45);  // >=3
  assert.strictEqual(stopScale(2), 1.25);  // >=1.5
  assert.strictEqual(stopScale(1), 1);     // 默认
  assert.strictEqual(stopScale(0), 1);
});

/* ---------- fgiDiscount 恐慌贪婪折扣 ---------- */
t('fgiDiscount 极度恐惧 0.3 / 恐惧 0.5 / 偏恐惧 0.7 / 正常 1', () => {
  assert.strictEqual(fgiDiscount({ value: 15 }), 0.3);
  assert.strictEqual(fgiDiscount({ value: 25 }), 0.5);
  assert.strictEqual(fgiDiscount({ value: 40 }), 0.7);
  assert.strictEqual(fgiDiscount({ value: 50 }), 1);
  assert.strictEqual(fgiDiscount({ value: 85 }), 1);
});
t('fgiDiscount 空值返回 1（不折扣）', () => {
  assert.strictEqual(fgiDiscount(null), 1);
  assert.strictEqual(fgiDiscount(undefined), 1);
  assert.strictEqual(fgiDiscount({}), 1);
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
