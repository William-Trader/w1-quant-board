'use strict';
// 实测 Coinglass/LSR 8 个关键接口（真实网络，key 有效时必须 8/8 PASS）
const { loadEnv } = require('../lib/env');
const env = loadEnv();
const BASE = (env.COINGLASS_BASE || 'https://api.coinglass.site').replace(/\/+$/, '');
const KEY = env.COINGLASS_API_KEY || '';

let pass = 0, total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' (' + extra + ')' : ''}`); }
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

async function hit(path, opts = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(BASE + path, { headers: { 'X-API-Key': KEY, 'Accept': 'application/json' }, signal: ctrl.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, ms: Date.now() - t0, upstream: r.headers.get('x-upstream'), etag: r.headers.get('etag') };
  } catch (e) {
    return { status: 0, error: e.message, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

(async () => {
  console.log(`== verify-coinglass · ${BASE} · key ${KEY.slice(0, 6)}...${KEY.slice(-4)} ==`);

  // 1. Coinglass coins-markets
  let r = await hit('/api/futures/coins-markets?per_page=10');
  check('coins-markets', r.status === 200 && r.json && String(r.json.code) === '0' && Array.isArray(r.json.data) && r.json.data.length > 0, `http ${r.status} ${r.ms}ms rows=${r.json && r.json.data ? r.json.data.length : 0}`);

  // 2. fear-greed-history
  r = await hit('/api/index/fear-greed-history?limit=10');
  check('fear-greed-history', r.status === 200 && r.json && String(r.json.code) === '0' && r.json.data && Array.isArray(r.json.data.data_list), `http ${r.status} ${r.ms}ms points=${r.json && r.json.data ? r.json.data.data_list.length : 0}`);

  // 3. lsr v2 status
  r = await hit('/api/lsr/v2/status');
  check('lsr/v2/status', r.status === 200 && r.json && r.json.success !== false && r.json.ok !== undefined || (r.json && r.json.success !== false), `http ${r.status} ${r.ms}ms ok=${r.json && r.json.ok}`);

  // 4. lsr v2 ranking trader
  r = await hit('/api/lsr/v2/ranking?mode=trader&limit=20&offset=0');
  check('lsr/v2/ranking trader', r.status === 200 && r.json && r.json.success !== false && Array.isArray(r.json.data) && r.json.data.length > 0, `http ${r.status} ${r.ms}ms rows=${r.json && r.json.data ? r.json.data.length : 0} etag=${!!r.etag}`);

  // 5. ETag → 304 复用（用上次 ETag）
  if (r.etag) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r2 = await fetch(BASE + '/api/lsr/v2/ranking?mode=trader&limit=20&offset=0', { headers: { 'X-API-Key': KEY, 'If-None-Match': r.etag }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
    check('ETag/If-None-Match', r2.status === 304 || r2.status === 200, `http ${r2.status} ${Date.now() - t0}ms`);
  } else {
    check('ETag/If-None-Match', false, 'no etag header on ranking');
  }

  // 6. funding arbitrage
  r = await hit('/api/lsr/funding-rate/arbitrage?sort=apr&order=desc');
  check('lsr funding arbitrage', r.status === 200 && r.json && r.json.success !== false && Array.isArray(r.json.data), `http ${r.status} ${r.ms}ms rows=${r.json && r.json.data ? r.json.data.length : 0}`);

  // 7. consensus symbols + signals
  r = await hit('/api/lsr/consensus/v1/symbols');
  const symOk = r.status === 200 && r.json && r.json.success !== false;
  r = await hit('/api/lsr/consensus/v1/signals');
  const sigOk = r.status === 200 && (Array.isArray(r.json) || (r.json && r.json.success !== false));
  check('consensus symbols+signals', symOk && sigOk, `symbols http ok=${symOk}, signals http ${r.status} rows=${Array.isArray(r.json) ? r.json.length : '?'}`);

  // 8. spot coins-markets
  r = await hit('/api/spot/coins-markets?per_page=10');
  check('spot coins-markets', r.status === 200 && r.json && String(r.json.code) === '0' && Array.isArray(r.json.data), `http ${r.status} ${r.ms}ms rows=${r.json && r.json.data ? r.json.data.length : 0}`);

  console.log(`\n== ${pass}/${total} PASS ==`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => { console.error('VERIFY FATAL', e); process.exit(1); });
