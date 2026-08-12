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
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });
const wdb = new Database('/home/ubuntu/w1-board/data/w1.db');

// ---------- 防并发锁（cron 1分钟 + 限价轮询，防止重叠执行重复开单） ----------
const LOCK = '/tmp/alpha1_live.lock';
function acquireLock() {
  try { const st = fs.statSync(LOCK); if (Date.now() - st.mtimeMs < 90000) { console.log('[ALPHA1] 上一轮仍在运行，跳过本轮'); return false; } } catch (e) {}
  try { fs.writeFileSync(LOCK, String(process.pid)); } catch (e) {}
  return true;
}
function releaseLock() { try { fs.unlinkSync(LOCK); } catch (e) {} }

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

// ---------- 数据（1h + 15m + 日线，全部已收盘 bar + OKX 实时覆盖） ----------
// 改造：hist.db 每5分钟刷新（滞后≤10min），叠加 OKX 实时 K 线（已收盘 bar）消除滞后
function fetchOkxCandles(bar, limit) {
  try {
    const out = execFileSync('okx', ['--profile', 'live', '--json', 'market', 'candles', 'BTC-USDT-SWAP', '--bar', bar, '--limit', String(limit)], { timeout: 20000, encoding: 'utf8' });
    const d = JSON.parse(out);
    const arr = Array.isArray(d) ? d : (d.data || []);
    // OKX 返回 [ts,o,h,l,c,vol,...confirm]，confirm='1' 已收盘；过滤形成中 bar
    const now = Date.now();
    const barMs = bar === '1H' ? 3600e3 : 900e3;
    return arr.filter(x => Array.isArray(x) && x.length >= 5 && (String(x[8]) === '1' || (Number(x[0]) + barMs) <= now))
      .map(x => ({ ts: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) || 0 }))
      .sort((a, b) => a.ts - b.ts);
  } catch (e) { console.warn('[ALPHA1] OKX 实时K线获取失败(用hist.db):', e.message); return []; }
}
function mergeBars(base, live) {
  const map = new Map();
  for (const b of base) map.set(b.ts, b);
  for (const b of live) if (!map.has(b.ts)) map.set(b.ts, b);
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
const _h1Base = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts DESC LIMIT 700").all().reverse();
const _m15Base = db.prepare("SELECT ts,o,h,l,c FROM klines15 ORDER BY ts DESC LIMIT 2900").all().reverse();
const h1 = mergeBars(_h1Base, fetchOkxCandles('1H', 300)).slice(-700);
const m15 = mergeBars(_m15Base, fetchOkxCandles('15m', 300)).slice(-2900);
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
// 实时可用余额（口径统一：available，冻结不计入）——返回 null 表示查询失败
function liveAvailEq() {
  try {
    const out = execSync('okx --profile live account balance USDT 2>/dev/null | tail -4', { timeout: 30000 });
    const m = out.toString().match(/USDT\s+[\d.]+\s+([\d.]+)/);
    if (m) return parseFloat(m[1]);
  } catch (e) {}
  return null;
}
function accountEq() {
  const live = liveAvailEq();
  if (live != null) return live;
  const r = wdb.prepare("SELECT value FROM kv WHERE key='okx:eq'").get();
  return r ? Number(r.value) : 2890;
}
// 回撤熔断：实时可用权益 → 更新峰值 → 返回风险系数（口径与提现一致：available）
function riskFactor() {
  let eq = liveAvailEq();
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
  // 冷却（全方向，对齐回测）——从平仓时间 resolved_at 起算，非开仓时间
  const last = wdb.prepare("SELECT resolved_at FROM signal_track WHERE strategy=? AND status IN ('WIN','LOSS') ORDER BY id DESC LIMIT 1").get(STRAT);
  const t0 = last && last.resolved_at ? last.resolved_at : (last && last.pushed_at ? last.pushed_at : 0);
  if (t0 && (Date.now() - t0) < COOLDOWN_H * 3600e3) return true;
  return false;
}
// 实时盘口（bid/ask），用于最优限价入场
function fetchTicker() {
  try {
    const out = execFileSync('okx', ['--profile', 'live', '--json', 'market', 'ticker', 'BTC-USDT-SWAP'], { timeout: 15000, encoding: 'utf8' });
    const d = JSON.parse(out);
    const arr = Array.isArray(d) ? d : (d.data || []);
    const t = arr[0] || {};
    return { bid: Number(t.bidPx) || 0, ask: Number(t.askPx) || 0, last: Number(t.last) || 0 };
  } catch (e) { return { bid: 0, ask: 0, last: 0 }; }
}
// 真实平仓成交价：bills 最近一笔带盈亏的成交（type=2 交易, pnl!=0 = 平仓）
function fetchRealFillPx() {
  try {
    const out = execFileSync('okx', ['--profile', 'live', '--json', 'account', 'bills', '--instType', 'SWAP'], { timeout: 20000, encoding: 'utf8' });
    const d = JSON.parse(out);
    const arr = Array.isArray(d) ? d : (d.data || []);
    const t = arr.find(x => String(x.instId || '').includes('BTC-USDT-SWAP') && String(x.type) === '2' && Number(x.pnl) !== 0);
    if (t) return { px: Number(t.px), pnl: Number(t.pnl), fee: Number(t.fee), ts: Number(t.ts) };
  } catch (e) {}
  return null;
}
// 最优限价：做多挂 bid（吃流动性最优点），做空挂 ask；拿不到盘口则用信号价
function optimalLimitPx(dir, sigPrice) {
  const tk = fetchTicker();
  if (dir === 'long') return (tk.bid > 0 && Math.abs(tk.bid - sigPrice) / sigPrice < 0.01) ? tk.bid : sigPrice;
  return (tk.ask > 0 && Math.abs(tk.ask - sigPrice) / sigPrice < 0.01) ? tk.ask : sigPrice;
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
    const okx = require('../lib/okx_executor');
    const lpx = optimalLimitPx(sig.dir, sig.price);
    console.log(`[ALPHA1] 信号 ${sig.dir}(${sig.mode}/${src}) @${sig.price} → 最优限价 ${lpx.toFixed(1)}（轮询40s，不成交流单市价兜底）`);
    const pr = await okx.openPositionLimit(wdb, {
      dir: sig.dir, entry: sig.price, stop: sig.stop, target1: sig.t1,
      leverage: lev, mult: posMult, riskPct: RISK_PCT * rf, limitPx: lpx
    });
    if (!pr.ok) { console.error(`[ALPHA1] 开单失败: ${pr.error}`); return pr; }
    okxMeta.notional = pr.meta.notional; okxMeta.lev = pr.meta.lev || lev; okxMeta.mode = pr.mode;
    if (pr.avgPx) okxMeta.avgPx = pr.avgPx;
    console.log(`[ALPHA1] OKX 开单成功: ${sig.dir} ${pr.mode} 成交均价${pr.avgPx ? pr.avgPx.toFixed(1) : '待确认'} 名义$${pr.meta.notional} 杠杆${pr.meta.lev || lev}x`);
  }
  const liqDist = sig.stopPct * 1.3;
  const liqPx = sig.dir === 'long' ? sig.price * (1 - liqDist / 100) : sig.price * (1 + liqDist / 100);
  try {
    const t2Px = sig.dir === 'long' ? sig.price * (1 - 4 * sig.stopPct / 100) : sig.price * (1 + 4 * sig.stopPct / 100);
    const rrV = Math.abs(sig.t1 - sig.price) / Math.max(Math.abs(sig.stop - sig.price), 0.01);
    wdb.prepare(`INSERT INTO signal_track (symbol, direction, entry, stop, target1, target2, rr, pos_pct, status, pushed_at, reason, strategy, strategy_id, regime, leverage, liq_price, margin_usd, notional_usd, risk_usd, okx_meta)
      VALUES (?,?,?,?,?,?,?,?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      SYMBOL, sig.dir, sig.price, sig.stop, sig.t1, t2Px, rrV, sig.posPct || 1, Date.now(), sig.mode + ':' + src, STRAT, 'alpha1-v3', sig.reg,
      lev, liqPx, +(riskUsd / lev).toFixed(2), Math.round(notional), Math.round(riskUsd), JSON.stringify(okxMeta));
    console.log(`[ALPHA1] signal_track 已记录 #${wdb.prepare("SELECT MAX(id) m FROM signal_track").get().m}`);
  } catch (e) { console.error('[ALPHA1] signal_track 写入失败:', e.message); }
  return { ok: true };
}

// ---------- 提现落袋 ----------
async function checkWithdraw() {
  try {
    // 可用余额口径（冻结不计入），与开仓风控统一
    const eq = liveAvailEq();
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
    const okx = require('../lib/okx_executor');
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
    // 实际成交价优先：平仓成功后从 OKX bills 查询真实均价，避免虚拟吊灯价失真
    let actualExit = exit;
    const rTotal = (isLong ? (actualExit - p.entry) : (p.entry - actualExit)) / (stopDist || 1);
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
    const pnlPct = (isLong ? (actualExit - p.entry) : (p.entry - actualExit)) / p.entry * 100 * (p.leverage || 1);
    if (DRY) { console.log(`[DRY] 平仓 #${p.id} ${p.direction} ${reason} @${actualExit} r=${rTotal.toFixed(2)} pnl≈${pnlPct.toFixed(2)}%`); continue; }
    try {
      const okx = require('../lib/okx_executor');
      const r = await okx.closePosition(SYMBOL, p.direction);
      if (r.ok) {
        const real = fetchRealFillPx();
        const effExit = real ? real.px : exit;
        const effPnl = real ? ((isLong ? (effExit - p.entry) : (p.entry - effExit)) / p.entry * 100 * (p.leverage || 1)) : pnlPct;
        const meta = JSON.stringify({ exitPx: effExit, pnl: real ? real.pnl : null, fee: real ? real.fee : null });
        const win = effPnl >= 0;
        wdb.prepare("UPDATE signal_track SET status=?, resolved_at=?, pnl_pct=?, exit_reason=?, okx_meta=? WHERE id=?").run(win ? 'WIN' : 'LOSS', Date.now(), +effPnl.toFixed(2), reason, meta, p.id);
        console.log(`[ALPHA1] 平仓 #${p.id} ${reason} 实价${effExit.toFixed(1)} r=${rTotal.toFixed(2)} pnl=${effPnl.toFixed(2)}% OK`);
      } else {
        console.error(`[ALPHA1] 平仓 #${p.id} 失败（保持 OPEN，下轮重试）: ${r.error}`);
      }
    } catch (e) { console.error('[ALPHA1] 平仓异常（保持 OPEN）:', e.message); }
  }
}

// ---------- 主流程 ----------
(async () => {
  if (!acquireLock()) return;
  try {
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
  } catch (e) { console.error('[ALPHA1] 主流程异常:', e.message); }
  finally { releaseLock(); }
})();
