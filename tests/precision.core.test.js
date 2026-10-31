// W1 价格/多空比精度层纯函数测试（2026-10-31）
// 只测不变量，不依赖数据库/网络：口径公式必须可复算。
const assert = require('assert');
const P = require('../lib/precision');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  PASS', name); }
  catch (e) { failed++; console.error('  FAIL', name, '->', e.message); }
}

console.log('== W1 精度层纯函数测试 ==');

t('computeLsr: 持仓名义 = long_notional/short_notional', () => {
  const l = P.computeLsr({ symbol: 'BTCUSDT', long_notional: 200, short_notional: 100, long_traders: 300, short_traders: 100, whale_long_qty: 4, whale_short_qty: 2, ratio: 2 });
  assert.strictEqual(l.notional_lsr, 2);
  assert.strictEqual(l.account_lsr, 3);
  assert.strictEqual(l.whale_qty_lsr, 2);
  assert.strictEqual(l.vendor_ratio, 2);
  assert.ok(l.cross_check_pct < 1e-9);
});

t('computeLsr: 厂商 ratio 与重算不一致时给出 cross_check_pct', () => {
  const l = P.computeLsr({ symbol: 'ETHUSDT', long_notional: 150, short_notional: 100, ratio: 2 });
  assert.strictEqual(l.notional_lsr, 1.5);
  assert.ok(Math.abs(l.cross_check_pct - 25) < 1e-6);
});

t('computeLsr: 缺字段返回 null 而不是 NaN', () => {
  const l = P.computeLsr({ symbol: 'X' });
  assert.strictEqual(l.notional_lsr, null);
  assert.strictEqual(l.account_lsr, null);
  assert.strictEqual(l.whale_qty_lsr, null);
});

t('interpretLsr: 大单偏空 + 散户偏多 = 分歧', () => {
  const txt = P.interpretLsr({ notional_lsr: 0.5, account_lsr: 1.5 });
  assert.ok(txt.includes('分歧'));
  assert.ok(txt.includes('大单偏空'));
});

t('weightedPrice: 两源同价 → 偏差 0，置信 high', () => {
  const w = P.weightedPrice([
    { name: 'gate', price: 100, volume: 60, ts: 1000 },
    { name: 'coinglass', price: 100, volume: 40, ts: 1000 }
  ], 1000);
  assert.strictEqual(w.n, 2);
  assert.strictEqual(w.max_dev_pct, 0);
  assert.strictEqual(w.confidence, 'high');
  assert.ok(Math.abs(w.price - 100) < 1e-9);
});

t('weightedPrice: 单源权重不超过 60%', () => {
  const w = P.weightedPrice([
    { name: 'a', price: 100, volume: 999, ts: 1000 },
    { name: 'b', price: 100, volume: 1, ts: 1000 }
  ], 1000);
  assert.ok(w.weights.every(x => x.weight <= 0.6001));
});

t('weightedPrice: 异常源被质量分 0 剔除', () => {
  const w = P.weightedPrice([
    { name: 'good', price: 100, volume: 50, ts: 1000 },
    { name: 'bad', price: 110, volume: 50, ts: 1000 }
  ], 1000);
  // 10% 偏离 > 1% → 质量 0，权重由 good 独占（受 60% 上限后仍应接近 100）
  assert.ok(w.price < 100.01, '加权价应贴近正常源，实际 ' + w.price);
});

t('qualityOf: 分档边界', () => {
  assert.strictEqual(P.qualityOf(0), 1);
  assert.strictEqual(P.qualityOf(0.3), 1);
  assert.strictEqual(P.qualityOf(0.31), 0.25);
  assert.strictEqual(P.qualityOf(1), 0.25);
  assert.strictEqual(P.qualityOf(1.01), 0);
});

t('pctDiff: 正负号正确', () => {
  assert.strictEqual(P.pctDiff(101, 100), 1);
  assert.strictEqual(P.pctDiff(99, 100), -1);
  assert.strictEqual(P.pctDiff(1, 0), null);
});

console.log(`\n结果: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
