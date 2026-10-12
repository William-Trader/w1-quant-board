'use strict';
// ============================================================
// 智能回测引擎 backtest.js（2026-08-08）
//  模式一 OKX：拉 OKX 历史 K 线（1H/15m）+ 费率历史，回测最长 30 天（价格/量/费率/news 维度）
//  模式二 本地：w1.db 快照回放，全因子（LSR/清算/KOL/费率），时长=数据覆盖（当前 ~24h）
//  - 交易模拟：限价/市价入场、止损/目标/48h 超时、冷却 4h、每日上限 12
//  - 统计：胜率/盈亏比/平均盈亏/总盈亏(1000U 本金)/最大回撤/按策略·币·方向拆分
//  - 仅供研究参考，不构成投资建议
// ============================================================
const { execFile } = require('child_process');
const { kvGet, kvSet } = require('./db');

const PROXY = process.env.PROXY_URL || 'http://127.0.0.1:7890';
const OKX = 'https://www.okx.com';
const CACHE_TTL = 6 * 3600 * 1000;

/* ---------- OKX 请求（curl 走代理，简单可靠） ---------- */
function okxGet(path, timeoutMs = 15000, retries = 3) {
  // 2026-09-07: 加自动重试(退避), 抵抗瞬时代理/网络抖动 -> 显著降"采集失败"
  const attempt = (n) => new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--max-time', String(timeoutMs / 1000), '--proxy', PROXY, OKX + path], (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('bad json: ' + String(stdout).slice(0, 120))); }
    });
  });
  return (async () => {
    let lastErr;
    for (let n = 0; n <= retries; n++) {
      if (n > 0) await new Promise(r => setTimeout(r, 400 * n)); // 0,400,800,1200ms
      try { return await attempt(n); }
      catch (e) { lastErr = e; }
    }
    throw lastErr;
  })();
}

/* ---------- 拉取 K 线（分页，缓存） ---------- */
async function fetchKlines(env, symbol, bar, days, bypassCache = false) {
  const cacheKey = `bt:klines:${symbol}:${bar}:${days}`;
  const cached = kvGet(env.db, cacheKey, null);
  if (!bypassCache && cached && cached.ts && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  const instId = symbol + '-USDT-SWAP';
  const all = [];
  let before = '';
  const need = Math.ceil(days * 24 * 60 / (bar === '15m' ? 15 : 60));
  let guard = 0;
  while (all.length < need && guard < 20) {
    guard++;
    let path = `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=300`;
    if (before) path += '&after=' + before;
    const r = await okxGet(path);
    if (r.code !== '0' || !Array.isArray(r.data) || !r.data.length) break;
    // OKX candles: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
    for (const c of r.data) {
      all.push({ ts: Number(c[0]), o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]), v: Number(c[5]) });
    }
    before = r.data[r.data.length - 1][0]; // 下一页（更早）
    await new Promise(res => setTimeout(res, 250)); // 限速
  }
  all.sort((a, b) => a.ts - b.ts);
  const data = all.slice(-need);
  kvSet(env.db, cacheKey, { ts: Date.now(), data });
  return data;
}

/* ---------- 拉取费率历史（8h 一条） ---------- */
async function fetchFunding(env, symbol, days) {
  const cacheKey = `bt:funding:${symbol}:${days}`;
  const cached = kvGet(env.db, cacheKey, null);
  if (cached && cached.ts && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  const instId = symbol + '-USDT-SWAP';
  const all = [];
  let before = '';
  let guard = 0;
  while (guard < 6) {
    guard++;
    let path = `/api/v5/public/funding-rate-history?instId=${instId}&limit=100`;
    if (before) path += '&before=' + before;
    const r = await okxGet(path);
    if (r.code !== '0' || !Array.isArray(r.data) || !r.data.length) break;
    for (const f of r.data) all.push({ ts: Number(f.fundingTime), rate: Number(f.fundingRate) });
    before = r.data[r.data.length - 1].fundingTime;
    await new Promise(res => setTimeout(res, 250));
  }
  all.sort((a, b) => a.ts - b.ts);
  kvSet(env.db, cacheKey, { ts: Date.now(), data: all });
  return all;
}

/* ---------- 小工具 ---------- */
const sma = (arr, n) => { if (arr.length < n) return null; let s = 0; for (let i = arr.length - n; i < arr.length; i++) s += arr[i]; return s / n; };
const emaArr = (arr, n) => { const k = 2 / (n + 1); const out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k)); return out; };
const adxOf = (bars, n = 14) => {
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
};
const rsiArr = (closes, n = 14) => {
  const out = new Array(closes.length).fill(50);
  for (let i = n; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - n + 1; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d > 0) g += d; else l -= d; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
};
const atrArr = (arr, n = 14) => { if (arr.length < n + 1) return null; const ds = []; for (let i = arr.length - n; i < arr.length; i++) ds.push(Math.abs(arr[i] - arr[i - 1])); return ds.reduce((a, b) => a + b, 0) / ds.length; };

function trendOf(closes) {
  if (closes.length < 13) return 'neutral';
  const px = closes[closes.length - 1];
  const s3 = sma(closes, 3), s6 = sma(closes, 6), s12 = sma(closes, 12);
  if (s3 === null || s6 === null || s12 === null) return 'neutral';
  if (px > s3 && s3 > s6 && s6 > s12) return 'long';
  if (px < s3 && s3 < s6 && s6 < s12) return 'short';
  return 'neutral';
}

function bollOf(closes) {
  if (closes.length < 21) return null;
  const slice = closes.slice(-20);
  const mid = sma(slice, 20);
  if (mid === null) return null;
  const v = slice.reduce((s, x) => s + (x - mid) * (x - mid), 0) / 20;
  const sd = Math.sqrt(v);
  return { up: mid + 2 * sd, lo: mid - 2 * sd, pos: (closes[closes.length - 1] - (mid - 2 * sd)) / (4 * sd) };
}

/* ---------- 回测主引擎（OKX 长周期模式） ---------- */
async function runOkxBacktest(env, opts) {
  const days = Math.min(Math.max(Number(opts.days) || 30, 1), 60);
  // 资金/杠杆参数：pnl_usd = 本金 × 仓位% × 杠杆 × 涨跌幅%
  const account = Math.max(Number(opts.account) || 1000, 100);
  const positionMode = opts.position_mode === 'fixed' ? 'fixed' : 'strategy';
  const posPctFixed = Math.min(Math.max(Number(opts.pos_pct_fixed) || 100, 1), 100);
  const leverage = Math.min(Math.max(Number(opts.leverage) || 1, 1), 125);
  const strategyFilter = (opts.strategy && opts.strategy !== 'all' && opts.strategy !== '全部') ? String(opts.strategy).toUpperCase() : null;
  const pnlOf = (pos, pnlPct) => {
    const eff = positionMode === 'fixed' ? posPctFixed : (pos.posPct || 3);
    return account * eff / 100 * leverage * pnlPct / 100;
  };
  const bar = opts.bar === '15m' ? '15m' : '1H';
  const symbols = (opts.symbols && opts.symbols.length ? opts.symbols : ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK']).slice(0, 10);
  const t0 = Date.now();
  const notes = [];
  const tradeList = [];
  const symbolsData = {};

  for (const sym of symbols) {
    const kl = await fetchKlines(env, sym, bar, days);
    if (!kl.length) { notes.push(`${sym}: K 线拉取失败，跳过`); continue; }
    const fr = await fetchFunding(env, sym, days);
    // 费率按时间填充到每根 K 线
    const rates = kl.map(k => {
      let r = 0, best = 0;
      for (const f of fr) {
        if (f.ts <= k.ts + (bar === '15m' ? 15 : 60) * 60 * 1000 && f.ts >= k.ts - 9 * 3600 * 1000) { r = f.rate; best = f.rate; }
      }
      return best || r;
    });
    symbolsData[sym] = { kl, rates };
  }
  if (!Object.keys(symbolsData).length) return { ok: false, error: 'no_okx_data' };

  // ST 日线指标预计算（仅 1H 模式）：从 1h K线按日合成 + EMA20/50/ADX
  if (bar === '1H') {
    for (const sym of Object.keys(symbolsData)) {
      const kl = symbolsData[sym].kl;
      const dayMap = new Map();
      for (const k of kl) {
        const d = new Date(k.ts).toISOString().slice(0, 10);
        const e = dayMap.get(d);
        if (!e) dayMap.set(d, { ts: k.ts, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
        else { e.h = Math.max(e.h, k.h); e.l = Math.min(e.l, k.l); e.c = k.c; e.v += k.v; }
      }
      const d1 = [...dayMap.values()].sort((a, b) => a.ts - b.ts);
      if (d1.length >= 40) {
        const dc = d1.map(x => x.c);
        symbolsData[sym].d1 = { ema20: emaArr(dc, 20), ema50: emaArr(dc, 50), adx: adxOf(d1), t0: d1[0].ts };
      }
    }
  }

  // 全局时间轴（取第一个币的时间，或合并所有 ts）
  const allTs = new Set();
  for (const sym of Object.keys(symbolsData)) for (const k of symbolsData[sym].kl) allTs.add(k.ts);
  const timeline = [...allTs].sort((a, b) => a - b);

  // news 历史（用于 RES 宏观情绪，仅覆盖最近 7 天）
  const newsRows = env.db.prepare("SELECT ts, sentiment, influence FROM news WHERE sentiment != 'neutral' ORDER BY ts").all();
  const newsScore = (ts) => {
    const dayAgo = ts - 86400 * 1000;
    let score = 0, bull = 0, bear = 0;
    for (const r of newsRows) {
      if (r.ts * 1000 < dayAgo || r.ts * 1000 > ts) continue;
      const w = Math.min(Number(r.influence || 1), 3);
      if (r.sentiment === 'bullish') { score += w; bull++; } else if (r.sentiment === 'bearish') { score -= w; bear++; }
    }
    if (bull >= 3 && score >= 5) return { dir: 'long', strength: Math.min(score / 20, 1) };
    if (bear >= 3 && score <= -5) return { dir: 'short', strength: Math.min(-score / 20, 1) };
    return { dir: null, strength: 0 };
  };

  const settings = require('./signal').loadSettings(env.db);
  const momCfg = settings.mom, resCfg = settings.res, stCfg = settings.st || { enabled: true }, frCfg = settings.fr || { enabled: true };
  const HOLD_MS = 48 * 3600 * 1000;
  const COOLDOWN_MS = settings.common.cooldown_h * 3600 * 1000;
  const MAX_DAILY = settings.common.daily_limit;
  const cfg = settings.common;

  const positions = [];  // 持仓（含保证金/名义/费用）
  const pending = [];    // 限价挂单（等回踩，48h 作废）
  const cooldown = {};
  const dailyCount = {};

  const trades = [];
  const acct = { equity: account, used: 0 }; // 账户权益 + 占用保证金
  let peak = 0, maxDd = 0;
  const eqCurve = [];
  const FEES_RATE = 0.0005; // taker 手续费（单边 0.05%）
  const openPos = (sym, dir, strat, factors, entry, stop, t1, t2, ts, posPct) => {
    const eff = positionMode === 'fixed' ? posPctFixed : (posPct || 3);
    const margin = acct.equity * eff / 100; // 保证金 = 当前权益 × 仓位%
    if (acct.used + margin > acct.equity + 1e-6) return false; // 资金不足：不开
    acct.used += margin;
    const notional = margin * leverage;
    const feeOpen = notional * FEES_RATE;
    acct.equity -= feeOpen; // 开仓手续费（从权益扣）
    positions.push({ symbol: sym, direction: dir, strategy: strat, factors: factors || [], entry, stop, t1, t2, ts, posPct: eff, margin, notional, fees: feeOpen });
    return true;
  };
  const settlePos = (pos, status, reason, exitPx, ts) => {
    const isLong = pos.direction === 'long';
    const pnlRaw = isLong ? (exitPx - pos.entry) / pos.entry * 100 : (pos.entry - exitPx) / pos.entry * 100;
    const feeClose = pos.notional * FEES_RATE;
    let pnlUsd = pos.notional * pnlRaw / 100 - pos.fees - feeClose;
    if (status !== 'OPEN' && pnlUsd <= -pos.margin) { pnlUsd = -pos.margin; status = 'LOSS'; reason = '爆仓'; } // 保证金亏完即爆仓
    acct.equity += pnlUsd;
    acct.used -= pos.margin;
    trades.push({ symbol: pos.symbol, direction: pos.direction, strategy: pos.strategy, factors: pos.factors, ts: pos.ts, entry: pos.entry, stop: pos.stop, t1: pos.t1, t2: pos.t2, posPct: pos.posPct, status, reason, exit_px: +exitPx.toFixed(4), exit_ts: ts, pnl_pct: +pnlRaw.toFixed(2), pnl_usd: +pnlUsd.toFixed(2) });
    const cum = acct.equity - account;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    eqCurve.push({ ts, equity: +cum.toFixed(2) });
  };

  const scanAt = (sym, data, idx, ts) => {
    const closes = data.kl.slice(Math.max(0, idx - 29), idx + 1).map(k => k.c);
    if (closes.length < 13) return null;
    const k = data.kl[idx];
    const trend = trendOf(closes);
    const boll = bollOf(closes);
    const px = k.c;
    const window = data.kl.slice(Math.max(0, idx - 11), idx + 1);
    const hi = Math.max(...window.map(x => x.h));
    const lo = Math.min(...window.map(x => x.l));
    const swing = (hi - lo) / lo * 100;
    const fromHigh = (px - hi) / hi * 100;
    const fromLow = (px - lo) / lo * 100;
    const lastMove = idx > 0 ? (px - data.kl[idx - 1].c) / data.kl[idx - 1].c * 100 : 0;
    const volMa = sma(window.map(x => x.v), 12);
    const volRatio = volMa > 0 ? k.v / volMa : 1;
    const funding = data.rates[idx];
    const chg1h = Number(k.c / data.kl[Math.max(0, idx - 1)].c - 1) * 100;
    const chg24 = idx >= 24 ? (px / data.kl[idx - 24].c - 1) * 100 : null;
    const res = [];
    // ---- FR（极端费率反转：RANGE 体制，4h 级别）----
    if (frCfg.enabled && idx >= 24) {
      const chg24v = idx >= 24 ? (px / data.kl[idx - 24].c - 1) : 0;
      const atr4 = atrArr(data.kl.slice(Math.max(0, idx - 27), idx + 1));
      const a4 = atr4 || px * 0.01;
      const rsi4 = rsiArr(data.kl.slice(Math.max(0, idx - 27), idx + 1).map(x => x.c));
      const r4 = rsi4[rsi4.length - 1];
      // funding 极端（用当前快照费率近似 z，历史不足 30 天时降级为绝对阈值）
      const fundingAbs = Math.abs(funding);
      if (fundingAbs >= 0.0005) {
        if (funding > 0 && chg24v >= (1.5 * a4) / px && r4 >= 75) {
          res.push({ strategy: 'FR', direction: 'short', factors: [`费率${(funding * 100).toFixed(3)}%`, `24h+${(chg24v * 100).toFixed(1)}%`, `RSI${r4.toFixed(0)}`], swing });
        } else if (funding < 0 && chg24v <= -(1.5 * a4) / px && r4 <= 25) {
          res.push({ strategy: 'FR', direction: 'long', factors: [`费率${(funding * 100).toFixed(3)}%`, `24h${(chg24v * 100).toFixed(1)}%`, `RSI${r4.toFixed(0)}`], swing });
        }
      }
    }
    // ---- ST（智能趋势：日线 EMA20/50 + ADX 定方向 → 1h 回调入场）----
    if (stCfg.enabled && bar === '1H' && data.d1 && data.d1.ema20.length >= 40 && idx >= 60) {
      const dIdx = Math.min(Math.floor((ts - data.d1.t0) / 86400000), data.d1.ema20.length - 1);
      if (dIdx >= 20) {
        const adxv = data.d1.adx[dIdx];
        const dUp = data.d1.ema20[dIdx] > data.d1.ema50[dIdx];
        const dDn = data.d1.ema20[dIdx] < data.d1.ema50[dIdx];
        if (adxv >= 20 && adxv <= 55 && (dUp || dDn)) {
          const e20 = emaArr(closes, 20), e50 = emaArr(closes, 50);
          const e20v = e20[e20.length - 1], e50v = e50[e50.length - 1];
          const rr = rsiArr(closes)[closes.length - 1];
          const e20Up = e20[e20.length - 1] > e20[e20.length - 4];
          const volAvg = sma(data.kl.slice(Math.max(0, idx - 19), idx + 1).map(x => x.v), 20);
          if (dUp) {
            if (px >= e50v * 1.002 && px <= e20v * 1.006 && px >= e20v * 0.986 && rr >= 45 && rr <= 65 && e20Up && lastMove >= 0) {
              res.push({ strategy: 'ST', direction: 'long', factors: [`日线多ADX${adxv.toFixed(0)}`, `回调EMA20`, `RSI${rr.toFixed(0)}`], swing });
            }
          } else if (dDn) {
            if (px <= e50v * 0.998 && px >= e20v * 0.994 && px <= e20v * 1.014 && rr <= 55 && rr >= 35 && !e20Up && lastMove <= 0) {
              res.push({ strategy: 'ST', direction: 'short', factors: [`日线空ADX${adxv.toFixed(0)}`, `反弹EMA20`, `RSI${rr.toFixed(0)}`], swing });
            }
          }
        }
      }
    }
    return res.length ? res[0] : null;
  };

  // 交易计划（简化版 buildPlan，基于 closes）
  const planOf = (direction, px, closes, funding) => {
    const a = atrArr(closes);
    const chg24 = closes.length >= 25 ? Math.abs(closes[closes.length - 1] / closes[closes.length - 25] - 1) : 0;
    const atrVal = Math.max(a && a > 0 ? a : px * Math.max(chg24 * 0.1, 0.004), px * 0.004);
    const swingPct = closes.length >= 20 ? (Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20))) / Math.min(...closes.slice(-20)) * 100 : 1;
    const mult = swingPct >= 6 ? 1.7 : swingPct >= 3 ? 1.45 : swingPct >= 1.5 ? 1.25 : 1;
    const stopMult = cfg.atr_stop_mult * mult;
    const levels = closes.slice(-20);
    const hiL = Math.max(...levels), loL = Math.min(...levels);
    let entry, stop, entryNote;
    if (direction === 'long') {
      const retrace = px - (px - loL) * cfg.entry_retrace;
      entry = (px - loL) / px < 0.012 ? px : retrace;
      entryNote = entry === px ? '突破启动' : '回踩0.382';
      stop = Math.max(Math.min(px - atrVal * stopMult, loL - atrVal * 0.3 * mult), px * 0.85);
    } else {
      const retrace = px + (hiL - px) * cfg.entry_retrace;
      entry = (hiL - px) / px < 0.012 ? px : retrace;
      entryNote = entry === px ? '突破启动' : '回踩0.382';
      stop = Math.min(Math.max(px + atrVal * stopMult, hiL + atrVal * 0.3 * mult), px * 1.15);
    }
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return null;
    const t1 = direction === 'long' ? entry + risk * cfg.fib_t1 : entry - risk * cfg.fib_t1;
    const t2 = direction === 'long' ? entry + risk * cfg.fib_t2 : entry - risk * cfg.fib_t2;
    const rr = Math.abs(t1 - entry) / risk;
    if (rr < cfg.min_rr) return null;
    let posPct = 3;
    const atrPct = atrVal / px * 100;
    if (atrPct < 0.4) posPct = 8; else if (atrPct < 0.8) posPct = 5;
    posPct = Math.min(posPct, cfg.max_pos_pct);
    return { entry, stop, t1, t2, rr, posPct, entryNote };
  };

  // 主回放循环
  for (let i = 0; i < timeline.length; i++) {
    const ts = timeline[i];
    const day = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    dailyCount[day] = dailyCount[day] || 0;

    // 1) 限价挂单成交：回踩到 entry 才成交；48h 未回踩作废
    for (let q = pending.length - 1; q >= 0; q--) {
      const pg = pending[q];
      const sd = symbolsData[pg.symbol];
      if (!sd) continue;
      const k = sd.kl.find(x => x.ts === ts);
      if (!k) continue;
      const hit = pg.direction === 'long' ? k.l <= pg.entry : k.h >= pg.entry;
      if (hit) openPos(pg.symbol, pg.direction, pg.strategy, pg.factors, pg.entry, pg.stop, pg.t1, pg.t2, ts, pg.posPct); // 资金不足则自动作废
      else if (ts - pg.ts > HOLD_MS) continue; // 超时作废
      else continue;
      pending.splice(q, 1);
    }
    // 2) 持仓检查（stop 先于 target 保守判定 + 爆仓）
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const sd = symbolsData[pos.symbol];
      if (!sd) continue;
      const k = sd.kl.find(x => x.ts === ts);
      if (!k) continue;
      let status = null, reason = null, exitPx = null;
      const isLong = pos.direction === 'long';
      if (isLong) {
        if (k.l <= pos.stop) { status = 'LOSS'; reason = '触及止损'; exitPx = pos.stop; }
        else if (k.h >= pos.t1) { status = 'WIN'; reason = '到达目标1'; exitPx = pos.t1; }
      } else {
        if (k.h >= pos.stop) { status = 'LOSS'; reason = '触及止损'; exitPx = pos.stop; }
        else if (k.l <= pos.t1) { status = 'WIN'; reason = '到达目标1'; exitPx = pos.t1; }
      }
      if (!status && ts - pos.ts > HOLD_MS) { status = 'FLAT'; reason = '48h超时'; exitPx = k.c; }
      if (status) { settlePos(pos, status, reason, exitPx, ts); positions.splice(p, 1); }
    }

    // 2) 新信号扫描
    if (i % (bar === '15m' ? 3 : 1) === 0) { // 15m 模式每 45min 扫一次控速
      for (const sym of Object.keys(symbolsData)) {
        const sd = symbolsData[sym];
        const idx = sd.kl.findIndex(x => x.ts === ts);
        if (idx < 0) continue;
        const hit = scanAt(sym, sd, idx, ts);
        if (!hit) continue;
        if (strategyFilter && hit.strategy !== strategyFilter) continue; // 单策略回测过滤
        const ck = sym + ':' + hit.direction;
        if (cooldown[ck] && ts - cooldown[ck] < COOLDOWN_MS) continue;
        if (dailyCount[day] >= MAX_DAILY) continue;
        const closes = sd.kl.slice(Math.max(0, idx - 29), idx + 1).map(k => k.c);
        const plan = planOf(hit.direction, sd.kl[idx].c, closes, sd.rates[idx]);
        if (!plan) continue;
        cooldown[ck] = ts;
        dailyCount[day]++;
        if (plan.entryNote === '突破启动') {
          openPos(sym, hit.direction, hit.strategy, hit.factors, sd.kl[idx].c, plan.stop, plan.t1, plan.t2, ts, plan.posPct); // 市价追单：立即成交（资金不足自动跳过）
        } else {
          pending.push({ symbol: sym, direction: hit.direction, strategy: hit.strategy, factors: hit.factors, entry: plan.entry, stop: plan.stop, t1: plan.t1, t2: plan.t2, ts, posPct: plan.posPct }); // 限价挂单：等回踩
        }
      }
    }
  }

  // 回测结束：剩余持仓按最后收盘结算
  const lastTs = timeline[timeline.length - 1];
  for (const pos of positions) {
    const sd = symbolsData[pos.symbol];
    const k = sd.kl[sd.kl.length - 1];
    const isLong = pos.direction === 'long';
    const pnl = isLong ? (k.c - pos.entry) / pos.entry * 100 : (pos.entry - k.c) / pos.entry * 100;
    settlePos(pos, 'OPEN', '回测结束未了结', k.c, k.ts);
  }
  for (const pg of pending) { /* 挂单未成交，作废不计 */ }

  // 统计
  const total = trades.length;
  const wins = trades.filter(t => t.status === 'WIN').length;
  const losses = trades.filter(t => t.status === 'LOSS').length;
  const flats = trades.filter(t => t.status === 'FLAT').length;
  const opens = trades.filter(t => t.status === 'OPEN').length;
  const closed = trades.filter(t => t.status !== 'OPEN');
  const pnls = closed.map(t => t.pnl_pct);
  const avgPnl = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
  const avgWin = wins ? trades.filter(t => t.status === 'WIN').map(t => t.pnl_pct).reduce((a, b) => a + b, 0) / wins : null;
  const avgLoss = losses ? trades.filter(t => t.status === 'LOSS').map(t => t.pnl_pct).reduce((a, b) => a + b, 0) / losses : null;
  const byStrategy = {};
  const bySymbol = {};
  for (const t of closed) {
    (byStrategy[t.strategy] = byStrategy[t.strategy] || { total: 0, win: 0, loss: 0, pnl: 0 });
    const b = byStrategy[t.strategy]; b.total++; if (t.status === 'WIN') b.win++; if (t.status === 'LOSS') b.loss++; b.pnl += t.pnl_usd;
    (bySymbol[t.symbol] = bySymbol[t.symbol] || { total: 0, win: 0, loss: 0, pnl: 0 });
    const s = bySymbol[t.symbol]; s.total++; if (t.status === 'WIN') s.win++; if (t.status === 'LOSS') s.loss++; s.pnl += t.pnl_usd;
  }

  notes.push('OKX 长周期回测（' + bar + ' K线 × ' + days + ' 天）');
  notes.push('已计入：双边手续费 0.05%、保证金占用、爆仓模拟、限价单需回踩成交（48h 未到作废）');
  notes.push('因子范围：价格/量/费率/趋势/布林（LSR/清算/KOL 无历史，仅本地模式可用）');
  if (days > 7) notes.push('RES 宏观情绪因子仅覆盖最近 7 天（news 历史限制）');

  return {
    ok: true, mode: 'okx', bar, days, symbols: Object.keys(symbolsData),
    generated_at: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    runtime_ms: Date.now() - t0,
    equity_curve: eqCurve,
    params: { account, position_mode: positionMode, pos_pct_fixed: posPctFixed, leverage },
    summary: {
      total, wins, losses, flats, opens,
      win_rate: total ? Math.round(wins / total * 100) : 0,
      avg_pnl: avgPnl != null ? +avgPnl.toFixed(2) : null,
      avg_win: avgWin != null ? +avgWin.toFixed(2) : null,
      avg_loss: avgLoss != null ? +avgLoss.toFixed(2) : null,
      total_pnl_usd: +(acct.equity - account).toFixed(2),
      max_drawdown_usd: +maxDd.toFixed(2),
      profit_factor: avgLoss ? +(Math.abs(avgWin * wins / (avgLoss * losses))).toFixed(2) : null
    },
    by_strategy: Object.entries(byStrategy).map(([k, v]) => ({ strategy: k, ...v, win_rate: v.total ? Math.round(v.win / v.total * 100) : 0 })),
    by_symbol: Object.entries(bySymbol).map(([k, v]) => ({ symbol: k, ...v, win_rate: v.total ? Math.round(v.win / v.total * 100) : 0 })),
    trades: [...trades].sort((a, b) => b.ts - a.ts).slice(0, 60),
    notes
  };
}

/* ---------- 本地深度回测（全因子，数据覆盖内） ---------- */
async function runLocalBacktest(ctx, opts) {
  const signal = require('./signal');
  const { db } = ctx;
  const settings = opts.settings || signal.loadSettings(db);
  const account = Math.max(Number(opts.account) || 1000, 100);
  const positionMode = opts.position_mode === 'fixed' ? 'fixed' : 'strategy';
  const posPctFixed = Math.min(Math.max(Number(opts.pos_pct_fixed) || 100, 1), 100);
  const leverage = Math.min(Math.max(Number(opts.leverage) || 1, 1), 125);
  const strategyFilter = (opts.strategy && opts.strategy !== 'all' && opts.strategy !== '全部') ? String(opts.strategy).toUpperCase() : null;
  const pnlOf = (pos, pnlPct) => {
    const eff = positionMode === 'fixed' ? posPctFixed : (pos.posPct || 3);
    return account * eff / 100 * leverage * pnlPct / 100;
  };
  const snaps = signal.futuresSnapshots(db, 10000);
  if (snaps.length < 30) return { ok: false, error: '本地快照不足（<30）' };
  const t0 = Date.now();
  const t1 = snaps[0].ts, t2 = snaps[snaps.length - 1].ts;
  const hours = (t2 - t1) / 3600;
  const COOLDOWN_MS = settings.common.cooldown_h * 3600 * 1000;
  const MAX_DAILY = settings.common.daily_limit;
  const positions = [], trades = [];
  const cooldown = {};
  let equity = 0, peak = 0, maxDd = 0;
  let traderMap = null, whaleMap = null;
  for (let i = 0; i < snaps.length; i++) {
    const cur = snaps[i];
    const prev = i > 0 ? snaps[i - 1] : null;
    const ts = cur.ts;
    const day = new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    // 持仓检查
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      const c = cur.m.get(pos.symbol);
      if (!c) continue;
      const px = Number(c.current_price);
      const isLong = pos.direction === 'long';
      let status = null, reason = null, exitPx = null;
      if (isLong) { if (px <= pos.stop) { status = 'LOSS'; reason = '触及止损'; exitPx = px; } else if (px >= pos.t1) { status = 'WIN'; reason = '到达目标1'; exitPx = px; } }
      else { if (px >= pos.stop) { status = 'LOSS'; reason = '触及止损'; exitPx = px; } else if (px <= pos.t1) { status = 'WIN'; reason = '到达目标1'; exitPx = px; } }
      if (!status && (ts - pos.ts) > 48 * 3600) { status = 'FLAT'; reason = '48h超时'; exitPx = px; }
      if (status) {
        const pnl = isLong ? (exitPx - pos.entry) / pos.entry * 100 : (pos.entry - exitPx) / pos.entry * 100;
        const u = pnlOf(pos, pnl);
        trades.push({ ...pos, status, reason, exit_ts: ts, pnl_pct: +pnl.toFixed(2), pnl_usd: +u.toFixed(2) });
        equity += u; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity);
        positions.splice(p, 1);
      }
    }
    // 扫描（每 3 根一次控速）
    if (i % 3 !== 0) continue;
    if (!traderMap) {
      const mk = (mode) => {
        const row = db.prepare('SELECT payload FROM lsr_rankings WHERE mode=? ORDER BY ts DESC LIMIT 1').get(mode);
        const m = new Map();
        if (!row) return m;
        try { const p = JSON.parse(row.payload); for (const c of (p.data || [])) if (c && c.symbol) m.set(c.symbol, c); } catch {}
        return m;
      };
      traderMap = mk('trader'); whaleMap = mk('whale');
    }
    for (const coin of cur.m.values()) {
      try {
        const r = signal.scanCoin(ctx, coin, coin.symbol, snaps.slice(Math.max(0, i - 29), i + 1), prev ? prev.m : null, settings, traderMap, whaleMap);
        if (!r.hit) continue;
        const ck = coin.symbol + ':' + r.hit.direction;
        if (cooldown[ck] && ts - cooldown[ck] < COOLDOWN_MS) continue;
        const dayCount = trades.filter(t => t.ts && new Date(t.ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === day).length + positions.filter(p => p.ts && new Date(p.ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === day).length;
        if (dayCount >= MAX_DAILY) continue;
        cooldown[ck] = ts;
        positions.push({ symbol: coin.symbol, direction: r.hit.direction, strategy: r.hit.strategy, factors: r.hit.factors, ts, entry: r.hit.plan.entry, stop: r.hit.plan.stop, t1: r.hit.plan.t1, posPct: r.hit.plan.posPct, entryNote: r.hit.plan.entryNote });
      } catch {}
    }
  }
  // 结算剩余
  const last = snaps[snaps.length - 1];
  for (const pos of positions) {
    const c = last.m.get(pos.symbol);
    const px = c ? Number(c.current_price) : pos.entry;
    const isLong = pos.direction === 'long';
    const pnl = isLong ? (px - pos.entry) / pos.entry * 100 : (pos.entry - px) / pos.entry * 100;
    const u = pnlOf(pos, pnl);
    trades.push({ ...pos, status: 'OPEN', reason: '数据结束未了结', pnl_pct: +pnl.toFixed(2), pnl_usd: +u.toFixed(2) });
    equity += u;
  }
  const total = trades.length;
  const wins = trades.filter(t => t.status === 'WIN').length;
  const losses = trades.filter(t => t.status === 'LOSS').length;
  const flats = trades.filter(t => t.status === 'FLAT').length;
  const closed = trades.filter(t => t.status !== 'OPEN');
  const pnls = closed.map(t => t.pnl_pct);
  const avgPnl = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
  const avgWin = wins ? trades.filter(t => t.status === 'WIN').map(t => t.pnl_pct).reduce((a, b) => a + b, 0) / wins : null;
  const avgLoss = losses ? trades.filter(t => t.status === 'LOSS').map(t => t.pnl_pct).reduce((a, b) => a + b, 0) / losses : null;
  return {
    ok: true, mode: 'local',
    generated_at: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    runtime_ms: Date.now() - t0,
    equity_curve: [],
    params: { account, position_mode: positionMode, pos_pct_fixed: posPctFixed, leverage },
    coverage_hours: +hours.toFixed(1),
    summary: {
      total, wins, losses, flats,
      opens: trades.filter(t => t.status === 'OPEN').length,
      win_rate: total ? Math.round(wins / total * 100) : 0,
      avg_pnl: avgPnl != null ? +avgPnl.toFixed(2) : null,
      avg_win: avgWin != null ? +avgWin.toFixed(2) : null,
      avg_loss: avgLoss != null ? +avgLoss.toFixed(2) : null,
      total_pnl_usd: +equity.toFixed(2),
      max_drawdown_usd: +maxDd.toFixed(2),
      profit_factor: avgLoss ? +(Math.abs(avgWin * wins / (avgLoss * losses))).toFixed(2) : null
    },
    by_strategy: [],
    by_symbol: [],
    trades: [...trades].sort((a, b) => b.ts - a.ts).slice(0, 60),
    notes: ['本地全因子回测（LSR/清算/KOL/费率 全部参与）', `覆盖 ${hours.toFixed(1)} 小时（数据仅存 ${Math.ceil(hours / 24)} 天）`]
  };
}

async function runBacktest(ctx, opts) {
  const mode = opts.mode === 'local' ? 'local' : 'okx';
  if (mode === 'local') return runLocalBacktest(ctx, opts);
  return runOkxBacktest(ctx.env, opts);
}

module.exports = { runBacktest, fetchKlines, fetchFunding };
