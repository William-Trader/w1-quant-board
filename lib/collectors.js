// 采集层（node-cron，Asia/Shanghai）+ 引擎快照计算 + SMOKE 假数据
const cron = require('node-cron');
const { store } = require('./store');
const { info, debug, warn, error } = require('./log');
const { kvGet, kvSet } = require('./db');
const { CoinglassClient } = require('./coinglass');
const verdictEngine = require('./verdict');
const ai = require('./ai');
const heroBrief = require('./hero_brief');
const marketGlobal = require('./market_global');
const altseason = require('./altseason');
const marketStructure = require('./market_structure');
const ecoCalendar = require('./eco_calendar');
const skyeye = require('./skyeye');
const marketWatch = require('./market_watch');
const regime = require('./regime');
const healthGuard = require('./health_guard');

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
    warn(`[collect] ${source} failed: ${e.message}`);
    return false;
  }
}

/* ---------------- 各采集任务 ---------------- */
async function collectGatePrices(ctx) {
  return timed(ctx, 'gate_spot', async () => {
    const base = ctx.env.GATE_BASE;
    const results = await Promise.allSettled(MAJORS.map(async s => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(`${base}/spot/tickers?currency_pair=${s}_USDT`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`gate http ${r.status}`);
        const arr = await r.json();
        return { s, t: arr && arr[0] };
      } finally { clearTimeout(timer); }
    }));
    // allSettled：单币失败不拖垮整批（修复：Promise.all 一币失败 8 币价格全断档）
    const now = Math.floor(Date.now() / 1000);
    const ins = ctx.db.prepare('INSERT OR REPLACE INTO prices(symbol,ts,price,change_24h,high_24h,low_24h,volume,source) VALUES(?,?,?,?,?,?,?,?)');
    let n = 0;
    const tx = ctx.db.transaction(() => {
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const { s, t } = r.value;
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
const LSR_KEEP = ['rank', 'symbol', 'ratio', 'ratio_30m', 'ratio_pct',
  'trader_ratio', 'trader_ratio_30m', 'trader_ratio_pct', 'whale_ratio', 'whale_ratio_30m_ago', 'whale_ratio_pct',
  'delta_2m', 'delta_30m', 'delta_4h', 'delta_2m_abs', 'delta_30m_abs', 'delta_4h_abs',
  'whale_delta_2m', 'whale_delta_30m', 'whale_delta_4h', 'whale_delta_2m_abs', 'whale_delta_30m_abs', 'whale_delta_4h_abs',
  'oi_mcap_ratio', 'long_short_ratio', 'long_notional', 'short_notional', 'long_traders', 'short_traders',
  'long_whales', 'short_whales', 'whale_long_qty', 'whale_short_qty', 'whale_total_qty', 'whale_long_count', 'whale_short_count',
  'whale_long_avg_entry', 'whale_short_avg_entry', 'ov_ratio', 'ov_long_short_ratio', 'ov_total_positions',
  'ov_total_traders', 'ov_long_traders', 'ov_short_traders', 'ov_long_whales', 'ov_short_whales',
  'ov_long_qty', 'ov_short_qty', 'ov_long_whales_qty', 'ov_short_whales_qty', 'updated_at', 'calculated_at'];
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
        // 注意：funding_rate 存 Coinglass 原始百分数值（0.005421 = 0.005421%），z-score 消费方对缩放不敏感；勿与 store.futuresCoin 的 ÷100 小数混算
        const ins = ctx.db.prepare('INSERT OR REPLACE INTO funding_history(ts,symbol,funding_rate) VALUES(?,?,?)');
        const tx = ctx.db.transaction((rows) => { for (const c of rows) ins.run(now, c.symbol, c.avg_funding_rate_by_oi != null ? c.avg_funding_rate_by_oi : null); });
        tx(arr.filter(c => c && c.symbol));
      }
    } catch (e) { warn(`[collect] funding_history 写入失败: ${e.message}`); }
    return `coins=${r.data.data ? r.data.data.length : 0}`;
  });
}

/* ---------------- K线累积采集（回测基建：持续累积 OHLCV 到 klines 表，供天机回测读真实数据） ---------------- */
async function collectKlines(ctx) {
  return timed(ctx, 'okx_klines', async () => {
    let total = 0;
    const db = ctx.db;
    const now = Math.floor(Date.now() / 1000);
    // 去重：库里已有该(symbol,interval)的最新 ts，作为增量起点
    const existing = db.prepare('SELECT symbol, interval, MAX(ts) mx FROM klines GROUP BY symbol, interval').all();
    const maxMap = new Map();
    for (const r of existing) maxMap.set(r.symbol + ':' + r.interval, r.mx || 0);
    // 每币两档：4h（主回测周期）+ 5m（REPLAY 复现模式）
    const INTERVALS = ['4h', '5m'];
    for (const sym of MAJORS) {
      for (const intv of INTERVALS) {
        try {
          // fetchKlines(env, symbol, bar, days) 拉 OKX 历史，bar 支持 15m/1H 等；这里为累积策略：
          // - 4h 用 '4H'，5m 用 '5m'（OKX bar 枚举：1m/3m/5m/15m/30m/1H/2H/4H）
          const bar = intv === '4h' ? '4H' : '5m';
          const days = intv === '4h' ? 2 : 1;
          // 2026-08-25 修复：fetchKlines 内部用 env.db 读写缓存，ctx.env 无 db → 合并传入
          const klines = require('./backtest').fetchKlines(Object.assign({}, ctx.env, { db: ctx.db }), sym, bar, days, true); // bypassCache: 采集必须真拉增量，不吃6h缓存
          const arr = await klines;
          if (!Array.isArray(arr) || !arr.length) continue;
          const ins = db.prepare('INSERT OR REPLACE INTO klines(symbol,interval,ts,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?)');
          const tx = db.transaction((rows) => {
            for (const k of rows) {
              if (k.ts <= (maxMap.get(sym + ':' + intv) || 0)) continue; // 只补增量
              ins.run(sym, intv, k.ts, k.o, k.h, k.l, k.c, k.v);
            }
          });
          tx(arr);
          total += arr.length;
        } catch (e) {
          warn(`[klines] ${sym} ${intv} 采集失败: ${e.message}`);
        }
      }
    }
    return `rows=${total}`;
  });
}

async function collectLsrRanking(ctx, mode) {
  return timed(ctx, 'lsr_ranking_' + mode, async () => {
    const sort = mode === 'whale' ? 'whale_delta_2m' : 'delta_2m';
    const pages = Math.max(1, Math.min(4, Number(ctx.env.LSR_RANKING_PAGES || process.env.LSR_RANKING_PAGES || 2)));
    let offset = 0, allRows = [], lastData = {}, lastEtag = null, hasMore = true, used = 0;
    while (used < pages && hasMore) {
      const path = '/api/lsr/ranking?mode=' + mode + '&sort=' + sort + '&order=desc&limit=50&offset=' + offset;
      const r = await ctx.cg.request(path);
      if (!r.ok) throw new Error(r.error || 'lsr_fail');
      const page = (r.data && r.data.data) || [];
      allRows = allRows.concat(page);
      lastData = r.data || {};
      lastEtag = r.etag || lastEtag;
      hasMore = !!(r.data && r.data.has_more);
      offset = (r.data && r.data.next_offset != null) ? r.data.next_offset : offset + page.length;
      used++;
      if (!page.length) break;
    }
    const now = Math.floor(Date.now() / 1000);
    const seen = new Set();
    const merged = [];
    for (const c of allRows.slice(0, 50)) { if (c.symbol && !seen.has(c.symbol)) { seen.add(c.symbol); merged.push(c); } }
    for (const c of allRows) {
      if (merged.length >= 60) break;
      const sym = String(c.symbol || '').toUpperCase();
      const isMajor = MAJORS.some(m => sym === m || sym.startsWith(m + 'USDT'));
      if (isMajor && !seen.has(c.symbol)) { seen.add(c.symbol); merged.push(c); }
    }
    lastData.data = merged;
    ctx.db.prepare('INSERT OR REPLACE INTO lsr_rankings(mode,ts,etag,payload) VALUES(?,?,?,?)')
      .run(mode, now, lastEtag, JSON.stringify(compactLsr(lastData)));
    return 'pages=' + used + ' rows=' + merged.length;
  });
}

// LSR v2 批量完整信号（8 大币 + XAU，含 delta_2m/30m/4h、notional、whale 字段）—— 深化算法数据源
async function collectLsrSignals(ctx) {
  return timed(ctx, 'lsr_signals', async () => {
    const syms = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'ADA', 'XAU'];
    const r = await ctx.cg.request(`/api/lsr/signals?symbols=${syms.join(',')}&mode=trader`, { etag: false });
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
    } catch (e) { warn(`[collect] lsr_history 写入失败: ${e.message}`); }
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
    const r = await ctx.cg.request('/api/lsr/consensus/v1/signals?symbols=BTC,ETH,SOL,BNB,XRP,DOGE,LINK,ADA', { etag: false }); // v4: 明确币种，空 symbols 上游 400
    if (!r.ok) {
      // 2026-10-01 底座降噪：该上游接口自 2026-07 起恒定 400（已下线），此前每 10 分钟刷 WARN（累计 621 条）。
      const nowMs = Date.now();
      const lastWarn = Number(kvGet(ctx.db, 'cg:consensus:last_warn', 0) || 0);
      if (nowMs - lastWarn > 6 * 3600 * 1000) {
        kvSet(ctx.db, 'cg:consensus:last_warn', nowMs);
        warn('[collect] lsr_consensus 上游返回 ' + (r.error || r.status) + '（接口疑似下线，已降频告警）');
      }
      return 'upstream_down';
    }
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
        if (n > 0) { info(`[collect] cg_fear_greed 主源失败(${r.error})→ alternative.me 兜底 rows=${n}`); return `alt-rows=${n}`; }
      } catch (e) { warn(`[collect] fear_greed 备用源也失败: ${e.message}`); }
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
    // 2026-09-01 加固：超时放宽 25s + 失败重试 2 次，防偶发上游慢/抖动 abort 导致 ETF 序列长期缺失
    const url = ctx.env.OPENCLUE_URL;
    const timeoutMs = 25000;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`openclue http ${r.status}`);
        const data = await r.json();
        ctx.db.prepare('INSERT OR REPLACE INTO openclue_archive(ts,payload) VALUES(?,?)')
          .run(Math.floor(Date.now() / 1000), JSON.stringify(data));
        return `verdict=${data.verdict && data.verdict.verdict} (attempt ${attempt})`;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) { warn(`[collect] openclue attempt ${attempt} failed: ${e.message}; retrying`); }
      } finally { clearTimeout(timer); }
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
    }
    throw lastErr;
  });
}

async function collectETF(ctx) {
  return timed(ctx, 'etf_archive', async () => {
    // 2026-09-01 主动更新：改用 Coinglass 实时 BTC ETF 流（openclue 源滞后4天），经现有 client 拉取并落库
    const cg = new CoinglassClient(ctx.env, ctx.db);
    let data;
    try {
      const r = await cg.request('/api/etf/bitcoin/flow-history', { etag: false });
      // 业务失败态要先识别，否则 r.data=null 会被误判为 empty payload
      if (r && (r.ok === false || r.businessOk === false)) throw new Error(r.error || 'etf request biz_failed');
      // Coinglass 返回两层包装：r.data.code='0', r.data.data=[...]
      data = r && r.data && r.data.code === '0' ? r.data.data : (r && r.data);
    } catch (e) {
      warn('[collect] etf_archive request failed:', e.message);
      throw e;
    }
    if (!Array.isArray(data) || !data.length) throw new Error('etf_archive empty payload');
    const series = data
      .filter(x => x && typeof x.flow_usd === 'number')
      .map(x => {
        const d = new Date(x.timestamp);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return { label: `${mm}/${dd}`, value: Math.round(x.flow_usd / 1e6 * 10) / 10 };
      });
    ctx.db.prepare('INSERT OR REPLACE INTO etf_archive(ts,payload) VALUES(?,?)')
      .run(Math.floor(Date.now() / 1000), JSON.stringify({ series, exported_at: data[0] ? data[0].timestamp : null, en: 'coinglass' }));
    return `etf_days=${series.length} last=${series.length ? series[series.length - 1].value : '?'}`;
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
// 2026-10-23 修复：8 所串行 + 429 全局冷却导致采集周期漂到 60~90min（health_guard 30min 阈值误报断供）
// 改为并行采集（各所独立路径，不会重复打同一接口）+ 失败重试 1 次
async function collectLiquidation(ctx, exchange) {
  return timed(ctx, `cg_liquidation_${exchange}`, async () => {
    let r = await ctx.cg.request(`/api/futures/liquidation/coin-list?exchange=${exchange}`);
    if (!r.ok && /rate_limited|business_rate_limited|network|timeout|http_5/.test(String(r.error || ''))) {
      await new Promise(s => setTimeout(s, 2000 + Math.random() * 1500));
      r = await ctx.cg.request(`/api/futures/liquidation/coin-list?exchange=${exchange}`);
    }
    if (!r.ok) throw new Error(r.error || 'liq_fail');
    const compact = compactLiquidation(r.data);
    if (!compact.length) throw new Error('liq_empty');
    ctx.db.prepare('INSERT OR REPLACE INTO liquidation(exchange,ts,payload) VALUES(?,?,?)')
      .run(exchange, Math.floor(Date.now() / 1000), JSON.stringify({ exchange, data: compact }));
    return `rows=${compact.length}`;
  });
}
// 2026-10-25 修复：8 所并发抢占令牌桶（rpm 3~10）→ 单轮要排队 30~160s，重试/退避叠加后周期漂到 90~120min，
// health_guard 30min 阈值持续误报「爆仓清算断供」。改为 2 所一组小并发 + 组间隔，既压住 429 又保 30min 内跑完。
const LIQ_CONCURRENCY = 2;
const LIQ_BATCH_GAP_MS = 1500;
async function collectLiquidationAll(ctx) {
  for (let i = 0; i < LIQ_EXCHANGES.length; i += LIQ_CONCURRENCY) {
    const batch = LIQ_EXCHANGES.slice(i, i + LIQ_CONCURRENCY);
    await Promise.allSettled(batch.map(ex => collectLiquidation(ctx, ex)));
    if (i + LIQ_CONCURRENCY < LIQ_EXCHANGES.length) await new Promise(r => setTimeout(r, LIQ_BATCH_GAP_MS));
  }
  return `exchanges=${LIQ_EXCHANGES.length}`;
}

// 2026-10-25 自愈：30min 巡检发现清算数据超 40min 未更新（说明本轮 cron 被限流拖死）→ 补采一次
async function liquidationWatchdog(ctx) {
  const row = ctx.db.prepare('SELECT MAX(ts) m FROM liquidation').get();
  const age = Math.floor(Date.now() / 1000) - Number((row && row.m) || 0);
  if (age > 2100) {
    warn(`[collect] liquidation stale ${age}s -> 触发自愈补采`);
    await collectLiquidationAll(ctx);
  }
  return age;
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
    } catch (e) { debug('[collect] posture loop break:', e.message); break; }
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
      ], null, 'verdict-daily');
      text = r.text.replace(/\*\*/g, '').replace(/^#+\s*/gm, ''); // 去 markdown 残留
      source = r.source;
    } catch (e) {
      text = ruleTemplateText(snap); source = 'rule-template';
      warn(`[ai] 双 key 均失败，使用规则模板兜底: ${e.message}`);
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
  db.prepare('DELETE FROM futures_markets WHERE ts < ?').run(now - 90 * day); // 回测基建：因子快照保留90天
  db.prepare('DELETE FROM funding_history WHERE ts < ?').run(now - 90 * day);
  db.prepare('DELETE FROM lsr_history WHERE ts < ?').run(now - 90 * day);
  db.prepare('DELETE FROM lsr_rankings WHERE ts < ?').run(now - 1 * day);
  db.prepare('DELETE FROM lsr_signals WHERE ts < ?').run(now - 7 * day); // 修复：lsr_signals 无清理（约 4-7MB/天）
  db.prepare('DELETE FROM funding_arb WHERE ts < ?').run(now - 1 * day);
  db.prepare('DELETE FROM consensus WHERE ts < ?').run(now - 1 * day);
  db.prepare('DELETE FROM liquidation WHERE ts < ?').run(now - 90 * day); // 回测基建：清算保留90天
  db.prepare('DELETE FROM openclue_archive WHERE ts < ?').run(now - 400 * day); // 目标存 400 天
  // 2026-10-01 底座补全：以下表此前【无任何清理策略】→ 随运行无限膨胀（w1.db 4.1GB 主因）
  db.prepare('DELETE FROM jin10_flash_cache WHERE ts < ?').run(now - 30 * day);
  db.prepare('DELETE FROM economic_calendar WHERE ts < ?').run(now - 180 * day);
  db.prepare('DELETE FROM macro_indicators_cache WHERE ts < ?').run(now - 30 * day);
  db.prepare('DELETE FROM asset_prices WHERE ts < ?').run(now - 400 * day);
  db.prepare('DELETE FROM klines WHERE ts < ?').run(now * 1000 - 400 * day * 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  // 访问日志：确定性清理（原先只在页面访问时 2% 概率触发，长期不收敛）
  db.prepare('DELETE FROM access_log WHERE ts < ?').run(Date.now() - 90 * day * 1000);
}


/* ---------------- 每周系统自检：开单逻辑自评补写 ---------------- */
function weeklySelfReview(ctx) {
  const db = ctx.db;
  // 1. 已结算但无自评的单 → 用库存 reasoning 补写（规则自评）
  const pending = db.prepare("SELECT id, symbol, direction, status, pnl_pct, reason, reasoning_json FROM signal_track WHERE status IN ('WIN','LOSS') AND (self_review IS NULL OR self_review='') LIMIT 200").all();
  let done = 0;
  for (const r of pending) {
    try {
      let rz = null; try { rz = JSON.parse(r.reasoning_json || 'null'); } catch (e) {}
      const dims = (rz && rz.dims) || {};
      const pos = Object.entries(dims).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const parts = [];
      if (r.status === 'WIN') {
        parts.push('✅ 逻辑兑现');
        if (pos.length) parts.push('驱动: ' + pos.slice(0, 2).map(([k, v]) => k + '(' + (v > 0 ? '+' : '') + v + ')').join('、'));
      } else {
        parts.push('❌ 未达预期' + (r.reason ? '（' + r.reason + '）' : ''));
        if (pos.length) parts.push('当时依据: ' + pos.slice(0, 2).map(([k, v]) => k + '(' + (v > 0 ? '+' : '') + v + ')').join('、'));
      }
      if (rz && rz.regime) parts.push('体制: ' + rz.regime);
      const review = parts.join('｜') || '（该单无决策明细，仅记录结果）';
      db.prepare("UPDATE signal_track SET self_review=? WHERE id=?").run(review, r.id);
      done++;
    } catch (e) { warn('[self_review] 单 ' + r.id + ' 补写失败:', e.message); }
  }
  // 2. 检查最近一周新单数量与胜率（自检报告）
  const weekAgo = Date.now() - 7 * 86400 * 1000;
  const wk = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) w FROM signal_track WHERE strategy='TIANJI' AND pushed_at>=?").get(weekAgo);
  const wkRate = wk && wk.n ? Math.round(wk.w / wk.n * 100) : 0;
  info(`[self_review] 周检完成：补写自评 ${done} 单；近7天新单 ${wk ? wk.n : 0} 笔 胜率 ${wkRate}%`);
  return done;
}

/* ---------------- 异动检测挂接（futures/lsr 采集成功后异步跑，失败不影响采集） ---------------- */

async function pushMacroAlertCron(ctx) {
  try {
    const ma = require('./macro_alert');
    const r = await ma.pushMacroAlert(ctx);
    if (r.ok) info('[macro] 事件提醒已推送');
  } catch (e) {
    warn('[macro] cron 异常:', e.message);
  }
}


/* ---------------- 全球资产行情采集（OKX SWAP：美股/指数/大宗/加密永续，一次批量拉取） ---------------- */
// 2026-08-14 新增：机构级全球资产仪表盘数据源（v2 改用 OKX，Yahoo 对云 IP 封锁）
async function collectGlobalAssets(ctx) {
  const { db } = ctx;
  const { ASSETS } = require('./marketdata/universe');
  const okx = require('./marketdata/okx_market');
  const now = Math.floor(Date.now() / 1000);
  try {
    const tickers = await okx.allTickers();
    const map = new Map(tickers.map(t => [t.instId, t]));
    const ins = db.prepare(`INSERT OR REPLACE INTO asset_prices
      (symbol,ts,price,prev_close,change_pct,change,currency,name,exchange,asset_class,name_zh,grp)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    let okN = 0;
    for (const a of ASSETS) {
      const t = map.get(a.s);
      if (!t || !t.last || Number(t.last) <= 0) continue;
      const q = okx.normalize(t, a);
      ins.run(a.s, now, q.price, q.prevClose, q.changePct, q.change, q.currency, q.name, 'OKX', a.cls, a.zh, a.grp);
      okN++;
    }
    recordHealth(db, 'okx_global_assets', okN > 10 ? 1 : 0, 0, `ok=${okN}/${ASSETS.length}`);
    debug(`[assets] OKX 全球资产采集完成: ${okN}/${ASSETS.length}`);
    return { ok: okN };
  } catch (e) {
    recordHealth(db, 'okx_global_assets', 0, 0, e.message);
    warn('[assets] OKX 采集失败:', e.message);
    return { ok: 0, error: e.message };
  }
}

/* ---------------- 美股财报日历采集（每 2 小时，交易时段自动覆盖） ---------------- */
async function collectEarnings(ctx) {
  const { db } = ctx;
  try {
    const yahoo = require('./marketdata/yahoo');
    const rows = await yahoo.earningsCalendar(14);
    if (!rows.length) return 0;
    const ups = db.prepare(`INSERT OR REPLACE INTO earnings
      (symbol,date,eps_est,eps_act,revenue_est,revenue_act,quarter,fetched_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    let n = 0;
    for (const r of rows) {
      if (!r.symbol || !r.date) continue;
      ups.run(r.symbol, r.date, r.epsEst, r.epsAct, r.revenueEst, r.revenueAct, r.quarter, Date.now());
      n++;
    }
    recordHealth(db, 'yahoo_earnings', 1, 0, `${n} 条财报日历`);
    debug(`[earnings] 财报日历更新 ${n} 条`);
    return n;
  } catch (e) {
    recordHealth(db, 'yahoo_earnings', 0, 0, e.message);
    warn('[earnings] 财报日历采集失败:', e.message);
    return 0;
  }
}

/* ---------------- FRED 经济数据库（每日；未配置 FRED_API_KEY 时自动跳过） ---------------- */
async function collectFred(ctx) {
  const { db, env } = ctx;
  try {
    const fred = require('./marketdata/fred');
    const r = await fred.collectAll(env);
    if (!r.ok) { recordHealth(db, 'fred', 0, 0, r.skipped); return; }
    db.prepare('INSERT OR REPLACE INTO macro_snapshot(ts,payload) VALUES(?,?)').run(Math.floor(Date.now()/1000), JSON.stringify(r));
    recordHealth(db, 'fred', 1, 0, `${Object.keys(r.series).length} 个系列`);
    debug(`[fred] 经济数据库更新 ${Object.keys(r.series).length} 个系列`);
  } catch (e) {
    recordHealth(db, 'fred', 0, 0, e.message);
    warn('[fred] 采集失败:', e.message);
  }
}

/* ---------------- 全球资产 10 大指标：定时计算存储（前端只读缓存，不实时算） ---------------- */
async function collectMacroIndicators(ctx) {
  const { db } = ctx;
  try {
    const { buildIndicators } = require('./analytics/market_indicators');
    const r = await buildIndicators(db);
    if (!r || !Array.isArray(r.indicators)) { recordHealth(db, 'macro_indicators', 0, 0, 'empty'); return; }
    db.prepare('CREATE TABLE IF NOT EXISTS macro_indicators_cache(ts INTEGER PRIMARY KEY, payload TEXT NOT NULL)').run();
    db.prepare('INSERT OR REPLACE INTO macro_indicators_cache(ts,payload) VALUES(?,?)')
      .run(Math.floor(Date.now() / 1000), JSON.stringify(r));
    const n = r.scored || 0;
    recordHealth(db, 'macro_indicators', n >= 3 ? 1 : 0, 0, `算得 ${n}/${r.total} 个有效指标 · composite=${r.composite ?? '-'}`);
    debug(`[macro-ind] 指标计算存储完成: ${n}/${r.total} 个有效，composite=${r.composite ?? '-'}`);
  } catch (e) {
    recordHealth(db, 'macro_indicators', 0, 0, e.message);
    warn('[macro-ind] 计算失败:', e.message);
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
  'etf': collectETF,
  'liquidation': collectLiquidationAll,
  'daily-verdict': collectDailyVerdict,
  'stablecoin': (ctx) => { const ff = require('./fund_flow'); return ff.collectStablecoinSupply(ctx.db); },
  'macro-indicators': collectMacroIndicators,
  'daily-analysis': async (ctx) => {
    // William 每日分析：每天 08:00 生成当日 BTC/ETH 五维分析
    try {
      const da = require('./daily_analysis');
      da.ensureTable(ctx.db);
      const d = new Date();
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = await da.generateOne(ctx.db, ctx.env, ds);
      debug('[daily] 分析完成:', ds, r.cached ? '已存在' : '生成');
    } catch (e) { warn('[daily] 生成失败:', e.message); }
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
      const ex = ctx.db.prepare('SELECT date, ts FROM hero_brief_self WHERE date=?').get(t);
      if (ex) {
        // 2026-08-22：凌晨 rerun 预生成的记录（早于当天 08:20）不视为正式缓存，08:30 cron 允许覆盖刷新
        const dayFloor = Math.floor(new Date(t + 'T08:20:00+08:00').getTime() / 1000);
        if (ex.ts >= dayFloor) return 'cached';
      }
      const snap = buildEngineSnapshot(ctx);
      const hb = await heroBrief.generate(ctx, snap);
      ctx.db.prepare('INSERT OR REPLACE INTO hero_brief_self(date,payload,ts,source) VALUES(?,?,?,?)')
        .run(t, JSON.stringify(hb), Math.floor(Date.now() / 1000), hb.source);
      debug('[hero_brief] 自研生成完成 (' + hb.source + '): ' + hb.headline_zh);
      return hb.source;
    } catch (e) { warn('[hero_brief] 生成失败:', e.message); throw e; }
  }
};

function startCron(ctx) {
  const opt = { timezone: TZ };
  cron.schedule('* * * * *', () => collectGatePrices(ctx), opt);        // 60s
  cron.schedule('*/5 * * * *', () => { collectFuturesMarkets(ctx).catch(e => warn('[futures] 快照采集失败:', e.message)); }, opt); // 300s futures快照（修复价格断档 2026-08-15）
  cron.schedule('*/5 * * * *', () => { collectKlines(ctx).catch(e => warn('[klines] 累积采集失败:', e.message)); }, opt); // 300s K线增量累积（回测基建）
  cron.schedule('*/5 * * * *', async () => {
    const okT = await collectLsrRanking(ctx, 'trader');
    const okW = await collectLsrRanking(ctx, 'whale');
    await collectFundingArb(ctx);
  }, opt); // 300s + 异动检测挂接
  cron.schedule('*/5 * * * *', () => { collectLsrSignals(ctx).catch(e => warn('[lsr] signals error:', e.message)); }, opt);  // v2 批量完整信号（8大币+XAU）
  cron.schedule('*/5 * * * *', () => { collectLsrHealth(ctx).catch(e => warn('[lsr] health error:', e.message)); }, opt);  // LSR 健康监控
  // 2026-10-01 退役：/api/lsr/consensus/v1/signals 上游已下线（恒定 400；实测 v2/v1/coins/futures 变体全部 404/400）。
  // 无可用替代端点 → 停止采集。consensus 表与下游空值保护保留，待有新数据源再启用。
  cron.schedule('*/10 * * * *', () => { collectConsensus(ctx).catch(e => warn('[lsr] consensus error:', e.message)); }, opt); // LSR 共识 v1（新网关已恢复）
  cron.schedule('0 */3 * * *', () => collectFearGreed(ctx), opt);   // FGI 上游一日一更，3h 采样足够（避免空请求浪费 Coinglass 配额/429）
  cron.schedule('*/10 * * * *', () => { healthGuard.runGuard(ctx).catch(e => warn('[health_guard] cron error:', e.message)); }, opt); // 数据断供统一预警巡检 10min
  // 2026-10-21 v7 监测核心：跨源一致性 / 告警评分卡 / SLO 日汇总
  cron.schedule('*/10 * * * *', () => { require('./consistency').run(ctx).catch(e => warn('[consistency] cron error:', e.message)); }, opt);
  cron.schedule('*/15 * * * *', () => { try { require('./scorecard').evaluate(ctx.db, { days: 30, limit: 300 }); } catch (e) { warn('[scorecard] cron error:', e.message); } }, opt);
  cron.schedule('20 0 * * *', () => { try { require('./slo').rollup(ctx.db, { days: 30 }); } catch (e) { warn('[slo] cron error:', e.message); } }, opt);
  cron.schedule('*/30 * * * *', () => { collectLiquidationAll(ctx).catch(e => warn('[collect] liquidation cron error:', e.message)); }, opt); // 1800s 清算多所（2 所小并发，2026-10-25）
  cron.schedule('*/15 * * * *', () => { liquidationWatchdog(ctx).catch(e => warn('[collect] liquidation watchdog error:', e.message)); }, opt); // 每15min 断供自愈补采
  cron.schedule('*/30 * * * *', () => { collectOpenclue(ctx).catch(e => warn('[openclue_archive] cron error:', e.message)); try { prune(ctx); } catch (e) { warn('[openclue_archive] prune error:', e.message); } }, opt); // 1800s
  cron.schedule('0 */2 * * *', () => { collectETF(ctx).catch(e => warn('[etf_archive] cron error:', e.message)); }, opt); // 主动更新 ETF 流 2h（2026-09-01 新增）
  cron.schedule('30 8 * * *', () => collectDailyVerdict(ctx), opt);     // 每日 08:30
  cron.schedule('30 8 * * *', () => { try { JOBS['hero-brief-self'](ctx); } catch (e) { warn('[hero_brief] cron error:', e.message); } }, opt); // 每日 08:30 自研今日主要观点
  cron.schedule('35 8 * * *', () => { JOBS['altseason'](ctx).catch(e => warn('[altseason] cron error:', e.message)); }, opt); // 每日 08:35 山寨季/主流季判断
  cron.schedule('40 8 * * *', () => { marketStructure.collectMarketStructure(ctx).catch(e => warn('[market_structure] cron error:', e.message)); }, opt); // 每日 08:40 市场结构
  cron.schedule('*/30 * * * *', () => { ecoCalendar.collectEcoCalendar(ctx).catch(e => warn('[eco_calendar] cron error:', e.message)); }, opt); // 经济日历 30min
  cron.schedule('*/30 * * * *', () => { try { const ff = require('./fund_flow'); ff.collectStablecoinSupply(ctx.db); } catch (e) { warn('[fund] cron error:', e.message); } }, opt); // 稳定币供应 30min
  cron.schedule('*/30 * * * *', () => { marketGlobal.collectMarketGlobal(ctx).catch(e => warn('[market_global] cron error:', e.message)); }, opt); // 市场全局 30min
  cron.schedule('0 8 * * *', () => JOBS['daily-analysis'](ctx), opt);  // 每日 08:00 William 每日分析
  cron.schedule('0 8 * * *', () => pushMacroAlertCron(ctx), opt);          // 每日 08:00 宏观事件提醒
  cron.schedule('0 20 * * *', () => pushMacroAlertCron(ctx), opt);         // 每日 20:00 宏观事件提醒
  cron.schedule('*/5 * * * *', () => { collectGlobalAssets(ctx).catch(e => warn('[assets] cron error:', e.message)); }, opt); // 全球资产行情 5min
  cron.schedule('*/5 * * * *', () => { skyeye.scanAll(ctx).catch(e => warn('[skyeye] scan error:', e.message)); }, opt); // SkyEye异动预警 5min
  cron.schedule('*/10 * * * *', () => { marketWatch.scanAll(ctx).catch(e => warn('[market_watch] scan error:', e.message)); }, opt); // 市场监测群增强播报 10min（费率/OI/KOL，各带去重）
  cron.schedule('*/15 * * * *', () => { regime.classify(ctx, ['BTC','ETH','SOL','BNB','XRP','DOGE','LINK','ADA']).catch(e => warn('[regime] classify error:', e.message)); }, opt); // 市场体制总开关 15min（2026-08-31修复：此前未调度导致门控失效全损）
  // 2026-08-22 停用：yahoo 财报日历端点持续 429（外部限流），且 earnings 表无任何消费方（routes/前端均未引用），纯消耗请求。恢复条件：换数据源或 yahoo 解封
  // cron.schedule('17 */2 * * *', () => { collectEarnings(ctx).catch(e => warn('[earnings] cron error:', e.message)); }, opt); // 财报日历 2h (disabled 2026-08-22)
  cron.schedule('45 8 * * *', () => { collectFred(ctx).catch(e => warn('[fred] cron error:', e.message)); }, opt);        // FRED 每日 08:45
  cron.schedule('*/30 * * * *', () => { collectMacroIndicators(ctx).catch(e => warn('[macro-ind] cron error:', e.message)); }, opt); // 全球资产10大指标：定时计算存储 30min
  cron.schedule('17 * * * *', () => { const kol = require('./kol_watch'); kol.collectKOL(ctx).catch(e => warn('[kol] cron error:', e.message)); }, opt); // KOL 观点每小时
  // 启动后立即错峰补一轮（避免冷启动空库）
  const boot = [collectGatePrices, collectFuturesMarkets, collectFearGreed, collectOpenclue, collectETF,
    (c) => collectLsrRanking(c, 'trader'), (c) => collectLsrRanking(c, 'whale'),
    collectFundingArb, collectLiquidationAll,   // 2026-10-01: collectConsensus 已退役
    collectDailyVerdict, JOBS['hero-brief-self'], JOBS['daily-analysis'],
    (c) => { try { const ff = require('./fund_flow'); return ff.collectStablecoinSupply(c.db); } catch (e) { warn('[fund] boot error:', e.message); } },
    marketGlobal.collectMarketGlobal,
    marketStructure.collectMarketStructure,
    ecoCalendar.collectEcoCalendar,
    altseason.collectAltseason,
    pushMacroAlertCron,
    collectGlobalAssets,
    collectMacroIndicators];
  boot.forEach((fn, i) => setTimeout(() => fn(ctx), 3000 + i * 2500));
  // boot 全部完成后错峰跑一次异动检测（冷启动数据就绪后）
  info('[cron] jobs registered (Asia/Shanghai)');
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
  debug('[smoke] fake data seeded');
}

module.exports = { startCron, buildEngineSnapshot, collectDailyVerdict, seedSmoke, recordHealth, prune, JOBS, collectLsrSignals, collectLsrHealth, collectLsrRanking, collectConsensus, collectGlobalAssets, collectEarnings, collectFred, skyeye, marketWatch };
