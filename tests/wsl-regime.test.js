'use strict';
// WSL 表达式语言 + 体制分类器 回归测试
const test = require('node:test');
const assert = require('node:assert');
const wsl = require('../lib/wsl');
const regime = require('../lib/regime');

// ---------- WSL 解析器 ----------
test('wsl 算术优先级: 1+2*3=7', () => {
  assert.strictEqual(wsl.evaluate(wsl.parse('1+2*3'), null, 0), 7);
});
test('wsl 括号: (1+2)*3=9', () => {
  assert.strictEqual(wsl.evaluate(wsl.parse('(1+2)*3'), null, 0), 9);
});
test('wsl 比较链: 3>2 and 2>1', () => {
  assert.strictEqual(wsl.evaluate(wsl.parse('3>2 and 2>1'), null, 0), true);
});
test('wsl or/not 逻辑', () => {
  assert.strictEqual(wsl.evaluate(wsl.parse('1>2 or 2>1'), null, 0), true);
  assert.strictEqual(wsl.evaluate(wsl.parse('not 1>2'), null, 0), true);
});
test('wsl 字符串字面量', () => {
  assert.strictEqual(wsl.evaluate(wsl.parse("'hello'"), null, 0), 'hello');
  assert.strictEqual(wsl.evaluate(wsl.parse('"world"'), null, 0), 'world');
});
test('wsl 除零返回 NaN 不抛错', () => {
  assert.ok(Number.isNaN(wsl.evaluate(wsl.parse('1/0'), null, 0)));
});
test('wsl 变量求值走 ctx.getVar', () => {
  const ctx = { getVar: (n) => n === 'close' ? 100 : NaN, getTfVar: () => NaN, fn: {} };
  assert.strictEqual(wsl.evaluate(wsl.parse('close'), ctx, 5), 100);
});
test('wsl 跨周期简写 close_1d', () => {
  const ctx = { getVar: () => NaN, getTfVar: (name, tf) => (name === 'close' && tf === '1d') ? 200 : NaN, fn: {} };
  assert.strictEqual(wsl.evaluate(wsl.parse('close_1d'), ctx, 5), 200);
});
test('wsl 函数调用 + 参数', () => {
  const ctx = { getVar: () => NaN, getTfVar: () => NaN, fn: { max: (c, args, i) => Math.max(args[0].v, args[1].v) } };
  assert.strictEqual(wsl.evaluate(wsl.parse('max(3,7)'), ctx, 0), 7);
});
test('wsl 语法错误抛异常', () => {
  assert.throws(() => wsl.parse('1 +'));
  assert.throws(() => wsl.parse('(1+2'));
  assert.throws(() => wsl.parse('close @ 3'));
});
test('wsl 未知函数抛异常', () => {
  const ctx = { getVar: () => NaN, getTfVar: () => NaN, fn: {} };
  assert.throws(() => wsl.evaluate(wsl.parse('nosuchfn(1)'), ctx, 0));
});

// ---------- 体制分类器（纯函数） ----------
function mkBars(closes, mult = 1) {
  return closes.map((c, i) => ({ t: i * 86400, o: c, h: c * (1 + 0.01 * mult), l: c * (1 - 0.01 * mult), c, v: 100 }));
}
test('regime.adxCalc: 强趋势序列 ADX 高', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
  const bars = closes.map((c, i) => ({ t: i * 86400, o: c - 1, h: c + 2, l: c - 2, c, v: 100 }));
  const A = regime.adxCalc(bars);
  const last = A[A.length - 1];
  assert.ok(last > 20, `强趋势 ADX 应>20，实际 ${last.toFixed(1)}`);
});
test('regime.adxCalc: 震荡序列 ADX 低', () => {
  // 高频剧烈震荡（周期1.5根K线、振幅±3）——低频正弦波会被 ADX 误判为弱趋势
  let v = 100;
  const closes = [];
  for (let i = 0; i < 60; i++) { v += Math.sin(i / 1.5) * 3; closes.push(v); }
  const bars = closes.map((c, i) => ({ t: i * 86400, o: c - 0.5, h: c + 3.5, l: c - 3.5, c, v: 100 }));
  const A = regime.adxCalc(bars);
  const last = A[A.length - 1];
  assert.ok(last < 20, `震荡 ADX 应<20，实际 ${last.toFixed(1)}`);
});
test('regime.ema: 单调递增序列 EMA 跟随', () => {
  const arr = Array.from({ length: 30 }, (_, i) => 100 + i);
  const e = regime.ema(arr, 20);
  assert.ok(e[e.length - 1] > 110 && e[e.length - 1] < 130, `EMA 应在区间内，实际 ${e[e.length - 1]}`);
});
test('regime.zscore: 末值高于均值 → 正 z', () => {
  const arr = [1, 1, 1, 1, 1, 1, 1, 1, 1, 5];
  const z = regime.zscore(arr);
  assert.ok(z > 1, `z 应>1，实际 ${z}`);
});
test('regime.zscore: 常数序列 → 0', () => {
  assert.strictEqual(regime.zscore([3, 3, 3, 3, 3, 3]), 0);
});
test('regime.zscore: 短序列(<5) → 0', () => {
  assert.strictEqual(regime.zscore([1, 2, 3]), 0);
});
test('regime.pctileRank: 末值为最大值 → 1.0', () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const r = regime.pctileRank(arr);
  assert.strictEqual(r, 1);
});
test('regime.pctileRank: 短序列(<20) → null', () => {
  assert.strictEqual(regime.pctileRank([1, 2, 3]), null);
});
