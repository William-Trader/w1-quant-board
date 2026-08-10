// lib/evalctx.js — WSL 求值上下文 + 函数库（从 engine.js 拆出）
'use strict';
const wsl = require('./wsl');
const { ema, sma, rsi, atr, adxCalc, zscoreArr } = require('./indicators');
function buildCtx(db, sym, tfs, regime, fundingZ, lsrZ, fgi, side, lsrData) {
  lsrData = lsrData || {};
  // tfs: {'1h': bars, '4h': bars, '1d': bars}
  const data = {};
  for (const [tf, bars] of Object.entries(tfs)) {
    const closes = bars.map(b => b.c);
    data[tf] = {
      bars, close: closes, high: bars.map(b => b.h), low: bars.map(b => b.l),
      open: bars.map(b => b.o), volume: bars.map(b => b.v),
      ema20: ema(closes, 20), ema50: ema(closes, 50),
      rsi14: rsi(closes, 14), atr14: atr(bars, 14), adx14: adxCalc(bars)
    };
  }
  const ctx = {
    funding_z30: fundingZ, lsr_z30: lsrZ, fgi: fgi || 50, regime, side, db, lsrData,
    getVar(name, i) {
      switch (name) {
        case 'funding_z30': return fundingZ;
        case 'lsr_z30': return lsrZ;
        case 'fgi': return fgi || 50;
        case 'regime': return regime;
        case 'side': return side;
        case 'lsr': case 'lsr_ratio': return lsrData.ratio != null ? lsrData.ratio : (lsrData.trader_ratio != null ? lsrData.trader_ratio : NaN);
        case 'lsr_delta_2m': return lsrData.delta_2m != null ? lsrData.delta_2m : (lsrData.trader_delta_2m != null ? lsrData.trader_delta_2m : NaN);
        case 'lsr_delta_4h': return lsrData.delta_4h != null ? lsrData.delta_4h : (lsrData.trader_delta_4h != null ? lsrData.trader_delta_4h : NaN);
        case 'whale_ratio': return lsrData.whale_ratio != null ? lsrData.whale_ratio : NaN;
        case 'whale_delta_2m': return lsrData.whale_delta_2m != null ? lsrData.whale_delta_2m : NaN;
        case 'lsr_notional': return (lsrData.long_notional != null && lsrData.short_notional != null) ? lsrData.long_notional - lsrData.short_notional : NaN;
        default: return getVarImpl(data, name, i);
      }
    },
    getTfVar(name, tf, i) { return getVarImpl(data, name, i, tf); },
    fn: FN,
    data
  };
  return ctx;
}
function getVarImpl(data, name, i, tf) {
  if (!tf) tf = '1h';
  const d = data[tf];
  if (!d) return NaN;
  const j = Math.min(i, d.close.length - 1);
  switch (name) {
    case 'close': return d.close[j];
    case 'high': return d.high[j];
    case 'low': return d.low[j];
    case 'open': return d.open[j];
    case 'volume': return d.volume[j];
    case 'ema20': return d.ema20[j];
    case 'ema50': return d.ema50[j];
    case 'rsi14': return d.rsi14[j];
    case 'adx14': return d.adx14[j];
    case 'atr14': return d.atr14[j];
    default: return NaN;
  }
}
const FN = {
  ema(ctx, args, i) {
    const n = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const a = ema(d.close, n); return a[Math.min(i, a.length - 1)];
  },
  sma(ctx, args, i) {
    const n = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const a = sma(d.close, n); return a[Math.min(i, a.length - 1)];
  },
  rsi(ctx, args, i) {
    const n = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const a = rsi(d.close, n); return a[Math.min(i, a.length - 1)];
  },
  adx(ctx, args, i) {
    const n = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const a = d.adx14 && n === 14 ? d.adx14 : adxCalc(d.bars, n); return a[Math.min(i, a.length - 1)];
  },
  atr(ctx, args, i) {
    const n = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const a = d.atr14 && n === 14 ? d.atr14 : atr(d.bars, n); return a[Math.min(i, a.length - 1)];
  },
  pct_change(ctx, args, i) {
    const bars = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const j = Math.min(i, d.close.length - 1);
    if (j < bars || d.close[j - bars] === 0) return NaN;
    return (d.close[j] / d.close[j - bars] - 1) * 100;
  },
  highest(ctx, args, i) {
    const n = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const j = Math.min(i, d.bars.length - 1);
    return Math.max(...d.bars.slice(Math.max(0, j - n + 1), j + 1).map(b => b.h));
  },
  lowest(ctx, args, i) {
    const n = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const j = Math.min(i, d.bars.length - 1);
    return Math.min(...d.bars.slice(Math.max(0, j - n + 1), j + 1).map(b => b.l));
  },
  ref(ctx, args, i) {
    // 正确语义：返回表达式在 i-n 根K线前的值（表达式自身可带 tf，如 highest(24,'4h')）
    // n=0 → 当前值；n 缺省 → 前 1 根
    const nArg = numArg(args[1]);
    const n = (isFinite(nArg) && nArg >= 0) ? nArg : 1;
    const j = i - n;
    if (j < 0) return NaN;
    return wsl.evaluate(args[0], ctx, j);
  },
  abs(ctx, args, i) { return Math.abs(wsl.evaluate(args[0], ctx, i)); },
  min(ctx, args, i) { return Math.min(wsl.evaluate(args[0], ctx, i), wsl.evaluate(args[1], ctx, i)); },
  max(ctx, args, i) { return Math.max(wsl.evaluate(args[0], ctx, i), wsl.evaluate(args[1], ctx, i)); },
  zscore(ctx, args, i) {
    const n = numArg(args[0]); const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const j = Math.min(i, d.close.length - 1);
    return zscoreArr(d.close.slice(Math.max(0, j - n + 1), j + 1));
  },
  cross_above(ctx, args, i) {
    const a = wsl.evaluate(args[0], ctx, i), b = wsl.evaluate(args[1], ctx, i);
    const aPrev = wsl.evaluate(args[0], ctx, i - 1), bPrev = wsl.evaluate(args[1], ctx, i - 1);
    return !!(a > b && aPrev <= bPrev);
  },
  cross_below(ctx, args, i) {
    const a = wsl.evaluate(args[0], ctx, i), b = wsl.evaluate(args[1], ctx, i);
    const aPrev = wsl.evaluate(args[0], ctx, i - 1), bPrev = wsl.evaluate(args[1], ctx, i - 1);
    return !!(a < b && aPrev >= bPrev);
  },
  extreme(ctx, args, i) {
    const n = numArg(args[0]); const side = ctx.side >= 0 ? 1 : -1;
    const tf = strArg(args[1]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const j = Math.min(i, d.bars.length - 1);
    const seg = d.bars.slice(Math.max(0, j - n + 1), j + 1);
    return side >= 0 ? Math.max(...seg.map(b => b.h)) : Math.min(...seg.map(b => b.l));
  },
  bb_width(ctx, args, i) {
    const n = numArg(args[0]) || 20; const k = numArg(args[1]) || 2; const tf = strArg(args[2]) || '1h';
    const d = ctxTF(ctx, tf); if (!d) return NaN; const j = Math.min(i, d.close.length - 1);
    if (j < n - 1) return NaN;
    const seg = d.close.slice(j - n + 1, j + 1);
    const m = seg.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / n);
    return sd === 0 ? 0 : (2 * k * sd) / d.close[j];
  }
};
function ctxTF(ctx, tf) {
  const d = ctx.data ? ctx.data[tf] : null;
  return d && d.close && d.close.length ? d : null;
}
function numArg(a) { return a && a.type === 'num' ? a.v : NaN; }
function strArg(a) { return a && a.type === 'str' ? a.v : null; }

module.exports = { buildCtx, FN };
