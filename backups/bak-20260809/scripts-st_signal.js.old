#!/usr/bin/env node
// ============================================================
// W1 SmartTrend 智能行情判断策略（ST）
//   先判大级别（日线 EMA20/50 + ADX 趋势方向）→ 再找入场点（1h 回调 EMA20 + RSI + 止跌确认）
//   出场: ATR×2.5 初始止损 + 2.5ATR 追踪 + 2R/4R 分批止盈 + 72h 超时
//   仓位: 100x, 单笔风险 0.5%（与 signal.js v2 一致）
// 独立脚本: cron 每小时执行; 走 qqbot 推送 + signal_track 战绩
// ============================================================
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { loadEnv } = require(path.join(ROOT, 'lib', 'env'));
const env = loadEnv();
const D = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const db = new D(path.join(ROOT, 'data', 'w1.db'));
const { kvGet, kvSet } = require(path.join(ROOT, 'lib', 'db'));
const { pushToGroup } = require(path.join(ROOT, 'lib', 'qqbot'));

const WATCH = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'XAU'];
const LEV = 100, RISK = 0.005;              // 100x, 单笔风险 0.5%
const COOLDOWN_H = 6, DAILY_MAX = 4;        // 每方向冷却 6h, 每日最多 4 条 ST
const CACHE_DIR = path.join(ROOT, 'data', 'st_cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function ema(arr, n) { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; }
function sma(arr, n) { const out = []; let s = 0; for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= n) s -= arr[i - n]; out.push(i >= n - 1 ? s / n : null); } return out; }
function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(50);
  for (let i = n; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - n + 1; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d > 0) g += d; else l -= d; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function adxCalc(bars, n = 14) {
  const out = new Array(bars.length).fill(0);
  let pDM = 0, mDM = 0, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    const pDm = up > dn && up > 0 ? up : 0;
    const mDm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { pDM += pDm; mDM += mDm; trSum += tr; if (i < n) continue; }
    else { pDM = pDM - pDM / n + pDm; mDM = mDM - mDM / n + mDm; trSum = trSum - trSum / n + tr; }
    const pdi = 100 * pDM / (trSum || 1), mdi = 100 * mDM / (trSum || 1);
    const dx = 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1);
    out[i] = i === n ? dx : (out[i - 1] * (n - 1) + dx) / n;
  }
  return out;
}
async function getKlines(sym) {
  const to = Math.floor(Date.now() / 1000);
  const [h1r, d1r] = await Promise.all([
    fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym === 'XAU' ? 'PAXG' : sym}_USDT&interval=1h&from=${to - 7 * 86400}&to=${to}`, { signal: AbortSignal.timeout(12000) }),
    fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym === 'XAU' ? 'PAXG' : sym}_USDT&interval=1d&from=${to - 300 * 86400}&to=${to}`, { signal: AbortSignal.timeout(12000) })
  ]);
  if (!h1r.ok || !d1r.ok) throw new Error(`kline http`);
  const map = a => a.map(c => ({ t: +c[0], o: +c[5], h: +c[3], l: +c[4], c: +c[2], v: +c[6] })).sort((a, b) => a.t - b.t);
  return { h1: map(await h1r.json()), d1: map(await d1r.json()) };
}
// 信号: 返回 {dir, entry, stop, t1, t2, rr, reason} 或 null
function stSignal(h1, d1) {
  if (h1.length < 120 || d1.length < 40) return null;
  const d1c = d1.map(b => b.c);
  const e20d = ema(d1c, 20), e50d = ema(d1c, 50), ADX = adxCalc(d1);
  const dIdx = d1.length - 1;
  const adxv = ADX[dIdx];
  if (adxv < 20 || adxv > 55) return null;
  const up = e20d[dIdx] > e50d[dIdx];
  const dn = e20d[dIdx] < e50d[dIdx];
  if (!up && !dn) return null;
  const closes = h1.map(b => b.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const R = rsi(closes, 14);
  const i = h1.length - 1;
  const px = h1[i].c;
  const ema20 = e20[i], ema50 = e50[i];
  const r = R[i];
  const volAvg = sma(h1.map(b => b.v), 20)[i] || 1;
  const ema20Up = e20[i] > e20[i - 3];
  if (up) {
    if (px < ema50 * 1.002) return null;
    const retrace = px <= ema20 * 1.006 && px >= ema20 * 0.986;
    if (retrace && r >= 45 && r <= 65 && h1[i].v >= volAvg * 0.85 && h1[i].c >= h1[i - 1].c && ema20Up) {
      // ATR 止损
      const A = atr(h1)[i];
      const stopPct = Math.min(0.025, Math.max(0.005, (2.5 * A) / px));
      const dir = 'long';
      return { dir, entry: px, stop: px * (1 - stopPct), t1: px * (1 + 2 * stopPct), t2: px * (1 + 4 * stopPct), rr: 2, reason: `日线多 ADX${adxv.toFixed(0)} 回调EMA20 RSI${r.toFixed(0)}` };
    }
  } else {
    if (px > ema50 * 0.998) return null;
    const retrace = px >= ema20 * 0.994 && px <= ema20 * 1.014;
    if (retrace && r <= 55 && r >= 35 && h1[i].v >= volAvg * 0.85 && h1[i].c <= h1[i - 1].c && !ema20Up) {
      const A = atr(h1)[i];
      const stopPct = Math.min(0.025, Math.max(0.005, (2.5 * A) / px));
      const dir = 'short';
      return { dir, entry: px, stop: px * (1 + stopPct), t1: px * (1 - 2 * stopPct), t2: px * (1 - 4 * stopPct), rr: 2, reason: `日线空 ADX${adxv.toFixed(0)} 反弹EMA20 RSI${r.toFixed(0)}` };
    }
  }
  return null;
}
function atr(bars, n = 14) {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    out[i] = i === 1 ? tr : (out[i - 1] * (n - 1) + tr) / n;
  }
  return out;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const dailyKey = `st:daily:${today}`;
  const dailyCount = Number(kvGet(db, dailyKey, 0) || 0);
  let pushed = 0, hits = 0;
  for (const sym of WATCH) {
    let kl;
    try { kl = await getKlines(sym); }
    catch (e) { console.log(`[ST] ${sym} K线失败: ${e.message}`); continue; }
    let sig;
    try { sig = stSignal(kl.h1, kl.d1); } catch (e) { console.log(`[ST] ${sym} 计算失败: ${e.message}`); continue; }
    if (!sig) continue;
    hits++;
    const cdKey = `signal:cooldown:${sym}:${sig.dir}`;
    const lastPush = kvGet(db, cdKey, 0);
    if (lastPush && Date.now() - lastPush < COOLDOWN_H * 3600 * 1000) { console.log(`[ST] ${sym}:${sig.dir} 冷却中跳过`); continue; }
    if (dailyCount + pushed >= DAILY_MAX) { console.log(`[ST] 已达日限 ${DAILY_MAX}，停止`); break; }
    // 100x 固定风险仓位
    const stopDistPct = Math.abs(sig.entry - sig.stop) / sig.entry * 100;
    const posPct = Math.min(0.5, Number((RISK / stopDistPct / 100).toFixed(3)));
    const act = sig.dir === 'long' ? '做多' : '做空';
    const fmt = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(4);
    const msg = [
      `【W1 智能趋势】${sym} ${act}`,
      `入场 $${fmt(sig.entry)}（回调确认）｜止损 $${fmt(sig.stop)}｜盈亏比 1:${sig.rr}`,
      `目标 $${fmt(sig.t1)} / $${fmt(sig.t2)}`,
      `⚖️ 100x杠杆：保证金 ${posPct}%（名义 ${(posPct * 100).toFixed(1)}%）｜单笔风险 0.5%`,
      `确认：${sig.reason}`,
      `提示：仅供研究，不构成投资建议，盈亏自负`
    ].join('\n');
    let ok = false;
    try { ok = await pushToGroup(env, db, msg); } catch (e) { console.warn('[ST] push error:', e.message); }
    if (ok) {
      kvSet(db, cdKey, Date.now());
      kvSet(db, dailyKey, dailyCount + pushed + 1);
      db.prepare(`INSERT INTO signal_track (symbol, direction, entry, stop, target1, target2, rr, pos_pct, msg, status, pushed_at, strategy) VALUES (?,?,?,?,?,?,?,?,?,'OPEN',?,?)`)
        .run(sym, sig.dir, sig.entry, sig.stop, sig.t1, sig.t2, sig.rr, posPct, msg, Date.now(), 'ST');
      console.log(`[ST] PUSH ${sym}:${sig.dir} entry=${sig.entry} ${sig.reason}`);
      pushed++;
    } else {
      console.log(`[ST] ${sym} 推送失败（群未配置或错误）`);
    }
  }
  console.log(`[ST] 扫描 ${WATCH.length} 币, 信号 ${hits}, 推送 ${pushed}`);
  process.exit(0);
}
main().catch(e => { console.error('[ST] FATAL', e); process.exit(1); });
