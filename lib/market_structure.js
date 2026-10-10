'use strict';
const { info, warn } = require('./log');
/**
 * lib/market_structure.js — 市场结构 365 天历史（全免费、全真实）
 * 目标：altseason 引擎 1 年回填所需的「占比动量」数据源
 * 方案：CoinGecko 免费接口拉 8 大币（BTC/ETH/SOL/BNB/XRP/ADA/DOGE/LINK）365 天市值
 *       → 构造「BTC 集中度 = BTC市值 ÷ TOP8市值」（官方 BTC.D 的同口径替代，
 *         绝对值略高但趋势等价，引擎内部统一用此口径，保证 1 年分数可比）
 * 存储：market_structure(ts PK, payload{btc_mcap_usd, top8_mcap_usd, concentration})
 * 初始化：8 × market_chart?days=365&interval=daily（一次性）
 * 日常：每天 1 次 /coins/markets（单请求拿 8 币当前市值）
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const TZ = 'Asia/Shanghai';
const PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
const BASE = 'https://api.coingecko.com/api/v3';
const SYMS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'LINK'];
const ID_MAP = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', LINK: 'chainlink' };
const IDS = Object.values(ID_MAP).join(',');

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS market_structure (
    ts INTEGER PRIMARY KEY,
    payload TEXT NOT NULL
  )`);
}

async function cgGet(url, retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      // 2026-09-30 修复：CoinGecko 经代理偶发返回 HTML 限流页 / 空响应
      // 策略：代理优先 → 失败回退直连 → 加 UA 头 → 检测非 JSON 响应后重试
      let stdout = '';
      const attempts = [
        ['-s', '-m', '25', '--proxy', PROXY, '-A', 'Mozilla/5.0', url],
        ['-s', '-m', '25', '-A', 'Mozilla/5.0', url]
      ];
      let lastErr = null;
      for (const args of attempts) {
        try {
          const r = await execFileP('curl', args);
          const out = (r.stdout || '').trim();
          if (!out) { lastErr = new Error('cg empty'); continue; }
          if (out[0] !== '{' && out[0] !== '[') {
            lastErr = new Error('cg non-JSON (rate limit page): ' + out.slice(0, 60).replace(/\s+/g, ' '));
            continue;
          }
          stdout = out;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!stdout) throw lastErr || new Error('cg empty');
      const j = JSON.parse(stdout);
      if (j && j.cg_empty_reason) throw new Error('cg empty');
      if (j.status && j.status.error_code) {
        const code = j.status.error_code;
        if (code === 429) {
          warn('[market_structure] 429 rate limited, wait 20s');
          await new Promise(r => setTimeout(r, 20000));
          if (i === retry) throw new Error('cg 429');
          continue;
        }
        throw new Error(`cg ${code}`.slice(0, 80));
      }
      return j;
    } catch (e) {
      if (i === retry) throw e;
      await new Promise(r => setTimeout(r, 8000));
    }
  }
}

/** 初始化 365 天历史（8 个币 market_chart，按天对齐） */
async function initHistory(db) {
  ensureTable(db);
  const byDay = {};
  for (let i = 0; i < SYMS.length; i++) {
    const sym = SYMS[i];
    // interval=daily 上限 365 天
    const d = await cgGet(`${BASE}/coins/${ID_MAP[sym]}/market_chart?vs_currency=usd&days=365&interval=daily`);
    const caps = d.market_caps || [];
    if (!caps.length) throw new Error(`${sym} no history`);
    for (const [ts, val] of caps) {
      const day = new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
      if (!byDay[day]) byDay[day] = { ts: Math.floor(ts / 1000), mcap: {} };
      byDay[day].mcap[sym] = val;
    }
    await new Promise(r => setTimeout(r, 4000)); // 免费限流缓冲
  }
  const insert = db.prepare('INSERT OR REPLACE INTO market_structure(ts,payload) VALUES(?,?)');
  let n = 0;
  for (const day of Object.keys(byDay).sort()) {
    const v = byDay[day];
    const syms = Object.keys(v.mcap).filter(s => v.mcap[s] != null);
    if (syms.length < 5) continue; // 当日覆盖不足跳过
    const btc = v.mcap.BTC;
    const top8 = syms.reduce((s, k) => s + v.mcap[k], 0);
    if (!btc || !top8) continue;
    insert.run(v.ts, JSON.stringify({
      btc_mcap_usd: Math.round(btc),
      top8_mcap_usd: Math.round(top8),
      concentration: Math.round(btc / top8 * 10000) / 100 // %
    }));
    n++;
  }
  info(`[market_structure] 初始化 ${n} 天（365 天窗口内有效 ${n} 天）`);
  return n;
}

/** 日常更新（单请求拿 8 币当前市值） */
async function collectMarketStructure(ctx) {
  const db = ctx.db;
  ensureTable(db);
  const cnt = db.prepare('SELECT COUNT(*) c FROM market_structure').get().c;
  if (cnt === 0) {
    try { await initHistory(db); } catch (e) { warn('[market_structure] 初始化失败:', e.message); }
  }
  const d = await cgGet(`${BASE}/coins/markets?vs_currency=usd&ids=${IDS}&per_page=100&order=market_cap_desc`);
  const mcap = {};
  let top8 = 0;
  for (const c of d) {
    const sym = (c.symbol || '').toUpperCase();
    if (SYMS.includes(sym) && c.market_cap) { mcap[sym] = c.market_cap; top8 += c.market_cap; }
  }
  if (!mcap.BTC || top8 <= 0) throw new Error('markets no data');
  db.prepare('INSERT OR REPLACE INTO market_structure(ts,payload) VALUES(?,?)')
    .run(Math.floor(Date.now() / 1000), JSON.stringify({
      btc_mcap_usd: Math.round(mcap.BTC),
      top8_mcap_usd: Math.round(top8),
      concentration: Math.round(mcap.BTC / top8 * 10000) / 100
    }));
  return `conc=${(mcap.BTC / top8 * 100).toFixed(1)}%`;
}

/** 按天序列（concentration 为主） */
function getSeries(db, days = 365) {
  ensureTable(db);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = db.prepare('SELECT ts,payload FROM market_structure WHERE ts>=? ORDER BY ts ASC').all(since);
  const byDay = {};
  for (const r of rows) {
    try {
      const d = new Date(r.ts * 1000).toLocaleDateString('en-CA', { timeZone: TZ });
      byDay[d] = JSON.parse(r.payload);
    } catch (e) { debug('[market_structure] skip:', e.message); }
  }
  const labels = Object.keys(byDay).sort();
  const clean = arr => arr.filter(p => p.y != null && isFinite(p.y));
  return {
    concentration: clean(labels.map(d => ({ x: d, y: byDay[d].concentration }))),
    btc_mcap: clean(labels.map(d => ({ x: d, y: byDay[d].btc_mcap_usd }))),
    top8_mcap: clean(labels.map(d => ({ x: d, y: byDay[d].top8_mcap_usd })))
  };
}

function getLatest(db) {
  ensureTable(db);
  const r = db.prepare('SELECT ts,payload FROM market_structure ORDER BY ts DESC LIMIT 1').get();
  return r ? Object.assign(JSON.parse(r.payload), { ts: r.ts }) : null;
}

module.exports = { ensureTable, initHistory, collectMarketStructure, getSeries, getLatest, SYMS };
