#!/usr/bin/env node
'use strict';
// ============================================================
// α1 破浪 v3 实盘模块（2026-08-12 升级：接入 15m K 线）
// 与 bt_dual.exp.js 回测同逻辑（含 15m 入场确认 use15mEntry）：
//   - RANGE 震荡：1h 触下轨+RSI<45 做多 / 触上轨+RSI>55 做空 → 15m 触带确认入场
//   - TREND/TURN：1h 突破/EMA20 回调 → 15m 回调 EMA20 附近确认入场
//   - 出场：15m 触价（止损/中轨止盈/吊灯/超时），部分止盈 60% 落袋后保本+吊灯
//   - 吊灯追踪、回撤熔断降仓、冷却 4h（全方向）、提现 15%@2x
// 运行：node scripts/alpha1_live.js [--dry]
// ============================================================
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });
const wdb = new Database('/home/ubuntu/w1-board/data/w1.db');

const DRY = process.argv.includes('--dry');
const SYMBOL = 'BTC-USDT-SWAP';
const STRAT = 'ALPHA1';
const RISK_PCT = 1.0;          // 单笔风险 %（权益，熔断后 0.5%/0.2%）
const COOLDOWN_H = 2;          // 冷却（全方向，对齐回测 v3.1：R1.0+T1.8+cd2）
const RANGE_RSI_LO = 45, RANGE_RSI_HI = 55;
const RANGE_STOP_ATR = 1.5, TREND_STOP_ATR = 1.8;
const TREND_T1_RR = 1.5;
const RANGE_TIMEOUT = 24, TREND_TIMEOUT = 48;   // 小时
const RANGE_TRAIL_ATR = 1.0, TREND_TRAIL_ATR = 1.8;   // v3.1 收紧吊灯（回测：胜率85% PF14.09 DD4.2%）
const T1_PCT = 60;             // 部分止盈 60%
const DD_FUSE = 10;            // 回撤熔断：>6% 半仓 / >10% 0.2 仓
const LEV_CAP = 20;
const PENDING_H = 6;           // 15m 入场确认等待窗口（小时）

// ---------- 指标 ----------
function emaArr(arr, n) { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; }
function rsiArr(closes, n = 14) {
  const out = new Array(closes.length).fill(50); let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = g * (n - 1) / n + (d > 0 ? d : 0); l = l * (n - 1) / n + (d < 0 ? -d : 0);
    if (i >= n) { const rs = l === 0 ? 100 : g / l; out[i] = 100 - 100 / (1 + rs); }
  }
  return out;
}
function atrArr(bars, n = 14) {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    out[i] = i === 1 ? tr : (out[i - 1] * (n - 1) + tr) / n;
  }
  return out;
}
function adxArr(bars, n = 14) {
  const out = new Array(bars.length).fill(0); let pDM = 0, mDM = 0, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h, dn = bars[i - 1].l - bars[i].l;
    const pDm = up > dn && up > 0 ? up : 0, mDm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { pDM += pDm; mDM += mDm; trSum += tr; if (i < n) continue; }
    else { pDM = pDM - pDM / n + pDm; mDM = mDM - mDM / n + mDm; trSum = trSum - trSum / n + tr; }
    const pdi = 100 * pDM / (trSum || 1), mdi = 100 * mDM / (trSum || 1);
    const dx = 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1);
    out[i] = i === n ? dx : (out[i - 1] * (n - 1) + dx) / n;
  }
  return out;
}

// ---------- 数据（1h + 15m + 日线，全部已收盘 bar） ----------
const h1 = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts DESC LIMIT 700").all().reverse();
const m15 = db.prepare("SELECT ts,o,h,l,c FROM klines15 ORDER BY ts DESC LIMIT 2900").all().reverse();
const d1 = (() => {
  const map = new Map();
  for (const b of h1) {
    const day = new Date(b.ts + 8 * 3600e3).toISOString().slice(0, 10);
    if (!map.has(day)) map.set(day, { ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c });
    else { const d = map.get(day); d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); d.c = b.c; }
  }
  return [...map.values()];
})();
const hc = h1.map(b => b.c), dc = d1.map(b => b.c);
const m15c = m15.map(b => b.c);
const e20 = emaArr(hc, 20), e50 = emaArr(hc, 50), e200 = emaArr(hc, 200);
const rsi = rsiArr(hc, 14), atr = atrArr(h1, 14);
const rsi15 = rsiArr(m15c, 14), e20m15 = emaArr(m15c, 20), atr15 = atrArr(m15, 14);
const bbU = new Array(h1.length).fill(0), bbL = new Array(h1.length).fill(0), bbM = new Array(h1.length).fill(0);
for (let i = 19; i < h1.length; i++) {
  const seg = hc.slice(i - 19, i + 1);
  const m = seg.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  bbU[i] = m + 2 * sd; bbL[i] = m - 2 * sd; bbM[i] = m;
}
const bb15U = new Array(m15.length).fill(0), bb15L = new Array(m15.length).fill(0);
for (let i = 19; i < m15.length; i++) {
  const seg = m15c.slice(i - 19, i + 1);
  const m = seg.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  bb15U[i] = m + 2 * sd; bb15L[i] = m - 2 * sd;
}
const de20 = emaArr(dc, 20), de50 = emaArr(dc, 50), de200 = emaArr(dc, 200);
const dadx = adxArr(d1, 14);
function regime() {
  const i = d1.length - 1;
  const adxv = dadx[i] || 0;
  const up = de20[i] > de50[i] && de50[i] > de200[i];
  const dn = de20[i] < de50[i] && de50[i] < de200[i];
  const crossUp = de20[i] > de50[i] && de20[i - 1] <= de50[i - 1];
  const crossDn = de20[i] < de50[i] && de20[i - 1] >= de50[i - 1];
  const slope = adxv - (dadx[i - 5] || 0);
  if (adxv >= 25 && up && slope > -1) return 'TREND_UP';
  if (adxv >= 25 && dn && slope < 1) return 'TREND_DOWN';
  if (crossUp && adxv < 25) return 'TURN_UP';
  if (crossDn && adxv < 25) return 'TURN_DOWN';
  if (adxv < 20) return 'RANGE';
  return adxv >= 25 ? (up ? 'TREND_UP' : dn ? 'TREND_DOWN' : 'RANGE') : 'RANGE';
}

// ---------- 信号（1h 层） ----------
function signal() {
  const i = h1.length - 1;
  const reg = regime();
  const c = hc[i], at = atr[i] || c * 0.01;
  let dir = null, mode = null;
  if (reg === 'RANGE') {
    const tol = 0.15 * at;
    if (c <= bbL[i] + tol && rsi[i] < RANGE_RSI_LO) { dir = 'long'; mode = 'range'; }
    else if (c >= bbU[i] - tol && rsi[i] > RANGE_RSI_HI) { dir = 'short'; mode = 'range'; }
  } else if (reg === 'TREND_UP' || reg === 'TURN_UP') {
    if (c > bbU[i] && e20[i] > e50[i]) { dir = 'long'; mode = 'trend'; }
    else if (c >= e20[i] * 0.995 && c <= e20[i] * 1.01 && rsi[i] >= 40 && rsi[i] <= 55 && e20[i] > e50[i]) { dir = 'long'; mode = 'trend'; }
  } else if (reg === 'TREND_DOWN' || reg === 'TURN_DOWN') {
    if (c < bbL[i] && e20[i] < e50[i]) { dir = 'short'; mode = 'trend'; }
    else if (c <= e20[i] * 1.005 && c >= e20[i] * 0.99 && rsi[i] >= 45 && rsi[i] <= 60 && e20[i] < e50[i]) { dir = 'short'; mode = 'trend'; }
  }
  return { reg, dir, mode, price: c, at, ts: h1[i].ts };
}

// ---------- 15m 入场确认（更小级别入场点） ----------
function m15Confirm(dir, mode) {
  const k = m15.length - 1;   // 最新已收盘 15m bar
  const b = m15[k];
  if (!b) return null;
  const tol15 = 0.15 * (atr15[k] || b.c * 0.01);
  let ok = false;
  if (mode === 'range') {
    if (dir === 'long') ok = b.c <= bb15L[k] + tol15 && rsi15[k] < RANGE_RSI_LO;
    else ok = b.c >= bb15U[k] - tol15 && rsi15[k] > RANGE_RSI_HI;
  } else {
    if (dir === 'long') ok = b.c >= e20m15[k] * 0.997 && b.c <= e20m15[k] * 1.003 && rsi15[k] >= 40 && rsi15[k] <= 55;
    else ok = b.c <= e20m15[k] * 1.003 && b.c >= e20m15[k] * 0.997 && rsi15[k] >= 45 && rsi15[k] <= 60;
  }
  return ok ? { price: b.c, ts: b.ts } : null;
}

// ---------- 持仓参数（入场价 → stop/t1/仓位） ----------
function buildParams(dir, mode, price, reg) {
  const at = atr[h1.length - 1] || price * 0.01;
  const stopAt = mode === 'range' ? RANGE_STOP_ATR : TREND_STOP_ATR;
  const stopPct = Math.min(4, Math.max(0.5, stopAt * at / price * 100));
  const stop = dir === 'long' ? price * (1 - stopPct / 100) : price * (1 + stopPct / 100);
  const t1 = mode === 'range' ? bbM[h1.length - 2] : (dir === 'long' ? price + price * stopPct / 100 * TREND_T1_RR : price - price * stopPct / 100 * TREND_T1_RR);
  return { stopPct, stop, t1, price };
}

// ---------- 实盘执行 ----------
function okxAutoOn() {
  try { const r = wdb.prepare("SELECT value FROM kv WHERE key='okx:auto'").get(); return r && r.value === '1'; } catch (e) { return false; }
}
function accountEq() {
  const r = wdb.prepare("SELECT value FROM kv WHERE key='okx:eq'").get();
  return r ? Number(r.value) : 2890;
}
// 回撤熔断：实时权益 → 更新峰值 → 返回风险系数
function riskFactor() {
  let eq = null;
  try {
    const { execSync } = require('child_process');
    const out = execSync('okx --profile live account balance USDT 2>/dev/null | tail -4', { timeout: 30000 });
    const m = out.toString().match(/USDT\s+([\d.]+)/);
    eq = m ? parseFloat(m[1]) : null;
  } catch (e) {}
  if (eq == null) { try { const r = wdb.prepare("SELECT value FROM kv WHERE key='okx:eq'").get(); eq = r ? Number(r.value) : 2890; } catch (e) {} }
  let peak = eq;
  try { const r = wdb.prepare("SELECT value FROM kv WHERE key='alpha1:peak'").get(); if (r) peak = Math.max(Number(r.value) || eq, eq); } catch (e) {}
  try { wdb.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('alpha1:peak',?)").run(String(Math.round(peak * 100) / 100)); } catch (e) {}
  const ddPct = peak > 0 ? (peak - eq) / peak * 100 : 0;
  let rf = 1.0;
  if (DD_FUSE > 0) { if (ddPct > DD_FUSE * 0.6) rf = 0.5; if (ddPct > DD_FUSE) rf = 0.2; }
  console.log(`[ALPHA1] 风控: 权益≈${eq.toFixed(1)} 峰值${peak.toFixed(1)} 回撤${ddPct.toFixed(1)}% → 风险系数×${rf}`);
  return rf;
}
function hasOpen(dir) {
  const r = wdb.prepare("SELECT COUNT(*) c FROM signal_track WHERE status='OPEN' AND strategy=?").get(STRAT);
  if (r.c > 0) return true;
  // 冷却（全方向，对齐回测）
  const last = wdb.prepare("SELECT pushed_at FROM signal_track WHERE strategy=? AND status IN ('WIN','LOSS') ORDER BY id DESC LIMIT 1").get(STRAT);
  if (last && (Date.now() - last.pushed_at) < COOLDOWN_H * 3600e3) return true;
  return false;
}
async function openPos(sig, src) {
  const eq = accountEq();
  const rf = riskFactor();
  const riskUsd = eq * RISK_PCT / 100 * rf;
  let posMult = 1.0;
  try { const mr = wdb.prepare("SELECT value FROM kv WHERE key='okx:pos_mult'").get(); posMult = mr ? Number(mr.value) : 1.0; } catch (e) {}
  if (!isFinite(posMult) || posMult <= 0) posMult = 1.0;
  const notional = riskUsd / (sig.stopPct / 100) * posMult;
  const lev = Math.min(LEV_CAP, Math.floor(100 / (sig.stopPct * 1.3) * 10) / 10);
  const okxMeta = {};
  if (DRY) {
    okxMeta.notional = Math.round(notional); okxMeta.lev = lev;
    console.log(`[DRY] 信号: ${sig.reg} ${sig.dir}(${sig.mode}/${src}) @${sig.price} 止损${sig.stop.toFixed(1)} 止盈${sig.t1.toFixed(1)} 风险$${riskUsd.toFixed(1)} 名义$${notional.toFixed(0)} 杠杆${lev}x 倍数${posMult}x`);
  } else {
    const okx = require('./okx_executor');
    const pr = await okx.openPosition(wdb, { dir: sig.dir, entry: sig.price, stop: sig.stop, target1: sig.t1, leverage: lev });
    if (!pr.ok) { console.error(`[ALPHA1] 开单失败: ${pr.error}`); return pr; }
    okxMeta.notional = pr.meta.notional; okxMeta.lev = lev;
    console.log(`[ALPHA1] OKX 开单成功: ${sig.dir} @${sig.price} 名义$${pr.meta.notional} 杠杆${lev}x`);
  }
  const liqDist = sig.stopPct * 1.3;
  const liqPx = sig.dir === 'long' ? sig.price * (1 - liqDist / 100) : sig.price * (1 + liqDist / 100);
  try {
    wdb.prepare(`INSERT INTO signal_track (symbol, direction, entry, stop, target1, status, pushed_at, reason, strategy, strategy_id, regime, leverage, liq_price, margin_usd, notional_usd, risk_usd, okx_meta)
      VALUES (?,?,?,?,?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      SYMBOL, sig.dir, sig.price, sig.stop, sig.t1, Date.now(), sig.mode + ':' + src, STRAT, 'alpha1-v3', sig.reg,
      lev, liqPx, +(riskUsd / lev).toFixed(2), Math.round(notional), Math.round(riskUsd), JSON.stringify(okxMeta));
    console.log(`[ALPHA1] signal_track 已记录 #${wdb.prepare("SELECT MAX(id) m FROM signal_track").get().m}`);
  } catch (e) { console.error('[ALPHA1] signal_track 写入失败:', e.message); }
  return { ok: true };
}

// ---------- 提现落袋 ----------
async function checkWithdraw() {
  try {
    const { execSync } = require('child_process');
    let eq = null;
    try {
      const out = execSync('okx --profile live account balance USDT 2>/dev/null | tail -4', { timeout: 30000 });
      // 可用余额口径：USDT <equity> <available> <frozen>，冻结资金不计入提现判断
      const m = out.toString().match(/USDT\s+[\d.]+\s+([\d.]+)/);
      eq = m ? parseFloat(m[1]) : null;
    } catch (e) {}
    if (eq == null) { console.log('[ALPHA1] 余额查询失败，跳过提现检查'); return; }
    let wdBase = null;
    try { const r = wdb.prepare("SELECT value FROM kv WHERE key='alpha1:wdBase'").get(); wdBase = r ? Number(r.value) : null; } catch (e) {}
    if (wdBase == null) {
      wdb.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('alpha1:wdBase',?)").run(String(Math.round(eq * 100) / 100));
      console.log(`[ALPHA1] 提现基准初始化 = ${eq.toFixed(2)}u（权益达 ${(eq * 2).toFixed(0)}u 触发提现）`);
      return;
    }
    // 基准保持原值不迁移：可用余额口径下，冻结(持仓/挂单)资金不计入达标判断
    if (eq >= wdBase * 2) {
      const wd = (eq - wdBase) * 0.15;
      console.log(`[ALPHA1] 🎉 权益 ${eq.toFixed(2)} ≥ 基准×2（${(wdBase * 2).toFixed(2)}）→ 提利润 15% = ${wd.toFixed(2)}u 落袋`);
      if (!DRY) {
        try {
          const out = execSync('node scripts/okx_transfer.js ' + wd.toFixed(2), { cwd: '/home/ubuntu/w1-board', timeout: 60000 });
          console.log('[ALPHA1] 划转:', out.toString().trim().split('\n').slice(-2).join(' | '));
        } catch (e) { console.error('[ALPHA1] 划转失败:', e.message); return; }
      } else {
        console.log(`[DRY] 将划转 ${wd.toFixed(2)} USDT → 资金账户`);
      }
      const newBase = eq - wd;
      wdb.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('alpha1:wdBase',?)").run(String(Math.round(newBase * 100) / 100));
      console.log(`[ALPHA1] 提现完成，基准更新 ${newBase.toFixed(2)}u`);
    } else {
      console.log(`[ALPHA1] 提现检查：权益 ${eq.toFixed(2)} / 基准 ${wdBase.toFixed(2)}（${(eq / wdBase * 100).toFixed(0)}%），未达 200%`);
    }
  } catch (e) { console.error('[ALPHA1] 提现检查异常:', e.message); }
}

// 同步 OKX 端止损条件单（吊灯/保本移动）
async function syncOkxStop(p, isLong, newSlPx) {
  try {
    if (DRY) { console.log(`[DRY] 同步 OKX 止损单 → ${newSlPx.toFixed(1)}`); return; }
    const okx = require('./okx_executor');
    const g = await okx.getAlgoStop(wdb);
    if (!g.ok) { console.log(`[ALPHA1] OKX 止损单查询: ${g.error}`); return; }
    const cur = g.slTriggerPx;
    const better = isLong ? newSlPx > cur : newSlPx < cur;
    if (!better) return;   // 只向有利方向移动
    const r = await okx.amendStop(wdb, g.algoId, newSlPx);
    console.log(`[ALPHA1] OKX 止损单 ${cur.toFixed(1)} → ${newSlPx.toFixed(1)} ${r.ok ? 'OK' : 'FAIL:' + (r.error || '')}`);
  } catch (e) { console.error('[ALPHA1] syncOkxStop 异常:', e.message); }
}

// ---------- 持仓管理（15m 触价：止损/止盈/吊灯/超时 + 部分止盈 60%） ----------
async function managePositions() {
  const rows = wdb.prepare("SELECT * FROM signal_track WHERE status='OPEN' AND strategy=? ORDER BY id DESC LIMIT 5").all(STRAT);
  const h1i = h1.length - 1;
  const m15i = m15.length - 1;
  for (const p of rows) {
    const isLong = p.direction === 'long';
    const mode = (p.reason || '').startsWith('range') ? 'range' : 'trend';
    const heldH = (Date.now() - p.pushed_at) / 3600e3;
    const timeout = mode === 'range' ? RANGE_TIMEOUT : TREND_TIMEOUT;
    const partial = p.reason && p.reason.includes('partial');
    const stopNow = partial ? p.entry : p.stop;   // 部分止盈后保本
    let exit = null, reason = null;
    // 15m 触价检查（最新已收盘 15m bar：low/high）
    const b15 = m15[m15i];
    if (isLong && b15.l <= stopNow) { exit = stopNow; reason = 'stop'; }
    else if (!isLong && b15.h >= stopNow) { exit = stopNow; reason = 'stop'; }
    else if (!partial && isLong && b15.h >= p.target1) { exit = p.target1; reason = 't1_partial'; }
    else if (!partial && !isLong && b15.l <= p.target1) { exit = p.target1; reason = 't1_partial'; }
    else {
      // 吊灯追踪（1h 窗口，已收盘）
      const win = mode === 'trend' ? 40 : 20;
      const trA = mode === 'trend' ? TREND_TRAIL_ATR : RANGE_TRAIL_ATR;
      const at = atr[h1i] || p.entry * 0.01;
      let trailPx = null;
      if (isLong) { let mx = -Infinity; for (let k = Math.max(0, h1i - win); k <= h1i - 1; k++) if (h1[k].h > mx) mx = h1[k].h; const tr = Math.max(mx - trA * at, partial ? p.entry : 0); trailPx = tr; if (b15.l <= tr) { exit = tr; reason = 'trail'; } }
      else { let mn = Infinity; for (let k = Math.max(0, h1i - win); k <= h1i - 1; k++) if (h1[k].l < mn) mn = h1[k].l; const tr = Math.min(mn + trA * at, partial ? p.entry : Infinity); trailPx = tr; if (b15.h >= tr) { exit = tr; reason = 'trail'; } }
      // 吊灯抬高 → OKX 止损单同步（仅向有利方向）
      if (!exit && trailPx != null && !partial) {
        const better = isLong ? trailPx > p.stop : trailPx < p.stop;
        if (better) await syncOkxStop(p, isLong, trailPx);
      }
    }
    // 超时
    if (!exit && heldH >= timeout) { exit = b15.c; reason = 'timeout'; }
    if (!exit) continue;
    const stopDist = Math.abs(p.entry - p.stop);
    const rTotal = (isLong ? (exit - p.entry) : (p.entry - exit)) / (stopDist || 1);
    if (reason === 't1_partial') {
      // 部分止盈：60% 利润落袋（等价）→ 止损移到保本，剩余仓位继续吊灯（不实际平仓，OKX 无部分平）
      const pnlPct = (isLong ? (exit - p.entry) : (p.entry - exit)) / p.entry * 100 * (p.leverage || 1) * (T1_PCT / 100);
      if (DRY) { console.log(`[DRY] 部分止盈 #${p.id} ${p.direction} @${exit} 落袋60% pnl≈${pnlPct.toFixed(2)}% → 保本+吊灯`); continue; }
      try {
        wdb.prepare("UPDATE signal_track SET reason=?, resolved_at=? WHERE id=?").run((mode === 'range' ? 'range' : 'trend') + ':partial', Date.now(), p.id);
        console.log(`[ALPHA1] 部分止盈 #${p.id} @${exit} 止损移至保本（剩余仓位吊灯追踪）`);
        await syncOkxStop(p, isLong, p.entry);   // OKX 端止损同步到保本
      } catch (e) { console.error('[ALPHA1] 部分止盈异常:', e.message); }
      continue;
    }
    const pnlPct = (isLong ? (exit - p.entry) : (p.entry - exit)) / p.entry * 100 * (p.leverage || 1);
    if (DRY) { console.log(`[DRY] 平仓 #${p.id} ${p.direction} ${reason} @${exit} r=${rTotal.toFixed(2)} pnl≈${pnlPct.toFixed(2)}%`); continue; }
    try {
      const okx = require('./okx_executor');
      const r = await okx.closePosition(SYMBOL);
      wdb.prepare("UPDATE signal_track SET status=?, resolved_at=?, pnl_pct=?, exit_reason=? WHERE id=?").run(reason === 'stop' ? 'LOSS' : 'WIN', Date.now(), +pnlPct.toFixed(2), reason, p.id);
      console.log(`[ALPHA1] 平仓 #${p.id} ${reason} @${exit} r=${rTotal.toFixed(2)} ${r.ok ? 'OK' : 'FAIL:' + r.error}`);
    } catch (e) { console.error('[ALPHA1] 平仓异常:', e.message); }
  }
}

// ---------- 主流程 ----------
(async () => {
  console.log(`[ALPHA1] ${DRY ? 'DRY-RUN（不下单）' : 'LIVE'} · v3.1(15m) · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  await checkWithdraw();
  await managePositions();
  // pending 15m 确认（1h 信号后等待 15m 入场点）
  let pending = null;
  try { const r = wdb.prepare("SELECT value FROM kv WHERE key='alpha1:pending'").get(); pending = r ? JSON.parse(r.value) : null; } catch (e) {}
  if (pending) {
    if (Date.now() - pending.ts > PENDING_H * 3600e3) {
      wdb.prepare("DELETE FROM kv WHERE key='alpha1:pending'").run();
      console.log('[ALPHA1] pending 过期作废');
      pending = null;
    }
  }
  // 1h 信号
  const sig = signal();
  console.log(`[ALPHA1] regime=${sig.reg} 现价≈${sig.price.toFixed(1)} 15m 收盘≈${m15c[m15c.length - 1].toFixed(1)}`);
  if (hasOpen(sig.dir)) { console.log('[ALPHA1] 已有持仓或冷却中，跳过'); return; }
  // 有 pending → 等 15m 确认
  if (pending) {
    const cf = m15Confirm(pending.dir, pending.mode);
    if (cf) {
      const params = buildParams(pending.dir, pending.mode, cf.price, pending.reg);
      const finalSig = Object.assign({}, pending, params, { price: cf.price });
      console.log(`[ALPHA1] ✅ 15m 确认入场: ${pending.dir}(${pending.mode}) @${cf.price}（1h 信号 ${new Date(pending.ts).toLocaleString('zh-CN', { hour12: false })} 触发）`);
      if (!DRY && !okxAutoOn()) { console.log('[ALPHA1] okx:auto=OFF，仅记录'); wdb.prepare("DELETE FROM kv WHERE key='alpha1:pending'").run(); return; }
      await openPos(finalSig, '15m-confirm');
      wdb.prepare("DELETE FROM kv WHERE key='alpha1:pending'").run();
    } else {
      console.log('[ALPHA1] pending 等待 15m 入场点（15m 尚未确认）');
    }
    return;
  }
  // 新 1h 信号 → 立即 15m 确认（已就绪则直接入，否则挂 pending）
  if (!sig.dir) { console.log('[ALPHA1] 无信号，观望'); return; }
  const cf = m15Confirm(sig.dir, sig.mode);
  if (cf) {
    const params = buildParams(sig.dir, sig.mode, cf.price, sig.reg);
    const finalSig = Object.assign({}, sig, params, { price: cf.price });
    console.log(`[ALPHA1] ✅ 15m 已确认入场: ${sig.dir}(${sig.mode}) @${cf.price}（1h ${sig.reg}）`);
    if (!DRY && !okxAutoOn()) { console.log('[ALPHA1] okx:auto=OFF，仅记录信号'); return; }
    await openPos(finalSig, '15m-direct');
  } else {
    // 挂 pending 等 15m 确认（最多 PENDING_H 小时）
    try {
      wdb.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('alpha1:pending',?)").run(JSON.stringify({ dir: sig.dir, mode: sig.mode, reg: sig.reg, ts: Date.now() }));
      console.log(`[ALPHA1] 1h 信号 ${sig.dir}(${sig.mode}) 已挂起，等待 15m 入场点（15m 触带/回调）`);
    } catch (e) { console.error('[ALPHA1] pending 写入失败:', e.message); }
  }
})();
