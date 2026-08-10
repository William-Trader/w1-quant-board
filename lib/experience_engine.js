'use strict';
// ============================================================
// W1 统一信号引擎 v1.0（2026-08-10 William 老板指令）
// 指标战绩（历史回测）与交易信号（实盘）共用此引擎
// 移植自 scripts/experience/blind_engine.py（v3.1 信号评分），保证同分同判
//   历史模式: analyze(freezeTs) + judge(a) → 与 50 场已存结果逐一比对验证
//   实盘模式: analyze(now) + judge(a) + buildOrder() → 开单写入 signal_track
// 纪律: 只用截止时点数据（冻结时间，严禁未来函数）
// ============================================================
const path = require('path');
const Database = require('better-sqlite3');

const HIST_DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const LEVER = 100;
const PRINCIPAL = 10000;

let _hist = null;
function histDb() {
  if (!_hist) _hist = new Database(HIST_DB, { readonly: true });
  return _hist;
}

/* ---------------- 指标计算（与 blind_engine.py 完全一致） ---------------- */
function sma(vals, n) {
  if (vals.length < n) return null;
  return vals.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function rsiOf(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg >= 0) g += chg; else l -= chg;
  }
  if (l === 0) return 100.0;
  return 100 - 100 / (1 + (g / n) / (l / n));
}
function macdOf(closes, f = 12, s = 26, sig = 9) {
  if (closes.length < s + sig) return [null, null, null];
  const ema = (v, n) => { const k = 2 / (n + 1); let e = v[0]; const out = [e]; for (let i = 1; i < v.length; i++) { e = v[i] * k + e * (1 - k); out.push(e); } return out; };
  const ef = ema(closes, f), es = ema(closes, s);
  const dif = ef.map((a, i) => a - es[i]);
  const dea = ema(dif, sig);
  return [dif[dif.length - 1], dea[dea.length - 1], (dif[dif.length - 1] - dea[dea.length - 1]) * 2];
}
function bollOf(closes, n = 20) {
  if (closes.length < n) return [null, null, null];
  const seg = closes.slice(-n);
  const mid = seg.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(seg.reduce((a, x) => a + (x - mid) ** 2, 0) / n);
  return [mid + 2 * sd, mid, mid - 2 * sd];
}

/* ---------------- analyze(freezeTsMs)：只用 < freezeTsMs 的数据 ---------------- */
function analyze(freezeTsMs) {
  const db = histDb();
  const rows = db.prepare(`
    SELECT date(ts/1000,'unixepoch','+8 hours') d, MIN(o) o, MAX(h) h, MIN(l) l,
           (SELECT c FROM klines k2 WHERE k2.symbol=k1.symbol AND k2.ts=(SELECT MAX(ts) FROM klines k3 WHERE k3.symbol=k1.symbol AND date(k3.ts/1000,'unixepoch','+8 hours')=date(k1.ts/1000,'unixepoch','+8 hours'))) c,
           SUM(v) v
    FROM klines k1 WHERE symbol='BTCUSDT' AND ts < ? GROUP BY d ORDER BY d
  `).all(freezeTsMs);
  if (rows.length < 40) return null;
  const closes = rows.map(r => r.c);
  const last = rows[rows.length - 1];
  const price = last.c;
  const r = rsiOf(closes);
  const [, , hist] = macdOf(closes);
  const s7 = sma(closes, 7), s25 = sma(closes, 25), s99 = sma(closes, 99);
  const [bu, , bl] = bollOf(closes);
  const mom5 = closes.length >= 6 ? (price / closes[closes.length - 6] - 1) * 100 : null;
  const mom20 = closes.length >= 21 ? (price / closes[closes.length - 21] - 1) * 100 : null;
  const lo20 = Math.min(...closes.slice(-20)), hi20 = Math.max(...closes.slice(-20));
  const pos20 = hi20 > lo20 ? (price - lo20) / (hi20 - lo20) * 100 : 50;
  const v5rows = rows.slice(-6, -1);
  const v5 = v5rows.length >= 5 ? v5rows.reduce((a, b) => a + b.v, 0) / 5 : (last.v || 0);
  const volr = v5 ? last.v / v5 : 1.0;
  const fgiRow = db.prepare('SELECT value FROM fgi WHERE ts < ? ORDER BY ts DESC LIMIT 1').get(Math.floor(freezeTsMs / 1000));
  const fndRow = db.prepare('SELECT rate FROM funding WHERE ts < ? ORDER BY ts DESC LIMIT 1').get(freezeTsMs);
  return {
    date: last.d, price, rsi: r, macd_hist: hist,
    s7, s25, s99, boll_up: bu, boll_lo: bl,
    mom5, mom20, pos20, volr,
    fgi: fgiRow ? fgiRow.value : null,
    funding: fndRow ? fndRow.rate : null,
  };
}

/* ---------------- judge(a)：v3.1 信号评分 → 方向 + 仓位 + 理由 ---------------- */
function judge(a) {
  if (!a) return null;
  let score = 0; const reasons = [];
  const p = a.price;
  if (a.rsi !== null && a.rsi !== undefined) {
    if (a.rsi < 25) { score += 2.0; reasons.push(`RSI ${a.rsi.toFixed(0)} 严重超卖 +2.0`); }
    else if (a.rsi < 30) { score += 1.5; reasons.push(`RSI ${a.rsi.toFixed(0)} 超卖 +1.5`); }
    else if (a.rsi > 80) { score -= 2.0; reasons.push(`RSI ${a.rsi.toFixed(0)} 严重超买 -2.0`); }
    else if (a.rsi > 70) { score -= 1.5; reasons.push(`RSI ${a.rsi.toFixed(0)} 超买 -1.5`); }
  }
  if (a.macd_hist !== null && a.macd_hist !== undefined) {
    if (a.macd_hist > 0) { score += 1.5; reasons.push('MACD 金叉/多头 +1.5'); }
    else { score -= 1.5; reasons.push('MACD 死叉/空头 -1.5'); }
  }
  if (a.s7 && a.s25 && a.s99) {
    if (a.s7 > a.s25 && a.s25 > a.s99) { score += 1.0; reasons.push('均线多头排列 +1.0'); }
    else if (a.s7 < a.s25 && a.s25 < a.s99) { score -= 1.0; reasons.push('均线空头排列 -1.0'); }
  }
  if (a.boll_up && a.boll_lo) {
    if (p > a.boll_up) { score -= 1.0; reasons.push('上轨上方 -1.0'); }
    else if (p < a.boll_lo) { score += 1.0; reasons.push('下轨下方 +1.0'); }
  }
  if (a.mom20 !== null && a.mom20 !== undefined) {
    if (a.mom20 < -10) { score += 1.0; reasons.push(`20日动量 ${a.mom20.toFixed(1)}% 超跌 +1.0`); }
    else if (a.mom20 > 10) { score -= 1.0; reasons.push(`20日动量 ${a.mom20.toFixed(1)}% 过热 -1.0`); }
  }
  if (a.volr !== null && a.volr !== undefined) {
    if (a.volr > 1.6 && a.mom5 !== null && a.mom5 < 0) { score -= 1.0; reasons.push(`放量下跌 ${a.volr.toFixed(1)}x -1.0`); }
    else if (a.volr > 1.6 && a.mom5 !== null && a.mom5 > 0) { score += 1.0; reasons.push(`放量上涨 ${a.volr.toFixed(1)}x +1.0`); }
  }
  if (a.fgi !== null && a.fgi !== undefined) {
    if (a.fgi < 20) { score += 2.0; reasons.push(`FGI ${a.fgi} 极度恐惧 +2.0`); }
    else if (a.fgi < 30) { score += 1.0; reasons.push(`FGI ${a.fgi} 恐惧 +1.0`); }
    else if (a.fgi > 85) { score -= 2.0; reasons.push(`FGI ${a.fgi} 极度贪婪 -2.0`); }
    else if (a.fgi > 70) { score -= 1.0; reasons.push(`FGI ${a.fgi} 贪婪 -1.0`); }
  }
  let label, pos;
  if (score >= 3.0) { label = '🚀 强烈看多'; pos = 12; }
  else if (score >= 2.0) { label = '📈 看多'; pos = 8; }
  else if (score >= 1.0) { label = '↗️ 谨慎看多'; pos = 3; }
  else if (score > 0.3) { label = '↗️ 中性偏多'; pos = 0; }
  else if (score >= -0.3) { label = '⚡ 中性震荡'; pos = 0; }
  else if (score >= -1.0) { label = '↘️ 中性偏空'; pos = 0; }
  else if (score >= -2.0) { label = '↘️ 谨慎看空'; pos = 3; }
  else if (score >= -3.0) { label = '📉 看空'; pos = 8; }
  else { label = '🛑 强烈看空'; pos = 12; }
  return { score: Math.round(score * 100) / 100, label, pos, reasons };
}

/* ---------------- 方向 ---------------- */
function directionOf(label) {
  if (label.includes('多')) return 'long';
  if (label.includes('空')) return 'short';
  return null;
}

/* ---------------- 实盘开单计划（限价挂单/回撤 0.382，与给单引擎 buildPlan 风格一致） ---------------- */
function buildOrder(a, j, symbol) {
  const price = a.price;
  const dir = directionOf(j.label);
  if (!dir || j.pos <= 0) return null;
  // 用 14 日真实波动估算 ATR（日线）
  const db = histDb();
  const rows = db.prepare(`
    SELECT date(ts/1000,'unixepoch','+8 hours') d,
           (SELECT c FROM klines k2 WHERE k2.symbol=k1.symbol AND k2.ts=(SELECT MAX(ts) FROM klines k3 WHERE k3.symbol=k1.symbol AND date(k3.ts/1000,'unixepoch','+8 hours')=date(k1.ts/1000,'unixepoch','+8 hours'))) c
    FROM klines k1 WHERE symbol='BTCUSDT' AND ts < ? GROUP BY d ORDER BY d DESC LIMIT 15
  `).all(Date.now());
  const closes = rows.map(r => r.c).reverse();
  const atr = closes.length >= 2 ? Math.abs(closes[closes.length - 1] - closes[closes.length - 2]) : price * 0.01;
  const stopMult = j.pos >= 8 ? 2.0 : j.pos >= 3 ? 1.5 : 1.2;
  const stopDist = Math.max(atr * stopMult, price * 0.008);
  let entry, stop, target1, target2;
  if (dir === 'long') {
    entry = price - atr * 0.382;           // 回撤 0.382 挂单
    stop = price - stopDist;
    target1 = entry + stopDist * 1.5;
    target2 = entry + stopDist * 2.5;
  } else {
    entry = price + atr * 0.382;
    stop = price + stopDist;
    target1 = entry - stopDist * 1.5;
    target2 = entry - stopDist * 2.5;
  }
  const rr = Math.round(((Math.abs(target1 - entry) / Math.abs(entry - stop)) + Number.EPSILON) * 10) / 10;
  const fgiDisc = a.fgi !== null ? (a.fgi <= 20 ? 0.3 : a.fgi <= 30 ? 0.5 : a.fgi <= 45 ? 0.7 : 1) : 1;
  const posPct = Math.min(12, Math.max(0, Math.round((j.pos * fgiDisc) * 100) / 100));
  return {
    symbol: symbol || 'BTC', direction: dir, order_type: 'limit',
    entry: Math.round(entry), stop: Math.round(stop),
    target1: Math.round(target1), target2: Math.round(target2),
    rr, pos_pct: posPct, price: Math.round(price),
    label: j.label, score: j.score, reasons: j.reasons,
    fgi: a.fgi, atr: Math.round(atr), note: '统一引擎实盘单（限价挂单）'
  };
}

/* ---------------- 实盘一次判断（analyze(now) + judge + buildOrder） ---------------- */
function runLive(symbol) {
  const now = Date.now();
  const a = analyze(now);
  if (!a) return { ok: false, error: '数据不足' };
  const j = judge(a);
  const order = buildOrder(a, j, symbol);
  return { ok: true, ts: now, a, j, order };
}

module.exports = { analyze, judge, buildOrder, runLive, directionOf, histDb, LEVER, PRINCIPAL };

/* ============================================================
 * 实盘开单：统一引擎判断 → 写入 signal_track（与给单引擎共用结算链路）
 * 返回: { placed, order, existing }  existing=已有同向OPEN单则跳过（防重复）
 * ============================================================ */
function placeLiveOrder(db, opts = {}) {
  const symbol = opts.symbol || 'BTC';
  const res = runLive(symbol);
  if (!res.ok) return res;
  const { j, order } = res;
  if (!order) return { ok: true, placed: false, reason: 'no_signal', j, order: null };

  // 防重复：同 symbol 同方向已有 OPEN 单则跳过
  const ex = db.prepare("SELECT id FROM signal_track WHERE symbol=? AND direction=? AND status='OPEN' ORDER BY id DESC LIMIT 1")
    .get(symbol, order.direction);
  if (ex) return { ok: true, placed: false, reason: 'dup_open', existing_id: ex.id, j, order };

  const pushed_at = Date.now();
  const msg = `[统一引擎] ${j.label} ${order.pos_pct}%×100x ${order.direction === 'long' ? '限价多' : '限价空'} @${order.entry} 止损${order.stop} 目标${order.target1}/${order.target2}`;
  const info = db.prepare(`
    INSERT INTO signal_track
      (symbol, direction, entry, stop, target1, target2, rr, pos_pct, msg, status, pushed_at, strategy, strategy_id, regime, reason)
    VALUES (?,?,?,?,?,?,?,?,?, 'OPEN', ?, 'UNIFIED', ?, 'live', ?)
  `).run(symbol, order.direction, order.entry, order.stop, order.target1, order.target2,
         order.rr, order.pos_pct, msg, pushed_at, 'uni-v1', JSON.stringify(order.reasons));
  return { ok: true, placed: true, id: info.lastInsertRowid, order, j };
}

/* 当前实盘状态：统一引擎最新判断 + 最新 OPEN 单 */
function liveStatus(db, symbol = 'BTC') {
  const res = runLive(symbol);
  const open = db.prepare("SELECT * FROM signal_track WHERE status='OPEN' AND strategy='UNIFIED' ORDER BY id DESC LIMIT 1").get();
  return { ok: true, ts: Date.now(), judge: res.ok ? res.j : null, order: res.ok ? res.order : null, open: open || null };
}

// 补充导出（追加在 module.exports 之后的函数）
module.exports.placeLiveOrder = placeLiveOrder;
module.exports.liveStatus = liveStatus;
