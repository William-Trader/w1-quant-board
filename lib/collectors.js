// 采集层（node-cron，Asia/Shanghai）+ 引擎快照计算 + SMOKE 假数据
const cron = require('node-cron');
const { store } = require('./store');
const { kvGet, kvSet } = require('./db');
const verdictEngine = require('./verdict');
const ai = require('./ai');
const heroBrief = require('./hero_brief');
const marketGlobal = require('./market_global');
const altseason = require('./altseason');
const marketStructure = require('./market_structure');
const ecoCalendar = require('./eco_calendar');

const MAJORS = verdictEngine.MAJORS;
const TZ = 'Asia/Shanghai';

function recordHealth(db, source, ok, ms, detail) {
  db.prepare('INSERT INTO source_health(source,ok,ms,detail,ts) VALUES(?,?,?,?,?)')
    .run(source, ok ? 1 : 0, Math.round(ms || 0), detail ? String(detail).slice(0, 400) : null, Math.floor(Date.now() / 1000));
}

async function timed(ctx, source, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    recordHealth(ctx.db, source, true, Date.now() - t0, detail || 'ok');
    return true;
  } catch (e) {
    recordHealth(ctx.db, source, false, Date.now() - t0, e.message);
    console.warn(`[collect] ${source} failed: ${e.message}`);
    return false;
  }
}

/* ---------------- 各采集任务 ---------------- */
async function collectGatePrices(ctx) {
  return timed(ctx, 'gate_spot', async () => {
    const base = ctx.env.GATE_BASE;
    const results = await Promise.all(MAJORS.map(async s => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(`${base}/spot/tickers?currency_pair=${s}_USDT`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`gate http ${r.status}`);
        const arr = await r.json();
        return { s, t: arr && arr[0] };
      } finally { clearTimeout(timer); }
    }));
    const now = Math.floor(Date.now() / 1000);
    const ins = ctx.db.prepare('INSERT OR REPLACE INTO prices(symbol,ts,price,change_24h,high_24h,low_24h,volume,source) VALUES(?,?,?,?,?,?,?,?)');
    let n = 0;
    const tx = ctx.db.transaction(() => {
      for (const { s, t } of results) {
        if (!t || !t.last) continue;
        ins.run(s, now, parseFloat(t.last), parseFloat(t.change_percentage || 0), parseFloat(t.high_24h || 0), parseFloat(t.low_24h || 0), parseFloat(t.quote_volume || 0), 'gate');
        n++;
      }
    });
    tx();
    if (n === 0) throw new Error('no_tickers');
    return `${n} tickers`;
  });
}

// futures coins-markets 单币 74 字段，W1 看板 + 威廉量化系统(analyst_tools) + qq-bot
// 实际用到的并集 ~46 字段。写入前裁剪，库体积省 ~38%，且不丢任何消费方字段。
// 注意：量化系统 get_coin_futures 会读 liquidation/long_short_ratio/long&short_volume 的多周期字段，必须保留！
const FUTURES_KEEP = [
  // W1 看板（routes/collectors/market_analyzer）
  'symbol', 'current_price', 'price_change_percent_24h', 'avg_funding_rate_by_oi',
  'open_interest_usd', 'open_interest_change_percent_24h', 'open_interest_change_usd_24h',
  'market_cap_usd', 'volume_change_percent_24h', 'liquidation_usd_24h',
  // 量化系统 analyst_tools.get_coin_futures
  'volume_24h_usd', 'oi_vol_ratio', 'open_interest_market_cap_ratio', 'price_change_percent_1h',
  'liquidation_usd_1h', 'liquidation_usd_4h', 'liquidation_usd_12h',
  'long_liquidation_usd_1h', 'long_liquidation_usd_4h', 'long_liquidation_usd_12h', 'long_liquidation_usd_24h',
  'short_liquidation_usd_1h', 'short_liquidation_usd_4h', 'short_liquidation_usd_12h', 'short_liquidation_usd_24h',
  'long_short_ratio_5m', 'long_short_ratio_15m', 'long_short_ratio_30m', 'long_short_ratio_1h',
  'long_short_ratio_4h', 'long_short_ratio_12h', 'long_short_ratio_24h',
  'long_volume_usd_5m', 'long_volume_usd_15m', 'long_volume_usd_30m', 'long_volume_usd_1h',
  'long_volume_usd_4h', 'long_volume_usd_12h', 'long_volume_usd_24h',
  'short_volume_usd_5m', 'short_volume_usd_15m', 'short_volume_usd_30m', 'short_volume_usd_1h',
  'short_volume_usd_4h', 'short_volume_usd_12h', 'short_volume_usd_24h'
];
function compactFutures(data) {
  const arr = data && data.data;
  if (!Array.isArray(arr)) return data;
  return Object.assign({}, data, { data: arr.map(c => {
    const out = {};
    for (const k of FUTURES_KEEP) if (c[k] !== undefined) out[k] = c[k];
    return out;
  }) });
}

// LSR ranking 单行 76 字段，看板 + 量化系统(analyst_tools.get_lsr_data) 并集 ~18 字段。
// 注意：量化系统读 ov_long/ov_short_traders、whale_long/short_qty&count、delta_4h_pct，必须保留！
const LSR_KEEP = ['rank', 'symbol', 'ratio', 'trader_ratio', 'whale_ratio',
  'delta_2m', 'whale_delta_2m', 'delta_4h', 'trader_delta_4h', 'whale_delta_4h',
  'oi_mcap_ratio', 'long_short_ratio',
  'delta_4h_pct', 'ov_long_traders', 'ov_short_traders',
  'whale_long_qty', 'whale_short_qty', 'whale_long_count', 'whale_short_count'];
function compactLsr(data) {
  const arr = data && data.data;
  if (!Array.isArray(arr)) return data;
  return Object.assign({}, data, { data: arr.map(c => {
    const out = {};
    for (const k of LSR_KEEP) if (c[k] !== undefined) out[k] = c[k];
    return out;
  }) });
}

async function collectFuturesMarkets(ctx) {
  return timed(ctx, 'cg_futures_markets', async () => {
    const r = await ctx.cg.request('/api/futures/coins-markets?per_page=50');
    if (!r.ok) throw new Error(r.error || 'cg_fail');
    const now = Math.floor(Date.now() / 1000);
    ctx.db.prepare('INSERT INTO futures_markets(ts,payload) VALUES(?,?)')
      .run(now, JSON.stringify(compactFutures(r.data)));
    // 轻量费率历史（FR 回测数据基建）：只存 币种+费率，90 天 ~6MB
    try {
      const arr = (r.data && r.data.data) || [];
      if (Array.isArray(arr) && arr.length) {
        const ins = ctx.db.prepare('INSERT OR REPLACE INTO funding_history(ts,symbol,funding_rate) VALUES(?,?,?)');
        const tx = ctx.db.transaction((rows) => { for (const c of rows) ins.run(now, c.symbol, c.avg_funding_rate_by_oi != null ? c.avg_funding_rate_by_oi : null); });
        tx(arr.filter(c => c && c.symbol));
      }
    } catch (e) { console.warn(`[collect] funding_history 写入失败: ${e.message}`); }
    return `coins=${r.data.data ? r.data.data.length : 0}`;
  });
}

async function collectLsrRanking(ctx, mode) {
  return timed(ctx, `lsr_ranking_${mode}`, async () => {
    const sort = mode === 'whale' ? 'whale_delta_2m' : 'delta_2m';
    // all=true 全量返回（~660 行）：本地合并 top50 + 8 大币，保证 BTC/主流币 LSR 可用（limit=50 时 BTC 排 166 名外会丢失）
    const path = `/api/lsr/v2/ranking?mode=${mode}&sort=${sort}&order=desc&limit=50&offset=0&all=true`;
    const r = await ctx.cg.request(path);
    if (!r.ok) throw new Error(r.error || 'lsr_fail');
    const now = Math.floor(Date.now() / 1000);
    const allRows = (r.data && r.data.data) || [];
    let merged = allRows;
    if (Array.isArray(allRows)) {
      const seen = new Set();
      merged = [];
      for (const c of allRows.slice(0, 50)) { if (c.symbol && !seen.has(c.symbol)) { seen.add(c.symbol); merged.push(c); } }
      for (const c of allRows) {
        if (merged.length >= 60) break;
        const s = String(c.symbol || '').toUpperCase();
        const isMajor = MAJORS.some(m => s === m || s.startsWith(m + 'USDT'));
        if (isMajor && !seen.has(c.symbol)) { seen.add(c.symbol); merged.push(c); }
      }
      if (r.data) r.data.data = merged;
    }
    ctx.db.prepare('INSERT OR REPLACE INTO lsr_rankings(mode,ts,etag,payload) VALUES(?,?,?,?)')
      .run(mode, now, r.etag || null, JSON.stringify(compactLsr(r.data)));
    return r.fromCache ? 'etag-304 reuse' : `rows=${merged.length}`;
  });
}

// LSR v2 批量完整信号（8 大币 + XAU，含 delta_2m/30m/4h、notional、whale 字段）—— 深化算法数据源
async function collectLsrSignals(ctx) {
  return timed(ctx, 'lsr_signals', async () => {
    const syms = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'ADA', 'XAU'];
    const r = await ctx.cg.request(`/api/lsr/v2/signals?symbols=${syms.join(',')}&mode=trader`, { etag: false });
    if (!r.ok) throw new Error(r.error || 'lsr_signals_fail');
    const now = Math.floor(Date.now() / 1000);
    ctx.db.prepare('INSERT OR REPLACE INTO lsr_signals(ts,payload) VALUES(?,?)')
      .run(now, JSON.stringify(r.data));
    // 轻量多空比历史（FR 回测数据基建）：只存回测必需字段，90 天小体积
    try {
      const arr = (r.data && r.data.data) || [];
      if (Array.isArray(arr) && arr.length) {
        const ins = ctx.db.prepare(`INSERT OR REPLACE INTO lsr_history(ts,symbol,ratio,trader_ratio,whale_ratio,delta_2m,delta_4h,trader_delta_4h,whale_delta_4h,long_notional,short_notional)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
        const tx = ctx.db.transaction((rows) => {
          for (const c of rows) {
            if (!c || !c.symbol) continue;
            ins.run(now, c.symbol,
              c.ratio != null ? c.ratio : null,
              c.trader_ratio != null ? c.trader_ratio : null,
              c.whale_ratio != null ? c.whale_ratio : null,
              c.delta_2m != null ? c.delta_2m : null,
              c.delta_4h != null ? c.delta_4h : null,
              c.trader_delta_4h != null ? c.trader_delta_4h : null,
              c.whale_delta_4h != null ? c.whale_delta_4h : null,
              c.long_notional != null ? c.long_notional : null,
              c.short_notional != null ? c.short_notional : null);
          }
        });
        tx(arr);
      }
    } catch (e) { console.warn(`[collect] lsr_history 写入失败: ${e.message}`); }
    return `rows=${(r.data && r.data.data ? r.data.data.length : 0)}`;
  });
}

// LSR 健康/新鲜度监控
async function collectLsrHealth(ctx) {
  return timed(ctx, 'lsr_health', async () => {
    const r = await ctx.cg.request('/api/lsr/health', { etag: false });
    if (!r.ok) throw new Error(r.error || 'lsr_health_fail');
    const h = r.data || {};
    return `ok=${h.ok} age=${h.age_seconds || '?'}s`;
  });
}

async function collectFundingArb(ctx) {
  return timed(ctx, 'lsr_funding_arb', async () => {
    const r = await ctx.cg.request('/api/lsr/funding-rate/arbitrage?sort=apr&order=desc', { etag: false });
    if (!r.ok) throw new Error(r.error || 'arb_fail');
    const payload = Object.assign({}, r.data, { data: (r.data.data || []).slice(0, 100) }); // 只留 TOP100 控制库体积
    ctx.db.prepare('INSERT INTO funding_arb(ts,payload) VALUES(?,?)')
      .run(Math.floor(Date.now() / 1000), JSON.stringify(payload));
    return `rows=${payload.data.length}`;
  });
}

async function collectConsensus(ctx) {
  return timed(ctx, 'lsr_consensus', async () => {
    const r = await ctx.cg.request('/api/lsr/consensus/v1/signals', { etag: false }); // 不传 symbols 取全部
    if (!r.ok) throw new Error(r.error || 'consensus_fail');
    ctx.db.prepare('INSERT INTO consensus(ts,payload) VALUES(?,?)')
      .run(Math.floor(Date.now() / 1000), JSON.stringify(r.data));
    return `coins=${Array.isArray(r.data) ? r.data.length : '?'}`;
  });
}

async function collectFearGreed(ctx) {
  return timed(ctx, 'cg_fear_greed', async () => {
    // 主源：Coinglass
    const r = await ctx.cg.request('/api/index/fear-greed-history?limit=90', { etag: false });
    if (!r.ok) {
      // 备用源：alternative.me 免费公开 API（限流/故障时兜底，保证 FGI 不断供）
      try {
        const alt = await fetch('https://api.alternative.me/fng/?limit=10', { signal: AbortSignal.timeout(10000) });
        if (!alt.ok) throw new Error('alt_fg_' + alt.status);
        const d = await alt.json();
        const data = d.data || [];
        const ins = ctx.db.prepare('INSERT OR REPLACE INTO fear_greed(ts,value,classification) VALUES(?,?,?)');
        const classify = v => v <= 25 ? 'Extreme Fear' : v <= 45 ? 'Fear' : v <= 55 ? 'Neutral' : v <= 75 ? 'Greed' : 'Extreme Greed';
        let n = 0;
        const tx = ctx.db.transaction(() => {
          for (const row of data) {
            const v = Math.round(Number(row.value));
            let ts = Number(row.timestamp);
            if (ts > 1e12) ts = Math.floor(ts / 1000);
            if (!isFinite(v) || !isFinite(ts)) continue;
            ins.run(ts, v, classify(v));
            n++;
          }
        });
        tx();
        if (n > 0) { console.log(`[collect] cg_fear_greed 主源失败(${r.error})→ alternative.me 兜底 rows=${n}`); return `alt-rows=${n}`; }
      } catch (e) { console.warn(`[collect] fear_greed 备用源也失败: ${e.message}`); }
      throw new Error(r.error || 'fg_fail');
    }
    const d = r.data.data || r.data;
    const values = d.data_list || [];
    const times = d.time_list || [];
    const ins = ctx.db.prepare('INSERT OR REPLACE INTO fear_greed(ts,value,classification) VALUES(?,?,?)');
    const classify = v => v <= 25 ? 'Extreme Fear' : v <= 45 ? 'Fear' : v <= 55 ? 'Neutral' : v <= 75 ? 'Greed' : 'Extreme Greed';
    let n = 0;
    const tx = ctx.db.transaction(() => {
      for (let i = 0; i < Math.min(values.length, times.length); i++) {
        const v = Math.round(Number(values[i]));
        let ts = Number(times[i]);
        if (ts > 1e12) ts = Math.floor(ts / 1000); // 上游 time_list 为毫秒，统一落秒
        if (!isFinite(v) || !isFinite(ts)) continue;
        ins.run(ts, v, classify(v));
        n++;
      }
    });
    tx();
    return `points=${n}`;
  });
}

async function collectOpenclue(ctx) {
  return timed(ctx, 'openclue_archive', async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(ctx.env.OPENCLUE_URL, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`openclue http ${r.status}`);
      const data = await r.json();
      ctx.db.prepare('INSERT OR REPLACE INTO openclue_archive(ts,payload) VALUES(?,?)')
        .run(Math.floor(Date.now() / 1000), JSON.stringify(data));
      return `verdict=${data.verdict && data.verdict.verdict}`;
    } finally { clearTimeout(timer); }
  });
}

/* ---------------- 清算数据（Coinglass coin-list，24h 维度，多所） ---------------- */
const LIQ_KEEP = ['symbol', 'liquidation_usd_24h', 'long_liquidation_usd_24h', 'short_liquidation_usd_24h'];
// 主流合约所；串行采集（间隔 3s）避免密集请求触发网关限流
const LIQ_EXCHANGES = ['OKX', 'Binance', 'Bybit', 'Gate', 'HTX', 'Bitget', 'KuCoin', 'MEXC'];
const LIQ_GAP_MS = 3000;
function compactLiquidation(data) {
  const arr = data && data.data;
  if (!Array.isArray(arr)) return data;
  return arr.map(c => {
    const out = {};
    for (const k of LIQ_KEEP) if (c[k] !== undefined) out[k] = c[k];
    return out;
  }).filter(c => c.symbol);
}
async function collectLiquidation(ctx, exchange) {
  return timed(ctx, `cg_liquidation_${exchange}`, async () => {
    const r = await ctx.cg.request(`/api/futures/liquidation/coin-list?exchange=${exchange}`);
    if (!r.ok) throw new Error(r.error || 'liq_fail');
    const compact = compactLiquidation(r.data);
    if (!compact.length) throw new Error('liq_empty');
    ctx.db.prepare('INSERT OR REPLACE INTO liquidation(exchange,ts,payload) VALUES(?,?,?)')
      .run(exchange, Math.floor(Date.now() / 1000), JSON.stringify({ exchange, data: compact }));
    return `rows=${compact.length}`;
  });
}
async function collectLiquidationAll(ctx) {
  for (const ex of LIQ_EXCHANGES) {
    await collectLiquidation(ctx, ex);
    await new Promise(r => setTimeout(r, LIQ_GAP_MS));
  }
  return `exchanges=${LIQ_EXCHANGES.length}`;
}

/* ---------------- 引擎快照：读库 → posture/stances/verdict/countdown ---------------- */
// 快照依赖的库数据每 1-5 分钟才更新一次；API 高频调用时 30s 内存缓存，
// 避免每个请求都重算 11 因子。日报任务传 force=true 保证取最新。
let snapshotCache = { ts: 0, snap: null };
const SNAPSHOT_TTL_MS = 30000;
function buildEngineSnapshot(ctx, force = false) {
  const now = Date.now();
  if (!force && snapshotCache.snap && now - snapshotCache.ts < SNAPSHOT_TTL_MS) {
    return snapshotCache.snap;
  }
  const db = ctx.db;
  const futures = store.latestFutures(db);
  const futPayload = futures ? futures.data : null;
  const lsrT = store.latestLsr(db, 'trader');
  const lsrW = store.latestLsr(db, 'whale');
  const cons = store.latestConsensus(db);
  const consPayload = cons ? cons.data : null;
  const fgNow = store.fgCurrent(db);
  const fgSeries = store.fgSeries(db, 90);
  const prices = store.latestPrices(db);
  const oc = store.latestOpenclue(db);
  const ocd = oc && oc.data;

  // 输入汇总
  const futArr = futures && futures.data && futures.data.data ? futures.data.data : [];
  const majorFut = MAJORS.map(s => store.futuresCoin(futPayload, s)).filter(Boolean);
  const fundingAvg = majorFut.length ? majorFut.reduce((s, c) => s + (c.avg_funding_rate_by_oi || 0), 0) / majorFut.length : 0;
  const dvol = prices.rows.length ? prices.rows.reduce((s, r) => s + Math.abs(r.change_24h || 0), 0) / prices.rows.length : 0;
  const oiChg = majorFut.length ? majorFut.reduce((s, c) => s + (c.open_interest_change_percent_24h || 0), 0) / majorFut.length : 0;
  const pxChg = majorFut.length ? majorFut.reduce((s, c) => s + (c.price_change_percent_24h || 0), 0) / majorFut.length : 0;

  // 总市值边际变化（稳定币/资金流替代指标）：与 6 小时前快照对比
  const totalMcap = futArr.reduce((s, c) => s + (c.market_cap_usd || 0), 0);
  const prevMcap = kvGet(db, 'mcap_snap', null);
  let mcapDelta = 0;
  if (prevMcap && prevMcap.value > 0 && totalMcap > 0) {
    mcapDelta = (totalMcap - prevMcap.value) / prevMcap.value * 100;
  }
  if (totalMcap > 0 && (!prevMcap || Date.now() - prevMcap.ts > 6 * 3600 * 1000)) {
    kvSet(db, 'mcap_snap', { value: totalMcap, ts: Date.now() });
  }

  // LSR 主流币偏离
  const skew = (payload) => {
    let acc = 0, n = 0;
    for (const s of MAJORS) {
      const c = store.lsrCoin(payload, s);
      if (c && typeof c.ratio === 'number') { acc += c.ratio - 1; n++; }
      else if (c && typeof c.trader_ratio === 'number') { acc += c.trader_ratio - 1; n++; }
    }
    return n ? acc / n : 0;
  };
  const whaleSkew = (payload) => {
    let acc = 0, n = 0;
    for (const s of MAJORS) {
      const c = store.lsrCoin(payload, s);
      if (c && typeof c.whale_ratio === 'number') { acc += c.whale_ratio - 1; n++; }
    }
    return n ? acc / n : 0;
  };

  // KOL 共识偏向
  let consBias = 0;
  const consArr = Array.isArray(cons && cons.data) ? cons.data : [];
  const consMajors = MAJORS.map(s => store.consensusCoin(consPayload, s)).filter(Boolean);
  if (consMajors.length) consBias = consMajors.reduce((s, c) => s + (c.trust_adjusted_bias || 0), 0) / consMajors.length;

  const fgi7 = fgSeries.length >= 8 ? fgNow.value - fgSeries[fgSeries.length - 8].value : 0;

  const etfSeries = ocd && Array.isArray(ocd.etf_btc_flow_14d_series) ? ocd.etf_btc_flow_14d_series : [];
  const etfRecent3 = etfSeries.slice(-3).reduce((s, x) => s + (x.value || 0), 0);

  const inputs = {
    fgi: fgNow ? fgNow.value : null,
    fgi_7d_delta: fgi7,
    dvol,
    funding_avg: fundingAvg,
    oi_change_24h: oiChg,
    price_change_24h: pxChg,
    stablecoin_mcap_delta_pct: mcapDelta,
    etf_recent3_musd: etfRecent3,
    etf_based_on: etfSeries.length ? 'William 归档 ETF 序列' : '近似（无直接数据源）',
    lsr_trader_skew: skew(lsrT && lsrT.data),
    lsr_whale_skew: whaleSkew(lsrW && lsrW.data),
    consensus_bias: consBias,
    cycle_valuation: ocd && ocd.posture && ocd.posture.inputs ? (ocd.posture.inputs.cycle_mvrv_z || 0) : 0
  };

  // days_held：回溯 verdict_daily 连续同 state 天数
  let daysHeld = 1;
  const hist = store.verdictHistory(db, 30);
  // 先算临时 posture 拿 state
  const tmpPosture = verdictEngine.computePosture(inputs, 0);
  for (const h of hist) {
    try {
      const p = JSON.parse(h.posture_json || '{}');
      if (p.state === tmpPosture.state) daysHeld++;
      else break;
    } catch { break; }
  }

  const posture = verdictEngine.computePosture(inputs, daysHeld);

  const stances = MAJORS.map(sym => {
    const fc = store.futuresCoin(futPayload, sym);
    const pr = prices.rows.find(r => r.symbol === sym);
    const lt = store.lsrCoin(lsrT && lsrT.data, sym);
    const lw = store.lsrCoin(lsrW && lsrW.data, sym);
    const cc = store.consensusCoin(consPayload, sym);
    return verdictEngine.computeStance(sym, {
      price_24h: fc ? fc.price_change_percent_24h : (pr ? pr.change_24h : 0),
      funding: fc ? fc.avg_funding_rate_by_oi : 0,
      trader_ratio: lt ? (lt.trader_ratio ?? lt.ratio) : null,
      trader_delta_4h: lt ? (lt.trader_delta_4h ?? lt.delta_4h ?? 0) : 0,
      whale_ratio: lw ? (lw.whale_ratio ?? null) : (lt ? (lt.whale_ratio ?? null) : null),
      consensus_bias: cc ? (cc.trust_adjusted_bias || 0) : 0,
      // 升级v6.1：传入 24h 波动率（供 stance 波动率自适应缩放；无直接数据时用价格涨跌绝对值近似）
      vol_24h: fc && fc.volatility_24h ? fc.volatility_24h : Math.abs(fc ? fc.price_change_percent_24h : (pr ? pr.change_24h : 0))
    });
  });

  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const prevDaily = hist[0] || null;
  const official = ocd ? { verdict: ocd.verdict, posture: ocd.posture } : null;
  const verdict = verdictEngine.synthesizeVerdict(posture, stances, prevDaily, official);
  const officialCond = ocd && ocd.verdict && ocd.verdict.countdown ? ocd.verdict.countdown.conditions : null;
  const countdown = verdictEngine.computeCountdown(posture, stances, officialCond);

  // William 归档 8 币立场对照
  const officialStances = {};
  if (ocd && Array.isArray(ocd.coins)) {
    for (const c of ocd.coins) officialStances[c.symbol] = { stance: c.stance, confidence: c.confidence, headline_zh: c.headline_zh };
  }

  // 自研「今日主要观点」（HERO_SELF_MODE=openclue 时回退 openclue）
  const selfHb = process.env.HERO_SELF_MODE !== 'openclue' ? heroBrief.getToday(db) : null;
  const snap = {
    today, inputs, posture, stances, verdict, countdown,
    officialStances,
    hero_brief: selfHb ? selfHb : (ocd && ocd.hero_brief ? ocd.hero_brief : null),
    hero_brief_source: selfHb ? 'self' : (ocd && ocd.hero_brief ? 'openclue' : null),
    official: ocd ? {
      exported_at: ocd.exported_at,
      verdict: ocd.verdict ? { verdict: ocd.verdict.verdict, headline_zh: ocd.verdict.headline_zh, headline_en: ocd.verdict.headline_en } : null,
      posture: ocd.posture ? { state: ocd.posture.state, score: ocd.posture.score, days_held: ocd.posture.days_held } : null,
      market_stance: ocd.market_stance || null,
      fear_greed_value: ocd.fear_greed_value ?? null,
      etf_btc_flow_14d_series: etfSeries,
      mcap_30d_series: ocd.mcap_30d_series || [],
      btc_dominance: ocd.btc_dominance ?? null,
      btc_dominance_30d_series: ocd.btc_dominance_30d_series || [],
      btc_funding_30d_series: ocd.btc_funding_30d_series || [],
      status_summary: ocd.status_summary || null,
      stance_distribution_today: ocd.stance_distribution_today || null
    } : null,
    ts: {
      futures: futures ? futures.ts : null,
      lsr_trader: lsrT ? lsrT.ts : null,
      lsr_whale: lsrW ? lsrW.ts : null,
      consensus: cons ? cons.ts : null,
      fear_greed: fgNow ? fgNow.ts : null,
      openclue: oc ? oc.ts : null,
      prices: prices.ts || null
    }
  };
  snapshotCache = { ts: now, snap };
  return snap;
}

/* ---------------- 每日 08:30 DeepSeek 日报 ---------------- */
function ruleTemplateText(snapshot) {
  const v = snapshot.verdict, p = snapshot.posture;
  return `【规则模板生成】${v.headline_zh} ${v.rationale_zh} 关注点：${v.watch_zh}。新变化：${v.whats_new_zh}（姿态 ${p.state} ${p.score} 分，${p.conviction.zh}，已维持 ${p.days_held} 天）`;
}

async function collectDailyVerdict(ctx) {
  return timed(ctx, 'ai_daily_verdict', async () => {
    const snap = buildEngineSnapshot(ctx, true); // 日报必须用最新快照
    const promptData = {
      posture: { score: snap.posture.score, state: snap.posture.state, reason_zh: snap.posture.reason_zh, flip_trigger_zh: snap.posture.flip_trigger_zh, conviction: snap.posture.conviction },
      verdict: { verdict: snap.verdict.verdict, headline_zh: snap.verdict.headline_zh, rationale_zh: snap.verdict.rationale_zh, watch_zh: snap.verdict.watch_zh, whats_new_zh: snap.verdict.whats_new_zh },
      stances: snap.stances.map(s => ({ symbol: s.symbol, stance: s.stance, confidence: s.confidence })),
      inputs: snap.inputs
    };
    let text, source;
    try {
      const r = await ai.chat(ctx.env, [
        { role: 'system', content: '你是加密市场量化分析师，为「William 量化看板 W1」撰写每日判断。基于给定 JSON 数据，用中文写 120-200 字的专业、克制、可执行的每日判断：先给结论，再给理由，最后给今日关注点。用纯文本，禁止使用任何 markdown 符号（不要 ** 加粗、不要 # 标题）。不要用"建议投资"等措辞，用"观察/等待/防守"。' },
        { role: 'user', content: JSON.stringify(promptData) }
      ]);
      text = r.text.replace(/\*\*/g, '').replace(/^#+\s*/gm, ''); // 去 markdown 残留
      source = r.source;
    } catch (e) {
      text = ruleTemplateText(snap); source = 'rule-template';
      console.warn(`[ai] 双 key 均失败，使用规则模板兜底: ${e.message}`);
    }
    ctx.db.prepare(`INSERT INTO verdict_daily(date,posture_json,verdict_json,stances_json,ai_text,ai_text_en,ai_source,created_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(date) DO UPDATE SET posture_json=excluded.posture_json, verdict_json=excluded.verdict_json,
        stances_json=excluded.stances_json, ai_text=excluded.ai_text, ai_text_en=excluded.ai_text_en,
        ai_source=excluded.ai_source, created_at=excluded.created_at`)
      .run(snap.today, JSON.stringify(snap.posture), JSON.stringify(snap.verdict),
        JSON.stringify(snap.stances), text, snap.verdict.headline_en, source, Date.now());
    return `source=${source}`;
  });
}

/* ---------------- 保留期清理 ---------------- */
function prune(ctx) {
  const db = ctx.db;
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM source_health WHERE ts < ?').run(now - 7 * day);
  db.prepare('DELETE FROM prices WHERE ts < ?').run(now - 2 * day);
  // 合约/LSR/套利/共识历史从无读取（引擎与 API 只消费最新一条），保留 1 天足矣，省库体积
  db.prepare('DELETE FROM futures_markets WHERE ts < ?').run(now - 1 * day);
  db.prepare('DELETE FROM funding_history WHERE ts < ?').run(now - 90 * day);
  db.prepare('DELETE FROM lsr_history WHERE ts < ?').run(now - 90 * day);
  db.prepare('DELETE FROM lsr_rankings WHERE ts < ?').run(now - 1 * day);
  db.prepare('DELETE FROM funding_arb WHERE ts < ?').run(now - 1 * day);
  db.prepare('DELETE FROM consensus WHERE ts < ?').run(now - 1 * day);
  db.prepare('DELETE FROM liquidation WHERE ts < ?').run(now - 1 * day);
  db.prepare('DELETE FROM openclue_archive WHERE ts < ?').run(now - 400 * day); // 目标存 400 天
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}


/* ---------------- 异动检测挂接（futures/lsr 采集成功后异步跑，失败不影响采集） ---------------- */
// 新架构：WSL 引擎接管扫描（体制门控 + 双策略 + 出场引擎）；旧 lib/signal.js 保留文件不再注册
// 2026-08-11: 交易信号引擎已由「β1 御风 · 中低频趋势引擎」(dir_prod/experience_engine) 替换
// 旧 FR/ST WSL 引擎(engine.js)退役：不再扫描/推送/开单，文件保留作后台参考
// 方向引擎由 server.js 定时器驱动（每5分钟 autoOpen + resolveOpenSignals 自动结算）
async function runSignalAfter(ctx) {
  try {
    const { db } = ctx;
    const eng = require('./experience_engine');
    const signal = require('./signal');
    // 数据采集后立即补跑一轮方向引擎（与 server.js 定时器互为冗余，autoOpen 内部有防重复）
    eng.autoOpen(db, { symbol: 'BTC' });
    try {
      const snaps = signal.futuresSnapshots(db, 1);
      if (snaps.length) { const n = signal.resolveOpenSignals(db, snaps); if (n) console.log('[dir] 自动结算 ' + n + ' 单'); }
    } catch (e) { console.warn('[dir] 自动结算异常:', e.message); }
  } catch (e) {
    console.warn('[dir] 方向引擎扫描异常:', e.message);
  }
}

/* ---------------- 战绩周报推送（每周日 10:00 · 新引擎 ST/FR） ---------------- */
async function pushWeeklyReport(ctx) {
  try {
    const { db, env } = ctx;
    const { pushToGroup } = require('./qqbot');
    const since = Date.now() - 7 * 86400 * 1000;
    const rows = db.prepare("SELECT strategy, status, pnl_pct, exit_reason, regime, direction, symbol FROM signal_track WHERE pushed_at >= ? AND strategy IN ('DIR','UNIFIED')").all(since);
    if (!rows.length) { console.log('[weekly] 本周无方向引擎信号，跳过周报'); return; }
    const settled = rows.filter(r => r.status === 'WIN' || r.status === 'LOSS');
    const wins = settled.filter(r => r.status === 'WIN');
    const losses = settled.filter(r => r.status === 'LOSS');
    const pnlSum = settled.reduce((a, r) => a + Number(r.pnl_pct || 0), 0);
    const reasons = {};
    for (const r of settled) if (r.exit_reason) reasons[r.exit_reason] = (reasons[r.exit_reason] || 0) + 1;
    const timeStopN = reasons['超时'] || 0;
    const timeStopPct = settled.length ? Math.round(timeStopN / settled.length * 100) : 0;
    const byStrat = {};
    for (const r of settled) {
      byStrat[r.strategy] = byStrat[r.strategy] || { n: 0, win: 0, pnl: 0 };
      byStrat[r.strategy].n++; if (r.status === 'WIN') byStrat[r.strategy].win++; byStrat[r.strategy].pnl += Number(r.pnl_pct || 0);
    }
    const stratLines = Object.entries(byStrat).map(([k, v]) => `  ${k}: ${v.n}笔 胜${v.win} 胜率${Math.round(v.win / v.n * 100)}% 盈亏${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(2)}%`).join('\n');
    const lines = [
      '【W1 方向引擎周报】御风 · 中低频趋势引擎战绩',
      `总信号 ${rows.length} · 已结算 ${settled.length}（胜 ${wins.length} / 负 ${losses.length}）`,
      `胜率 ${settled.length ? Math.round(wins.length / settled.length * 100) : 0}% · 累计盈亏 ${pnlSum >= 0 ? '+' : ''}${pnlSum.toFixed(2)}%`,
      stratLines,
      `出场分布: ${Object.entries(reasons).map(([k, v]) => `${k}×${v}`).join(' ') || '—'}`,
      `⚠️ 超时占比 ${timeStopPct}%（目标 < 30%）${timeStopPct >= 30 ? '→ 出场结构需优化' : '✅ 健康'}`,
      `当前体制: ${(function(){ try { const { kvGet } = require('./db'); const r = JSON.parse(kvGet(db, 'signal:regime', '{}') || '{}'); return r.regime || '未知'; } catch { return '未知'; } })()}`,
      '提示：仅供研究，不构成投资建议'
    ].join('\n');
    const ok = await pushToGroup(env, db, lines);
    console.log('[weekly] 周报推送:', ok ? '成功' : '失败/未配置');
  } catch (e) {
    console.warn('[weekly] 周报推送异常:', e.message);
  }
}

/* ---------- 关键事件推送：每 12h 检索宏观事件 → 利多利空研判 → 推群降仓提醒 ---------- */
async function pushMacroAlertCron(ctx) {
  try {
    const ma = require('./macro_alert');
    const r = await ma.pushMacroAlert(ctx);
    if (r.ok) console.log('[macro] 事件提醒已推送');
  } catch (e) {
    console.warn('[macro] cron 异常:', e.message);
  }
}

/* ---------------- 任务注册 ---------------- */
const JOBS = {
  'gate-prices': collectGatePrices,
  'futures-markets': collectFuturesMarkets,
  'lsr-trader': (ctx) => collectLsrRanking(ctx, 'trader'),
  'lsr-whale': (ctx) => collectLsrRanking(ctx, 'whale'),
  'lsr-signals': collectLsrSignals,
  'lsr-health': collectLsrHealth,
  'funding-arb': collectFundingArb,
  'consensus': collectConsensus,
  'fear-greed': collectFearGreed,
  'openclue': collectOpenclue,
  'liquidation': collectLiquidationAll,
  'daily-verdict': collectDailyVerdict,
  'stablecoin': (ctx) => { const ff = require('./fund_flow'); return ff.collectStablecoinSupply(ctx.db); },
  'weekly-report': pushWeeklyReport,
  'daily-analysis': async (ctx) => {
    // William 每日分析：每天 08:00 生成当日 BTC/ETH 五维分析
    try {
      const da = require('./daily_analysis');
      da.ensureTable(ctx.db);
      const d = new Date();
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = await da.generateOne(ctx.db, ctx.env, ds);
      console.log('[daily] 分析完成:', ds, r.cached ? '已存在' : '生成');
    } catch (e) { console.warn('[daily] 生成失败:', e.message); }
  },
  'macro-alert': pushMacroAlertCron,
  'market-global': marketGlobal.collectMarketGlobal,
  'market-structure': marketStructure.collectMarketStructure,
  'eco-calendar': ecoCalendar.collectEcoCalendar,
  'altseason': altseason.collectAltseason,
  'hero-brief-self': async (ctx) => {
    // 自研「今日主要观点」：每天生成一次（AI 文案 + 规则骨架），失败自动模板兜底
    try {
      heroBrief.ensureTable(ctx.db);
      const t = heroBrief.today();
      const ex = ctx.db.prepare('SELECT date FROM hero_brief_self WHERE date=?').get(t);
      if (ex) return 'cached';
      const snap = buildEngineSnapshot(ctx);
      const hb = await heroBrief.generate(ctx, snap);
      ctx.db.prepare('INSERT OR REPLACE INTO hero_brief_self(date,payload,ts,source) VALUES(?,?,?,?)')
        .run(t, JSON.stringify(hb), Math.floor(Date.now() / 1000), hb.source);
      console.log('[hero_brief] 自研生成完成 (' + hb.source + '): ' + hb.headline_zh);
      return hb.source;
    } catch (e) { console.warn('[hero_brief] 生成失败:', e.message); throw e; }
  }
};

function startCron(ctx) {
  const opt = { timezone: TZ };
  cron.schedule('* * * * *', () => collectGatePrices(ctx), opt);        // 60s
  cron.schedule('*/5 * * * *', async () => { const ok = await collectFuturesMarkets(ctx); if (ok) await runSignalAfter(ctx); }, opt);  // 300s（原120s→改，缓解429 + 库增速）+ 异动检测挂接
  cron.schedule('*/5 * * * *', async () => {
    const okT = await collectLsrRanking(ctx, 'trader');
    const okW = await collectLsrRanking(ctx, 'whale');
    await collectFundingArb(ctx);
    if (okT && okW) await runSignalAfter(ctx);
  }, opt); // 300s + 异动检测挂接
  cron.schedule('*/5 * * * *', () => { collectLsrSignals(ctx).catch(e => console.warn('[lsr] signals error:', e.message)); }, opt);  // v2 批量完整信号（8大币+XAU）
  cron.schedule('*/5 * * * *', () => { collectLsrHealth(ctx).catch(e => console.warn('[lsr] health error:', e.message)); }, opt);  // LSR 健康监控
  cron.schedule('*/10 * * * *', () => collectConsensus(ctx), opt);      // 600s
  cron.schedule('*/30 * * * *', () => collectFearGreed(ctx), opt);   // 1800s
  cron.schedule('*/30 * * * *', () => collectLiquidationAll(ctx), opt); // 1800s 清算多所（串行）
  cron.schedule('*/30 * * * *', () => { collectOpenclue(ctx); prune(ctx); }, opt); // 1800s
  cron.schedule('30 8 * * *', () => collectDailyVerdict(ctx), opt);     // 每日 08:30
  cron.schedule('30 8 * * *', () => { try { JOBS['hero-brief-self'](ctx); } catch (e) { console.warn('[hero_brief] cron error:', e.message); } }, opt); // 每日 08:30 自研今日主要观点
  cron.schedule('35 8 * * *', () => { JOBS['altseason'](ctx).catch(e => console.warn('[altseason] cron error:', e.message)); }, opt); // 每日 08:35 山寨季/主流季判断
  cron.schedule('40 8 * * *', () => { marketStructure.collectMarketStructure(ctx).catch(e => console.warn('[market_structure] cron error:', e.message)); }, opt); // 每日 08:40 市场结构
  cron.schedule('*/30 * * * *', () => { ecoCalendar.collectEcoCalendar(ctx).catch(e => console.warn('[eco_calendar] cron error:', e.message)); }, opt); // 经济日历 30min
  cron.schedule('*/30 * * * *', () => { try { const ff = require('./fund_flow'); ff.collectStablecoinSupply(ctx.db); } catch (e) { console.warn('[fund] cron error:', e.message); } }, opt); // 稳定币供应 30min
  cron.schedule('*/30 * * * *', () => { marketGlobal.collectMarketGlobal(ctx).catch(e => console.warn('[market_global] cron error:', e.message)); }, opt); // 市场全局 30min
  cron.schedule('0 10 * * 0', () => pushWeeklyReport(ctx), opt);          // 每周日 10:00 战绩周报
  cron.schedule('0 8 * * *', () => cronJobs['daily-analysis'](ctx), opt);  // 每日 08:00 William 每日分析
  cron.schedule('0 8 * * *', () => pushMacroAlertCron(ctx), opt);          // 每日 08:00 宏观事件提醒
  cron.schedule('0 20 * * *', () => pushMacroAlertCron(ctx), opt);         // 每日 20:00 宏观事件提醒
  // 启动后立即错峰补一轮（避免冷启动空库）
  const boot = [collectGatePrices, collectFuturesMarkets, collectFearGreed, collectOpenclue,
    (c) => collectLsrRanking(c, 'trader'), (c) => collectLsrRanking(c, 'whale'),
    collectFundingArb, collectConsensus, collectLiquidationAll,
    collectDailyVerdict, JOBS['hero-brief-self'],
    (c) => { try { const ff = require('./fund_flow'); return ff.collectStablecoinSupply(c.db); } catch (e) { console.warn('[fund] boot error:', e.message); } },
    marketGlobal.collectMarketGlobal,
    marketStructure.collectMarketStructure,
    ecoCalendar.collectEcoCalendar,
    altseason.collectAltseason,
    pushMacroAlertCron];
  boot.forEach((fn, i) => setTimeout(() => fn(ctx), 3000 + i * 2500));
  // boot 全部完成后错峰跑一次异动检测（冷启动数据就绪后）
  setTimeout(() => runSignalAfter(ctx), 3000 + boot.length * 2500 + 2000);
  console.log('[cron] 14 jobs registered (Asia/Shanghai)');
}

/* ---------------- SMOKE 假数据（不起真实采集） ---------------- */
function seedSmoke(ctx) {
  const db = ctx.db;
  const now = Math.floor(Date.now() / 1000);
  const insP = db.prepare('INSERT OR REPLACE INTO prices(symbol,ts,price,change_24h,high_24h,low_24h,volume,source) VALUES(?,?,?,?,?,?,?,?)');
  const base = { BTC: 64650, ETH: 3420, SOL: 151.2, BNB: 585, XRP: 0.62, DOGE: 0.124, ADA: 0.45, LINK: 14.1 };
  MAJORS.forEach((s, i) => insP.run(s, now, base[s], (i % 3 - 1) * 1.8, base[s] * 1.02, base[s] * 0.98, 1e8, 'gate-smoke'));

  const futData = { code: '0', data: MAJORS.map((s, i) => ({
    symbol: s, current_price: base[s], avg_funding_rate_by_oi: 0.0001 * (i % 3 - 1),
    market_cap_usd: base[s] * 2e7, open_interest_usd: base[s] * 1e6,
    open_interest_change_percent_24h: (i % 3 - 1) * 1.2, price_change_percent_24h: (i % 3 - 1) * 1.8
  })) };
  db.prepare('INSERT INTO futures_markets(ts,payload) VALUES(?,?)').run(now, JSON.stringify(futData));

  for (const mode of ['trader', 'whale']) {
    const payload = {
      success: true, updated_at: now, mode, total: 50, returned: 50,
      data: MAJORS.concat(['PEPE', 'WIF', 'ARB', 'OP']).map((s, i) => ({
        rank: i + 1, symbol: s + 'USDT', ratio: 1 + (i % 5 - 2) * 0.1,
        trader_ratio: 1 + (i % 5 - 2) * 0.1, whale_ratio: 1 + (i % 4 - 1.5) * 0.12,
        delta_2m: (i % 3 - 1) * 0.02, trader_delta_4h: (i % 3 - 1) * 0.03,
        whale_delta_2m: (i % 4 - 1.5) * 0.02, oi_mcap_ratio: 0.05
      }))
    };
    db.prepare('INSERT OR REPLACE INTO lsr_rankings(mode,ts,etag,payload) VALUES(?,?,?,?)')
      .run(mode, now, '"smoke"', JSON.stringify(payload));
  }

  db.prepare('INSERT INTO funding_arb(ts,payload) VALUES(?,?)').run(now, JSON.stringify({
    success: true, updated_at: now,
    data: MAJORS.map((s, i) => ({
      rank: i + 1, symbol: s,
      buy: { exchange: 'KuCoin', funding_rate: 0.0001 * (i + 1), funding_rate_pct: 0.01 * (i + 1) },
      sell: { exchange: 'Kraken', funding_rate: 0.001 * (i + 1), funding_rate_pct: 0.1 * (i + 1) },
      apr: 80 + i * 25, funding: 0.001, fee: 0.04, spread: -0.2, next_funding_time: (now + 3600) * 1000
    }))
  }));

  db.prepare('INSERT INTO consensus(ts,payload) VALUES(?,?)').run(now, JSON.stringify(
    MAJORS.map((s, i) => ({
      symbol: s + 'USDT', display_symbol: s, snapshot_date: new Date().toISOString().slice(0, 10),
      price: base[s], decision: i % 2 ? 'long' : 'short', decision_label: i % 2 ? '看多' : '看空',
      color: i % 2 ? 'green' : 'red', confidence: 0.3 + (i % 4) * 0.1,
      trust_adjusted_bias: (i % 3 - 1) * 0.08,
      top_factors: [{ id: 'smoke_factor', name: '冒烟因子', description: 'SMOKE 假数据', score: 0.3, direction: 'bullish' }],
      firing_factors_count: 3
    }))
  ));

  const insFg = db.prepare('INSERT OR REPLACE INTO fear_greed(ts,value,classification) VALUES(?,?,?)');
  for (let i = 89; i >= 0; i--) {
    const v = 30 + Math.round(20 * Math.sin(i / 7));
    insFg.run(now - i * 86400, v, v <= 25 ? 'Extreme Fear' : v <= 45 ? 'Fear' : v <= 55 ? 'Neutral' : 'Greed');
  }

  const ocPayload = {
    source: 'https://openclue.net', exported_at: new Date().toISOString(),
    coins: MAJORS.map((s, i) => ({
      symbol: s, name: s, stance: ['bullish', 'cautiously_bullish', 'neutral', 'cautiously_bearish'][i % 4],
      confidence: 0.5, updated_at: new Date().toISOString(),
      headline_zh: `${s} 官方立场示例`, headline_en: `${s} official stance sample`,
      status: { code: 'watch', reason_zh: '示例', reason_en: 'sample' }, price_24h_change_pct: (i % 3 - 1)
    })),
    posture: { state: 'defensive', score: -2, days_held: 5, reason_zh: '示例理由', reason_en: 'sample', flip_trigger_zh: '示例触发', flip_trigger_en: 'sample', conviction: { code: 'solid', zh: '信念稳固', en: 'solid' }, inputs: { fgi: 26, cycle_mvrv_z: 0.38 }, report_date: new Date().toISOString().slice(0, 10) },
    verdict: { verdict: 'cautious', headline_zh: '官方标题示例', headline_en: 'official sample', rationale_zh: '官方理由示例', rationale_en: 'sample', watch_zh: '官方关注示例', watch_en: 'sample', whats_new_zh: '官方新变化示例', whats_new_en: 'sample', verdict_days_held: 5, report_date: new Date().toISOString().slice(0, 10), countdown: { intensity: { trend: 'steady', score_from: -2, score_to: -2 }, conditions: [{ key: 'fgi', label_zh: '情绪', label_en: 'Sentiment', line_zh: '恐慌退潮', line_en: 'fear recedes', today_move: 'none', distance_bucket: '还差一步' }] } },
    market_stance: 'cautiously_risk_off',
    hero_brief: { tone: 'cautious', subject: 'market', quote_zh: '官方简报引用示例：市场处于消化期。', quote_en: 'Official hero brief sample.', headline_zh: '官方简报标题', headline_en: 'sample', template: 'inflection', chart_key: 'fgi_gauge' },
    fear_greed_value: 26, btc_dominance: 56.4,
    etf_btc_flow_14d_series: Array.from({ length: 14 }, (_, i) => ({ label: `D${i + 1}`, value: (i % 3 - 1) * 120 })),
    mcap_30d_series: Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, value: 2.2e12 + i * 1e10 })),
    btc_dominance_30d_series: Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, value: 55 + Math.sin(i / 5) })),
    btc_funding_30d_series: Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, value: 0.00005 + (i % 5) * 0.00001 })),
    status_summary: { strengthened: 1, weakened: 0, steady: 2, watch: 5, mixed: 0 },
    stance_distribution_today: { bullish: 2, neutral: 4, bearish: 2 }
  };
  db.prepare('INSERT OR REPLACE INTO openclue_archive(ts,payload) VALUES(?,?)').run(now, JSON.stringify(ocPayload));

  // 昨日日报（供 whats_new 对比）
  const yPosture = { score: -1.8, state: 'defensive', days_held: 4, conviction: { code: 'solid', zh: '信念稳固', en: 'solid' }, factors: [], reason_zh: '昨日示例', reason_en: 'yesterday', flip_trigger_zh: 'x', flip_trigger_en: 'x', inputs: { fgi: 28 }, report_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) };
  const yStances = MAJORS.map((s, i) => ({ symbol: s, stance: ['neutral', 'cautiously_bearish', 'neutral', 'cautiously_bullish'][i % 4], confidence: 0.4 }));
  db.prepare(`INSERT OR REPLACE INTO verdict_daily(date,posture_json,verdict_json,stances_json,ai_text,ai_text_en,ai_source,created_at)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: TZ }),
      JSON.stringify(yPosture), JSON.stringify({ verdict: 'cautious', headline_zh: '昨日判断示例' }),
      JSON.stringify(yStances), '昨日 AI 日报示例：市场谨慎。', 'yesterday sample', 'rule-template', Date.now() - 86400000);

  for (const src of ['gate_spot', 'cg_futures_markets', 'lsr_ranking_trader', 'lsr_ranking_whale', 'lsr_funding_arb', 'lsr_consensus', 'cg_fear_greed', 'openclue_archive', 'ai_daily_verdict']) {
    recordHealth(db, src, true, 42, 'smoke seed');
  }
  console.log('[smoke] fake data seeded');
}

module.exports = { startCron, buildEngineSnapshot, collectDailyVerdict, seedSmoke, recordHealth, prune, JOBS, collectLsrSignals, collectLsrHealth };
