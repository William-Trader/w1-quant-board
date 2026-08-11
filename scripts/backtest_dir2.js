'use strict';
// W1 中低频方向系统回测 v3（2026-08-11）
// 升级: 单进程批量参数扫描 + 样本外验证（防过拟合）
//   - 训练段: 2024-01 ~ 2025-12（2年）
//   - 验证段: 2026-01 ~ 2026-08（样本外，选参后单独验证）
//   - 稳健性: 邻域参数平均分（防止尖峰过拟合）
const Database = require('better-sqlite3');
const db = new Database('/home/ubuntu/btc-oracle/backtest/hist.db', { readonly: true });
const dirEngine = require('../lib/dir_engine');

const rows = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
const h1 = rows.map(r => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
const funding = db.prepare('SELECT ts, rate FROM funding ORDER BY ts').all();
const fgi = db.prepare('SELECT ts, value FROM fgi ORDER BY ts').all();

function agg(bars, secs) {
  const out = []; let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.ts / (secs * 1000));
    if (!cur || cur.bucket !== bucket) { if (cur) out.push(cur); cur = { bucket, ts: b.ts, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  if (cur) out.push(cur);
  return out;
}
const h4 = agg(h1, 14400);
const d1 = agg(h1, 86400);
const fundTs = funding.map(f => f.ts), fundRate = funding.map(f => f.rate);
const fgiTs = fgi.map(f => f.ts), fgiVal = fgi.map(f => f.value);
function fundingWindow(ts, days = 30) {
  const cutoff = ts - days * 86400 * 1000; const out = [];
  for (let j = fundTs.length - 1; j >= 0; j--) { if (fundTs[j] < cutoff) break; out.push(fundRate[j]); }
  return out.reverse();
}
function lastFgi(ts) {
  let lo = 0, hi = fgiTs.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fgiTs[m] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  return fgiVal[ans];
}

// 预计算
const dc = d1.map(b => b.c);
const hc = h4.map(b => b.c);
const e20 = dirEngine.emaArr(dc, 20), e50 = dirEngine.emaArr(dc, 50), e200 = dirEngine.emaArr(dc, 200);
const adxD = dirEngine.adxArr(d1, 14);
const atrH = dirEngine.atrArr(h4, 14);

const d1IdxOf = (ts) => {
  let lo = 0, hi = d1.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (d1[m].ts <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
};

// 单次回测
function runBacktest(cfg, startTs, endTs) {
  const ENTRY_TH = cfg.entry_th, RISK_PCT = cfg.risk_pct, STOP_ATR = cfg.stop_atr;
  const T1_RR = cfg.t1_rr, T1_PCT = cfg.t1_pct ?? 50, TRAIL_ATR = cfg.trail_atr;
  const TIME_BARS = cfg.time_bars, MIN_R = cfg.min_r ?? 0.5, LEV_CAP = cfg.lev_cap ?? 50;
  const COOLDOWN_BARS = cfg.cooldown ?? 6;
  const PRINCIPAL = 10000;
  const USE_FUNDING = cfg.use_funding !== 0, USE_FGI = cfg.use_fgi !== 0;
  const startIdx = Math.max(90, h4.findIndex(b => b.ts >= startTs));
  const endIdx = h4.findIndex(b => b.ts > endTs) === -1 ? h4.length : h4.findIndex(b => b.ts > endTs);

  let trades = [], equity = PRINCIPAL, peak = PRINCIPAL, maxDd = 0;
  let dailyPnl = new Map(), pos = null;
  let cooldown = { long: -1e9, short: -1e9 };

  for (let i = startIdx; i < endIdx; i++) {
    const bar = h4[i]; const ts = bar.ts;
    const dayStr = new Date(ts).toISOString().slice(0, 10);
    if (pos) {
      pos.barsHeld++;
      const isLong = pos.dir === 'long';
      if (isLong) {
        const seg = h4.slice(Math.max(0, i - 40), i + 1);
        pos.trail = Math.max(Math.max(...seg.map(b => b.h)) - TRAIL_ATR * atrH[i], pos.partial ? pos.entry : 0);
      } else {
        const seg = h4.slice(Math.max(0, i - 40), i + 1);
        pos.trail = Math.min(Math.min(...seg.map(b => b.l)) + TRAIL_ATR * atrH[i], pos.partial ? pos.entry : Infinity);
      }
      let exitPx = null, reason = null;
      if (isLong && bar.l <= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
      else if (!isLong && bar.h >= pos.stop) { exitPx = pos.stop; reason = 'stop'; }
      else if (!pos.partial && isLong && bar.h >= pos.t1) { exitPx = pos.t1; reason = 't1'; }
      else if (!pos.partial && !isLong && bar.l <= pos.t1) { exitPx = pos.t1; reason = 't1'; }
      else if (pos.barsHeld >= 2 && isLong && bar.l <= pos.trail) { exitPx = pos.trail; reason = 'trail'; }
      else if (pos.barsHeld >= 2 && !isLong && bar.h >= pos.trail) { exitPx = pos.trail; reason = 'trail'; }
      else if (pos.barsHeld >= TIME_BARS) {
        const rNow = (isLong ? (bar.c - pos.entry) : (pos.entry - bar.c)) / Math.abs(pos.entry - pos.origStop);
        if (rNow >= MIN_R) { exitPx = bar.c; reason = 'timeout_win'; }
        else { exitPx = bar.c; reason = 'timeout'; }
      }
      if (exitPx != null) {
        const rTotal = (isLong ? (exitPx - pos.entry) : (pos.entry - exitPx)) / Math.abs(pos.entry - pos.origStop);
        if (reason === 't1') {
          const partReal = pos.riskUsd * (T1_PCT / 100) * rTotal;
          equity += partReal; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity);
          dailyPnl.set(dayStr, (dailyPnl.get(dayStr) || 0) + partReal);
          trades.push({ ts, day: dayStr, dir: pos.dir, entry: pos.entry, exit: pos.t1, reason: 't1', r: +rTotal.toFixed(2), pnl_usd: +partReal.toFixed(0), status: 'WIN' });
          pos = { ...pos, stop: pos.entry, t1: null, remaining: +(1 - T1_PCT / 100).toFixed(3), barsHeld: pos.barsHeld, partial: true, origStop: pos.origStop };
          continue;
        } else {
          const realized = pos.riskUsd * (pos.remaining || 1) * rTotal;
          equity += realized; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity);
          dailyPnl.set(dayStr, (dailyPnl.get(dayStr) || 0) + realized);
          const status = rTotal > 0 ? 'WIN' : 'LOSS';
          trades.push({ ts, day: dayStr, dir: pos.dir, entry: pos.entry, exit: +exitPx.toFixed(0), reason, r: +rTotal.toFixed(2), pnl_usd: +realized.toFixed(0), status });
          pos = null;
        }
      }
    }
    if (!pos) {
      const di = d1IdxOf(ts);
      if (di >= 60) {
        const regime = dirEngine.classifyRegime(d1.slice(0, di + 1), h4.slice(0, i + 1), i);
        const fz = USE_FUNDING ? dirEngine.zscoreOf(fundingWindow(ts)) : 0;
        const fv = USE_FGI ? lastFgi(ts) : null;
        const snaps = { fundingZ: fz, fgi: fv, oiChg: null, lsrTrader: null, lsrWhale: null, liqLongPct: null };
        const sd = dirEngine.scoreDirection(d1.slice(0, di + 1), h4.slice(0, i + 1), snaps);
        const score = sd.score;
        const canTrade = ['TREND_UP', 'TREND_DOWN', 'TURN_UP', 'TURN_DOWN'].includes(regime.type) || Math.abs(score) >= ENTRY_TH + 1.5;
        if (canTrade) {
          const dir = score >= ENTRY_TH ? 'long' : score <= -ENTRY_TH ? 'short' : null;
          if (dir && i - cooldown[dir] >= COOLDOWN_BARS) {
            const atrV = atrH[i] || bar.c * 0.01;
            const stopDistPct = Math.min(6, Math.max(0.8, STOP_ATR * atrV / bar.c * 100));
            const pp = dirEngine.positionPlan(PRINCIPAL, RISK_PCT, stopDistPct, regime.type, regime.vol_level, Math.abs(score));
            const leverage = Math.min(LEV_CAP, pp.leverage);
            const riskUsd = PRINCIPAL * RISK_PCT / 100;
            const stop = dir === 'long' ? bar.c * (1 - stopDistPct / 100) : bar.c * (1 + stopDistPct / 100);
            const t1 = dir === 'long' ? bar.c * (1 + stopDistPct * T1_RR / 100) : bar.c * (1 - stopDistPct * T1_RR / 100);
            pos = { dir, entry: bar.c, stop, origStop: stop, t1, trail: 0, barsHeld: 0, idx: i, notional: pp.notional_usd, margin: pp.notional_usd / leverage, riskUsd, remaining: 1, partial: false, regime: regime.type, day: dayStr };
            cooldown[dir] = i;
          }
        }
      }
    }
  }
  const settled = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
  const wins = settled.filter(t => t.status === 'WIN');
  const losses = settled.filter(t => t.status === 'LOSS');
  const winRate = settled.length ? wins.length / settled.length : 0;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b.r, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, b) => a + b.r, 0) / losses.length) : 0;
  const grossWin = wins.reduce((a, b) => a + b.r, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.r, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const days = [...dailyPnl.keys()].sort();
  const dailyReturns = days.map(d => (dailyPnl.get(d) || 0) / PRINCIPAL);
  const meanR = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const sdR = dailyReturns.length > 1 ? Math.sqrt(dailyReturns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (dailyReturns.length - 1)) : 0;
  const sharpe = sdR > 0 ? meanR / sdR * Math.sqrt(365) : 0;
  const totalRet = (equity - PRINCIPAL) / PRINCIPAL * 100;
  return { trades: trades.length, settled: settled.length, wins: wins.length, losses: losses.length, win_rate: +(winRate * 100).toFixed(1), avg_win_r: +avgWin.toFixed(2), avg_loss_r: +avgLoss.toFixed(2), profit_factor: +profitFactor.toFixed(2), sharpe: +sharpe.toFixed(2), total_ret_pct: +totalRet.toFixed(1), max_dd_pct: +(maxDd / PRINCIPAL * 100).toFixed(1), equity: +equity.toFixed(0), by_reason: trades.reduce((a, t) => { a[t.reason] = (a[t.reason] || 0) + 1; return a; }, {}), by_dir: trades.reduce((a, t) => { a[t.dir] = (a[t.dir] || 0) + 1; return a; }, {}) };
}

// 主入口：批量扫描
const TRAIN_START = Date.UTC(2024, 0, 1), TRAIN_END = Date.UTC(2025, 11, 31, 23, 59);
const TEST_START = Date.UTC(2026, 0, 1), TEST_END = Date.UTC(2026, 11, 31, 23, 59);
module.exports = { runBacktest, TRAIN_START, TRAIN_END, TEST_START, TEST_END };
if (require.main === module) {
  const scan = JSON.parse(process.argv[2] || '{}');
  const combos = scan.combos || [];
  const results = [];
  for (const c of combos) {
    const train = runBacktest(c, TRAIN_START, TRAIN_END);
    const test = runBacktest(c, TEST_START, TEST_END);
    results.push({ cfg: c, train, test });
  }
  console.log(JSON.stringify(results, null, 1));
}
