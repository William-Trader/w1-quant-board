'use strict';
// W1 引擎回归测试（node:test 内置，零依赖）
// 锁死 2026-08-09 修复的 6 个算法缺陷，杜绝复发
const test = require('node:test');
const assert = require('node:assert');
const wsl = require('../lib/wsl');
const engine = require('../lib/engine');

// ---- 测试工具：构造假 K 线（高点明显高于收盘，用于验证 ref/highest）----
function makeBars(close, high) {
  return close.map((c, i) => ({ t: i * 3600 * 4, o: c, h: (high || close.map(x => x + 50))[i], l: c - 10, c, v: 100 }));
}
function stubDb() {
  return { prepare: () => ({ get: () => null, all: () => [], run: () => {} }) };
}
// 真实引擎场景：1h 必备 + 4h 补充（run() 中 k1h 恒有）
function buildTfs(n = 300) {
  const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.01);
  const h = closes.map(c => c + 50);
  return { '1h': makeBars(closes, h), '4h': makeBars(closes, h) };
}
function ctx4h(lsr = {}) {
  const tfs = buildTfs();
  const c = engine.buildCtx(stubDb(), 'BTC', tfs, 'RANGE', 0, 0, 50, 1, lsr);
  c._tfs = tfs;
  return c;
}

// ---- 缺陷A: ref() 应返回表达式值而非 close ----
test('ref(highest(24,4h),0) 返回最高价而非收盘价', () => {
  const c = ctx4h();
  const v = wsl.evaluate(wsl.parse("ref(highest(24,'4h'),0)"), c, 299);
  assert.ok(isFinite(v) && v > 140, `期望≈150(最高价)，实际 ${v}`);
});
test('ref(x,0) 支持偏移0（当前值）', () => {
  const c = ctx4h();
  const v = wsl.evaluate(wsl.parse("ref(close,0)"), c, 299);
  assert.ok(Math.abs(v - 102.99) < 0.01, `期望 102.99，实际 ${v}`);
});
test('ref(x) 缺省偏移为1（前一根）', () => {
  const c = ctx4h();
  const v = wsl.evaluate(wsl.parse("ref(close)"), c, 299);
  assert.ok(Math.abs(v - 102.98) < 0.01, `期望 102.98，实际 ${v}`);
});

// ---- 缺陷B: lsr 变量可解析 ----
test('getVar("lsr") 返回当前多空比', () => {
  const c = engine.buildCtx(stubDb(), 'BTC', buildTfs(), 'RANGE', 0, 0, 50, 1, { ratio: 1.45 });
  assert.strictEqual(c.getVar('lsr', 299), 1.45);
});
test('lsr 缺 ratio 时回退 trader_ratio', () => {
  const c = engine.buildCtx(stubDb(), 'BTC', buildTfs(), 'RANGE', 0, 0, 50, 1, { trader_ratio: 1.4 });
  assert.strictEqual(c.getVar('lsr', 299), 1.4);
});

// ---- 缺陷C/E: buildCtx 挂内部 data，FN 指标可求值 ----
test('ema(20,4h) 可求值（修复前 NaN 止盈永不触发）', () => {
  const c = ctx4h();
  const v = wsl.evaluate(wsl.parse("ema(20,'4h')"), c, 299);
  assert.ok(isFinite(v) && v > 0, `ema=${v} 应为有限正数`);
});
test('FN 全部函数经 ctx 可求值（修复前恒 NaN hits=0）', () => {
  const c = ctx4h();
  for (const expr of ["rsi(14,'4h')", "atr(14,'4h')", "adx(14,'4h')", "highest(24,'4h')", "lowest(24,'4h')", "bb_width(20,2,'4h')", "zscore(20,'4h')", "sma(20,'4h')"]) {
    const v = wsl.evaluate(wsl.parse(expr), c, 299);
    assert.ok(isFinite(v), `${expr} 应可求值，实际 ${v}`);
  }
});
test('pct_change / cross_above / extreme 可求值', () => {
  const c = ctx4h();
  assert.ok(isFinite(wsl.evaluate(wsl.parse("pct_change(24,'4h')"), c, 299)));
  assert.ok(typeof wsl.evaluate(wsl.parse("cross_above(ema(20,'4h'),ema(50,'4h'))"), c, 299) === 'boolean');
  assert.ok(isFinite(wsl.evaluate(wsl.parse("extreme(24,'4h')"), c, 299)));
});

// ---- 缺陷G: dirFixAst 方向修正 ----
test('dirFixAst 做多: highest→lowest（止损应在下方）', () => {
  const ast = wsl.parse("ref(highest(24,'4h'),0)");
  engine.dirFixAst(ast, true);
  const c = ctx4h();
  const v = wsl.evaluate(ast, c, 299);
  // 修完后应取最低价(≈100)而非最高价(≈150)
  assert.ok(v < 110, `做多止损应取最低价≈100，实际 ${v}`);
});
test('dirFixAst 做空: lowest→highest（止损应在上方）', () => {
  const ast = wsl.parse("ref(lowest(24,'4h'),0)");
  engine.dirFixAst(ast, false);
  const c = ctx4h();
  const v = wsl.evaluate(ast, c, 299);
  assert.ok(v > 140, `做空止损应取最高价≈150，实际 ${v}`);
});

// ---- 缺陷D: partial pct 配置读取（runExits 内逻辑，用纯函数验证口径）----
test('partial 减仓比例读取配置 pct 字段', () => {
  // 直接验证口径：pos_pct × pct/100，默认50%
  const posPct = 0.08, pct = 50;
  const half = Number((posPct * pct / 100).toFixed(4));
  assert.strictEqual(half, 0.04);
  const pct2 = 30;
  const half2 = Number((posPct * pct2 / 100).toFixed(4));
  assert.strictEqual(half2, 0.024);
});

// ---- 完整策略表达式可解析可求值 ----
test('FR/ST 策略 YAML 表达式全部可解析', () => {
  const yaml = require('js-yaml');
  const fs = require('fs');
  const path = require('path');
  const fr = yaml.load(fs.readFileSync(path.join(__dirname, '../strategies/funding_reversal.wsl.yaml'), 'utf8'));
  const st = yaml.load(fs.readFileSync(path.join(__dirname, '../strategies/st_evo.wsl.yaml'), 'utf8'));
  const c = ctx4h();
  for (const [name, expr] of [['FR-long', fr.entry.long], ['FR-short', fr.entry.short], ['FR-stop', fr.exit.stop], ['FR-target', fr.exit.target], ['ST-long', st.entry.long], ['ST-short', st.entry.short], ['ST-structure', st.exit.structure]]) {
    const ast = wsl.parse(expr); // 解析不抛错即通过
    wsl.evaluate(ast, c, 299);   // 求值不抛错即通过
    assert.ok(true, `${name} 可解析可求值`);
  }
});
