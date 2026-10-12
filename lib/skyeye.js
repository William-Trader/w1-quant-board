'use strict';
const { warn } = require('./log');
// ═══════════════════════════════════════════════════════════
// SkyEye Monitor v6.0 — 异动预警引擎
// 2026-08-14 William老板升级令 · 最高端最实用
//  ① 价格异动雷达  ② 爆仓风暴  ③ FGI突变
//  ④ 多空极端      ⑤ 清算技术因子翻转  ⑥ 到价提醒
// 独立模块：异常隔离不拖垮主系统；kv 冷却防刷屏
// ═══════════════════════════════════════════════════════════
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const { store } = require('./store');

const WATCH = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','LINK'];
const COOLDOWN = 30*60*1000;             // 价格异动等高频信号的普通冷却
const COOLDOWN_EXTREME = 4*60*60*1000;    // 多空极端/爆仓风暴：状态型去重的最小间隔 4h

const TH = {
  priceMovePct: 2.0,     // 15分钟变动≥2% = 异动
  liqStorm: 1e8,         // 24h清算≥1亿$ = 风暴
  lsrHi: 2.0, lsrLo: 0.5,
  fgiSwing: 10,          // FGI单次变动≥10
  qibaoFlip: 35,         // 清算技术分变化≥35 = 翻转
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

// 判断多空倾向（用于「翻转才推」的方向态，避免震荡反复刷屏）
function qiBias(score) {
  if (score >= 15) return 'bullish';   // 中性偏多及以上
  if (score <= -15) return 'bearish';  // 中性偏空及以下
  return 'neutral';                    // -15~14 震荡观望
}

function qibaoFlips(db) {
  try {
    const qibao = require('./qibao7');
    const rep = qibao.listReport(db);
    const rows = rep && rep.rows;
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      const cur = Number(r.score || 0);
      const bias = qiBias(cur);
      // 分数快照键：仅用于记录上次综合分（供「翻转」幅度判断）
      const scoreKey = 'skyeye:qibao:score:' + r.symbol;
      // 方向态键：记录上次已推送的多空倾向，只有「倾向真正翻转」才再推
      const biasKey = 'skyeye:qibao:bias:' + r.symbol;
      const lastScore = Number(kvGet(db, scoreKey, 0) || 0);
      const lastBias = kvGet(db, biasKey, 'none') || 'none';
      kvSet(db, scoreKey, cur);
      // 首次初始化：只记状态不推送（无历史对照）
      if (lastBias === 'none') { kvSet(db, biasKey, bias); continue; }
      // 方向态翻转到实质多/空（neutral 不算翻转，避免中性区抖动刷屏）
      const flipped = bias !== lastBias && bias !== 'neutral' && lastBias !== 'neutral';
      // 若方向没翻转，但仍在同向且分数大幅变化（≥阈值），视为「强化」但不重推（只更新态）
      if (flipped) {
        out.push({symbol: r.symbol, from: lastScore, to: cur, label: r.label, bias, lastBias});
        kvSet(db, biasKey, bias);
      } else if (bias !== lastBias) {
        // neutral 与 多/空 之间的切换也更新态，但不属于实质翻转，不推送
        kvSet(db, biasKey, bias);
      }
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

// 状态型去重：状态「激活」才允许推送一次；同一状态回落前不再重复。
// 返回 true=允许推送(并立刻标记本次状态为已推)，false=跳过(同状态已推过)。
// key 记录「当前持续状态标识 + 最近推送时间」，状态标识变化(如极端→正常)即重置。
function stateGate(db, key, stateTag, minIntervalMs) {
  const now = Date.now();
  let rec = null;
  try { rec = JSON.parse(kvGet(db, key, '') || ''); } catch (e) { rec = null; }
  if (!rec || typeof rec !== 'object') rec = { tag: null, last: 0 };
  if (stateTag == null) {
    // 状态回落：清空标记，允许未来重新触发
    if (rec.tag !== null) kvSet(db, key, JSON.stringify({ tag: null, last: 0 }));
    return false;
  }
  const same = rec.tag === stateTag;
  const inMinInterval = (now - rec.last) < minIntervalMs;
  if (same && inMinInterval) return false;   // 同状态且在最小间隔内：跳过
  // 允许推送（首次激活 or 状态变化 or 超过最小间隔的强化提醒）
  kvSet(db, key, JSON.stringify({ tag: stateTag, last: now }));
  return true;
}

async function pushAlert(ctx, title, lines) {
  const msg = [title, '━━━━━━━━━━━━', ...lines, '⚠️ 仅供研究参考，不构成投资建议'].join('\n');
  try { return await pushToGroup(ctx.env, ctx.db, msg, 'monitor'); }
  catch(e) { warn('[skyeye] push fail:', e.message); return false; }
}

// 主扫描入口（每5分钟由 cron 调用）
async function scanAll(ctx) {
  const { db, env } = ctx;
  if (!env || !db) return 0;
  const fired = [];

  // ① 价格异动（状态型去重：同方向持续异动只推一次，方向反转或回落<阈值才重推；30min内不重复）
  for (const sym of WATCH) {
    const pct = priceMovePct(db, sym);
    if (pct == null) continue;
    const key = 'skyeye:price:'+sym;
    if (Math.abs(pct) >= TH.priceMovePct) {
      const tag = pct >= 0 ? 'up' : 'down';
      if (stateGate(db, key, tag, COOLDOWN)) {
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
    } else {
      stateGate(db, key, null, 0);   // 回落清除，允许未来重新触发
    }
  }

  // ② 爆仓风暴（状态型去重：风暴持续期只推一次，回落<阈值后重新激活；4h内不重复）
  const liqMap = aggLiquidation(db);
  const liqSyms = new Set(Object.keys(liqMap));
  for (const sym of WATCH) {
    const v = liqMap[sym];
    const key = 'skyeye:liq:'+sym;
    if (v && v.usd >= TH.liqStorm) {
      // 状态标识：方向占优（多头/空头爆仓占优），同方向风暴持续只推一次
      const tag = v.long > v.short ? 'long' : 'short';
      if (stateGate(db, key, tag, COOLDOWN_EXTREME)) {
        const dirTxt = v.long > v.short ? '多头爆仓占优（下跌动能）' : '空头爆仓占优（反弹动能）';
        fired.push({
          title: `💥【SkyEye·爆仓风暴】${sym} 24h清算 $${(v.usd/1e8).toFixed(2)}亿`,
          lines: [
            `📉 多头爆仓 $${(v.long/1e6).toFixed(1)}M / 空头爆仓 $${(v.short/1e6).toFixed(1)}M`,
            `⚡ ${dirTxt}`,
            `💡 巨额清算后波动放大、常伴随插针/惯性延续，等企稳再动，不赌反手`,
          ]
        });
      }
    } else {
      // 未达风暴阈值 → 状态回落，清除标记，允许未来重新触发
      stateGate(db, key, null, 0);
    }
  }

  // ④ FGI突变（状态型去重：同方向突变只推一次，反向突变才重推；冷却保底防抖）
  const fgi = fgiSwing(db);
  if (fgi) {
    const fgik = 'skyeye:fgi';
    const tag = fgi.diff >= 0 ? 'up' : 'down';
    if (stateGate(db, fgik, tag, COOLDOWN_EXTREME)) {
      fired.push({
        title: `😱【SkyEye·情绪突变】FGI ${fgi.from} → ${fgi.to}（${fgi.diff>=0?'+':''}${fgi.diff}）`,
        lines: [
          `📊 当前情绪：${fgi.cls}`,
          `💡 情绪剧烈转向，注意仓位调整（恐惧期打折）`,
        ]
      });
    }
  } else {
    stateGate(db, 'skyeye:fgi', null, 0);   // 无突变则回落清除
  }

  // ③ 多空极端（散户 LSR 双极端 · 状态型去重：极端持续只推一次，回归正常后重新激活；4h内不重复）
  const lsrList = lsrExtremes(db);
  const lsrSyms = new Set(lsrList.map(e => e.symbol));
  for (const sym of WATCH) {
    const key = 'skyeye:lsr:' + sym;
    const ex = lsrList.find(e => e.symbol === sym);
    if (ex) {
      // 状态标识：偏多极端 / 偏空极端
      const tag = ex.ratio >= TH.lsrHi ? 'overlong' : 'overshort';
      if (stateGate(db, key, tag, COOLDOWN_EXTREME)) {
        fired.push({
          title: `⚖️【SkyEye·多空极端】${sym} 散户多空比 ${ex.ratio.toFixed(2)}`,
          lines: [
            `📊 ${ex.dir}`,
            `💡 LSR 极端拥挤，警惕反向收割，勿追单`,
          ]
        });
      }
    } else {
      // 未达极端 → 回落清除，允许未来重新触发
      stateGate(db, key, null, 0);
    }
  }

  // ⑤ 清算技术因子翻转（状态真正翻转才推、每次只推一次，不重复刷屏）
  for (const q of qibaoFlips(db)) {
    fired.push({
      title: `🧭【SkyEye·因子翻转】${q.symbol} 综合分 ${q.from>=0?'+':''}${q.from} → ${q.to>=0?'+':''}${q.to}`,
      lines: [
        `📊 当前判定：${q.label}`,
        `🔁 ${q.lastBias==='bullish'?'多→空':q.lastBias==='bearish'?'空→多':q.lastBias+'→'+q.bias}`,
        `💡 多空倾向发生实质翻转，重新评估持仓`,
      ]
    });
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
