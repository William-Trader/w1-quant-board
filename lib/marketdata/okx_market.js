'use strict';
// ============================================================
// OKX 全球资产行情 v1.0（2026-08-14）
//  - 免 key 公共 API，直连（云端已验证可达）
//  - 覆盖：美股指数/ETF/个股代币化永续 + 大宗（金/银/铜/油/气）+ 加密
//  - allTickers() 一次拉全部 447 个 SWAP，批量过滤即可
//  - candles() 历史K线（备用；加密 K线仍走 Gate 保持一致性）
// ============================================================
const BASE = 'https://www.okx.com/api/v5';

async function _get(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(BASE + path, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'w1-board/6.0' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`okx_http_${res.status}`);
    const j = await res.json();
    if (j.code !== '0') throw new Error(`okx_${j.code}`);
    return j.data;
  } finally { clearTimeout(timer); }
}

/** 全部 SWAP ticker（一次请求，约 447 个） */
async function allTickers() {
  return _get('/market/tickers?instType=SWAP');
}

/** 单品种 ticker */
async function ticker(instId) {
  const d = await _get('/market/ticker?instId=' + encodeURIComponent(instId));
  return d && d[0] || null;
}

/** K线（bar: 1m/5m/15m/1H/4H/1D；limit ≤ 300） */
async function candles(instId, bar = '1D', limit = 100) {
  const d = await _get(`/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`);
  return (d || []).map(c => ({
    t: Number(c[0]),
    o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]), v: Number(c[5])
  }));
}

/** 标准换算：OKX ticker → 统一行情对象 */
function normalize(t, def) {
  const price = Number(t.last);
  const open = Number(t.open24h);
  return {
    symbol: t.instId,
    price,
    prevClose: open || null,
    change: price && open ? price - open : null,
    changePct: price && open ? (price - open) / open * 100 : null,
    currency: 'USD',
    marketTime: Number(t.ts) || Date.now(),
    name: def ? def.en : t.instId,
    exchange: 'OKX',
    high24h: Number(t.high24h), low24h: Number(t.low24h),
    vol24h: Number(t.volCcy24h)
  };
}

module.exports = { allTickers, ticker, candles, normalize };
