// lib/kline.js — K线获取 + 30分钟缓存（从 engine.js 拆出）
'use strict';
const klCache = { ts: 0, data: {} };
async function fetchKL(sym, tf, bars = 300) {
  const to = Math.floor(Date.now() / 1000);
  const secs = tf === '1d' ? 86400 : tf === '4h' ? 14400 : tf === '1h' ? 3600 : 900;
  const from = to - bars * secs;
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym}_USDT&interval=${tf}&from=${from}&to=${to}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`kline ${sym} ${tf} http ${r.status}`);
  const arr = await r.json();
  return arr.map(c => ({ t: +c[0], o: +c[5], h: +c[3], l: +c[4], c: +c[2], v: +c[6] })).sort((a, b) => a.t - b.t);
}
async function getKL(sym, tf) {
  const key = sym + ':' + tf;
  if (klCache.data[key] && Date.now() - klCache.ts < 30 * 60 * 1000) return klCache.data[key];
  const k = await fetchKL(sym, tf);
  klCache.data[key] = k;
  klCache.ts = Date.now();
  return k;
}


module.exports = { getKL, fetchKL };
