// W1 Signal v2 Backtest Engine
const D = require('better-sqlite3');
const db = new D('/home/ubuntu/w1-board/data/w1.db', { readonly: true });

// 50 币种：从 coinglass 最新快照动态获取（仅云端回测用，推送白名单固定 8 币）
const WATCH8 = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'XAU'];
const SYMBOLS = process.argv[3] === '8'
  ? WATCH8
  : (() => {
      try {
        const r = db.prepare('SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 1').get();
        const arr = JSON.parse(r.payload).data || [];
        return arr.map(x => x.symbol).filter(Boolean);
      } catch { return WATCH8; }
    })();
const FEE = 0.0005, SLIP = 0.0002;
const LEV = 100, RISK = 0.005;
const MAX_POS = 3, DAILY_LOSS_LIMIT = 0.03, DD_LIMIT = 0.08;
const COOLDOWN_H = 2, DAILY_MAX_TRADES = 8;
const WINDOW_DAYS = 10; // MOM 用 10 天 K线; 因子策略自动受限

async function fetchKlines(sym, days = 41) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym}_USDT&interval=1h&from=${from}&to=${to}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${sym} kline http ${r.status}`);
  const arr = await r.json();
  // gate 格式: [ts, quote_vol, close, high, low, open, base_vol, closed]
  return arr.map(c => ({ t: +c[0], o: +c[5], h: +c[3], l: +c[4], c: +c[2], v: +c[6] })).sort((a, b) => a.t - b.t);
}
async function fetchD1(sym, days = 300) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym}_USDT&interval=1d&from=${from}&to=${to}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${sym} d1 http ${r.status}`);
  const arr = await r.json();
  return arr.map(c => ({ t: +c[0], o: +c[5], h: +c[3], l: +c[4], c: +c[2], v: +c[6] })).sort((a, b) => a.t - b.t);
}
function loadFactorRows(sql) { return db.prepare(sql).all(); }
function nearest(rowArr, t) {
  let lo = 0, hi = rowArr.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rowArr[mid].ts <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best >= 0 ? rowArr[best] : null;
}
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
function atr(bars, n = 14) {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    out[i] = i === 1 ? tr : (out[i - 1] * (n - 1) + tr) / n;
  }
  return out;
}
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sg = ema(line, sig);
  return { line, sg, hist: line.map((v, i) => v - sg[i]) };
}

// ---- 策略信号 (v2) ----
function momSignal(i, bars, A, lsrRow, futRow, k) {
  if (i < 100) return null;
  const px = bars[i].c;
  const chg1h = (px - bars[i - 1].c) / bars[i - 1].c * 100;
  const hi24 = Math.max(...bars.slice(i - 24, i + 1).map(b => b.h));
  const lo24 = Math.min(...bars.slice(i - 24, i + 1).map(b => b.l));
  const r = rsi(k.closes, 14)[i];
  const trendUp = k.ema20[i] > k.ema50[i];
  const lsr = lsrRow ? (lsrRow.trader_ratio || 1) : 1;
  const funding = futRow ? (futRow.avg_funding_rate_by_oi || 0) : 0;
  // 做空: 冲高回落
  if (chg1h >= 0.8 && (hi24 - px) / hi24 >= 0.0035 && r > 58) {
    let score = 2;
    if (funding > 0.0002) score++;
    if (lsr > 1.08) score++;
    if (!trendUp) score++; else score--;
    if (score >= 2) return { strat: 'MOM', dir: 'short', reason: `冲高 r${r.toFixed(0)} s${score} 1h${chg1h.toFixed(1)}%` };
  }
  // 做多: 急跌反弹
  if (chg1h <= -0.8 && (px - lo24) / lo24 >= 0.0035 && r < 42) {
    let score = 2;
    if (funding < -0.0002) score++;
    if (lsr < 0.92) score++;
    if (trendUp) score++; else score--;
    if (score >= 2) return { strat: 'MOM', dir: 'long', reason: `急跌 r${r.toFixed(0)} s${score} 1h${chg1h.toFixed(1)}%` };
  }
  return null;
}

function resSignal(i, bars, k, consRow) {
  if (i < 60 || !consRow || !consRow.decision) return null;
  const r = rsi(k.closes, 14)[i];
  const m = k.macd;
  let tech = 0;
  if (k.ema20[i] > k.ema50[i]) tech++; else tech--;
  if (bars[i].c > k.ema20[i] && r > 50) tech++; else if (bars[i].c < k.ema20[i] && r < 50) tech--;
  if (m.hist[i] > 0 && m.hist[i] > m.hist[i - 1]) tech++; else if (m.hist[i] < 0 && m.hist[i] < m.hist[i - 1]) tech--;
  if (consRow.decision === 'long' && tech >= 2) return { strat: 'RES', dir: 'long', reason: `共识多+技术${tech}` };
  if (consRow.decision === 'short' && tech <= -2) return { strat: 'RES', dir: 'short', reason: `共识空+技术${tech}` };
  return null;
}

function cloudSignal(i, bars, k, consRow) {
  if (i < 30 || !consRow) return null;
  const bias = consRow.trust_adjusted_bias || 0;
  const conf = consRow.confidence || 0;
  if (Math.abs(bias) < 0.03) return null;
  if (conf < 0.35) return null;
  const dir = bias > 0 ? 'long' : 'short';
  if (dir === 'long' && bars[i].c < k.ema20[i]) return null;
  if (dir === 'short' && bars[i].c > k.ema20[i]) return null;
  return { strat: 'CLOUD', dir, reason: `共识${dir} bias${bias.toFixed(3)} conf${conf.toFixed(2)}` };
}

function r3dSignal(i, bars, futRow, lsrRow, k) {
  if (i < 60 || !futRow || !lsrRow) return null;
  const chg1h = futRow.price_change_percent_1h || 0;
  const funding = futRow.avg_funding_rate_by_oi || 0;
  const lsr5 = futRow.long_short_ratio_5m || (lsrRow.trader_ratio || 1);
  const dims = [];
  if (Math.abs(chg1h) >= 0.8) dims.push(chg1h > 0 ? 'long' : 'short');
  if (funding > 0.0002) dims.push('short'); else if (funding < -0.0002) dims.push('long');
  if (lsr5 > 1.2) dims.push('long'); else if (lsr5 < 0.85) dims.push('short');
  if (dims.length < 3) return null;
  if (!(dims[0] === dims[1] && dims[1] === dims[2])) return null;
  const dir = dims[0];
  if (dir === 'long' && k.ema20[i] < k.ema50[i]) return null;
  if (dir === 'short' && k.ema20[i] > k.ema50[i]) return null;
  return { strat: 'R3D', dir, reason: `三维 1h${chg1h.toFixed(1)}% 费${funding.toFixed(4)} LSR${lsr5.toFixed(2)}` };
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

// ---- SmartTrend 智能趋势: 日线大级别定方向 + 1h回调入场 ----
function smartTrendSignal(i, bars, k, d1, A) {
  if (i < 60 || !d1 || d1.ema20.length < 40) return null;
  // 日线大级别：EMA20 vs EMA50 + ADX≥20
  const dIdx = Math.min(Math.floor((bars[i].t - d1.t0) / 86400), d1.ema20.length - 1);
  if (dIdx < 20) return null;
  const adxv = d1.adx[dIdx];
  if (adxv < 20 || adxv > 55) return null;
  const up = d1.ema20[dIdx] > d1.ema50[dIdx];
  const dn = d1.ema20[dIdx] < d1.ema50[dIdx];
  if (!up && !dn) return null;
  const px = bars[i].c;
  const ema20 = k.ema20[i], ema50 = k.ema50[i];
  const r = rsi(k.closes, 14)[i];
  const vol = bars[i].v;
  const volAvg = sma(bars.map(b => b.v), 20)[i] || 1;
  const ema20Up = k.ema20[i] > k.ema20[i - 3];
  if (up) {
    if (px < ema50 * 1.002) return null;
    const retrace = px <= ema20 * 1.006 && px >= ema20 * 0.986;
    if (retrace && r >= 45 && r <= 65 && vol >= volAvg * 0.85 && bars[i].c >= bars[i - 1].c && ema20Up) {
      return { strat: 'ST', dir: 'long', reason: `日线多 ADX${adxv.toFixed(0)} 回调EMA20 RSI${r.toFixed(0)}` };
    }
  } else {
    if (px > ema50 * 0.998) return null;
    const retrace = px >= ema20 * 0.994 && px <= ema20 * 1.014;
    if (retrace && r <= 55 && r >= 35 && vol >= volAvg * 0.85 && bars[i].c <= bars[i - 1].c && !ema20Up) {
      return { strat: 'ST', dir: 'short', reason: `日线空 ADX${adxv.toFixed(0)} 反弹EMA20 RSI${r.toFixed(0)}` };
    }
  }
  return null;
}

function runBacktest(sym, bars, futRows, consRows, lsrRows, opts, d1) {
  const A = atr(bars, 14);
  const closes = bars.map(b => b.c);
  const k = { ema20: ema(closes, 20), ema50: ema(closes, 50), macd: macd(closes), closes };
  const sma20 = sma(closes, 20), sd = sma(closes, 20).map((m, i) => { if (m == null) return null; return Math.sqrt(closes.slice(i - 19, i + 1).reduce((a, c) => a + (c - m) ** 2, 0) / 20); });
  k.bbHi = sma20.map((m, i) => m == null ? null : m + 2 * sd[i]);
  k.bbLo = sma20.map((m, i) => m == null ? null : m - 2 * sd[i]);

  const trades = [];
  let pos = null, balance = 1, peak = 1, dailyPnL = 0, lastDay = 0, tradesToday = 0, lastTradeTs = 0;
  let stCalls = 0, stHits = 0;
  const openPos = [];
  const stopOut = (i, px, reason) => {
    const p = pos;
    const pnl = (px - p.entry) / p.entry * (p.dir === 'long' ? 1 : -1) * p.qtyNotional;
    trades.push({ strat: p.strat, dir: p.dir, entry: p.entry, exit: px, pnl, reason, barsHeld: i - p.entryBar, ts: bars[i].t, entryTs: p.ts });
    balance += pnl; openPos.splice(openPos.indexOf(p), 1); pos = null;
    dailyPnL += pnl; tradesToday++;
  };
  for (let i = 100; i < bars.length; i++) {
    const px = bars[i].c;
    const day = new Date(bars[i].t * 1000).getUTCDate();
    if (day !== lastDay) { lastDay = day; dailyPnL = 0; tradesToday = 0; }
    const dd = balance / peak - 1;
    if (balance > peak) peak = balance;
    const halted = dd <= -DD_LIMIT || dailyPnL <= -DAILY_LOSS_LIMIT;

    if (pos) {
      pos.barsHeld++;
      if (pos.barsHeld >= 120) stopOut(i, px, '超时120h');
      else if (pos.dir === 'long') {
        pos.stop = Math.max(pos.stop, px - 4 * A[i]);
        if (px <= pos.stop) stopOut(i, px, '止损/追踪');
        else if (px >= pos.tp1 && !pos.tp1Hit) { pos.tp1Hit = true; pos.stop = Math.max(pos.stop, pos.entry * 1.008); }
        else if (px >= pos.tp2) stopOut(i, px, '止盈6R');
      } else {
        pos.stop = Math.min(pos.stop, px + 4 * A[i]);
        if (px >= pos.stop) stopOut(i, px, '止损/追踪');
        else if (px <= pos.tp1 && !pos.tp1Hit) { pos.tp1Hit = true; pos.stop = Math.min(pos.stop, pos.entry * 0.992); }
        else if (px <= pos.tp2) stopOut(i, px, '止盈6R');
      }
    }
    if (pos || halted || openPos.length >= MAX_POS) continue;
    if (bars[i].t - lastTradeTs < COOLDOWN_H * 3600) continue;
    if (tradesToday >= DAILY_MAX_TRADES) continue;

    const futRow = nearest(futRows, bars[i].t);
    const lsrRow = nearest(lsrRows, bars[i].t);
    const consRow = nearest(consRows, bars[i].t);

    let sig = null;
    if (opts.mom) sig = momSignal(i, bars, A, lsrRow, futRow, k);
    if (!sig && opts.res) sig = resSignal(i, bars, k, consRow);
    if (!sig && opts.cloud) sig = cloudSignal(i, bars, k, consRow);
    if (!sig && opts.r3d) sig = r3dSignal(i, bars, futRow, lsrRow, k);
    if (!sig && opts.st && d1) { stCalls++; sig = smartTrendSignal(i, bars, k, d1, A); if (sig) stHits++; }
    if (!sig) continue;
    if (i + 1 >= bars.length) continue;
    const entryPx = bars[i + 1].o;
    const stopPct = Math.min(0.03, Math.max(0.004, (3.0 * A[i]) / entryPx));
    const qtyNotional = RISK / stopPct;
    pos = {
      dir: sig.dir, entry: entryPx, stop: sig.dir === 'long' ? entryPx * (1 - stopPct) : entryPx * (1 + stopPct),
      qtyNotional, strat: sig.strat, barsHeld: 0, entryBar: i + 1,
      tp1: sig.dir === 'long' ? entryPx * (1 + 3 * stopPct) : entryPx * (1 - 3 * stopPct),
      tp2: sig.dir === 'long' ? entryPx * (1 + 6 * stopPct) : entryPx * (1 - 6 * stopPct),
      tp1Hit: false, ts: bars[i + 1].t
    };
    balance -= qtyNotional * (FEE + SLIP);
    openPos.push(pos);
    lastTradeTs = bars[i + 1].t;
  }
  if (pos) stopOut(bars.length - 1, bars[bars.length - 1].c, '期末平仓');
  return { trades, finalBalance: balance, stCalls, stHits };
}

function summarize(res, sym, stratName) {
  const tr = res.trades;
  const wins = tr.filter(t => t.pnl > 0), losses = tr.filter(t => t.pnl <= 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = losses.reduce((a, t) => a + t.pnl, 0);
  const pf = gl === 0 ? (gp > 0 ? 99 : 0) : Math.abs(gp / gl);
  let peak = 1, bal = 1, mdd = 0;
  for (const t of tr) { bal += t.pnl; if (bal > peak) peak = bal; mdd = Math.max(mdd, peak - bal); }
  return { sym, strat: stratName, trades: tr.length, winRate: tr.length ? wins.length / tr.length : 0, pf, net: gp + gl, mdd, final: res.finalBalance,
    reasons: tr.slice(-8).map(t => `${t.strat}${t.dir} ${new Date(t.entryTs * 1000).toISOString().slice(5, 16)} 持${t.barsHeld}bar ${t.reason} → ${(t.pnl * 100).toFixed(2)}%`) };
}


async function runBacktestAPI(opts = {}) {
  const mode = (opts.strategy || 'all').toUpperCase();
  const stratOpts = mode === 'ALL' ? ['MOM', 'RES', 'CLOUD', 'R3D', 'ST'] : mode.split('+').map(s => s.trim().toUpperCase());
  const OPTMAP = { MOM: 'mom', RES: 'res', CLOUD: 'cloud', R3D: 'r3d', ST: 'st' };
  const optsAll = {};
  for (const s of stratOpts) if (OPTMAP[s]) optsAll[OPTMAP[s]] = true;
  const days = Math.min(Math.max(Number(opts.days) || 41, 7), 60);
  const symList = Array.isArray(opts.symbols) && opts.symbols.length ? opts.symbols : SYMBOLS;
  const futAll = loadFactorRows('SELECT payload, ts FROM futures_markets ORDER BY ts');
  const consAll = loadFactorRows('SELECT payload, ts FROM consensus ORDER BY ts');
  const lsrAll = loadFactorRows('SELECT payload, ts, mode FROM lsr_rankings ORDER BY ts');
  const futRows = futAll.map(r => { let d = []; try { d = JSON.parse(r.payload).data || []; } catch {} return { ts: r.ts, map: new Map(d.map(x => [x.symbol, x])) }; });
  const consRows = consAll.map(r => { let p = null; try { p = JSON.parse(r.payload); } catch {} const items = p && typeof p === 'object' ? Object.values(p) : []; return { ts: r.ts, map: new Map(items.map(x => [x.symbol, x])) }; });
  const lsrRows = lsrAll.filter(r => r.mode === 'trader').map(r => { let d = []; try { d = JSON.parse(r.payload).data || []; } catch {} return { ts: r.ts, map: new Map(d.map(x => [x.symbol, x])) }; });

  if (mode === 'stats') {
    // 统计信号条件命中率
    for (const sym of symList) {
      let bars;
      try { bars = await fetchKlines(sym); } catch (e) { continue; }
      if (bars.length < 200) continue;
      const closes = bars.map(b => b.c);
      const R = rsi(closes, 14);
      const V = sma(bars.map(b => b.v), 20);
      let c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0;
      for (let i = 100; i < bars.length; i++) {
        const chg1h = (bars[i].c - bars[i - 4].c) / bars[i - 4].c * 100;
        const hi24 = Math.max(...bars.slice(i - 96, i + 1).map(b => b.h));
        const lo24 = Math.min(...bars.slice(i - 96, i + 1).map(b => b.l));
        if (Math.abs(chg1h) >= 0.8) c1++;
        if (chg1h >= 0.8 && (hi24 - bars[i].c) / hi24 >= 0.003 && R[i] > 58) c2++;
        if (chg1h <= -0.8 && (bars[i].c - lo24) / lo24 >= 0.003 && R[i] < 42) c3++;
        if (R[i] > 65 || R[i] < 35) c4++;
        if (V[i] && bars[i].v >= V[i] * 1.1) c5++;
      }
      console.log(`${sym}: |1h|≥0.8%:${c1} 做空候选:${c2} 做多候选:${c3} RSI极端:${c4} 放量:${c5} (bars=${bars.length})`);
    }
    return;
  }

  const perStrat = { MOM: [], RES: [], CLOUD: [], R3D: [], ST: [] };
  let grand = 0, grandTrades = 0;
  for (const sym of symList) {
    let bars;
    try { bars = await fetchKlines(sym); } catch (e) { console.log(`[${sym}] K线失败: ${e.message}`); continue; }
    if (bars.length < 200) { console.log(`[${sym}] bar少 ${bars.length}`); continue; }
    // 直接用 1h bars（41 天全窗口回测；因子策略因数据窗自然受限）
    // 日线大级别指标（SmartTrend 用）
    let d1 = null;
    try {
      const d1raw = await fetchD1(sym);
      if (d1raw && d1raw.length >= 40) {
        const d1c = d1raw.map(b => b.c);
        d1 = { ema20: ema(d1c, 20), ema50: ema(d1c, 50), adx: adxCalc(d1raw), t0: d1raw[0].t };
      } else console.log(`[${sym}] d1 数据不足`);
    } catch (e) { console.log(`[${sym}] d1 失败: ${e.message}`); }
    // 合成 4h bar (每4根1h)（备用）
    const h4 = [];
    for (let i = 0; i + 3 < bars.length; i += 4) {
      const seg = bars.slice(i, i + 4);
      h4.push({ t: seg[0].t, o: seg[0].o, h: Math.max(...seg.map(b => b.h)), l: Math.min(...seg.map(b => b.l)), c: seg[3].c, v: seg.reduce((a, b) => a + b.v, 0) });
    }
    const h4c = h4.map(b => b.c);
    const h4k = { ema50: ema(h4c, 50), ema200: ema(h4c, 200), adx: adxCalc(h4) };
    // 按 1h 索引对齐 h4 指标（每个 1h bar 用其所属 4h bar 的指标）
    const h4aligned = { ema50: [], ema200: [], adx: [] };
    for (let i = 0; i < bars.length; i++) {
      const hi = Math.min(Math.floor(i / 4), h4c.length - 1);
      h4aligned.ema50.push(h4k.ema50[hi]);
      h4aligned.ema200.push(h4k.ema200[hi]);
      h4aligned.adx.push(h4k.adx[hi]);
    }
    const fut = futRows.map(r => { const x = r.map.get(sym); return x ? { ts: r.ts, ...x } : null; }).filter(Boolean);
    const cons = consRows.map(r => { const x = r.map.get(sym + 'USDT') || r.map.get(sym + '_USDT'); return x ? { ts: r.ts, decision: x.decision, trust_adjusted_bias: x.trust_adjusted_bias, confidence: x.confidence } : null; }).filter(Boolean);
    const lsr = lsrRows.map(r => { const x = r.map.get(sym + 'USDT') || r.map.get(sym + '_USDT'); return x ? { ts: r.ts, trader_ratio: x.trader_ratio || x.ratio } : null; }).filter(Boolean);
    console.log(`[${sym}] bars=${bars.length} fut=${fut.length} cons=${cons.length} lsr=${lsr.length}`);
    const r = runBacktest(sym, bars, fut, cons, lsr, optsAll, d1);
    console.log(`[${sym}] stCalls=${r.stCalls} stHits=${r.stHits}`);
    const trades = r.trades;
    const byStrat = {};
    for (const t of trades) { (byStrat[t.strat] = byStrat[t.strat] || []).push(t); }
    for (const nm of stratOpts) {
      if (!byStrat[nm]) continue;
      const sub = summarize({ trades: byStrat[nm], finalBalance: 1 + byStrat[nm].reduce((a, t) => a + t.pnl, 0) }, sym, nm);
      perStrat[nm].push(sub); grand += byStrat[nm].reduce((a, t) => a + t.pnl, 0); grandTrades += byStrat[nm].length;
    }
  }
  for (const [name, arr] of Object.entries(perStrat)) {
    if (!arr.length) continue;
    const all = arr.reduce((a, s) => a + s.net, 0);
    const tr = arr.reduce((a, s) => a + s.trades, 0);
    const wins = arr.reduce((a, s) => a + Math.round(s.winRate * s.trades), 0);
    const pf = arr.reduce((a, s) => a + s.pf, 0) / arr.length;
    console.log(`\n===== ${name} ===== 交易${tr} 胜率${tr ? (wins / tr * 100).toFixed(1) : 0}% PF${pf.toFixed(2)} 净${(all * 100).toFixed(2)}%`);
    for (const s of arr) if (s.trades) console.log(`  ${s.sym}: ${s.trades}笔 胜${(s.winRate * 100).toFixed(0)}% PF${s.pf.toFixed(2)} 净${(s.net * 100).toFixed(2)}% 回撤${(s.mdd * 100).toFixed(2)}% | ${s.reasons.join(' | ')}`);
  }
  console.log(`\n===== 合计 ${grandTrades}笔 净${(grand * 100).toFixed(2)}% =====`);
  const out = { ok: true, strategies: {}, summary: { trades: grandTrades, net: +(grand * 100).toFixed(2) } };
  for (const [name, arr] of Object.entries(perStrat)) {
    if (!arr.length) continue;
    const all = arr.reduce((a, s) => a + s.net, 0);
    const tr = arr.reduce((a, s) => a + s.trades, 0);
    const wins = arr.reduce((a, s) => a + Math.round(s.winRate * s.trades), 0);
    const pf = arr.reduce((a, s) => a + s.pf, 0) / arr.length;
    out.strategies[name] = {
      trades: tr, winRate: tr ? +(wins / tr * 100).toFixed(1) : 0, pf: +pf.toFixed(2),
      net: +(all * 100).toFixed(2), coins: arr.map(s => ({ sym: s.sym, trades: s.trades, winRate: +(s.winRate * 100).toFixed(0), pf: +s.pf.toFixed(2), net: +(s.net * 100).toFixed(2), mdd: +(s.mdd * 100).toFixed(2), reasons: s.reasons }))
    };
  }
  return out;
}
module.exports = { runBacktestAPI, WATCH8 };

// CLI 模式
if (require.main === module) {
  (async () => {  const futAll = loadFactorRows('SELECT payload, ts FROM futures_markets ORDER BY ts');
  const consAll = loadFactorRows('SELECT payload, ts FROM consensus ORDER BY ts');
  const lsrAll = loadFactorRows('SELECT payload, ts, mode FROM lsr_rankings ORDER BY ts');
  const futRows = futAll.map(r => { let d = []; try { d = JSON.parse(r.payload).data || []; } catch {} return { ts: r.ts, map: new Map(d.map(x => [x.symbol, x])) }; });
  const consRows = consAll.map(r => { let p = null; try { p = JSON.parse(r.payload); } catch {} const items = p && typeof p === 'object' ? Object.values(p) : []; return { ts: r.ts, map: new Map(items.map(x => [x.symbol, x])) }; });
  const lsrRows = lsrAll.filter(r => r.mode === 'trader').map(r => { let d = []; try { d = JSON.parse(r.payload).data || []; } catch {} return { ts: r.ts, map: new Map(d.map(x => [x.symbol, x])) }; });

  if (mode === 'stats') {
    // 统计信号条件命中率
    for (const sym of symList) {
      let bars;
      try { bars = await fetchKlines(sym); } catch (e) { continue; }
      if (bars.length < 200) continue;
      const closes = bars.map(b => b.c);
      const R = rsi(closes, 14);
      const V = sma(bars.map(b => b.v), 20);
      let c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0;
      for (let i = 100; i < bars.length; i++) {
        const chg1h = (bars[i].c - bars[i - 4].c) / bars[i - 4].c * 100;
        const hi24 = Math.max(...bars.slice(i - 96, i + 1).map(b => b.h));
        const lo24 = Math.min(...bars.slice(i - 96, i + 1).map(b => b.l));
        if (Math.abs(chg1h) >= 0.8) c1++;
        if (chg1h >= 0.8 && (hi24 - bars[i].c) / hi24 >= 0.003 && R[i] > 58) c2++;
        if (chg1h <= -0.8 && (bars[i].c - lo24) / lo24 >= 0.003 && R[i] < 42) c3++;
        if (R[i] > 65 || R[i] < 35) c4++;
        if (V[i] && bars[i].v >= V[i] * 1.1) c5++;
      }
      console.log(`${sym}: |1h|≥0.8%:${c1} 做空候选:${c2} 做多候选:${c3} RSI极端:${c4} 放量:${c5} (bars=${bars.length})`);
    }
    return;
  }

  const perStrat = { MOM: [], RES: [], CLOUD: [], R3D: [], ST: [] };
  let grand = 0, grandTrades = 0;
  for (const sym of symList) {
    let bars;
    try { bars = await fetchKlines(sym); } catch (e) { console.log(`[${sym}] K线失败: ${e.message}`); continue; }
    if (bars.length < 200) { console.log(`[${sym}] bar少 ${bars.length}`); continue; }
    // 直接用 1h bars（41 天全窗口回测；因子策略因数据窗自然受限）
    // 日线大级别指标（SmartTrend 用）
    let d1 = null;
    try {
      const d1raw = await fetchD1(sym);
      if (d1raw && d1raw.length >= 40) {
        const d1c = d1raw.map(b => b.c);
        d1 = { ema20: ema(d1c, 20), ema50: ema(d1c, 50), adx: adxCalc(d1raw), t0: d1raw[0].t };
      } else console.log(`[${sym}] d1 数据不足`);
    } catch (e) { console.log(`[${sym}] d1 失败: ${e.message}`); }
    // 合成 4h bar (每4根1h)（备用）
    const h4 = [];
    for (let i = 0; i + 3 < bars.length; i += 4) {
      const seg = bars.slice(i, i + 4);
      h4.push({ t: seg[0].t, o: seg[0].o, h: Math.max(...seg.map(b => b.h)), l: Math.min(...seg.map(b => b.l)), c: seg[3].c, v: seg.reduce((a, b) => a + b.v, 0) });
    }
    const h4c = h4.map(b => b.c);
    const h4k = { ema50: ema(h4c, 50), ema200: ema(h4c, 200), adx: adxCalc(h4) };
    // 按 1h 索引对齐 h4 指标（每个 1h bar 用其所属 4h bar 的指标）
    const h4aligned = { ema50: [], ema200: [], adx: [] };
    for (let i = 0; i < bars.length; i++) {
      const hi = Math.min(Math.floor(i / 4), h4c.length - 1);
      h4aligned.ema50.push(h4k.ema50[hi]);
      h4aligned.ema200.push(h4k.ema200[hi]);
      h4aligned.adx.push(h4k.adx[hi]);
    }
    const fut = futRows.map(r => { const x = r.map.get(sym); return x ? { ts: r.ts, ...x } : null; }).filter(Boolean);
    const cons = consRows.map(r => { const x = r.map.get(sym + 'USDT') || r.map.get(sym + '_USDT'); return x ? { ts: r.ts, decision: x.decision, trust_adjusted_bias: x.trust_adjusted_bias, confidence: x.confidence } : null; }).filter(Boolean);
    const lsr = lsrRows.map(r => { const x = r.map.get(sym + 'USDT') || r.map.get(sym + '_USDT'); return x ? { ts: r.ts, trader_ratio: x.trader_ratio || x.ratio } : null; }).filter(Boolean);
    console.log(`[${sym}] bars=${bars.length} fut=${fut.length} cons=${cons.length} lsr=${lsr.length}`);
    const r = runBacktest(sym, bars, fut, cons, lsr, optsAll, d1);
    console.log(`[${sym}] stCalls=${r.stCalls} stHits=${r.stHits}`);
    const trades = r.trades;
    const byStrat = {};
    for (const t of trades) { (byStrat[t.strat] = byStrat[t.strat] || []).push(t); }
    for (const nm of stratOpts) {
      if (!byStrat[nm]) continue;
      const sub = summarize({ trades: byStrat[nm], finalBalance: 1 + byStrat[nm].reduce((a, t) => a + t.pnl, 0) }, sym, nm);
      perStrat[nm].push(sub); grand += byStrat[nm].reduce((a, t) => a + t.pnl, 0); grandTrades += byStrat[nm].length;
    }
  }
  for (const [name, arr] of Object.entries(perStrat)) {
    if (!arr.length) continue;
    const all = arr.reduce((a, s) => a + s.net, 0);
    const tr = arr.reduce((a, s) => a + s.trades, 0);
    const wins = arr.reduce((a, s) => a + Math.round(s.winRate * s.trades), 0);
    const pf = arr.reduce((a, s) => a + s.pf, 0) / arr.length;
    console.log(`\n===== ${name} ===== 交易${tr} 胜率${tr ? (wins / tr * 100).toFixed(1) : 0}% PF${pf.toFixed(2)} 净${(all * 100).toFixed(2)}%`);
    for (const s of arr) if (s.trades) console.log(`  ${s.sym}: ${s.trades}笔 胜${(s.winRate * 100).toFixed(0)}% PF${s.pf.toFixed(2)} 净${(s.net * 100).toFixed(2)}% 回撤${(s.mdd * 100).toFixed(2)}% | ${s.reasons.join(' | ')}`);
  }
  console.log(`\n===== 合计 ${grandTrades}笔 净${(grand * 100).toFixed(2)}% =====`);
    console.log('CLI done');
  })();
}
