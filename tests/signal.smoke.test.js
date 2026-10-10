// W1 信号引擎 smoke test (2026-08-12) - 纯函数, 只读, 不碰实盘/数据库
// 运行: node tests/signal.smoke.test.js
const assert = require('assert');
const { bollinger, trendFilter, stopScale, momentumCheck } = require('../lib/signal');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✅', name); }
  catch (e) { failed++; console.error('  ❌', name, '→', e.message); }
}

console.log('== W1 信号引擎 smoke test ==');

// 1. bollinger: 正常序列
t('bollinger 返回上/中/下轨', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 5);
  const b = bollinger(closes);
  assert.ok(b && b.upper > b.mid && b.mid > b.lower, '轨道顺序错误');
  assert.ok(b.widthPct > 0, '带宽应为正');
});

// 2. bollinger: 数据不足返回 null
t('bollinger 数据不足返回 null', () => {
  assert.strictEqual(bollinger([1, 2, 3]), null);
  assert.strictEqual(bollinger('bad'), null);
});

// 3. trendFilter: 上升趋势识别
t('trendFilter 上升排列=up', () => {
  const arr = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
  assert.strictEqual(trendFilter(arr), 'long');
});

// 4. trendFilter: 下降趋势识别
t('trendFilter 下降排列=down', () => {
  const arr = Array.from({ length: 20 }, (_, i) => 200 - i * 2);
  assert.strictEqual(trendFilter(arr), 'short');
});

// 5. trendFilter: 数据不足返回 neutral
t('trendFilter 数据不足=neutral', () => {
  assert.strictEqual(trendFilter([1, 2]), 'neutral');
  assert.strictEqual(trendFilter(null), 'neutral');
});

// 6. stopScale: 波动率分档
t('stopScale 波动率分档正确', () => {
  assert.strictEqual(stopScale(7), 1.7);   // >=6
  assert.strictEqual(stopScale(4), 1.45);  // >=3
  assert.strictEqual(stopScale(2), 1.25);  // >=1.5
  assert.strictEqual(stopScale(0.5), 1);   // 默认
});

// 7. momentumCheck: 数据不足返回 null (不崩)
t('momentumCheck 数据不足不崩', () => {
  const snaps = [];
  const r = momentumCheck({}, snaps, { current_price: 100 }, 'BTC', {}, 'neutral');
  assert.ok(r === null || typeof r === 'object', '应返回 null 或对象');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
