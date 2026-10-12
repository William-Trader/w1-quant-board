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
const log = require('./log');


const HIST_DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const LEVER = 100;
const PRINCIPAL = 10000;

let _hist = null;
function histDb() {
  if (!_hist) _hist = new Database(HIST_DB, { readonly: true });
  return _hist;
}

/* ---------------- OKX 实盘全自动开关（kv: okx:auto） ----------------
 * 老板拍板后置 1：autoOpen 信号 → 真实 OKX 下单（自动仓位/杠杆/TP/SL）
 * 默认 0：只写虚拟盘 + QQ 推送，不动真钱
 */
function okxAutoOn(db) {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get('okx:auto');
  return row && row.value === '1';
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
function buildOrder(a, j, symbol, livePrice) {
  const price = livePrice || a.price;   // 市价开单：优先用实时现价
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
    entry = price;                          // 市价多：现价直接进场
    stop = price - stopDist;
    target1 = entry + stopDist * 1.5;
    target2 = entry + stopDist * 2.5;
  } else {
    entry = price;                          // 市价空：现价直接进场
    stop = price + stopDist;
    target1 = entry - stopDist * 1.5;
    target2 = entry - stopDist * 2.5;
  }
  const rr = Math.round(((Math.abs(target1 - entry) / Math.abs(entry - stop)) + Number.EPSILON) * 10) / 10;
  const fgiDisc = a.fgi !== null ? (a.fgi <= 20 ? 0.3 : a.fgi <= 30 ? 0.5 : a.fgi <= 45 ? 0.7 : 1) : 1;
  // v1.1: 智能仓位管理（10000u 当 50000u 用）— 风险预算制 + 爆仓价反推
  // 保证金% = 风险金额 / 名义，爆仓距离 = 止损×1.3，保证止损先于爆仓触发
  let plan = null, leverage = LEVER, marginUsd = null, liqPx = null, notionalUsd = null;
  try {
    const dirEng = require('./dir_prod');
    const an = dirEng.analyze('BTC', Date.now());
    plan = an.plan;
    leverage = Math.min(LEVER, plan.leverage);
    notionalUsd = plan.notional_usd;
    marginUsd = plan.margin_usd;
    // 爆仓价（按杠杆反推）
    const liqDistPct = 100 / leverage;
    liqPx = dir === 'long' ? price * (1 - liqDistPct / 100) : price * (1 + liqDistPct / 100);
  } catch (e) { log.warn('[unified] 智能仓位计算失败，退回原逻辑:', e.message); }
  const posPct = Math.min(12, Math.max(0, Math.round((j.pos * fgiDisc) * 100) / 100));
  return {
    symbol: symbol || 'BTC', direction: dir, order_type: 'market',
    entry: Math.round(entry), stop: Math.round(stop),
    target1: Math.round(target1), target2: Math.round(target2),
    rr, pos_pct: posPct, price: Math.round(price),
    label: j.label, score: j.score, reasons: j.reasons,
    fgi: a.fgi, atr: Math.round(atr), note: '统一引擎实盘单（市价开单）',
    leverage: leverage || LEVER, margin_usd: marginUsd != null ? Math.round(marginUsd) : null,
    notional_usd: notionalUsd != null ? Math.round(notionalUsd) : null,
    liq_price: liqPx != null ? Math.round(liqPx) : null,
    risk_usd: 200
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

/* ---------------- v2.0 实盘判断：由 dir_prod 锁定引擎驱动（实盘=回测同口径） ----------------
 * 回测锁定参数(v2复利): entry_th=3.0 risk_pct=3.5% stop_atr=2.8 t1_rr=0.8 t1_pct=60%
 *             trail_atr=2.5 time_bars=10 min_r=0.5 cons_only=1 cooldown=3 dd_fuse=5
 * 全部信号/仓位/止损/爆仓价来自 dir_prod.analyze()，与 backtest_v4 验证逻辑一致 */
function dirOrder(db, symbol = 'BTC') {
  try {
    const dirEng = require('./dir_prod');
    const an = dirEng.analyze(symbol, Date.now());
    if (!an || !an.tradeable || an.score.dir === 'flat') {
      return { ok: true, placed: false, reason: 'flat', an, order: null };
    }
    const dir = an.score.dir;
    const plan = an.plan;
    // 实时现价（futures_markets 快照）→ 市价开单基准
    let livePrice = null;
    try {
      const row = db.prepare("SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 1").get();
      if (row) {
        const arr = JSON.parse(row.payload);
        const hit = (arr.data || []).find(c => (c.symbol || '').toUpperCase() === symbol.toUpperCase());
        if (hit && hit.current_price != null) livePrice = Number(hit.current_price);
      }
    } catch {}
    const price = livePrice || an.price;
    const effStop = plan.stop_dist_pct;
    const stop = dir === 'long' ? price * (1 - effStop / 100) : price * (1 + effStop / 100);
    const t1 = dir === 'long' ? price * (1 + effStop * 0.8 / 100) : price * (1 - effStop * 0.8 / 100);
    const liqPx = dir === 'long' ? price * (1 - plan.liq_dist_pct / 100) : price * (1 + plan.liq_dist_pct / 100);
    const order = {
      symbol, direction: dir, order_type: 'market',
      entry: Math.round(price), stop: Math.round(stop),
      target1: Math.round(t1), target2: Math.round(t1),  // 回测t1_rr=0.8落袋后追踪，target2=追踪终点
      rr: 0.8, pos_pct: plan.risk_pct || 3.5, price: Math.round(price),
      label: an.regime.type + ' ' + (dir === 'long' ? '做多' : '做空'),
      score: an.score.value, reasons: [JSON.stringify(an.factors)],
      fgi: null, atr: Math.round(price * effStop / 100 / 2.8),
      note: 'β1 御风 · 中低频趋势引擎 v4 15m精确执行（回测同口径）',
      leverage: plan.leverage, margin_usd: Math.round(plan.margin_usd),
      notional_usd: Math.round(plan.notional_usd), liq_price: Math.round(liqPx),
      risk_usd: plan.risk_usd, regime: an.regime.type
    };
    return { ok: true, placed: true, reason: 'ok', an, order };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { analyze, judge, buildOrder, runLive, directionOf, histDb, LEVER, PRINCIPAL };

/* ============================================================
 * 实盘开单：统一引擎判断 → 写入 signal_track（与给单引擎共用结算链路）
 * 返回: { placed, order, existing }  existing=已有同向OPEN单则跳过（防重复）
 * ============================================================ */
function placeLiveOrder(db, opts = {}) {
  const symbol = opts.symbol || 'BTC';
  // 2026-08-11: 会员手动开单同样走 dir_prod 锁定引擎（实盘=回测同口径）
  const res = dirOrder(db, symbol);
  if (!res.ok) return res;
  if (!res.placed || !res.order) return { ok: true, placed: false, reason: res.reason || 'no_signal', order: null };
  const order = res.order;
  const j = { label: order.label, score: order.score };

  // 防重复：同 symbol 同方向已有 OPEN 单则跳过
  const ex = db.prepare("SELECT id FROM signal_track WHERE symbol=? AND direction=? AND status='OPEN' ORDER BY id DESC LIMIT 1")
    .get(symbol, order.direction);
  if (ex) return { ok: true, placed: false, reason: 'dup_open', existing_id: ex.id, j, order };

  const pushed_at = Date.now();
  const msg = `[W1方向引擎] ${order.label} ${order.pos_pct}%×${order.leverage || LEVER}x ${order.direction === 'long' ? '市价多' : '市价空'} @${order.entry} 止损${order.stop} 目标${order.target1}`;
  const info = db.prepare(`
    INSERT INTO signal_track
      (symbol, direction, entry, stop, target1, target2, rr, pos_pct, msg, status, pushed_at, strategy, strategy_id, regime, reason,
       leverage, liq_price, margin_usd, notional_usd, risk_usd)
    VALUES (?,?,?,?,?,?,?,?,?, 'OPEN', ?, 'UNIFIED', ?, 'live', ?,
       ?,?,?,?,?)
  `).run(symbol, order.direction, order.entry, order.stop, order.target1, order.target2,
         order.rr, order.pos_pct, msg, pushed_at, 'uni-v1', JSON.stringify(order.reasons || []),
         order.leverage || null, order.liq_price || null, order.margin_usd || null, order.notional_usd || null, order.risk_usd || null);
  return { ok: true, placed: true, id: info.lastInsertRowid, order, j };
}

/* 当前实盘状态：方向引擎（dir_prod 锁定引擎）最新判断 + 最新 OPEN 单
 * 2026-08-11: 由 v1 runLive 评分器切换为 dir_prod（实盘=回测同口径） */
function liveStatus(db, symbol = 'BTC') {
  const open = db.prepare("SELECT * FROM signal_track WHERE status='OPEN' AND strategy='UNIFIED' ORDER BY id DESC LIMIT 1").get();
  try {
    const res = dirOrder(db, symbol);
    if (!res.ok) return { ok: true, ts: Date.now(), judge: null, order: null, open: open || null, error: res.error };
    const an = res.an || null;
    // 兼容前端旧字段：judge/order（judge 由方向引擎评分生成）
    const judge = an ? {
      label: an.regime.type + ' ' + (an.score.dir === 'long' ? '做多' : an.score.dir === 'short' ? '做空' : '观望'),
      score: an.score.value, pos: an.plan ? an.plan.risk_pct : null,
      reasons: [
        '方向一致' + (an.score.cons ? '✓' : '✗'),
        'MACD_4h ' + (an.score.macd_4h === 'bull' ? '多' : '空'),
        'RSI_4h ' + (an.score.rsi_4h != null ? an.score.rsi_4h : '—'),
        'ADX ' + (an.regime.adx != null ? an.regime.adx : '—')
      ]
    } : null;
    return { ok: true, ts: Date.now(), judge, order: res.order || null, open: open || null,
             dir: { regime: an ? an.regime : null, score: an ? an.score : null, tradeable: an ? an.tradeable : false,
                     plan: an ? an.plan : null, levels: an ? an.levels : null, price: an ? an.price : null } };
  } catch (e) {
    return { ok: true, ts: Date.now(), judge: null, order: null, open: open || null, error: e.message };
  }
}

// 补充导出（追加在 module.exports 之后的函数）
module.exports.placeLiveOrder = placeLiveOrder;
module.exports.liveStatus = liveStatus;
module.exports.dirOrder = dirOrder;


/* 全自动开单：统一引擎自动扫描，有方向信号且无同向 OPEN 单 → 市价开单
 * 供 server.js 定时调度，无需人工干预 */
async function autoOpen(db, opts = {}) {
  const symbol = opts.symbol || 'BTC';
  // v2: 由 dir_prod 锁定引擎驱动（回测同口径：entry_th=3.0/stop=2.8ATR/t1=0.5R/cd=18）
  const res = dirOrder(db, symbol);
  if (!res.ok) return res;
  if (!res.placed) {
    log.info(`[unified] 自动扫描 ${symbol}: ${res.reason} 观望（${res.an ? res.an.regime.type + ' 评分' + res.an.score.value : '无信号'}），无操作`);
    return { ok: true, placed: false, reason: res.reason, order: null };
  }
  const { j, a } = res;
  const dir = res.order.direction;
  // 现有 OPEN 单
  const open = db.prepare("SELECT * FROM signal_track WHERE status='OPEN' AND strategy='UNIFIED' AND symbol=? ORDER BY id DESC LIMIT 1").get(symbol);
  if (open) {
    if (open.direction === dir) {
      log.info(`[unified] 自动扫描 ${symbol}: 已有同向单 id=${open.id} ${dir}，维持持仓`);
      return { ok: true, placed: false, reason: 'dup_open', existing_id: open.id, order: null };
    }
    // 方向翻转 → 按现价平旧单，再开新方向（自动换仓）
    const row = db.prepare("SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 1").get();
    let px = null;
    try { const arr = JSON.parse(row.payload); const hit = (arr.data || []).find(c => (c.symbol||'').toUpperCase() === symbol.toUpperCase()); px = hit ? Number(hit.current_price) : null; } catch {}
    if (px != null && isFinite(px) && px > 0) {
      const pnl = open.direction === 'long' ? (px - Number(open.entry)) / Number(open.entry) * 100 : (Number(open.entry) - px) / Number(open.entry) * 100;
      db.prepare("UPDATE signal_track SET status='FLAT', resolved_at=?, pnl_pct=?, reason='方向翻转自动平仓' WHERE id=?")
        .run(Date.now(), Number(pnl.toFixed(2)), open.id);
      // 实盘模式：同步平 OKX 仓位（防旧仓裸露）
      if (okxAutoOn(db)) {
        try {
          const okx = require('./okx_executor');
          const cr = await okx.closePosition('BTC-USDT-SWAP');
          log.info(`[unified] 方向翻转实盘平仓: ${cr.ok ? 'OK' : 'FAIL ' + (cr.error || '')}`);
        } catch (e) { log.warn('[unified] 实盘平仓异常:', e.message); }
      }
      log.info(`[unified] 方向翻转: 平旧单 id=${open.id} ${open.direction} @${px} pnl=${pnl.toFixed(2)}% → 开新方向 ${dir}`);
    }
  }
  // 开新单（市价）：直接用 dir_prod 锁定引擎订单写入 signal_track（实盘=回测同口径）
  const o = res.order;
  // ---- 实盘全自动：OKX 真实下单（自动仓位/杠杆/TP/SL） ----
  let okxMeta = null;
  if (okxAutoOn(db)) {
    try {
      const okx = require('./okx_executor');
      const pr = await okx.openPosition(db, {
        dir: o.direction, entry: o.entry, stop: o.stop,
        target1: o.target1, leverage: o.leverage || LEVER
      });
      if (pr.ok) {
        okxMeta = pr.meta || {};
        log.info(`[unified] OKX 实盘开单成功: ${o.direction} @${o.entry} 名义$${okxMeta.notional} 杠杆${o.leverage}x 张数${okxMeta.sz}`);
      } else {
        log.warn(`[unified] OKX 实盘开单失败: ${pr.error}（跳过实盘，仅记录虚拟信号）`);
      }
    } catch (e) { log.warn('[unified] OKX 实盘开单异常:', e.message); }
  }
  const pushed_at = Date.now();
  const msg = `[W1方向引擎] ${o.label} ${o.pos_pct}% ${o.direction === 'long' ? '市价多' : '市价空'} @$${o.entry} 止损$${o.stop} 目标$${o.target1}`;
  const info = db.prepare(`
    INSERT INTO signal_track
      (symbol, direction, entry, stop, target1, target2, rr, pos_pct, msg, status, pushed_at, strategy, strategy_id, regime, reason,
       leverage, liq_price, margin_usd, notional_usd, risk_usd)
    VALUES (?,?,?,?,?,?,?,?,?, 'OPEN', ?, 'DIR', ?, 'live', ?,
       ?,?,?,?,?)
  `).run(symbol, o.direction, o.entry, o.stop, o.target1, o.target2,
         o.rr, o.pos_pct, msg, pushed_at, 'dir-v1', o.reasons ? JSON.stringify(o.reasons) : null,
         o.leverage || null, o.liq_price || null, o.margin_usd || null, o.notional_usd || null, o.risk_usd || null);
  if (okxMeta) {
    try {
      db.prepare("UPDATE signal_track SET okx_meta=?, notional_usd=?, margin_usd=?, risk_usd=? WHERE id=?")
        .run(JSON.stringify(okxMeta), okxMeta.notional || o.notional_usd, okxMeta.riskUsd != null ? Math.round(okxMeta.riskUsd) : o.margin_usd, okxMeta.riskUsd != null ? Math.round(okxMeta.riskUsd) : o.risk_usd, info.lastInsertRowid);
    } catch (e) {}
  }
  log.info(`[unified] 自动开单 ${symbol}: placed=true id=${info.lastInsertRowid} dir=${o.direction} label=${o.label} pos=${o.pos_pct}%${okxMeta ? ' [OKX实盘]' : ' [虚拟盘]'}`);
  // 开单成功 → 推送 QQ 群（会员跟单播报：10000u 实际开仓 + 杠杆 + 爆仓价）
  try {
    const { pushToGroup } = require('./qqbot');
    const lev = o.leverage || LEVER;
    const margin = o.margin_usd != null ? o.margin_usd : Math.round(PRINCIPAL * o.pos_pct / 100);
    const notional = o.notional_usd != null ? o.notional_usd : margin * lev;
    const liq = o.liq_price != null ? o.liq_price : '—';
    const content = [
      `🎯 【β1 御风 · 中低频趋势引擎】${symbol} ${o.direction === 'long' ? '🟢做多' : '🔴做空'}`,
      `判断：${o.label}（${o.score != null ? '+' + o.score : ''}分）`,
      `入场：$${o.entry}  止损：$${o.stop}  目标：$${o.target1}`,
      `📦 实际开仓（10000u基准）：保证金 $${margin} × ${lev}x = 名义 $${notional}（当${(notional / 10000).toFixed(1)}倍用）`,
      `💥 爆仓价：$${liq}（止损先触发，爆仓缓冲 1.3x）`,
      `⚠️ 仅供研究参考，不构成投资建议`
    ].join('\n');
    pushToGroup(process.env, db, content, 'signal');
  } catch (e) { log.warn('[unified] 开单推送失败:', e.message); }
  return { ok: true, placed: true, id: info.lastInsertRowid, order: o };
}
module.exports.autoOpen = autoOpen;
