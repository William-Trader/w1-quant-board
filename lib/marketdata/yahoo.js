'use strict';
// ============================================================
// Yahoo Finance 行情封装 v1.1（2026-08-14）
//  - 直连 query1/query2 轮询；完整浏览器头
//  - 全局串行 + ≥1.5s 间隔 + 429 指数退避（30s/60s）
//  - symbol 级 5 分钟缓存（防 API 按需请求与采集互相叠加）
//  - 主源：美股/指数/大宗/外汇/债券；加密走 Gate（见 routes）
// ============================================================
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const TIMEOUT_MS = 10000;

let _chain = Promise.resolve();
let _lastReq = 0;
const _minGapMs = 1500;
const _cache = new Map(); // key -> {ts, data}
const CACHE_TTL = 5 * 60 * 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function throttle(fn) {
  const run = async () => {
    const wait = Math.max(0, _lastReq + _minGapMs - Date.now());
    if (wait > 0) await sleep(wait);
    _lastReq = Date.now();
    return fn();
  };
  const p = _chain.then(run, run);
  _chain = p.catch(() => {});
  return p;
}

function cacheGet(key) {
  const c = _cache.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.data;
  return undefined;
}
function cacheSet(key, data) { _cache.set(key, { ts: Date.now(), data }); }

async function getJson(path, retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(host + path, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': 'https://finance.yahoo.com/',
          'Origin': 'https://finance.yahoo.com',
          'Connection': 'keep-alive'
        },
        signal: ctrl.signal
      });
      if (res.status === 429) {
        lastErr = new Error('yahoo_429');
        await sleep(30000 * (attempt + 1)); // 30s / 60s 退避
        continue;
      }
      if (res.status === 403) { lastErr = new Error('yahoo_403'); await sleep(5000); continue; }
      if (!res.ok) throw new Error(`yahoo_http_${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') lastErr = new Error('yahoo_timeout');
      await sleep(2000 * (attempt + 1));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

/** 单资产报价（v8 chart） */
async function quote(symbol) {
  const key = 'q:' + symbol;
  const cached = cacheGet(key);
  if (cached) return cached;
  return throttle(async () => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`;
    const j = await getJson(path);
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.meta) throw new Error(`yahoo_empty_${symbol}`);
    const m = r.meta;
    const out = {
      symbol,
      price: m.regularMarketPrice,
      prevClose: m.previousClose,
      change: m.regularMarketPrice != null && m.previousClose != null ? m.regularMarketPrice - m.previousClose : null,
      changePct: m.regularMarketPrice != null && m.previousClose != null && m.previousClose !== 0
        ? ((m.regularMarketPrice - m.previousClose) / m.previousClose) * 100 : null,
      currency: m.currency,
      marketTime: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
      name: m.shortName || m.longName || symbol,
      exchange: m.exchangeName || ''
    };
    cacheSet(key, out);
    return out;
  });
}

/** K线 */
async function kline(symbol, range = '1mo', interval = '1d') {
  const key = `k:${symbol}:${range}:${interval}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  return throttle(async () => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const j = await getJson(path);
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r) throw new Error(`yahoo_kl_empty_${symbol}`);
    const ts = r.timestamp || [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      out.push({
        t: ts[i] * 1000,
        o: q.open && q.open[i], h: q.high && q.high[i],
        l: q.low && q.low[i], c: q.close && q.close[i], v: q.volume && q.volume[i]
      });
    }
    const filtered = out.filter(x => x.c != null);
    cacheSet(key, filtered);
    return filtered;
  });
}

/** 财报日历 */
async function earningsCalendar(daysAhead = 14) {
  const key = 'e:' + daysAhead;
  const cached = cacheGet(key);
  if (cached) return cached;
  return throttle(async () => {
    const start = Math.floor(Date.now() / 1000);
    const end = start + daysAhead * 86400;
    const path = `/calendar/earnings?from=${start}&to=${end}&size=100&offset=0`;
    const j = await getJson(path);
    const rows = (j && j.earnings && j.earnings.earningsDate) || [];
    const out = rows.map(r => ({
      symbol: r.symbol,
      date: r.startdatetime ? new Date(r.startdatetime).toISOString() : (r.earningsDate ? r.earningsDate.slice(0, 10) : null),
      epsEst: r.epsEstimate != null ? Number(r.epsEstimate) : null,
      epsAct: r.epsActual != null ? Number(r.epsActual) : null,
      revenueEst: r.revenueEstimate != null ? Number(r.revenueEstimate) : null,
      revenueAct: r.revenueActual != null ? Number(r.revenueActual) : null,
      quarter: r.quarter || null
    }));
    cacheSet(key, out);
    return out;
  });
}

module.exports = { quote, kline, earningsCalendar };
