'use strict';
const { openRO, cached, ema, rsi, mean, std, percentile, pctRank, fmtDate } = require('./util');
const HIST = '/home/ubuntu/btc-oracle/backtest/hist.db';

function classifyRegime(ema20, ema60, slope20, volPct) {
  if (volPct != null && volPct >= 0.8) return 'high_vol';
  if (ema20 > ema60 && slope20 > 0) return 'trend_up';
  if (ema20 < ema60 && slope20 < 0) return 'trend_down';
  return 'range';
}

function loadRows() {
  const db = openRO(HIST);
  if (!db) return null;
  try {
    const rows = db.prepare("SELECT ts,o,h,l,c FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
    return rows.map(r => ({ ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
  } catch (e) { return null; }
  finally { try { db.close(); } catch (e) {} }
}

function aggregateTrades(trades) {
  const by = {};
  for (const t of trades) {
    const k = t.regime || 'unknown';
    if (!by[k]) by[k] = [];
    by[k].push(t.ret);
  }
  const out = {};
  for (const [k, arr] of Object.entries(by)) {
    const wins = arr.filter(x => x > 0), losses = arr.filter(x => x <= 0);
    const grossWin = wins.reduce((s, x) => s + x, 0);
    const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));
    let eq = 1, peak = 1, dd = 0;
    for (const r of arr) { eq *= (1 + r / 100); peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
    out[k] = {
      n: arr.length,
      win_rate_pct: +(100 * wins.length / arr.length).toFixed(1),
      avg_ret_pct: +mean(arr).toFixed(3),
      profit_factor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
      max_drawdown_pct: +(100 * dd).toFixed(1)
    };
  }
  return out;
}

function compute() {
  return cached('research:regime', 10 * 60 * 1000, () => {
    const rows = loadRows();
    if (!rows || rows.length < 300) return { ok: false, error: 'no_data', hint: 'hist.db klines BTCUSDT 为空' };
    const closes = rows.map(r => r.c), opens = rows.map(r => r.o), highs = rows.map(r => r.h), lows = rows.map(r => r.l);
    const e20 = ema(closes, 20), e60 = ema(closes, 60), r14 = rsi(closes, 14);
    const rets = closes.map((c, i) => i ? Math.log(c / closes[i - 1]) : 0);
    const vol30 = rets.map((_, i) => i < 30 ? null : std(rets.slice(i - 29, i + 1)));
    const volPct = vol30.map((v, i) => {
      if (v == null || i < 200) return null;
      return pctRank(vol30.slice(Math.max(0, i - 500), i + 1).filter(x => x != null), v);
    });
    const regimes = rows.map((r, i) => i < 100 ? null : classifyRegime(e20[i], e60[i], e20[i] - e20[i - 5], volPct[i]));

    const fwd = closes.map((_, i) => (i + 25 < opens.length) ? (opens[i + 25] - opens[i + 1]) / opens[i + 1] * 100 : null);
    const byRegime = {};
    for (let i = 100; i < rows.length - 25; i++) {
      const k = regimes[i]; if (!k || fwd[i] == null) continue;
      if (!byRegime[k]) byRegime[k] = [];
      byRegime[k].push(fwd[i]);
    }
    const regimeStats = Object.entries(byRegime).map(([k, arr]) => ({
      regime: k, n: arr.length,
      avg_fwd_24h_pct: +mean(arr).toFixed(3),
      win_rate_pct: +(100 * arr.filter(x => x > 0).length / arr.length).toFixed(1),
      p10_pct: +percentile(arr, 0.1).toFixed(2),
      p90_pct: +percentile(arr, 0.9).toFixed(2)
    })).sort((a, b) => b.n - a.n);

    function simulate(signalFn, hold = 24) {
      const trades = [];
      let i = 110;
      while (i < rows.length - hold - 2) {
        const sig = signalFn(i);
        if (!sig) { i++; continue; }
        const entry = opens[i + 1], exit = opens[i + 1 + hold];
        if (!(entry > 0) || !(exit > 0)) { i++; continue; }
        const gross = (exit - entry) / entry * 100 * (sig === 'long' ? 1 : -1);
        trades.push({ regime: regimes[i], ret: gross - 0.08 });
        i += hold + 2;
      }
      return trades;
    }

    const momentum = (i) => {
      if (i < 6) return null;
      if (e20[i] > e60[i] && e20[i - 1] <= e60[i - 1]) return 'long';
      if (e20[i] < e60[i] && e20[i - 1] >= e60[i - 1]) return 'short';
      return null;
    };
    const meanrev = (i) => (r14[i] == null ? null : r14[i] < 30 ? 'long' : r14[i] > 70 ? 'short' : null);
    const breakout = (i) => {
      const hi = Math.max.apply(null, highs.slice(i - 20, i));
      const lo = Math.min.apply(null, lows.slice(i - 20, i));
      if (closes[i] > hi) return 'long';
      if (closes[i] < lo) return 'short';
      return null;
    };
    const strategies = [
      { key: 'momentum', zh: '趋势动量 EMA20/60 交叉' },
      { key: 'meanrev', zh: '均值回归 RSI14 30/70' },
      { key: 'breakout', zh: '20 根突破' }
    ].map(s => {
      const fn = s.key === 'momentum' ? momentum : s.key === 'meanrev' ? meanrev : breakout;
      const trades = simulate(fn, 24);
      return Object.assign(s, { overall: aggregateTrades(trades).unknown || aggregateTrades(trades)[Object.keys(aggregateTrades(trades))[0]] || null, by_regime: aggregateTrades(trades), trades: trades.length });
    });

    return {
      ok: true, as_of: Math.floor(Date.now() / 1000),
      source: 'hist.db klines BTCUSDT 1h',
      coverage: { from: fmtDate(rows[0].ts), to: fmtDate(rows[rows.length - 1].ts), bars: rows.length },
      current: { regime: regimes[regimes.length - 1], ema20: +e20[e20.length - 1].toFixed(2), ema60: +e60[e60.length - 1].toFixed(2), vol_pct: volPct[volPct.length - 1] == null ? null : +(100 * volPct[volPct.length - 1]).toFixed(1) },
      regimes: regimeStats,
      strategies,
      notes: '体制在高波动(volPct≥80%)时优先标记 high_vol；策略按信号后下一根开盘进场，持有24根，扣0.08%往返手续费。样本为BTC 1h，其他币种/周期需单独验证。'
    };
  });
}

module.exports = { compute, classifyRegime };
