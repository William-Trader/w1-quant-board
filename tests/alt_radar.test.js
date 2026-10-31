// 山寨异动雷达纯函数测试（2026-10-31）
// 只测口径与不变量，不依赖数据库/网络。
const assert = require('assert');
const A = require('../lib/alt_radar');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  PASS', name); } catch (e) { failed++; console.error('  FAIL', name, '->', e.message); } }

console.log('== 山寨异动雷达测试 ==');

t('isAlt: 主流币/稳定币/代币化股票被排除', () => {
  assert.strictEqual(A.isAlt('BTC'), false);
  assert.strictEqual(A.isAlt('ETH'), false);
  assert.strictEqual(A.isAlt('USDT'), false);
  assert.strictEqual(A.isAlt('GOOGL'), false);
  assert.strictEqual(A.isAlt('SOXL'), false);
  assert.strictEqual(A.isAlt('USDBRL'), false);
  assert.strictEqual(A.isAlt('PEPE'), true);
  assert.strictEqual(A.isAlt('ONDO'), true);
});

t('retAt: 15m 收益率按 5min 序列回溯', () => {
  const now = 1000000;
  const series = [
    { ts: now - 900, price: 100 },
    { ts: now - 600, price: 101 },
    { ts: now - 300, price: 102 },
    { ts: now, price: 104 }
  ];
  const r = A.retAt(series, 900);
  assert.ok(Math.abs(r - 4) < 1e-9, 'expected +4%, got ' + r);
});

t('retAt: 样本不足返回 null', () => {
  assert.strictEqual(A.retAt([], 900), null);
  assert.strictEqual(A.retAt([{ ts: 1, price: 100 }], 900), null);
});

t('scoreAnomaly: 双触发才出信号，单触发不出', () => {
  const base = { symbol: 'PEPE', price: 1, chg24: 5, r15: 0.2, r1h: 0.3, r4h: 0.5, oi: 1e8, oiChg: 1, volChg: 5, fund: 0.001, taker: 1, liq24: 0, longLiq: 0, shortLiq: 0, lsrAcc: 1, lsrNotional: 1, lsrDelta30: 0, liquidity: 1e8, samples: 50 };
  assert.strictEqual(A.scoreAnomaly(base), null);
  const hot = Object.assign({}, base, { r15: 6, oiChg: 15, volChg: 80, fund: 0.07 });
  const s = A.scoreAnomaly(hot);
  assert.ok(s && s.score > 0);
  assert.ok(s.tags.includes('急涨15m'));
  assert.ok(s.tags.includes('增仓'));
  assert.ok(s.tags.includes('费率极端多'));
});

t('scoreAnomaly: 强单触发（15m≥5%）可单独出信号', () => {
  const m = { symbol: 'X', price: 1, r15: 5.5, r1h: null, r4h: null, oi: 1e8, oiChg: 0, volChg: 0, fund: 0, taker: null, liq24: 0, longLiq: 0, shortLiq: 0, lsrAcc: null, lsrNotional: null, liqNotional: 0, liquidity: 1e8, samples: 10 };
  const s = A.scoreAnomaly(m);
  assert.ok(s && s.score > 0);
});

t('hotScore: 流动性越高分数越高', () => {
  const small = { liquidity: 2e7, chg24: 1, oiChg: 1, volChg: 1 };
  const big = { liquidity: 4e9, chg24: 1, oiChg: 1, volChg: 1 };
  assert.ok(A.hotScore(big) > A.hotScore(small));
});

t('formatAnomaly: 包含币种、标签、评分', () => {
  const m = { symbol: 'ONDO', price: 1.234, r15: 3, r1h: 5, chg24: 8, oi: 5e7, oiChg: 12, volChg: 60, fund: 0.07, lsrAcc: 1.7, lsrNotional: 2.1, taker: 1.9, tags: ['急涨15m', '增仓'], score: 72, samples: 50 };
  const txt = A.formatAnomaly(m);
  assert.ok(txt.includes('ONDO'));
  assert.ok(txt.includes('评分 72'));
  assert.ok(txt.includes('急涨15m'));
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
