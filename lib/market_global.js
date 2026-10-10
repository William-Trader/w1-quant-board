'use strict';
const { info, warn } = require('./log');
/**
 * lib/market_global.js — 自研市场全局数据（替代 openclue 的市值/占比系列）
 * 数据源：CoinGecko 免费 API（无需 key）
 *   - 当前值：GET /global → 总市值、24h 成交额、BTC 市值占比
 *   - 首跑初始化 30 天历史：/global/market_cap_chart + /coins/bitcoin/market_chart
 *   - 之后每 30 分钟存一条，自然积累
 * 存储：market_global(ts PK, payload{total_mcap_usd,total_volume_usd,btc_dom_pct})
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const TZ = 'Asia/Shanghai';
const PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
const BASE = 'https://api.coingecko.com/api/v3';

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS market_global (
    ts INTEGER PRIMARY KEY,
    payload TEXT NOT NULL
  )`);
}

/** 走代理拉 CoinGecko（云端 mihomo 127.0.0.1:7890，失败重试 2 次） */
async function cgGet(url, retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      const { stdout } = await execFileP('curl', ['-s', '-m', '20', '--proxy', PROXY, url]);
      if (!stdout) throw new Error('cg empty');
      const j = JSON.parse(stdout);
      if (j.status && j.status.error_code) throw new Error(`cg ${j.status.error_code} ${j.status.error_message || ''}`.slice(0, 120));
      return j;
    } catch (e) {
      if (i === retry) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

/** 首跑初始化 365 天历史
 * - BTC 市值/成交额：真实（/coins/bitcoin/market_chart 免费）
 * - 总市值：BTC市值 ÷ 当前占比（近似估算，随自采积累自动修正）
 * - 全网成交额：BTC成交额 ÷ 当前BTC成交额占比（估算，随自采真实值自动修正）
 * - BTC 占比：openclue 历史系列一次性种子迁移（市场数据迁移，之后完全自采）
 * - 当天不写入估算（保留自采真实值）
 */
async function initHistory(db) {
  const btcHist = await cgGet(`${BASE}/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily`);
  const cur = await cgGet(`${BASE}/global`);
  const domNow = cur.data && cur.data.market_cap_percentage && cur.data.market_cap_percentage.btc;
  const volNow = cur.data && cur.data.total_volume && cur.data.total_volume.usd;
  const btcMcapArr = (btcHist.market_caps || []);
  const btcVolArr = (btcHist.total_volumes || []);
  if (!btcMcapArr.length) throw new Error('cg history empty');
  // BTC 成交额占全网比例（当前值锚定，用于历史估算）
  const btcVolNow = btcVolArr.length ? btcVolArr[btcVolArr.length - 1][1] : null;
  const btcVolShare = btcVolNow && volNow ? btcVolNow / volNow : null;
  // openclue 占比历史种子（一次性迁移）
  let domHist = [];
  try {
    const oc = db.prepare('SELECT payload FROM openclue_archive ORDER BY ts DESC LIMIT 1').get();
    const ocd = oc && JSON.parse(oc.payload);
    if (ocd && Array.isArray(ocd.btc_dominance_30d_series)) domHist = ocd.btc_dominance_30d_series;
  } catch (e) { info('[market_global] 无种子则占比从今天起自采:', e.message); }
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const insert = db.prepare('INSERT OR REPLACE INTO market_global(ts,payload) VALUES(?,?)');
  const domNowV = domNow != null ? Math.round(domNow * 10) / 10 : null;
  btcMcapArr.forEach(([ts, btcMcap], i) => {
    const day = new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
    if (day === todayKey) return; // 今天保留自采真实值
    const dom = domHist[i] ? Number(domHist[i].value != null ? domHist[i].value : domHist[i]) : domNowV;
    const btcVol = btcVolArr[i] ? btcVolArr[i][1] : null;
    insert.run(Math.floor(ts / 1000), JSON.stringify({
      total_mcap_usd: dom ? Math.round(btcMcap / (dom / 100)) : Math.round(btcMcap),
      total_volume_usd: btcVolShare && btcVol ? Math.round(btcVol / btcVolShare) : null, // 估算：BTC成交量÷占比
      btc_dom_pct: dom,
      btc_mcap_usd: Math.round(btcMcap),
      btc_volume_usd: btcVol ? Math.round(btcVol) : null
    }));
  });
  info(`[market_global] 初始化 ${btcMcapArr.length} 天历史（总市值≈BTC市值÷占比、成交额≈BTC成交量÷占比${btcVolShare ? ' ' + Math.round(btcVolShare * 100) + '%' : ''}，估算，随自采修正）`);
}

async function collectMarketGlobal(ctx) {
  const db = ctx.db;
  ensureTable(db);
  const now = Math.floor(Date.now() / 1000);
  // 首跑初始化（表空时）
  const cnt = db.prepare('SELECT COUNT(*) c FROM market_global').get().c;
  if (cnt === 0) {
    try { await initHistory(db); } catch (e) { warn('[market_global] 历史初始化失败:', e.message); }
  }
  // 当前值（每 30min 一条）
  const g = await cgGet(`${BASE}/global`);
  const d = g.data || {};
  const mcap = d.total_market_cap && d.total_market_cap.usd;
  const vol = d.total_volume && d.total_volume.usd;
  const dom = d.market_cap_percentage && d.market_cap_percentage.btc;
  if (mcap == null) throw new Error('cg global no data');
  db.prepare('INSERT OR REPLACE INTO market_global(ts,payload) VALUES(?,?)')
    .run(now, JSON.stringify({
      total_mcap_usd: Math.round(mcap),
      total_volume_usd: vol != null ? Math.round(vol) : null,
      btc_dom_pct: dom != null ? Math.round(dom * 10) / 10 : null
    }));
  return `mcap=${(mcap / 1e12).toFixed(2)}T vol=${(vol / 1e9 / 1000).toFixed(1)}B dom=${dom != null ? dom.toFixed(1) : '-'}%`;
}

/** 按天聚合序列（30min 一条 → 每天最后一条） */
function getSeries(db, days = 30) {
  ensureTable(db);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare('SELECT ts,payload FROM market_global WHERE ts>=? ORDER BY ts ASC').all(since);
  const byDay = {};
  for (const r of rows) {
    try {
      const d = new Date(r.ts * 1000).toLocaleDateString('en-CA', { timeZone: TZ });
      byDay[d] = JSON.parse(r.payload);
    } catch (e) { debug('[market_global] skip:', e.message); }
  }
  const labels = Object.keys(byDay).sort();
  const clean = arr => arr.filter(p => p.y != null && isFinite(p.y));
  return {
    mcap: clean(labels.map(d => ({ x: d, y: byDay[d].total_mcap_usd }))),
    volume: clean(labels.map(d => ({ x: d, y: byDay[d].total_volume_usd }))),
    dom: clean(labels.map(d => ({ x: d, y: byDay[d].btc_dom_pct })))
  };
}

function getCurrent(db) {
  ensureTable(db);
  const r = db.prepare('SELECT ts,payload FROM market_global ORDER BY ts DESC LIMIT 1').get();
  return r ? Object.assign(JSON.parse(r.payload), { ts: r.ts }) : null;
}

module.exports = { ensureTable, initHistory, collectMarketGlobal, getSeries, getCurrent };
