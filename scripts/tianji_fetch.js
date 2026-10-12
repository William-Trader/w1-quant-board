'use strict';
// ═══════════════════════════════════════════════════════════
// TIANJI 回测数据全量抓取器 v2 (2026-08-21)
// 统一替代 /tmp/pull_*.js 零散脚本，一次跑全：
//   ① Binance K线 全量历史（分页/断点续拉/幂等）
//   ② Coinglass 5 因子历史（LSR账户比/LSR大户/OI/清算/费率，1000点上限）
//   ③ FGI 恐惧贪婪指数全历史（alternative.me，免费）
//   ④ KOL consensus 历史（合并 w1.db + 每日备份库，去重）
// 用法:
//   node tianji_fetch.js                          # 全量（默认：K线2018起 + 因子 + FGI + consensus）
//   node tianji_fetch.js --incremental            # 增量刷新（日常 cron，K线续拉 + 因子重拉最新1000）
//   node tianji_fetch.js --skip-klines            # 跳过K线
//   node tianji_fetch.js --skip-factors           # 跳过因子
//   node tianji_fetch.js --skip-fgi --skip-consensus   # 按需跳过
//   node tianji_fetch.js --db /path/to/x.sqlite   # 指定库（默认 data/tianji_full.sqlite）
// 幂等设计：INSERT OR REPLACE，可重复执行；断点续拉：K线从库内 MAX(time) 续
// ═══════════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const path = require('path');
const { execFile } = require('child_process');
const { CoinglassClient } = require('../lib/coinglass');
const { loadEnv } = require('../lib/env');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.argv.includes('--db')
  ? path.resolve(process.argv[process.argv.indexOf('--db') + 1])
  : path.join(ROOT, 'data', 'tianji_full.sqlite');
const INCREMENTAL = process.argv.includes('--incremental');
const SKIP_KLINES = process.argv.includes('--skip-klines');
const SKIP_FACTORS = process.argv.includes('--skip-factors');
const SKIP_FGI = process.argv.includes('--skip-fgi');
const SKIP_CONSENSUS = process.argv.includes('--skip-consensus');
const SKIP_NEWS = process.argv.includes('--skip-news');

const env = loadEnv();
const PROXY = env.PROXY_URL || 'http://127.0.0.1:7890';
// 交易所：Binance（默认）| OKX（实盘 fund 数据同源：Coinglass markets 用 OKX 合约，XAU=OKX XAU-USDT-SWAP）
const EXCHANGE = process.argv.includes('--exchange') ? process.argv[process.argv.indexOf('--exchange') + 1] : 'Binance';
const OKX_MODE = EXCHANGE === 'OKX';
// 间隔：默认 4h（全史）；--interval 5m → 从完整五维边界 2026-08-11 起（复现实盘用）
const INTERVAL = process.argv.includes('--interval') ? process.argv[process.argv.indexOf('--interval') + 1] : '4h';
const INTERVAL_MS = INTERVAL === '4h' ? 4 * 3600 * 1000 : 5 * 60 * 1000;
const KLINE_START_MS = INTERVAL === '5m' ? 1783814400000 : 1514764800000; // 5m: 2026-08-11 / 4h: 2018-01-01
// 9 标的（实盘 WATCH 列表；OKX 模式用 OKX 合约名，XAU=OKX XAU-USDT-SWAP 非 PAXG）
const SYMBOLS = OKX_MODE
  ? [['BTC', 'BTC-USDT-SWAP'], ['ETH', 'ETH-USDT-SWAP'], ['SOL', 'SOL-USDT-SWAP'], ['BNB', 'BNB-USDT-SWAP'],
     ['XRP', 'XRP-USDT-SWAP'], ['DOGE', 'DOGE-USDT-SWAP'], ['LINK', 'LINK-USDT-SWAP'], ['ADA', 'ADA-USDT-SWAP'],
     ['XAU', 'XAU-USDT-SWAP']]
  : [['BTC', 'BTCUSDT'], ['ETH', 'ETHUSDT'], ['SOL', 'SOLUSDT'], ['BNB', 'BNBUSDT'],
     ['XRP', 'XRPUSDT'], ['DOGE', 'DOGEUSDT'], ['LINK', 'LINKUSDT'], ['ADA', 'ADAUSDT'],
     ['XAU', 'PAXGUSDT']];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function curl(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-s', '--max-time', '25', '--proxy', PROXY, url], (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('bad json')); }
    });
  });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS lsr_account (exchange TEXT, symbol TEXT, interval TEXT, time INTEGER, ratio REAL, long_pct REAL, short_pct REAL, PRIMARY KEY(exchange,symbol,interval,time));
CREATE TABLE IF NOT EXISTS lsr_top (exchange TEXT, symbol TEXT, interval TEXT, time INTEGER, ratio REAL, long_pct REAL, short_pct REAL, PRIMARY KEY(exchange,symbol,interval,time));
CREATE TABLE IF NOT EXISTS oi_history (exchange TEXT, symbol TEXT, interval TEXT, time INTEGER, open REAL, high REAL, low REAL, close REAL, PRIMARY KEY(exchange,symbol,interval,time));
CREATE TABLE IF NOT EXISTS liquidation_hist (exchange TEXT, symbol TEXT, interval TEXT, time INTEGER, long_usd REAL, short_usd REAL, PRIMARY KEY(symbol,interval,time));
CREATE TABLE IF NOT EXISTS funding_hist (exchange TEXT, symbol TEXT, interval TEXT, time INTEGER, o REAL, h REAL, l REAL, c REAL, PRIMARY KEY(exchange,symbol,interval,time));
CREATE TABLE IF NOT EXISTS klines (symbol TEXT, interval TEXT, time INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY(symbol,interval,time));
CREATE TABLE IF NOT EXISTS consensus_hist (ts INTEGER PRIMARY KEY, payload TEXT);
CREATE TABLE IF NOT EXISTS fgi_hist (ts INTEGER PRIMARY KEY, value INTEGER, classification TEXT);
CREATE TABLE IF NOT EXISTS news_hist (ts INTEGER, title TEXT, sentiment TEXT, influence INTEGER, PRIMARY KEY(ts,title));
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);

const cg = new CoinglassClient(env, { prepare: () => ({ get: () => null, all: () => [], run: () => {} }) });
const t0 = Date.now();
let okCount = 0, errCount = 0, skipCount = 0;

function log(s) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`); }

/* ---------- ① K线（Binance 分页断点续拉；OKX 模式只拉 XAU-OKX 真合约，覆盖 PAXG 近似） ---------- */
async function pullKlines() {
  if (OKX_MODE) { await pullOkxKlines(); return; }
  const ins = db.prepare('INSERT OR REPLACE INTO klines VALUES (?,?,?,?,?,?,?,?)');
  for (const [key, sym] of SYMBOLS) {
    let all = [];
    let start;
    if (INCREMENTAL) {
      const r = db.prepare("SELECT MAX(time) mx FROM klines WHERE symbol=? AND interval=?").get(key, INTERVAL);
      start = (r && r.mx) ? r.mx + INTERVAL_MS : KLINE_START_MS;
    } else {
      start = KLINE_START_MS;
    }
    let pages = 0;
    while (true) {
      let arr;
      try {
        arr = await curl(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${INTERVAL}&limit=1000&startTime=${start}`);
      } catch (e) {
        if (++pages > 5) { log(`[K线] ${key} 连续失败: ${e.message}`); errCount++; break; }
        await sleep(1500); continue;
      }
      if (!Array.isArray(arr) || !arr.length) break;
      pages = 0;
      for (const k of arr) all.push([key, INTERVAL, k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
      const last = arr[arr.length - 1][0];
      if (arr.length < 1000 || last >= Date.now() - INTERVAL_MS) break;
      start = last + 1;
      await sleep(180);
    }
    if (all.length) {
      db.transaction(rows => { for (const x of rows) ins.run(...x); })(all);
      log(`[K线] ${key}(${sym}) 写入 ${all.length} 条 → 最新 ${new Date(all[all.length-1][2]).toISOString().slice(0, 16)}`);
      okCount++;
    } else {
      log(`[K线] ${key}(${sym}) 无新数据`); skipCount++;
    }
    await sleep(250);
  }
}

/* ---------- ①b OKX K线（candle API，300/页，before 分页；仅 XAU，其他币 Binance 已全史） ---------- */
async function pullOkxKlines() {
  const ins = db.prepare('INSERT OR REPLACE INTO klines VALUES (?,?,?,?,?,?,?,?)');
  const bar = INTERVAL === '4h' ? '4H' : '5m';
  let all = [];
  let before = '';
  let startMs;
  if (INCREMENTAL) {
    const r = db.prepare("SELECT MAX(time) mx FROM klines WHERE symbol=? AND interval=?").get('XAU', INTERVAL);
    startMs = (r && r.mx) ? r.mx + INTERVAL_MS : KLINE_START_MS;
  } else startMs = KLINE_START_MS;
  let fail = 0;
  while (true) {
    const url = `https://www.okx.com/api/v5/market/candles?instId=XAU-USDT-SWAP&bar=${bar}&limit=300${before ? '&before=' + before : ''}`;
    let arr;
    try { arr = await curl(url); } catch (e) { if (++fail > 5) break; await sleep(1500); continue; }
    const rows = (arr && arr.data) || [];
    if (!rows.length) break;
    fail = 0;
    for (const k of rows) {
      const t = +k[0]; // OKX 倒序 [ts,o,h,l,c,vol,...]
      if (t < startMs) { continue; }
      all.push(['XAU', INTERVAL, t, +k[1], +k[2], +k[3], +k[4], +k[5]]);
    }
    const lastT = +rows[rows.length - 1][0];
    before = String(lastT);
    if (rows.length < 300 || lastT < startMs) break;
    await sleep(150);
  }
  if (all.length) {
    db.transaction(rows => { for (const x of rows) ins.run(...x); })(all);
    log(`[K线-OKX] XAU(XAU-USDT-SWAP) 写入 ${all.length} 条 → 最新 ${new Date(Math.max(...all.map(x => x[2]))).toISOString().slice(0, 16)}`);
    okCount++;
  } else { log('[K线-OKX] XAU 无新数据'); skipCount++; }
}

/* ---------- ② Coinglass 因子历史（1000点上限；OKX 模式用 OKX 合约，与实盘 Coinglass markets 同源） ---------- */
async function pullFactors() {
  const jobs = [
    { table: 'lsr_account',
      path: s => `/api/futures/global-long-short-account-ratio/history?exchange=${EXCHANGE}&symbol=${s}&interval=${INTERVAL}`,
      map: (x, sym) => [EXCHANGE, sym, INTERVAL, x.time, x.global_account_long_short_ratio, x.global_account_long_percent, x.global_account_short_percent] },
    { table: 'lsr_top',
      path: s => `/api/futures/top-long-short-account-ratio/history?exchange=${EXCHANGE}&symbol=${s}&interval=${INTERVAL}`,
      map: (x, sym) => [EXCHANGE, sym, INTERVAL, x.time, x.top_account_long_short_ratio, x.top_account_long_percent, x.top_account_short_percent] },
    { table: 'oi_history',
      path: s => `/api/futures/open-interest/history?exchange=${EXCHANGE}&symbol=${s}&interval=${INTERVAL}`,
      map: (x, sym) => [EXCHANGE, sym, INTERVAL, x.time, +x.open, +x.high, +x.low, +x.close] },
    { table: 'liquidation_hist',
      // 清算端点的 symbol 用裸币名（Binance 模式 XAU→PAXG；OKX 模式直接裸名）
      path: (s, key) => `/api/futures/liquidation/aggregated-history?exchange_list=${EXCHANGE}&symbol=${OKX_MODE ? key : (key === 'XAU' ? 'PAXG' : key)}&interval=${INTERVAL}`,
      map: (x, sym) => [EXCHANGE, sym, INTERVAL, x.time, +x.aggregated_long_liquidation_usd || 0, +x.aggregated_short_liquidation_usd || 0] },
    { table: 'funding_hist',
      // ⚠️ 字段是 open/high/low/close（小写），值单位=百分数（如 0.01 = 0.01%）
      path: s => `/api/futures/funding-rate/history?exchange=${EXCHANGE}&symbol=${s}&interval=${INTERVAL}`,
      map: (x, sym) => [EXCHANGE, sym, INTERVAL, x.time, +x.open, +x.high, +x.low, +x.close] },
  ];
  for (const [key, cgSym] of SYMBOLS) {
    for (const job of jobs) {
      try {
        const r = await cg.request(job.path(cgSym, key), { etag: false });
        const d = r.data && (r.data.data || r.data);
        if (!Array.isArray(d) || !d.length) {
          log(`[因子] ${key}.${job.table} 无数据 err=${r.error}`); skipCount++; continue;
        }
        // 校验：funding 历史曾被字段名写错导致全 NULL → 现在写入前检查，全空则报错
        if (job.table === 'funding_hist' && d.every(x => !(+x.close) && !(+x.open))) {
          log(`[因子] ${key}.${job.table} ⚠️ 返回全空值，跳过（字段探测: ${JSON.stringify(d[0]).slice(0, 120)}）`);
          errCount++; continue;
        }
        const cols = job.map(d[0], key).length;
        const ins = db.prepare(`INSERT OR REPLACE INTO ${job.table} VALUES (${Array(cols).fill('?').join(',')})`);
        db.transaction(rows => { for (const x of rows) ins.run(...job.map(x, key)); })(d);
        const a = d[0].time, b = d[d.length - 1].time;
        log(`[因子] ${key}.${job.table} ${d.length}条 ${new Date(a).toISOString().slice(0,10)} → ${new Date(b).toISOString().slice(0,10)}`);
        okCount++;
      } catch (e) {
        log(`[因子] ${key}.${job.table} 异常: ${e.message}`); errCount++;
      }
      await sleep(600); // Coinglass 限流保护
    }
  }
}

/* ---------- ③ FGI 恐惧贪婪指数全历史 ---------- */
async function pullFgi() {
  try {
    const j = await curl('https://api.alternative.me/fng/?limit=0&format=json');
    const arr = (j && j.data) || [];
    if (!arr.length) { log('[FGI] 无数据'); errCount++; return; }
    const ins = db.prepare('INSERT OR REPLACE INTO fgi_hist VALUES (?,?,?)');
    db.transaction(rows => { for (const x of rows) ins.run(+x.timestamp * 1000, +x.value, String(x.value_classification || '')); })(arr);
    log(`[FGI] 写入 ${arr.length} 条 ${new Date(+arr[0].timestamp*1000).toISOString().slice(0,10)} → ${new Date(+arr[arr.length-1].timestamp*1000).toISOString().slice(0,10)}`);
    okCount++;
  } catch (e) { log(`[FGI] 异常: ${e.message}`); errCount++; }
}

/* ---------- ④ KOL consensus 历史合并（w1.db + 备份库，去重） ---------- */
function pullConsensus() {
  const ins = db.prepare('INSERT OR REPLACE INTO consensus_hist VALUES (?,?)');
  const seen = new Set();
  let total = 0;
  const files = [];
  // 当前 w1.db
  const liveDb = path.join(ROOT, 'data', 'w1.db');
  if (require('fs').existsSync(liveDb)) files.push(liveDb);
  // 每日备份（近 7 天保留窗口内）
  const bakDir = '/home/ubuntu/backups/db';
  try {
    for (const f of require('fs').readdirSync(bakDir)) {
      if (/^w1-\d{8}\.db$/.test(f)) files.push(path.join(bakDir, f));
    }
  } catch (e) {}
  for (const f of files) {
    let b;
    try { b = new Database(f, { readonly: true }); } catch (e) { continue; }
    let rows = [];
    try { rows = b.prepare('SELECT ts, payload FROM consensus').all(); } catch (e) { b.close(); continue; }
    b.close();
    for (const r of rows) {
      if (seen.has(r.ts)) continue;
      seen.add(r.ts);
      const tsMs = r.ts < 1e12 ? r.ts * 1000 : r.ts; // 秒 → 毫秒归一
      ins.run(tsMs, r.payload);
      total++;
    }
  }
  log(`[consensus] 合并 ${files.length} 个库，去重后 ${total} 条`);
  okCount += total ? 1 : 0;
}

/* ---------- ⑤ news 历史合并（w1.db + 备份库，去重 by ts+title） ---------- */
function pullNews() {
  const ins = db.prepare('INSERT OR REPLACE INTO news_hist VALUES (?,?,?,?)');
  const seen = new Set();
  let total = 0;
  const files = [];
  const liveDb = path.join(ROOT, 'data', 'w1.db');
  if (require('fs').existsSync(liveDb)) files.push(liveDb);
  const bakDir = '/home/ubuntu/backups/db';
  try {
    for (const f of require('fs').readdirSync(bakDir)) {
      if (/^w1-\d{8}\.db$/.test(f)) files.push(path.join(bakDir, f));
    }
  } catch (e) {}
  const seenTs = new Set();
  for (const f of files) {
    let b;
    try { b = new Database(f, { readonly: true }); } catch (e) { continue; }
    let rows = [];
    try { rows = b.prepare('SELECT ts, title, sentiment, influence FROM news ORDER BY ts').all(); } catch (e) { b.close(); continue; }
    b.close();
    for (const r of rows) {
      if (!r || !r.title) continue;
      const key = (r.ts || 0) + '|' + String(r.title).slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      ins.run(r.ts || 0, String(r.title), String(r.sentiment || 'neutral'), Number(r.influence) || 1);
      total++;
    }
  }
  const r2 = db.prepare("SELECT COUNT(*) c, MIN(datetime(ts,'unixepoch')) mn, MAX(datetime(ts,'unixepoch')) mx FROM news_hist").get();
  log(`[news] 合并 ${files.length} 个库，去重后 ${total} 条（库内 ${r2.c} 条 / ${r2.mn} → ${r2.mx}）`);
  okCount += total ? 1 : 0;
}

/* ---------- 汇总 ---------- */
function summary() {
  console.log('\n══════════ 抓取完成 ══════════');
  console.log(`库: ${DB_PATH} | 模式: ${INCREMENTAL ? '增量' : '全量'} | 成功 ${okCount} / 失败 ${errCount} / 跳过 ${skipCount} | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (const t of ['klines', 'lsr_account', 'lsr_top', 'oi_history', 'liquidation_hist', 'funding_hist']) {
    try {
      const r = db.prepare(`SELECT COUNT(*) c, COUNT(DISTINCT symbol) s, MIN(datetime(time/1000,'unixepoch')) mn, MAX(datetime(time/1000,'unixepoch')) mx FROM ${t}`).get();
      console.log(`${t}: ${r.c}条 / ${r.s}标的 / ${r.mn} → ${r.mx}`);
    } catch (e) { console.log(`${t}: 异常 ${e.message}`); }
  }
  for (const t of ['consensus_hist', 'fgi_hist']) {
    try {
      const r2 = db.prepare(`SELECT COUNT(*) c, MIN(datetime(ts/1000,'unixepoch')) mn, MAX(datetime(ts/1000,'unixepoch')) mx FROM ${t}`).get();
      console.log(`${t}: ${r2.c}条 / ${r2.mn} → ${r2.mx}`);
    } catch (e) { console.log(`${t}: 异常 ${e.message}`); }
  }
  try {
    const rn = db.prepare("SELECT COUNT(*) c, MIN(datetime(ts,'unixepoch')) mn, MAX(datetime(ts,'unixepoch')) mx FROM news_hist").get();
    console.log(`news_hist: ${rn.c}条 / ${rn.mn} → ${rn.mx}`);
  } catch (e) { console.log('news_hist: 异常 ' + e.message); }
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('built_at', ?)").run(new Date().toISOString());
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('mode', ?)").run(INCREMENTAL ? 'incremental' : 'full');
  db.close();
}

(async () => {
  log(`TIANJI 抓取器启动 (${INCREMENTAL ? '增量' : '全量'})`);
  if (!SKIP_KLINES) { log('① K线全量/续拉…'); await pullKlines(); }
  if (!SKIP_FACTORS) { log('② Coinglass 5因子…'); await pullFactors(); }
  if (!SKIP_FGI) { log('③ FGI 全历史…'); await pullFgi(); }
  if (!SKIP_CONSENSUS) { log('④ consensus 合并…'); pullConsensus(); }
  if (!SKIP_NEWS) { log('⑤ news 历史合并…'); pullNews(); }
  summary();
  process.exit(errCount > 3 ? 2 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
