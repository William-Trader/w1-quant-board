'use strict';
const { warn } = require('./log');
// ═══════════════════════════════════════════════════════════
// SkyEye Monitor v6.0 — 异动预警引擎
// 2026-08-14 William老板升级令 · 最高端最实用
//  ① 价格异动雷达  ② 爆仓风暴  ③ FGI突变
//  ④ 多空极端      ⑤ 七宝因子翻转  ⑥ 到价提醒
// 独立模块：异常隔离不拖垮主系统；kv 冷却防刷屏
// ═══════════════════════════════════════════════════════════
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const { store } = require('./store');

const WATCH = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','LINK'];
const COOLDOWN = 30*60*1000;

const TH = {
  priceMovePct: 2.0,     // 15分钟变动≥2% = 异动
  liqStorm: 1e8,         // 24h清算≥1亿$ = 风暴
  lsrHi: 2.0, lsrLo: 0.5,
  fgiSwing: 10,          // FGI单次变动≥10
  qibaoFlip: 35,         // 七宝分变化≥35 = 翻转
};

function latestPrice(db, symbol) {
  const r = db.prepare('SELECT price FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT 1').get(symbol);
  return r ? r.price : null;
}

// 每币最近 windowSec 秒变动%
function priceMovePct(db, symbol, windowSec = 900) {
  const t0 = Math.floor(Date.now()/1000) - windowSec;
  const rows = db.prepare('SELECT ts, price FROM prices WHERE symbol=? AND ts>=? ORDER BY ts ASC').all(symbol, t0);
  if (rows.length < 2) return null;
  const first = rows[0].price, last = rows[rows.length-1].price;
  if (!first) return null;
  return (last-first)/first*100;
}

// 跨所聚合清算
function aggLiquidation(db) {
  const EXS = ['Binance','OKX','Bybit','Bitget','HTX','Gate','MEXC','KuCoin'];
  const map = {};
  for (const ex of EXS) {
    const row = db.prepare('SELECT payload FROM liquidation WHERE exchange=? ORDER BY ts DESC LIMIT 1').get(ex);
    if (!row) continue;
    try {
      const p = JSON.parse(row.payload);
      const arr = p && p.data;
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        const sym = String(c.symbol || '').replace(/USDT$/,'');
        if (!sym) continue;
        if (!map[sym]) map[sym] = { usd: 0, long: 0, short: 0, ex: 0 };
        map[sym].usd += Number(c.liquidation_usd_24h || 0);
        map[sym].long += Number(c.long_liquidation_usd_24h || 0);
        map[sym].short += Number(c.short_liquidation_usd_24h || 0);
        map[sym].ex += 1;
      }
    } catch(e) {}
  }
  return map;
}

function lsrExtremes(db) {
  const t = store.latestLsr(db,'trader');
  const arr = t && t.data && t.data.data;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const c of arr) {
    const sym = String(c.symbol||'').replace(/USDT$/,'');
    if (!WATCH.includes(sym)) continue;
    const ratio = Number(c.ratio ?? c.trader_ratio ?? 0);
    if (ratio >= TH.lsrHi) out.push({symbol:sym, ratio, dir:'散户极端偏多(警惕回落)'});
    else if (ratio <= TH.lsrLo) out.push({symbol:sym, ratio, dir:'散户极端偏空(警惕反弹)'});
  }
  return out;
}

function fgiSwing(db) {
  const rows = db.prepare('SELECT ts,value,classification FROM fear_greed ORDER BY ts DESC LIMIT 2').all();
  if (rows.length < 2) return null;
  const a = rows[0], b = rows[1];
  const diff = a.value - b.value;
  if (Math.abs(diff) >= TH.fgiSwing) return { from:b.value, to:a.value, diff, cls:a.classification };
  return null;
}

function qibaoFlips(db) {
  try {
    const qibao = require('./qibao7');
    const rep = qibao.listReport(db);
    const rows = rep && rep.rows;
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      const last = Number(kvGet(db, 'skyeye:qibao:'+r.symbol, 0) || 0);
      const cur = Number(r.score || 0);
      if (last !== 0 && Math.abs(cur - last) >= TH.qibaoFlip) {
        out.push({symbol:r.symbol, from:last, to:cur, label:r.label});
      }
      kvSet(db, 'skyeye:qibao:'+r.symbol, cur);
    }
    return out;
  } catch(e) { return []; }
}

function priceAlerts(db) {
  let list = [];
  try { list = JSON.parse(kvGet(db, 'skyeye:alerts:list', '[]')); } catch (e) { debug('[skyeye] list parse:', e.message); list = []; }
  if (!list.length) return [];
  const fired = [], remain = [];
  for (const a of list) {
    const px = latestPrice(db, a.symbol);
    if (px == null) { remain.push(a); continue; }
    const hit = a.dir === 'down' ? px <= a.target : px >= a.target;
    if (hit) { a.price = px; fired.push(a); } else remain.push(a);
  }
  kvSet(db, 'skyeye:alerts:list', JSON.stringify(remain));
  return fired;
}

function cooled(db, key) {
  const last = Number(kvGet(db, key, 0) || 0);
  return Date.now() - last < COOLDOWN;
}

async function pushAlert(ctx, title, lines) {
  const msg = [title, '━━━━━━━━━━━━', ...lines, '⚠️ 仅供研究参考，不构成投资建议'].join('\n');
  try { return await pushToGroup(ctx.env, ctx.db, msg); }
  catch(e) { warn('[skyeye] push fail:', e.message); return false; }
}

// 主扫描入口（每5分钟由 cron 调用）
async function scanAll(ctx) {
  const { db, env } = ctx;
  if (!env || !db) return 0;
  const fired = [];

  // ① 价格异动
  for (const sym of WATCH) {
    const pct = priceMovePct(db, sym);
    if (pct == null) continue;
    if (Math.abs(pct) >= TH.priceMovePct) {
      const key = 'skyeye:price:'+sym;
      if (!cooled(db, key)) {
        kvSet(db, key, Date.now());
        const px = latestPrice(db, sym);
        fired.push({
          title: `🚨【SkyEye·价格异动】${sym} 15分钟 ${pct>=0?'+':''}${pct.toFixed(2)}%`,
          lines: [
            `📊 现价 $${px ? px.toLocaleString('en-US',{maximumFractionDigits:2}) : '—'}（15分钟 ${pct>=0?'+':''}${pct.toFixed(2)}%）`,
            `⚡ ${Math.abs(pct)>=4?'剧烈波动':'明显异动'}，注意短线节奏`,
            `💡 建议：急涨不追、急跌不接，等企稳信号再动`,
          ]
        });
      }
    }
  }

  // ② 爆仓风暴
  const liqMap = aggLiquidation(db);
  for (const [sym, v] of Object.entries(liqMap)) {
    if (v.usd >= TH.liqStorm) {
      const key = 'skyeye:liq:'+sym;
      if (!cooled(db, key)) {
        kvSet(db, key, Date.now());
        const dirTxt = v.long > v.short ? '多头爆仓占优（下跌动能）' : '空头爆仓占优（反弹动能）';
        fired.push({
          title: `💥【SkyEye·爆仓风暴】${sym} 24h清算 $${(v.usd/1e8).toFixed(2)}亿`,
          lines: [
            `📉 多头爆仓 $${(v.long/1e6).toFixed(1)}M / 空头爆仓 $${(v.short/1e6).toFixed(1)}M`,
            `⚡ ${dirTxt}`,
            `💡 巨额清算后常伴随插针，等企稳再动`,
          ]
        });
      }
    }
  }

  // ④ FGI突变
  const fgi = fgiSwing(db);
  if (fgi && !cooled(db, 'skyeye:fgi')) {
    kvSet(db, 'skyeye:fgi', Date.now());
    fired.push({
      title: `😱【SkyEye·情绪突变】FGI ${fgi.from} → ${fgi.to}（${fgi.diff>=0?'+':''}${fgi.diff}）`,
      lines: [
        `📊 当前情绪：${fgi.cls}`,
        `💡 情绪剧烈转向，注意仓位调整（恐惧期打折）`,
      ]
    });
  }

  // ⑤ 七宝因子翻转
  for (const q of qibaoFlips(db)) {
    const key = 'skyeye:qibao:'+q.symbol;
    if (!cooled(db, key)) {
      kvSet(db, key, Date.now());
      fired.push({
        title: `🧭【SkyEye·因子翻转】${q.symbol} 综合分 ${q.from>=0?'+':''}${q.from} → ${q.to>=0?'+':''}${q.to}`,
        lines: [
          `📊 当前判定：${q.label}`,
          `💡 多空倾向发生显著变化，重新评估持仓`,
        ]
      });
    }
  }

  // ⑥ 到价提醒
  for (const a of priceAlerts(db)) {
    fired.push({
      title: `🔔【SkyEye·到价提醒】${a.symbol} 已到 ${a.target}`,
      lines: [
        `📊 现价 $${a.price ? a.price.toLocaleString('en-US',{maximumFractionDigits:2}) : '—'}（${a.dir==='down'?'向下':'向上'}触发）`,
        `📝 ${a.note || '价格提醒'}`,
      ]
    });
  }

  // ⑦ 推送
  for (const f of fired) {
    await pushAlert(ctx, f.title, f.lines);
  }
  kvSet(db, 'skyeye:last_scan', Date.now());
  return fired.length;
}

function status(db) {
  let alerts = [];
  try { alerts = JSON.parse(kvGet(db,'skyeye:alerts:list','[]')); } catch (e) { debug('[skyeye] alerts parse:', e.message); alerts = []; }
  return { enabled: true, lastScan: Number(kvGet(db,'skyeye:last_scan',0)||0), activeAlerts: alerts.length, alerts };
}

module.exports = { scanAll, status, latestPrice, priceMovePct, aggLiquidation };
