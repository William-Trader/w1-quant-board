'use strict';
// lib/market_watch.js — 市场监测群增强播报 v1.0（2026-08-27 William 老板指令）
// ① 资金费率拥挤 ② OI 持仓异动 ③ 清算集中度 ④ 宏观联动 ⑤ KOL 共识翻转
// 全部纯模板拼装（0 token），推送到监测群 QQ_GROUP_MONITOR（type='monitor'）
const { warn, info, debug } = require('./log');
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const { aggLiquidation } = require('./skyeye');

// 主流监控币
const MAJOR = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK', 'SUI'];
const COOL = 4 * 3600 * 1000;   // 高频类去重 4h
const COOL_DAY = 24 * 3600 * 1000; // 宏观类去重 24h

function latestPayload(db, table) {
  try {
    const r = db.prepare(`SELECT payload FROM ${table} ORDER BY ts DESC LIMIT 1`).get();
    return r ? JSON.parse(r.payload) : null;
  } catch (e) { debug(`[mw] ${table} 读取失败: ${e.message}`); return null; }
}
function gated(db, key, coolMs) {
  const last = Number(kvGet(db, key, 0) || 0);
  if (Date.now() - last < coolMs) return false;
  kvSet(db, key, Date.now());
  return true;
}

/* ① 资金费率拥挤（futures_markets 5min 更新 → 每10min扫，同币同档4h去重） */
function fundingCheck(db) {
  const p = latestPayload(db, 'futures_markets');
  if (!p || !Array.isArray(p.data)) return [];
  const out = [];
  for (const x of p.data) {
    if (!MAJOR.includes(x.symbol)) continue;
    const fr = Number(x.avg_funding_rate_by_oi || 0);
    let lv = 0, tag = '';
    if (fr >= 0.005) { lv = 2; tag = '🔴 极端多头拥挤'; }
    else if (fr >= 0.0015) { lv = 1; tag = '🟠 多头拥挤'; }
    else if (fr <= -0.001) { lv = 1; tag = '🟢 空头付费(空挤)'; }
    if (lv && gated(db, `mw:fund:${x.symbol}:${lv}`, COOL)) {
      out.push(`• ${x.symbol} 费率 ${(fr * 100).toFixed(3)}%/8h — ${tag}`);
    }
  }
  return out.length ? ['💸【W1·费率拥挤】', ...out, '💡 高费率=多头过热，追多警惕踩踏'] : [];
}

/* ② OI 持仓异动（futures_markets 5min → 10min扫，4h去重） */
function oiCheck(db) {
  const p = latestPayload(db, 'futures_markets');
  if (!p || !Array.isArray(p.data)) return [];
  const out = [];
  for (const x of p.data) {
    if (!MAJOR.includes(x.symbol)) continue;
    const chg = Number(x.open_interest_change_percent_24h || 0);
    if (chg >= 5 && gated(db, `mw:oi:${x.symbol}:up`, COOL)) {
      out.push(`• ${x.symbol} OI +${chg.toFixed(1)}% (${(x.open_interest_change_usd_24h / 1e6).toFixed(0)}M$) — 🟢 增仓进场`);
    } else if (chg <= -5 && gated(db, `mw:oi:${x.symbol}:dn`, COOL)) {
      out.push(`• ${x.symbol} OI ${chg.toFixed(1)}% — 🔴 减仓离场/平仓潮`);
    }
  }
  return out.length ? ['📊【W1·OI 异动】', ...out, '💡 增仓上涨=吸筹拉升，增仓下跌=新空进场，减仓=抛压衰竭'] : [];
}

/* ③ 爆仓反转雷达（2026-08-27 老板指令升级）
   公式：窗口增量爆仓检测 → 上下方剩余清算墙 → 清算比 → 方向反转提示
   - 增量：8所聚合 24h 累计 vs 上一轮基准，差值 = 窗口内新爆仓（liquidation 30min 一更）
   - 墙：BTC 用 liq_agg_map 全所聚合清算墙；其他主流用 liq_max_pain 多空最大痛点量
   - 清算比 = 上方(空头)墙 / 下方(多头)墙
   - ⚠️ 修正：清算堆积=流动性真空带，穿墙概率>反转概率；仅作风险提示，不默认反手
   - 窄场景（孤立墙+震荡+首触）才可轻仓试反手 */
const LIQ_INC_MIN = 3e7;       // 单币窗口增量 ≥3000万$ 触发
const LIQ_RATIO_STRONG = 1.5;  // 清算比 >1.5 或 <0.67 = 强堆积（风险提示阈值）

function readWalls(db, sym) {
  try {
    if (sym === 'BTC') {
      const row = db.prepare("SELECT payload FROM cgpro_snapshots WHERE endpoint='liq_agg_map' ORDER BY ts DESC LIMIT 1").get();
      if (!row) return null;
      const p = JSON.parse(row.payload);
      const last = Number(p.data && p.data.last_price) || 0;
      const items = (p.data && p.data.data) || [];
      let above = 0, below = 0, abovePx = 0, belowPx = 0, aboveMax = 0, belowMax = 0;
      for (const it of items) {
        const lm = it.liqMapV2 || {};
        for (const [px, arr] of Object.entries(lm)) {
          const price = Number(px), amt = Number(arr[0][1]);
          if (price <= last) { below += amt; if (amt > belowMax) { belowMax = amt; belowPx = price; } }
          else { above += amt; if (amt > aboveMax) { aboveMax = amt; abovePx = price; } }
        }
      }
      return { above, below, last, aboveMax, belowMax, abovePx, belowPx };
    }
    const row = db.prepare("SELECT payload FROM cgpro_snapshots WHERE endpoint='liq_max_pain' ORDER BY ts DESC LIMIT 1").get();
    if (!row) return null;
    const arr = (JSON.parse(row.payload).data) || [];
    const hit = arr.find(x => String(x.symbol) === sym);
    if (!hit) return null;
    return {
      above: Number(hit.short_max_pain_liq_level || 0),
      below: Number(hit.long_max_pain_liq_level || 0),
      last: Number(hit.price || 0),
      aboveMax: Number(hit.short_max_pain_liq_level || 0),
      belowMax: Number(hit.long_max_pain_liq_level || 0),
      abovePx: Number(hit.short_max_pain_liq_price || 0),
      belowPx: Number(hit.long_max_pain_liq_price || 0),
    };
  } catch (e) { warn('[mw] readWalls:', e.message); return null; }
}

function liqCheck(db) {
  let map;
  try { map = aggLiquidation(db); } catch (e) { warn('[mw] liq agg:', e.message); return []; }
  const out = [];
  for (const sym of MAJOR) {
    const c = map[sym];
    if (!c || !c.usd) continue;
    const key = `mw:liqinc:${sym}`;
    let prev = null;
    try { prev = JSON.parse(kvGet(db, key, 'null')); } catch (e) { prev = null; }
    const cur = { total: c.usd, long: c.long, short: c.short };
    kvSet(db, key, JSON.stringify({ ts: Date.now(), ...cur }));
    if (!prev || prev.total == null) continue;
    const dTotal = cur.total - prev.total;
    const dLong = cur.long - prev.long;
    const dShort = cur.short - prev.short;
    if (dTotal < LIQ_INC_MIN) continue;                    // 未达巨额爆仓
    if (!gated(db, `mw:liqrev:${sym}`, COOL)) continue;    // 4h 去重
    const wall = readWalls(db, sym);
    const lines = [`• ${sym} 近30min新爆仓 $${(dTotal / 1e6).toFixed(0)}M（多$${(dLong / 1e6).toFixed(0)}M/空$${(dShort / 1e6).toFixed(0)}M）`];
    if (wall && wall.above + wall.below > 0) {
      const ratio = wall.above / Math.max(wall.below, 1);
      lines.push(`  ↳ 上方空头墙剩余 $${(wall.above / 1e6).toFixed(0)}M / 下方多头墙剩余 $${(wall.below / 1e6).toFixed(0)}M`);
      lines.push(`  ↳ 清算比 上:下 = ${ratio.toFixed(2)} : 1`);
      const longHeavy = dLong > dShort;
      if (longHeavy && ratio >= LIQ_RATIO_STRONG) {
        lines.push('  ⚠️ 多头墙被扫薄、上方空头墙厚（清算真空带）→ 警惕反弹，但默认穿墙概率>反转，仅窄场景（孤立墙+震荡+首触）可轻仓试多（止损墙外）');
      } else if (!longHeavy && ratio <= 1 / LIQ_RATIO_STRONG) {
        lines.push('  ⚠️ 空头墙被扫薄、下方多头墙厚（清算真空带）→ 警惕回落，但默认穿墙概率>反转，仅窄场景可轻仓试空（止损墙外）');
      } else if (longHeavy) {
        lines.push('  ⚠️ 多头爆仓为主，上方墙相对厚 → 反弹动能偏强');
      } else {
        lines.push('  ⚠️ 空头爆仓为主，下方墙相对厚 → 回落动能偏强');
      }
    } else {
      lines.push(`  ⚠️ ${dLong > dShort ? '多头' : '空头'}爆仓为主，注意方向反转`);
    }
    out.push(...lines);
  }
  return out.length ? ['💥【W1·爆仓反转雷达】', ...out, '💡 清算堆积=流动性真空带，穿墙概率>反转概率；仅窄场景（孤立墙+震荡+首触）轻仓试、止损墙外'] : [];
}

/* ④ 宏观联动（macro_snapshot 日更 → 每天09:00扫，状态变化才推） */
function macroCheck(db) {
  const p = latestPayload(db, 'macro_snapshot');
  if (!p || !p.series) return [];
  const s = p.series;
  const get = (id) => { try { const o = s[id] && s[id].observations; return o && o.length ? Number(o[o.length - 1].value) : null; } catch (e) { return null; } };
  const getPrev = (id) => { try { const o = s[id] && s[id].observations; return o && o.length > 1 ? Number(o[o.length - 2].value) : null; } catch (e) { return null; } };
  const out = [];

  const t3 = get('T10Y3M');       // 10Y-3M 利差
  if (t3 != null) {
    const st = t3 < 0 ? 'invert' : 'normal';
    const prevSt = kvGet(db, 'mw:macro:t3', '');
    if (prevSt && prevSt !== st && gated(db, 'mw:macro:t3:push', COOL_DAY)) {
      out.push(`• 美债10Y-3M利差 ${st === 'invert' ? '⚠️ 倒挂' : '🟢 解除倒挂'}（现 ${t3.toFixed(2)}%）`);
    }
    kvSet(db, 'mw:macro:t3', st);
  }
  const vix = get('VIXCLS');
  if (vix != null && vix >= 28 && gated(db, `mw:macro:vix:${vix >= 35 ? 2 : 1}`, COOL_DAY)) {
    out.push(`• VIX 恐慌指数 ${vix.toFixed(1)}${vix >= 35 ? ' 🔴 极端恐慌' : ' 🟠 恐慌升温'}`);
  }
  const usd = get('DTWEXBGS'), usdPrev = getPrev('DTWEXBGS');
  if (usd != null && usdPrev != null) {
    const d = (usd - usdPrev) / usdPrev * 100;
    if (Math.abs(d) >= 0.5 && gated(db, `mw:macro:usd:${d > 0 ? 'up' : 'dn'}`, COOL_DAY)) {
      out.push(`• 美元指数 ${d > 0 ? '+' : ''}${d.toFixed(2)}%（现 ${usd.toFixed(2)}）— ${d > 0 ? '美元走强压制风险资产' : '美元走弱利好风险资产'}`);
    }
  }
  return out.length ? ['🌐【W1·宏观联动】', ...out] : [];
}

/* ⑤ KOL 共识翻转（consensus 10min 更新 → 10min扫，long↔short 实质翻转才推） */
function kolCheck(db) {
  const p = latestPayload(db, 'consensus');
  const arr = Array.isArray(p) ? p : (p && Array.isArray(p.data) ? p.data : []);
  const out = [];
  for (const x of arr) {
    const sym = x.display_symbol || String(x.symbol || '').replace(/USDT$/, '');
    if (!MAJOR.includes(sym)) continue;
    const cur = x.decision || 'neutral';
    const key = `mw:kol:${sym}`;
    const prev = kvGet(db, key, '') || 'neutral';
    if (prev !== cur && ((prev === 'long' && cur === 'short') || (prev === 'short' && cur === 'long'))) {
      out.push(`• ${sym} AI共识 ${prev === 'long' ? '看多' : '看空'} → ${cur === 'long' ? '🟢 看多' : '🔴 看空'}（置信度 ${Math.round((x.confidence || 0) * 100)}%）`);
    }
    kvSet(db, key, cur);
  }
  return out.length ? ['🗣️【W1·KOL共识翻转】', ...out] : [];
}

/* 主入口：各类检查 → 逐类推送监测群 */
async function scanAll(ctx) {
  const { db, env } = ctx;
  let pushed = 0;
  const checks = [
    ['funding', fundingCheck(db)],
    ['oi', oiCheck(db)],
    ['liq', liqCheck(db)],
    ['macro', macroCheck(db)],
    ['kol', kolCheck(db)],
  ];
  for (const [name, lines] of checks) {
    if (!lines.length) continue;
    try {
      const ok = await pushToGroup(env, db, lines.join('\n'), 'monitor');
      if (ok) { pushed++; info(`[mw] ${name} 播报已推送`); }
    } catch (e) { warn(`[mw] ${name} 推送失败: ${e.message}`); }
  }
  return pushed;
}

module.exports = { scanAll, fundingCheck, oiCheck, liqCheck, macroCheck, kolCheck };
