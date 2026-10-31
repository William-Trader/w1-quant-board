'use strict';
// lib/market_watch.js — 市场监测群增强播报 v1.0（2026-08-27 William 老板指令）
// ① 资金费率拥挤 ② OI 持仓异动 ③ 清算集中度 ④ 宏观联动 ⑤ KOL 共识翻转
// 全部纯模板拼装（0 token），推送到监测群 QQ_GROUP_MONITOR（type='monitor'）
const { warn, info, debug } = require('./log');
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const precision = require('./precision');
const alertsLib = require('./alerts');
const adaptive = require('./adaptive');
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
    // 2026-10-31 修两处单位错误：
    // ① avg_funding_rate_by_oi 已是百分数（0.009474 = 0.009474%/8h），旧代码 ×100 显示成 0.95%，放大 100 倍；
    // ② 旧默认阈值 0.0015（=0.0015%）比正常费率低一个量级，正常行情会被误报「多头拥挤」。
    const fr = Number(x.avg_funding_rate_by_oi || 0);
    const ft = adaptive.fundingThreshold(db, x.symbol, 0.03).threshold;
    const hi = Math.max(0.03, ft);
    const hiExt = Math.max(0.06, ft * 1.5);
    const lo = -Math.max(0.02, ft * 0.6);
    let lv = 0, tag = '';
    if (fr >= hiExt) { lv = 2; tag = '🔴 极端多头拥挤'; }
    else if (fr >= hi) { lv = 1; tag = '🟠 多头拥挤'; }
    else if (fr <= lo) { lv = 1; tag = '🟢 空头付费(空挤)'; }
    if (lv && gated(db, `mw:fund:${x.symbol}:${lv}`, COOL)) {
      out.push(`• ${x.symbol} 费率 ${fr.toFixed(3)}%/8h — ${tag}（自适应阈值 ${ft.toFixed(3)}%）`);
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
    const chg = Number(x.open_interest_change_percent_24h);
    if (!Number.isFinite(chg)) continue;
    const oiUsd = Number(x.open_interest_usd);
    const chgUsd = Number(x.open_interest_change_usd_24h);
    const abs = Number.isFinite(oiUsd) ? `现 $${(oiUsd / 1e9).toFixed(2)}B` : '现 —';
    const delta = Number.isFinite(chgUsd) && chgUsd !== 0 ? `${chgUsd >= 0 ? '+' : ''}$${(chgUsd / 1e6).toFixed(0)}M` : '增量 —';
    if (chg >= 5 && gated(db, `mw:oi:${x.symbol}:up`, COOL)) {
      out.push(`• ${x.symbol} OI(24h) +${chg.toFixed(1)}% (${delta}；${abs}) — 🟢 增仓进场`);
    } else if (chg <= -5 && gated(db, `mw:oi:${x.symbol}:dn`, COOL)) {
      out.push(`• ${x.symbol} OI(24h) ${chg.toFixed(1)}% (${delta}；${abs}) — 🔴 减仓离场/平仓潮`);
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
      return { above, below, last, aboveMax, belowMax, abovePx, belowPx, source: 'cglass-pro/liq_agg_map', age_sec: Math.max(0, Math.floor(Date.now() / 1000) - Number(row.ts || 0)) };
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
      source: 'cglass-pro/liq_max_pain',
      age_sec: Math.max(0, Math.floor(Date.now() / 1000) - Number(row.ts || 0))
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
    const meta = map.__meta || {};
    const srcTxt = meta.source === 'agg' ? '聚合源·1次调用覆盖8所' : '8所明细';
    const exTxt = `🏦 ${srcTxt}：参与交易所 ${Array.isArray(meta.exchanges) ? meta.exchanges.length : '?'} 家（45min 内新鲜快照${Array.isArray(meta.stale) && meta.stale.length ? '；已剔除滞后：' + meta.stale.map(x => x.exchange).join(',') : ''}）`;
    const wall = readWalls(db, sym);
    const lines = [`• ${sym} 近30min新爆仓 $${(dTotal / 1e6).toFixed(0)}M（多$${(dLong / 1e6).toFixed(0)}M/空$${(dShort / 1e6).toFixed(0)}M）`, `  ↳ ${exTxt}`];
    if (wall && wall.above + wall.below > 0) {
      const ratio = wall.below > 0 ? wall.above / wall.below : null;
      lines.push(`  ↳ 上方空头墙剩余 $${(wall.above / 1e6).toFixed(0)}M / 下方多头墙剩余 $${(wall.below / 1e6).toFixed(0)}M`);
      if (wall.last > 0 && wall.abovePx > 0 && wall.belowPx > 0) {
        const da = (wall.abovePx - wall.last) / wall.last * 100;
        const db2 = (wall.belowPx - wall.last) / wall.last * 100;
        lines.push(`  ↳ 最近墙：上方 $${Number(wall.abovePx).toLocaleString('en-US',{maximumFractionDigits:2})}（距 +${da.toFixed(2)}%）/ 下方 $${Number(wall.belowPx).toLocaleString('en-US',{maximumFractionDigits:2})}（距 ${db2.toFixed(2)}%）`);
      }
      lines.push(`  ↳ 清算比 上:下 = ${ratio == null ? '下方墙为 0，无法计算' : ratio.toFixed(2) + ' : 1'}`);
      if (wall.source) lines.push(`  ↳ 墙源：${wall.source} · 龄期 ${wall.age_sec == null ? '—' : wall.age_sec + 's'}（全量源优先，缺失才回退聚合）`);
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
  // 2026-10-31 修排序 bug：FRED observations 是「最新在前」的降序数组，
  // 旧代码取 o[o.length-1] 实际拿到的是最旧一条（实测 VIX 差 3 天、美元指数差更久）。
  // 统一按 date 降序取第 1/2 条，并校验观测龄期。
  const obsDesc = (id) => {
    try {
      const o = s[id] && s[id].observations;
      if (!Array.isArray(o) || !o.length) return [];
      return o.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    } catch (e) { return []; }
  };
  const ageDays = (dateStr) => {
    const t = Date.parse(String(dateStr) + 'T00:00:00Z');
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
  };
  const get = (id) => { const o = obsDesc(id); return o.length ? Number(o[0].value) : null; };
  const getPrev = (id) => { const o = obsDesc(id); return o.length > 1 ? Number(o[1].value) : null; };
  const getDate = (id) => { const o = obsDesc(id); return o.length ? o[0].date : null; };
  const fresh = (id, maxDays) => { const d = getDate(id); if (!d) return false; const a = ageDays(d); return a != null && a <= maxDays; };
  const out = [];

  const t3 = get('T10Y3M');       // 10Y-3M 利差
  if (t3 != null && fresh('T10Y3M', 10)) {
    const st = t3 < 0 ? 'invert' : 'normal';
    const prevSt = kvGet(db, 'mw:macro:t3', '');
    if (prevSt && prevSt !== st && gated(db, 'mw:macro:t3:push', COOL_DAY)) {
      out.push(`• 美债10Y-3M利差 ${st === 'invert' ? '⚠️ 倒挂' : '🟢 解除倒挂'}（现 ${t3.toFixed(2)}%，观测 ${getDate('T10Y3M')}）`);
    }
    kvSet(db, 'mw:macro:t3', st);
  }
  const vix = get('VIXCLS');
  if (vix != null && fresh('VIXCLS', 10) && vix >= 28 && gated(db, `mw:macro:vix:${vix >= 35 ? 2 : 1}`, COOL_DAY)) {
    out.push(`• VIX 恐慌指数 ${vix.toFixed(1)}（观测 ${getDate('VIXCLS')}）${vix >= 35 ? ' 🔴 极端恐慌' : ' 🟠 恐慌升温'}`);
  }
  const usd = get('DTWEXBGS'), usdPrev = getPrev('DTWEXBGS');
  if (usd != null && usdPrev != null && fresh('DTWEXBGS', 14)) {
    const d = (usd - usdPrev) / usdPrev * 100;
    if (Math.abs(d) >= 0.5 && gated(db, `mw:macro:usd:${d > 0 ? 'up' : 'dn'}`, COOL_DAY)) {
      out.push(`• 美元指数 ${d > 0 ? '+' : ''}${d.toFixed(2)}%（现 ${usd.toFixed(2)}，观测 ${getDate('DTWEXBGS')}）— ${d > 0 ? '美元走强压制风险资产' : '美元走弱利好风险资产'}`);
    }
  }
  return out.length ? ['🌐【W1·宏观联动】', ...out] : [];
}

/* ⑤ KOL 共识翻转（consensus 10min 更新 → 10min扫，long↔short 实质翻转才推） */
function kolCheck(db) {
  // 2026-10-31 精度升级：共识表曾长期停更，旧代码无新鲜度检查会把历史观点当实时翻转。
  let row = null;
  try { row = db.prepare('SELECT ts,payload FROM consensus ORDER BY ts DESC LIMIT 1').get(); } catch (e) { return []; }
  if (!row) return [];
  const ageSec = Math.floor(Date.now() / 1000) - Number(row.ts || 0);
  if (ageSec > 7200) { debug(`[mw] consensus 数据龄期 ${ageSec}s > 2h，跳过 KOL 翻转`); return []; }
  let p = null;
  try { p = JSON.parse(row.payload); } catch (e) { return []; }
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
  return out.length ? ['🗣️【W1·KOL共识翻转】', ...out, `📡 数据龄期 ${Math.round(ageSec / 60)}min`] : [];
}

/* ⑥ 多空结构（2026-10-31 新增）：只报「分母分歧」与「30m 快速切换」，
   极端水平交给 SkyEye，避免同一件事两边刷屏。 */
function lsrCheck(db) {
  const snap = precision.lsrSnapshotAll(db, MAJOR);
  const out = [];
  for (const sym of MAJOR) {
    const l = snap[sym];
    if (!l || l.notional_lsr == null) continue;
    const n = l.notional_lsr, a = l.account_lsr;
    const d30 = l.delta_30m;
    const f = v => v == null ? '—' : v.toFixed(2);

    // A. 名义与账户背离（结构分歧）
    let divTag = null;
    if (a != null && n < 0.8 && a > 1.1) divTag = 'bigshort_retailong';
    else if (a != null && n > 1.25 && a < 0.9) divTag = 'biglong_retailshort';
    if (divTag && gated(db, `mw:lsrdiv:${sym}:${divTag}`, COOL)) {
      out.push(`• ${sym} 结构分歧：持仓名义 ${f(n)}（大单${n < 1 ? '偏空' : '偏多'}）｜账户 ${f(a)}（散户${a > 1 ? '偏多' : '偏空'}）`);
      out.push(`  ↳ 大户 ${f(l.whale_qty_lsr)}｜${l.interpretation}`);
    }

    // B. 30 分钟快速切换（|Δratio| ≥ 0.15）
    if (d30 != null && Math.abs(d30) >= 0.15 && gated(db, `mw:lsrshift:${sym}:${d30 > 0 ? 'up' : 'dn'}`, COOL)) {
      out.push(`• ${sym} 30m 多空比快速${d30 > 0 ? '抬升' : '回落'} ${(d30 * 100).toFixed(1)}%：${f(l.notional_lsr - d30)} → ${f(n)}（名义）｜账户 ${f(a)}`);
    }
  }
  return out.length ? ['⚖️【W1·多空结构】', ...out, '💡 名义=持仓金额、账户=人数；同向才是拥挤，背离是结构分歧'] : [];
}

/* 主入口：各类检查 → 逐类推送监测群 */
async function scanAll(ctx) {
  const { db, env } = ctx;
  let pushed = 0;
  const checks = [
    ['funding', fundingCheck(db)],
    ['oi', oiCheck(db)],
    ['lsr', lsrCheck(db)],
    ['liq', liqCheck(db)],
    ['macro', macroCheck(db)],
    ['kol', kolCheck(db)],
  ];
  // 2026-10-31 精度升级：每条固定播报都带数据来源/时间/跨源偏差
  let provenance = '';
  try {
    const ps = precision.priceSnapshot(db, ['BTC']).symbols.BTC;
    if (ps && ps.price != null) {
      const dev = ps.n >= 2 ? ps.max_dev_pct.toFixed(3) + '%' : '单源';
      provenance = `📡 数据：Coinglass 合约 5min · ${precision.fmtTime(ps.as_of)} 北京 ｜ 价差校验 ${dev}` + (ps.max_dev_pct != null && ps.max_dev_pct > precision.DEV_WARN_PCT ? ' ⚠️' : '');
    }
  } catch (e) {}
  for (const [name, lines] of checks) {
    if (!lines.length) { try { alertsLib.resolve(db, 'market_watch:' + name, 'condition cleared'); } catch (e) {} continue; }
    try {
      const full = provenance ? [].concat(lines, [provenance]).join('\n') : lines.join('\n');
      let rec = null;
      try { rec = alertsLib.record(db, { dedup_key: 'market_watch:' + name, rule: 'market_watch:' + name, severity: 'P2', title: lines[0], detail: full, payload: {} }); } catch (e) {}
      const ok = await pushToGroup(env, db, full, 'monitor');
      if (ok) { pushed++; if (rec) alertsLib.markNotified(db, [rec.id]); info(`[mw] ${name} 播报已推送`); }
    } catch (e) { warn(`[mw] ${name} 推送失败: ${e.message}`); }
  }
  return pushed;
}

module.exports = { scanAll, fundingCheck, oiCheck, lsrCheck, liqCheck, macroCheck, kolCheck };
