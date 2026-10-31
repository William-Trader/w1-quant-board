'use strict';
const { debug, info, warn } = require('./log');
// ============================================================
// W1 专业给单引擎 v4.0（2026-08-08 William 老板指令·严格动量+共振）
//   - 四种策略：
//       MOM  冲高回落动量单（严格多窗口确认，高胜率优先）
//       RES  宏观技术共振单（消息面×技术面同向）
//       CLOUD 云端共识单（KOL/TopTrader/因子/清算/FGI，v3保留）
//       R3D  三维共振单（价格/费率/LSR同向，v1保留）
//   - 设置界面化：阈值/开关全部存 kv，看板可调
//   - 动量确认因子（高胜率核心）：
//       放量冲高 + 动能衰竭 + 散户追多(LSR) + 多头拥挤(费率) + 清算顺风 + 多周期同向
//       要求 ≥ MIN_FACTORS 个因子同向才出单（宁可错过，不可做错）
// 全部读本地 SQLite，禁止额外打上游 API。
// ============================================================
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const { eventRiskAdjustment } = require('./event_risk');
const { fundFlowScore } = require('./fund_flow');
const precision = require('./precision');

const TZ = 'Asia/Shanghai';
const MAX_HOLD_H = 48;

// ---------------- 默认阈值（可被 kv 覆盖） ----------------
const DEFAULTS = {
  enabled: true,
  mom: { enabled: true, price_pct: 0.8, retrace_pct: 0.35, min_factors: 2, lsr_min: 1.08, funding_min: 0.0002 },
  res: { enabled: true, min_macro_strength: 2, min_tech_strength: 2 },
  cloud: { enabled: true, threshold: 1.2, conf_min: 0.35, strong_bonus: 0.8 },
  r3d: { enabled: true, price_pct: 0.8, price_pct_strong: 1.5 },
  common: { min_rr: 1.5, cooldown_h: 4, daily_limit: 8, atr_stop_mult: 2.5, fib_t1: 1.618, fib_t2: 2.618, entry_retrace: 0.382, max_pos_pct: 0.5, lev: 100 },
  // 实盘推送白名单（其余币种仅网站回测，不推送）
  push_symbols: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'XAU']
};

function loadSettings(db) {
  const saved = kvGet(db, 'signal:settings:v4', null);
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(s)) {
      if (saved[k] && typeof saved[k] === 'object' && s[k]) Object.assign(s[k], saved[k]);
      else if (saved[k] !== undefined) s[k] = saved[k];
    }
  }
  return s;
}

function saveSettings(db, patch) {
  const cur = loadSettings(db);
  for (const k of Object.keys(patch)) {
    if (patch[k] && typeof patch[k] === 'object' && cur[k] && typeof cur[k] === 'object') Object.assign(cur[k], patch[k]);
    else cur[k] = patch[k];
  }
  kvSet(db, 'signal:settings:v4', cur);
  return cur;
}

let lastCheckTs = 0;
function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }

/* ---------- 历史序列工具 ---------- */
function futuresSnapshots(db, n = 30) {
  const rows = db.prepare('SELECT ts,payload FROM futures_markets ORDER BY ts DESC LIMIT ?').all(n);
  const out = rows.map(r => {
    let arr = [];
    try { const p = JSON.parse(r.payload); arr = (p && p.data) || []; } catch (e) { debug('[signal] parse payload err:', e.message); }
    const m = new Map();
    for (const c of arr) if (c && c.symbol) m.set(c.symbol, c);
    return { ts: r.ts, m };
  });
  return out.reverse();
}

function priceSeries(snaps, symbol) {
  const out = [];
  for (const s of snaps) {
    const c = s.m.get(symbol);
    if (c) { const p = Number(c.current_price); if (isFinite(p) && p > 0) out.push(p); }
  }
  return out;
}

function sma(arr, n) {
  if (arr.length < n) return null;
  let s = 0; for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

function atr(arr, n = 14) {
  if (arr.length < n + 1) return null;
  const diffs = [];
  for (let i = arr.length - n; i < arr.length; i++) diffs.push(Math.abs(arr[i] - arr[i - 1]));
  return diffs.reduce((a, b) => a + b, 0) / diffs.length;
}

function structLevels(arr, n = 20) {
  if (arr.length < 2) return null;
  const slice = arr.slice(-n);
  return { high: Math.max(...slice), low: Math.min(...slice) };
}

function trendFilter(arr) {
  // 主趋势框架：15min(3根)/30min(6根)/1h(12根) 多级 SMA，完整排列才算趋势（趋势主导，宁缺毋滥）
  if (!Array.isArray(arr) || arr.length < 13) return 'neutral';
  const px = arr[arr.length - 1];
  const s3 = sma(arr, 3), s6 = sma(arr, 6), s12 = sma(arr, 12);
  if (s3 === null || s6 === null || s12 === null) return 'neutral';
  if (px > s3 && s3 > s6 && s6 > s12) return 'long';
  if (px < s3 && s3 < s6 && s6 < s12) return 'short';
  return 'neutral';
}

/* 布林带（20,2）：pos=带内位置 0~1，widthPct=带宽%，squeeze=带宽处于近40根低位（挤压后易突破） */
function bollinger(closes, period = 20, k = 2) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  const slice = closes.slice(-period);
  const mid = sma(slice, period);
  if (mid === null) return null;
  const v = slice.reduce((s, x) => s + (x - mid) * (x - mid), 0) / period;
  const sd = Math.sqrt(v);
  const upper = mid + k * sd, lower = mid - k * sd;
  const px = closes[closes.length - 1];
  const width = (upper - lower) / mid * 100;
  let squeeze = false;
  if (closes.length >= 60) {
    const ws = [];
    for (let i = 60; i >= period; i -= 5) {
      const sub = closes.slice(i - period, i);
      const m = sma(sub, period);
      if (m === null) continue;
      const vv = sub.reduce((s, x) => s + (x - m) * (x - m), 0) / period;
      ws.push(Math.sqrt(vv) * 2 / m * 100);
    }
    if (ws.length >= 5) {
      ws.sort((a, b) => a - b);
      squeeze = width <= ws[Math.floor(ws.length * 0.25)];
    }
  }
  return { upper, mid, lower, pos: (px - lower) / (upper - lower), widthPct: width, squeeze };
}

/* 大价格范围尺度系数：swing 越大，止损/目标尺度越宽（小尺度单子止损易被噪音触发） */
function stopScale(swingPct) {
  if (swingPct >= 6) return 1.7;   // ATR×3.06
  if (swingPct >= 3) return 1.45;  // ATR×2.61
  if (swingPct >= 1.5) return 1.25; // ATR×2.25
  return 1;                        // ATR×1.8
}

/* ---------- 通用数据读取 ---------- */
function lsrMap(db, mode) {
  const row = db.prepare('SELECT payload FROM lsr_rankings WHERE mode=? ORDER BY ts DESC LIMIT 1').get(mode);
  const m = new Map();
  if (!row) return m;
  try { const p = JSON.parse(row.payload); for (const c of (p.data || [])) if (c && c.symbol) m.set(c.symbol, c); } catch (e) { debug('[signal] parse row err:', e.message); }
  return m;
}

function pricePct(db, symbol, cur, prevMap) {
  const b = Number(cur && cur.current_price);
  const a = prevMap && prevMap.has(symbol) ? Number(prevMap.get(symbol).current_price) : NaN;
  if (isFinite(a) && a > 0 && isFinite(b)) return (b - a) / a * 100;
  const rows = db.prepare('SELECT price FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT 2').all(symbol);
  if (rows.length >= 2 && isFinite(rows[1].price) && rows[1].price > 0 && isFinite(rows[0].price)) return (rows[0].price - rows[1].price) / rows[1].price * 100;
  return null;
}

function consensusCoin(db, symbol) {
  const row = db.prepare('SELECT payload, ts FROM consensus ORDER BY ts DESC LIMIT 1').get();
  if (!row) return null;
  try {
    const arr = JSON.parse(row.payload);
    const sym = String(symbol).toUpperCase().replace(/USDT$/, '');
    return arr.find(c => (c.symbol || '').toUpperCase() === sym + 'USDT' || (c.display_symbol || '').toUpperCase() === sym) || null;
  } catch (e) { debug('[signal] parse:', e.message); return null; }
}

function fgiValue(db) {
  const row = db.prepare('SELECT value, classification FROM fear_greed ORDER BY ts DESC LIMIT 1').get();
  return row ? { value: row.value, classification: row.classification } : null;
}

/* 清算方向（主流币聚合） */
function liqSignal(db) {
  const MAJORS = new Set(['BTC','ETH','SOL','DOGE','BNB','XRP','ADA','AVAX','LINK','LTC','BCH','DOT','NEAR','APT','SUI','TIA','PEPE','WIF','INJ','ARB','OP','MATIC','AAVE','UNI','TRX','TON','FIL','ATOM','ETC','ICP']);
  const rows = db.prepare(`
    SELECT l1.exchange, l1.payload FROM liquidation l1
    JOIN (SELECT exchange, MAX(ts) ts FROM liquidation GROUP BY exchange) l2
      ON l1.exchange = l2.exchange AND l1.ts = l2.ts
  `).all();
  if (!rows.length) return null;
  let long = 0, short = 0, n = 0;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      for (const c of ((p && p.data) || [])) {
        const sym = String(c.symbol || '').replace(/USDT$/, '');
        if (!MAJORS.has(sym)) continue;
        long += Number(c.long_liquidation_usd_24h || 0);
        short += Number(c.short_liquidation_usd_24h || 0);
      }
      n++;
    } catch (e) { debug('[signal] liq parse err:', e.message); }
  }
  const total = long + short;
  if (n === 0 || total < 1e6) return null;
  const longPct = long / total;
  let direction = null;
  if (longPct > 0.65) direction = 'short';
  else if (longPct < 0.35) direction = 'long';
  return { direction, long, short, longPct, exchanges: n };
}

/* 宏观消息面情绪（news 24h 净分）→ { direction, strength, score }
 * 条数计数 + influence 封顶3，防个别高分新闻放大方向；strength 渐进 0~1 */
function macroSentiment(db) {
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const rows = db.prepare("SELECT sentiment, influence FROM news WHERE ts >= ? AND sentiment != 'neutral'").all(dayAgo);
  if (!rows.length) return { direction: null, strength: 0, score: 0 };
  let score = 0, bull = 0, bear = 0;
  for (const r of rows) {
    const w = Math.min(r.influence || 1, 3);
    if (r.sentiment === 'bullish') { score += w; bull++; }
    else if (r.sentiment === 'bearish') { score -= w; bear++; }
  }
  // 至少 3 条同向新闻才算方向；score 净分
  if (bull >= 3 && score >= 5) return { direction: 'long', strength: Math.min(score / 20, 1), score };
  if (bear >= 3 && score <= -5) return { direction: 'short', strength: Math.min(-score / 20, 1), score };
  return { direction: null, strength: 0, score };
}

/* ================= 策略一：冲高回落动量单（MOM） =================
 * 做空场景（冲高回落）：放量冲高 → 动能衰竭回落 → 散户追多(LSR高) → 多头拥挤(费率正)
 * 做多场景（探底回升）：放量急跌 → 动能衰竭回升 → 散户追空(LSR低) → 空头拥挤(费率负)
 * 确认因子计数 ≥ min_factors 才出单（高胜率）
 */
function momentumCheck(db, snaps, coin, symbol, cfg, trend) {
  const arr = priceSeries(snaps, symbol);
  if (arr.length < 6) return null;
  const px = Number(coin.current_price);
  const window = arr.slice(-12); // 最近12根快照（~1h 主窗口）
  const hi = Math.max(...window), lo = Math.min(...window);
  const prev = arr[arr.length - 2];
  const swingUp = (hi - lo) / lo * 100;      // 窗口振幅
  const fromHigh = (px - hi) / hi * 100;     // 距高点回撤%（负=回落）
  const fromLow = (px - lo) / lo * 100;      // 距低点回升%
  const lastMove = arr.length >= 4 ? (px - arr[arr.length - 4]) / arr[arr.length - 4] * 100 : (px - prev) / prev * 100; // 15min 变动
  const chg1h = Number(coin.price_change_percent_1h || 0);
  const chg24h = Number(coin.price_change_percent_24h || 0);

  // 成交量确认：5m 成交量 vs 1h 均值（放大倍数）
  const vol5 = Number(coin.long_volume_usd_5m || 0) + Number(coin.short_volume_usd_5m || 0);
  const vol1h = Number(coin.long_volume_usd_1h || 0) + Number(coin.short_volume_usd_1h || 0);
  const volRatio = vol1h > 0 ? (vol5 * 12) / vol1h : 0; // 5m折算成小时量比

  const lsr5m = Number(coin.long_short_ratio_5m || 0);
  const lsr4h = Number(coin.long_short_ratio_4h || 0);
  const funding = Number(coin.avg_funding_rate_by_oi || 0) / 100; // Coinglass % → 小数（2026-08-22 修单位：原百分数当小数致阈值恒误报）
  const liqLongPct = (() => {
    const l = Number(coin.long_liquidation_usd_24h || 0), s = Number(coin.short_liquidation_usd_24h || 0);
    return (l + s) > 0 ? l / (l + s) : 0.5;
  })();
  // 布林带确认：近期突破过上/下轨（超买/超卖）后才回落/回升，才是有效反转形态
  const boll = bollinger(arr);
  const brokeUpper = boll ? arr.slice(-8).some(p => p > boll.upper) : false;
  const brokeLower = boll ? arr.slice(-8).some(p => p < boll.lower) : false;

  // 检测做空候选：冲高回落
  if (swingUp >= cfg.price_pct && fromHigh <= -cfg.retrace_pct && trend !== 'long') { // 不逆 1h 主趋势
    const factors = [];
    if (lastMove < 0) factors.push('15min动能转负');
    if (volRatio >= 1.2 && vol5 > 200000) factors.push('放量冲高');
    if (brokeUpper) factors.push('触及布林上轨(超买)');
    if (boll && boll.squeeze) factors.push('带宽收窄突破');
    if (lsr5m >= cfg.lsr_min) factors.push(`散户追多LSR ${lsr5m.toFixed(2)}`);
    if (funding >= cfg.funding_min) factors.push(`多头拥挤费率 ${(funding * 100).toFixed(4)}%`);
    if (liqLongPct >= 0.55) factors.push('多头清算主导');
    if (chg1h > 0 && chg24h > 0) factors.push('1h/24h仍为正(冲高后回落)');
    if (factors.length >= cfg.min_factors) {
      return { strategy: 'MOM', direction: 'short', factors, score: factors.length, px, hi, lo, fromHigh, volRatio, lsr5m, funding };
    }
  }
  // 检测做多候选：探底回升
  if (swingUp >= cfg.price_pct && fromLow >= cfg.retrace_pct && trend !== 'short') { // 不逆 1h 主趋势
    const factors = [];
    if (lastMove > 0) factors.push('15min动能转正');
    if (volRatio >= 1.2 && vol5 > 200000) factors.push('放量急跌');
    if (brokeLower) factors.push('触及布林下轨(超卖)');
    if (boll && boll.squeeze) factors.push('带宽收窄突破');
    if (lsr5m <= (2 - cfg.lsr_min)) factors.push(`散户追空LSR ${lsr5m.toFixed(2)}`);
    if (funding <= -cfg.funding_min) factors.push(`空头拥挤费率 ${(funding * 100).toFixed(4)}%`);
    if (liqLongPct <= 0.45) factors.push('空头清算主导');
    if (chg1h < 0 && chg24h < 0) factors.push('1h/24h仍为负(探底回升)');
    if (factors.length >= cfg.min_factors) {
      return { strategy: 'MOM', direction: 'long', factors, score: factors.length, px, hi, lo, fromLow, volRatio, lsr5m, funding };
    }
  }
  return null;
}

/* ================= 策略二：宏观技术共振单（RES） =================
 * 宏观消息面方向 × 技术面方向（KOL共识/趋势/费率/LSR）同向 → 共振出单
 */
function resonanceCheck(db, coin, symbol, snaps, cfg) {
  const macro = macroSentiment(db);
  if (!macro.direction || macro.strength < (cfg.min_macro_strength / 10)) return null;

  // 硬性门槛：价格动量必须同向（做多时价格在涨，做空时价格在跌）——防逆势接刀
  const arr = priceSeries(snaps, symbol);
  const lastMove = arr.length >= 4 ? (arr[arr.length - 1] - arr[arr.length - 4]) / arr[arr.length - 4] * 100 : 0; // 15min 变动
  const chg1h = Number(coin.price_change_percent_1h || 0);
  const priceMom = macro.direction === 'long' ? (lastMove > 0.15 || chg1h > 0.3) : (lastMove < -0.15 || chg1h < -0.3); // 15min-1h 同向确认
  if (!priceMom) return null; // 价格没往宏观方向动，不叫共振

  const con = consensusCoin(db, symbol);
  const trend = trendFilter(arr);
  const funding = Number(coin.avg_funding_rate_by_oi || 0);
  const lsr4h = Number(coin.long_short_ratio_4h || 0);

  // 加权技术分：KOL共识 1.5 / 趋势 1.0 / 费率 0.8 / LSR 0.8
  let techScore = 0;
  const factors = [];
  if (con && con.decision === macro.direction && con.confidence >= 0.3) { techScore += 1.5; factors.push(`KOL共识${con.decision}`); }
  if (trend === macro.direction) { techScore += 1.0; factors.push(`趋势${trend}`); }
  if (macro.direction === 'long' && funding < 0) { techScore += 0.8; factors.push('负费率(空挤)'); }
  if (macro.direction === 'short' && funding > 0) { techScore += 0.8; factors.push('正费率(多挤)'); }
  if (macro.direction === 'long' && lsr4h < 1) { techScore += 0.8; factors.push('LSR偏空'); }
  if (macro.direction === 'short' && lsr4h > 1) { techScore += 0.8; factors.push('LSR偏多'); }

  // 共振要求：技术分 ≥ min_tech_strength（默认2.5）且至少2个因子
  if (techScore >= cfg.min_tech_strength && factors.length >= 2) {
    return { strategy: 'RES', direction: macro.direction, factors, score: techScore, macro: macro.score, techStrength: techScore, core: factors.filter(f => f.startsWith('KOL') || f.startsWith('趋势')).length, aux: factors.filter(f => !f.startsWith('KOL') && !f.startsWith('趋势')).length };
  }
  return null;
}

/* ================= 策略三：云端共识单（CLOUD，v3保留） ================= */
function cloudScore(db, symbol, fgi, liq, trend) {
  const con = consensusCoin(db, symbol);
  if (!con) return null;
  const conf = Number(con.confidence || 0);
  let dirScore = 0, score = 0;
  const detail = [];
  let hasConsensus = false;
  const ew = con.equal_weight || {};
  const kLong = Number(ew.long || 0), kShort = Number(ew.short || 0);
  const kNet = kLong - kShort;
  if (Math.abs(kNet) >= 15) {
    const w = Math.min(Math.abs(kNet) / 100, 0.8) * Math.min(conf / 0.5, 1);
    const c = kNet > 0 ? w * 1.2 : -w * 1.2;
    dirScore += c; score += c; hasConsensus = true;
    detail.push(`KOL多${kLong}%/空${kShort}%`);
  }
  const traders = con.top_aligned_traders || [];
  if (traders.length >= 3) {
    const longs = traders.filter(t => t.stance === 'long').length;
    const shorts = traders.filter(t => t.stance === 'short').length;
    const net = (longs - shorts) / traders.length;
    if (Math.abs(net) >= 0.4) {
      const w = Math.min(Math.abs(net), 1) * Math.min(conf / 0.5, 1);
      const c = net > 0 ? w * 1.0 : -w * 1.0;
      dirScore += c; score += c; hasConsensus = true;
      detail.push(`Trader ${longs}多/${shorts}空`);
    }
  }
  const bias = Number(con.trust_adjusted_bias || 0);
  if (Math.abs(bias) >= 0.03) {
    const c = bias > 0 ? Math.min(bias * 12, 0.8) : Math.max(bias * 12, -0.8);
    dirScore += c; score += c;
    detail.push(`因子bias ${bias >= 0 ? '+' : ''}${bias.toFixed(3)}`);
  }
  if (liq && liq.direction) {
    const c = liq.direction === 'long' ? 0.6 : -0.6;
    dirScore += c; score += c;
    detail.push(`清算${liq.direction === 'long' ? '轧空' : '杀多'}`);
  }
  if (fgi) {
    if (fgi.value <= 20) { score += 0.5; detail.push(`FGI=${fgi.value}极度恐惧`); }
    else if (fgi.value <= 30) { score += 0.3; detail.push(`FGI=${fgi.value}恐惧`); }
    else if (fgi.value >= 85) { score -= 0.5; detail.push(`FGI=${fgi.value}极度贪婪`); }
    else if (fgi.value >= 70) { score -= 0.3; detail.push(`FGI=${fgi.value}贪婪`); }
  }
  try { const ff = fundFlowScore(db); if (ff && ff.score !== 0) score += ff.score * 0.15; } catch (e) { debug('[signal] fundFlowScore err:', e.message); }
  // 15min-1h 主趋势加权（趋势主导）：同向 +0.2，反向 -0.5
  if (trend === 'long') { dirScore += 0.2; score += 0.2; detail.push('1h趋势多头'); }
  else if (trend === 'short') { dirScore -= 0.2; score -= 0.2; detail.push('1h趋势空头'); }
  const direction = dirScore > 0.3 ? 'long' : dirScore < -0.3 ? 'short' : null;
  return { score, direction, dirScore, conf, detail: detail.filter(Boolean), hasConsensus };
}

/* ================= 策略四：三维共振单（R3D，v1保留） ================= */
function fundingAnomaly(cur, prev, FUNDING) {
  const f = Number(cur && cur.avg_funding_rate_by_oi) / 100; // Coinglass % → 小数
  if (!isFinite(f) || f === 0) return { hit: false };
  const pf = prev ? Number(prev.avg_funding_rate_by_oi) / 100 : NaN;
  let flipped = false;
  if (isFinite(pf) && pf !== 0) {
    flipped = Math.sign(f) !== Math.sign(pf);
    if (!flipped || Math.abs(f) < FUNDING) return { hit: false };
  } else { if (Math.abs(f) < FUNDING * 2) return { hit: false }; }
  return { hit: true, direction: f > 0 ? 'long' : 'short', funding: f, flipped };
}

function lsrAnomaly(db, symbol, coin, traderMap, whaleMap, LSR_SKEW, LSR_DELTA) {
  const r4h = Number(coin && coin.long_short_ratio_4h);
  let hitDir = null, hitRatio = null;
  if (isFinite(r4h) && Math.abs(r4h - 1) >= LSR_SKEW) { hitDir = r4h > 1 ? 'long' : 'short'; hitRatio = r4h; }
  const tc = traderMap && traderMap.get(symbol);
  const wc = whaleMap && whaleMap.get(symbol);
  const tRatio = tc ? Number(tc.trader_ratio ?? tc.ratio) : NaN;
  const wRatio = wc ? Number(wc.whale_ratio ?? wc.ratio) : NaN;
  for (const r of [tRatio, wRatio]) {
    if (isFinite(r) && Math.abs(r - 1) >= LSR_SKEW) {
      const d = r > 1 ? 'long' : 'short';
      if (!hitDir) { hitDir = d; hitRatio = r; }
      else if (Math.abs(r - 1) > Math.abs(hitRatio - 1)) { hitDir = d; hitRatio = r; }
    }
  }
  return { hit: !!hitDir, direction: hitDir, ratio: hitRatio };
}

/* ================= 交易计划 ================= */
function buildPlan(direction, price, arr, coin, common, swingPct) {
  const px = Number(price);
  const a = atr(arr);
  const levels = structLevels(arr);
  const isLong = direction === 'long';
  const chg24 = Math.abs(Number(coin.price_change_percent_24h ?? 0)) / 100;
  const atrVal = Math.max(a && a > 0 ? a : (px * Math.max(chg24 * 0.1, 0.004)), px * 0.004);
  const mult = stopScale(swingPct || 0);
  const stopMult = common.atr_stop_mult * mult; // 大 swing 用更宽止损，防噪音触发
  let entry, stop, entryNote;
  if (isLong) {
    const base = levels ? levels.low : px - atrVal * 3;
    const swing = px - base;
    const retrace = px - swing * common.entry_retrace;
    entry = (px - base) / Math.max(px, 1) < 0.012 ? px : retrace;
    entryNote = entry === px ? '突破启动' : '回踩 0.382';
    stop = levels ? Math.min(px - atrVal * stopMult, levels.low - atrVal * 0.3 * mult) : px - atrVal * stopMult;
    stop = Math.max(stop, px * 0.85);
  } else {
    const base = levels ? levels.high : px + atrVal * 3;
    const swing = base - px;
    const retrace = px + swing * common.entry_retrace;
    entry = (base - px) / Math.max(px, 1) < 0.012 ? px : retrace;
    entryNote = entry === px ? '突破启动' : '回踩 0.382';
    stop = levels ? Math.max(px + atrVal * stopMult, levels.high + atrVal * 0.3 * mult) : px + atrVal * stopMult;
    stop = Math.min(stop, px * 1.15);
  }
  const riskDist = Math.abs(entry - stop);
  if (riskDist <= 0) return null;
  const t1 = isLong ? entry + riskDist * common.fib_t1 : entry - riskDist * common.fib_t1;
  const t2 = isLong ? entry + riskDist * common.fib_t2 : entry - riskDist * common.fib_t2;
  const rr = (Math.abs(t1 - entry) / riskDist).toFixed(1);
  let posPct = 3;
  // v2 固定风险模型（100x）：单笔风险 0.5% 账户，保证金% = 风险% / 止损距离% / 杠杆
  const RISK_PCT = 0.5;
  const stopDistPct = Math.max(riskDist / px * 100, 0.1);
  posPct = Math.min(common.max_pos_pct, Number((RISK_PCT / stopDistPct / 100).toFixed(3)));
  const lev = common.lev || 100;
  return { entry, stop, t1, t2, rr, posPct, lev, entryNote, atrPct: null, atrMult: stopMult, swingPct: swingPct || null, isLong };
}

function fgiDiscount(fgi) {
  if (!fgi) return 1;
  if (fgi.value <= 20) return 0.3;
  if (fgi.value <= 30) return 0.5;
  if (fgi.value <= 45) return 0.7;
  return 1;
}

/* ---------- 推送文案 ---------- */
function buildMessage(h) {
  const { symbol, direction, coin, plan, trend, strategy, factors, cloud } = h;
  const px = Number(coin.current_price);
  const chg24 = Number(coin.price_change_percent_24h ?? 0);
  const oi = Number(coin.open_interest_change_percent_24h ?? 0);
  const long = direction === 'long';
  const fmt = (v) => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : v >= 10 ? v.toFixed(2) : v.toFixed(4);
  const funding = Number(coin.avg_funding_rate_by_oi || 0) / 100; // Coinglass % → 小数
  const fundingPct = isFinite(funding) ? (funding * 100).toFixed(4) + '%' : '?';
  const ratioTxt = isFinite(Number(coin.long_short_ratio_4h)) && Number(coin.long_short_ratio_4h) > 0 ? Number(coin.long_short_ratio_4h).toFixed(2) : '?';
  const act = long ? '做多' : '做空';
  const isMajor = h.symbol === 'BTC' || h.symbol === 'ETH';
  const orderTxt = plan.entryNote === '突破启动' ? '市价追单' : '限价挂单(回踩成交)';
  const STRAT = { MOM: '智能策略', RES: '智能策略', CLOUD: '智能策略', R3D: '智能策略' };
  const stratTxt = STRAT[strategy] || strategy;
  const trendTxt = trend === 'long' ? '15min-1h多头排列' : trend === 'short' ? '15min-1h空头排列' : '15min-1h趋势中性';
  const factorsTxt = (factors || []).join(' · ');
  const cloudTxt = cloud && cloud.detail && cloud.detail.length ? `云端: ${cloud.detail.join(' · ')}｜综合分 ${cloud.score >= 0 ? '+' : ''}${cloud.score.toFixed(2)}｜置信 ${(cloud.conf * 100).toFixed(0)}%` : '';
  const lines = [
    `【W1 ${isMajor ? '主流单' : '信号'}】${symbol} ${act} ${stratTxt}`,
    `入场 $${fmt(plan.entry)}（${plan.entryNote}）｜现价 $${fmt(px)}｜${orderTxt}`,
    `止损 $${fmt(plan.stop)}（ATR×${plan.atrMult || 1.8}）｜盈亏比 1:${plan.rr}`,
    `目标 $${fmt(plan.t1)} / $${fmt(plan.t2)}（斐波 1.618/2.618）`,
    `⚖️ 100x杠杆：保证金 ${plan.posPct}%（名义 ${(plan.posPct * 100).toFixed(1)}%）｜单笔风险 0.5%｜强平保护 ~100%`,
    `确认因子：${factorsTxt || '—'}`,
    `数据：现价 $${fmt(px)}（24h ${chg24 >= 0 ? '+' : ''}${chg24.toFixed(1)}%）· OI ${oi >= 0 ? '+' : ''}${oi.toFixed(1)}% · 费率 ${fundingPct} · 多空比 ${ratioTxt} · ${trendTxt}`,
    `提示：仅供研究，不构成投资建议，盈亏自负`
  ];
  if (h.aiVote) {
    lines.splice(lines.length - 2, 0, h.aiVote.agree ? '🤖 AI 同向 ✓' : '🤖 AI 观望');
  }
  if (cloudTxt) lines.splice(lines.length - 2, 0, cloudTxt);
  if (h.riskLines && h.riskLines.length) lines.splice(lines.length - 1, 0, h.riskLines.join('\n'));
  return lines.join('\n');
}

/* ---------- 冷却/上限/推送 ---------- */
async function tryPush(ctx, h, settings) {
  const { db, env } = ctx;
  const cooldownKey = `signal:cooldown:${h.symbol}:${h.direction}`;
  const lastPush = kvGet(db, cooldownKey, 0);
  if (lastPush && Date.now() - lastPush < settings.common.cooldown_h * 3600 * 1000) {
    debug(`[signal] ${h.symbol}:${h.direction} 冷却中，跳过`);
    return false;
  }
  let riskHint = '', limitMult = 1, riskHigh = false;
  try {
    const er = eventRiskAdjustment(db);
    limitMult = er.dailyLimitMult || 1;
    riskHigh = er.risk === 'high';
    if (er.hint) riskHint = er.hint;
    if (er.lines && er.lines.length) {
      // 压缩为一行摘要：风险等级 + 事件名列表（群消息简洁化）
      const names = er.lines.slice(1).map(l => String(l).trim().split(/\s+/)[0]).filter(Boolean);
      h.riskLines = [er.lines[0] + (names.length ? '（' + names.join('·') + '）' : '')];
    }
  } catch (e) {}
  if (riskHigh && h.plan) {
    h.plan.posPct = Number((h.plan.posPct * 0.5).toFixed(3));
    h.plan.lev = settings.common.lev || 100;
  }
  const dailyKey = `signal:daily:${todayStr()}`;
  const dailyCount = Number(kvGet(db, dailyKey, 0) || 0);
  const effLimit = Math.floor(settings.common.daily_limit * limitMult);
  if (dailyCount >= effLimit) {
    debug(`[signal] 今日已达上限 ${effLimit} 条，跳过 ${h.symbol}:${h.direction}`);
    return false;
  }
  const msg = buildMessage(h);
  const pushFn = ctx.pushFn || pushToGroup;
  let ok = false;
  try { ok = await pushFn(env, db, msg); } catch (e) { warn('[signal] pushFn error:', e.message); }
  if (ok) {
    kvSet(db, cooldownKey, Date.now());
    kvSet(db, dailyKey, dailyCount + 1);
    try {
      db.prepare(`INSERT INTO signal_track
        (symbol, direction, entry, stop, target1, target2, rr, pos_pct, msg, status, pushed_at, strategy)
        VALUES (?,?,?,?,?,?,?,?,?, 'OPEN', ?, ?)`)
        .run(h.symbol, h.direction, h.plan.entry, h.plan.stop, h.plan.t1, h.plan.t2,
             Number(h.plan.rr), h.plan.posPct, msg, Date.now(), h.strategy);
      info(`[signal] 战绩入库: ${h.symbol} ${h.direction} (${h.strategy}) entry=${h.plan.entry}`);
    } catch (e) { warn('[signal] 战绩入库失败:', e.message); }
    info(`[signal] PUSH ${h.symbol}:${h.direction} [${h.strategy}] → 群 (daily=${dailyCount + 1}/${effLimit})${riskHint ? ' 风控: ' + riskHint : ''}`);
  } else {
    warn(`[signal] 推送未成功（未配置QQ_GROUP_OPENID或发送失败），不计冷却: ${h.symbol}:${h.direction}`);
  }
  return ok;
}

/* ---------- 战绩结算 ---------- */
async function resolveOpenSignals(db, snaps, env) {
  const opens = db.prepare("SELECT * FROM signal_track WHERE status='OPEN'").all();
  if (!opens.length) return 0;
  const cur = snaps[snaps.length - 1];
  if (!cur) return 0;
  let resolved = 0;
  const now = Date.now();
  for (const o of opens) {
    const c = cur.m.get(o.symbol);
    if (!c) continue;
    const px = Number(c.current_price);
    if (!isFinite(px)) continue;
    let status = null, reason = null, pnl = null;
    const isLong = o.direction === 'long';
    // v2: 对齐回测出场结构（t1_rr=0.8 部分落袋 → 止损移保本 → 超时判定；复利版 t1_pct=60%）
    if (o.t1_hit) {
      // 已部分落袋：止损已移至保本（entry），剩余按保本止损+超时
      if (isLong && px <= o.entry) { status = 'LOSS'; reason = '保本止损'; pnl = 0; }
      else if (!isLong && px >= o.entry) { status = 'LOSS'; reason = '保本止损'; pnl = 0; }
    } else {
      if (isLong && px >= o.target1) {
        // 到达目标1 → 60%落袋，剩余40%止损移保本（回测 t1_pct=60% 逻辑）
        db.prepare("UPDATE signal_track SET t1_hit=1, stop=entry WHERE id=?").run(o.id);
        status = null; reason = null; pnl = null;
        info(`[signal] ${o.symbol} 到达目标1 → 60%落袋，止损移保本 (id=${o.id})`);
      } else if (!isLong && px <= o.target1) {
        db.prepare("UPDATE signal_track SET t1_hit=1, stop=entry WHERE id=?").run(o.id);
        status = null; reason = null; pnl = null;
        info(`[signal] ${o.symbol} 到达目标1 → 60%落袋，止损移保本 (id=${o.id})`);
      } else if (isLong && px <= o.stop) { status = 'LOSS'; reason = '触及止损'; pnl = (o.stop - o.entry) / o.entry * 100; }
      else if (!isLong && px >= o.stop) { status = 'LOSS'; reason = '触及止损'; pnl = (o.entry - o.stop) / o.entry * 100; }
    }
    // 超时判定（回测 time_bars=10根4h=40h 对齐；实盘用 MAX_HOLD_H=48h 兼容）
    if (!status && now - o.pushed_at > MAX_HOLD_H * 3600 * 1000) {
      status = 'FLAT'; reason = '超时未了结';
      pnl = isLong ? (px - o.entry) / o.entry * 100 : (o.entry - px) / o.entry * 100;
    }
    if (status) {
      // 已部分落袋（t1_hit=1）→ 最终pnl = 60%落袋收益 + 40%剩余收益（与回测 t1_pct=60% 同口径）
      if (o.t1_hit && Number(o.entry) > 0) {
        const t1GainPct = isLong ? (Number(o.target1) - Number(o.entry)) / Number(o.entry) * 100
                                  : (Number(o.entry) - Number(o.target1)) / Number(o.entry) * 100;
        pnl = 0.6 * t1GainPct + 0.4 * (status === 'LOSS' && reason === '保本止损' ? 0 : pnl);
      }
      db.prepare("UPDATE signal_track SET status=?, resolved_at=?, pnl_pct=?, reason=? WHERE id=?")
        .run(status, now, Number(pnl.toFixed(2)), reason, o.id);
      info(`[signal] 战绩结算 ${o.symbol} ${o.direction} → ${status} (${reason}) pnl=${pnl.toFixed(2)}%`);
      // 自动平仓/结算 → 推送到群（老板要求：任何平仓都发群）
      if (env) {
        try {
          const icon = status === 'WIN' ? '✅' : (status === 'FLAT' ? '➖' : '❌');
          const dir = o.direction === 'long' ? '做多' : '做空';
          const pnlTxt = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
          const stopDist = Math.abs(Number(o.entry) - Number(o.stop)) / Number(o.entry) * 100;
          const rMult = stopDist > 0 ? pnl / stopDist : null;
          const closeMsg = [
            `【W1·自动平仓】${o.symbol} ${dir}（${o.strategy || 'SIGNAL'}）`,
            `进场 $${Number(o.entry).toFixed(2)} → 现价 $${px.toFixed(2)}`,
            `${icon} ${status === 'WIN' ? '止盈' : '止损'}了结｜盈亏 ${pnlTxt}${rMult == null ? '' : `（≈${rMult >= 0 ? '+' : ''}${rMult.toFixed(2)}R，止损距离 ${stopDist.toFixed(2)}%）`}｜${reason}`,
            '⚠️ 仅供研究参考，不构成投资建议',
          ].join('\n');
          await pushToGroup(env, db, closeMsg);
        } catch (e) { warn('[signal] 平仓推送失败:', e.message); }
      }
      if (status === 'LOSS' && pnl < 0) {
        // 日亏损熔断（2026-08-29 分方向）：多头亏损只熔断多头，不误伤空单
        const dk = 'signal:dayloss:' + o.direction + ':' + new Date().toISOString().slice(0, 10);
        const acc = Number(kvGet(db, dk, 0) || 0) + Math.abs(pnl);
        kvSet(db, dk, String(acc));
        warn(`[signal] ${o.direction} 当日累计亏损 ${acc.toFixed(2)}%（≥3% 熔断停推该方向）`);
      }
      resolved++;
    }
  }
  return resolved;
}

/* ---------- 持仓跟进建议（v4.1 新增）：OPEN 单与各面异动 → 提示平/减 ---------- */
async function followUpCheck(ctx, snaps, settings) {
  const { db, env } = ctx;
  const opens = db.prepare("SELECT * FROM signal_track WHERE status='OPEN'").all();
  if (!opens.length) return 0;
  const cur = snaps[snaps.length - 1];
  if (!cur) return 0;
  let cons = null;
  try {
    const row = db.prepare('SELECT ts,payload FROM consensus ORDER BY ts DESC LIMIT 1').get();
    // 2026-10-31：共识表需新鲜度门控，超过 2h 不参与跟进判断
    if (row && Math.floor(Date.now() / 1000) - Number(row.ts || 0) <= 7200) {
      const parsed = JSON.parse(row.payload);
      const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.data) ? parsed.data : []);
      cons = arr.find(c => (c.symbol || '').toUpperCase().startsWith('BTC') || (c.display_symbol || '').toUpperCase() === 'BTC') || null;
    }
  } catch (e) { debug('[signal] consensus parse err:', e.message); }
  const now = Date.now();
  let pushed = 0;
  for (const o of opens) {
    const c = cur.m.get(o.symbol);
    if (!c) continue;
    const px = Number(c.current_price);
    if (!isFinite(px)) continue;
    const isLong = o.direction === 'long';
    const arr = priceSeries(snaps, o.symbol);
    const trend = trendFilter(arr);
    const funding = Number(c.avg_funding_rate_by_oi || 0) / 100; // Coinglass % → 小数
    // 2026-10-31：LSR 改用 precision 三口径 + 该币 60 日分位，不再用未标口径的 long_short_ratio_4h
    const lsrNow = precision.lsrSnapshot(db, o.symbol);
    const lsrRatio = lsrNow && lsrNow.notional_lsr != null ? lsrNow.notional_lsr : null;
    const lsrPct = lsrRatio != null ? precision.lsrPercentile(db, o.symbol) : null;
    // 冷却：每单 6h 最多一条跟进建议
    const fk = `signal:follow:${o.id}`;
    const lastFollow = kvGet(db, fk, 0);
    if (lastFollow && now - lastFollow < 6 * 3600 * 1000) continue;
    const reasons = [];
    let action = null;
    // 1) 价格已破位 → 立即平仓
    if (isLong && px <= o.stop) { reasons.push(`现价 $${px.toFixed(2)} 已跌破止损 $${o.stop}`); action = '立即平仓'; }
    else if (!isLong && px >= o.stop) { reasons.push(`现价 $${px.toFixed(2)} 已涨破止损 $${o.stop}`); action = '立即平仓'; }
    // 2) 趋势翻转 → 减/平
    if (!action && trend !== 'neutral' && ((isLong && trend === 'short') || (!isLong && trend === 'long'))) {
      reasons.push(`趋势已翻转为${trend === 'long' ? '多头' : '空头'}`);
      action = '减仓 50% 或直接离场';
    }
    // 3) 费率反向拥挤 → 减仓
    if (!action && ((isLong && funding >= 0.001) || (!isLong && funding <= -0.001))) {
      reasons.push(`费率${isLong ? '多头拥挤 ' : '空头拥挤 '}${(funding * 100).toFixed(4)}%`);
      action = '建议减仓 1/3~1/2，谨防踩踏';
    }
    // 4) LSR 极端反向 → 减仓（持仓名义口径；用 60 日分位，避免固定阈值失真）
    if (!action && lsrRatio != null) {
      const hi = lsrPct && lsrPct.p95 != null ? Math.max(lsrPct.p95, 1.6) : 2.5;
      const lo = lsrPct && lsrPct.p5 != null ? Math.min(lsrPct.p5, 0.6) : 0.45;
      if ((isLong && lsrRatio >= hi) || (!isLong && lsrRatio <= lo)) {
        reasons.push(`持仓多空 ${lsrRatio.toFixed(2)}（60日 p5 ${lsrPct && lsrPct.p5 != null ? lsrPct.p5.toFixed(2) : '—'} / p95 ${lsrPct && lsrPct.p95 != null ? lsrPct.p95.toFixed(2) : '—'}）极端${isLong ? '偏多' : '偏空'}`);
        action = '建议减仓，拥挤度见顶信号';
      }
    }
    // 5) KOL 共识翻转 → 减仓
    if (!action && cons) {
      const bias = Number(cons.trust_adjusted_bias || 0);
      if ((isLong && bias <= -0.05) || (!isLong && bias >= 0.05)) {
        reasons.push(`KOL 共识翻转（bias ${bias.toFixed(3)}）`);
        action = '建议减仓一半';
      }
    }
    // 6) 到达目标 1 → 部分止盈
    if (!action && ((isLong && px >= o.target1) || (!isLong && px <= o.target1))) {
      reasons.push('已到达目标 1');
      action = '建议止盈 50%，止损上移至成本价';
    }
    if (!action || !reasons.length) continue;
    const act = isLong ? '多单' : '空单';
    const msg = `【W1 跟进】${o.symbol} ${act}（${o.strategy || '?'}）\n` +
      `信号价 $${o.entry} · 现价 $${px.toFixed(2)} · 止损 $${o.stop}\n` +
      `异动：${reasons.join('；')}\n` +
      `建议：${action}\n` +
      `提示：仅供研究，不构成投资建议`;
    let ok = false;
    try { ok = await (ctx.pushFn || pushToGroup)(env, db, msg); } catch (e) { warn('[signal] follow push error:', e.message); }
    if (ok) {
      kvSet(db, fk, now);
      pushed++;
      info(`[signal] 跟进建议 ${o.symbol} ${o.direction}: ${action}`);
    }
  }
  return pushed;
}

function buildWeeklyReport(db) {
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const rows = db.prepare("SELECT * FROM signal_track WHERE pushed_at >= ? ORDER BY id DESC").all(weekAgo);
  if (!rows.length) return null;
  const total = rows.length;
  const wins = rows.filter(r => r.status === 'WIN').length;
  const losses = rows.filter(r => r.status === 'LOSS').length;
  const flats = rows.filter(r => r.status === 'FLAT').length;
  const pnls = rows.filter(r => r.pnl_pct !== null).map(r => r.pnl_pct);
  const avgPnl = pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2) : '?';
  const winRate = (wins / Math.max(total, 1) * 100).toFixed(0);
  return [
    '📊 W1 战绩周报',
    `本周信号 ${total} 单｜胜率 ${winRate}%（WIN ${wins} / LOSS ${losses} / FLAT ${flats}）`,
    `已了结平均盈亏 ${avgPnl}%`,
    `提示：仅供研究，不构成投资建议`
  ].join('\n');
}

/* ---------- 单币扫描（供接口/主循环共用） ---------- */
function scanCoin(ctx, coin, symbol, snaps, prevMap, settings, traderMap, whaleMap) {
  const { db } = ctx;
  const c = settings.common;
  const prevCoin = prevMap ? prevMap.get(symbol) : null;
  const arr = priceSeries(snaps, symbol);
  const fgi = fgiValue(db);
  const liq = liqSignal(db);
  const trend = trendFilter(arr);
  const pct = pricePct(db, symbol, coin, prevMap);
  const lv = structLevels(arr);
  const swingPct = lv ? (lv.high - lv.low) / lv.low * 100 : Math.abs(pct || 0) * 2;
  const result = { symbol, trend, pct, swingPct };

  // 策略一：冲高回落动量单
  if (settings.mom.enabled) {
    const mom = momentumCheck(db, snaps, coin, symbol, settings.mom, trend);
    if (mom) {
      const plan = buildPlan(mom.direction, coin.current_price, arr, coin, c, swingPct);
      if (plan && Number(plan.rr) >= c.min_rr) {
        result.hit = { symbol, ...mom, plan, coin, trend };
        return result;
      }
    }
  }
  // 策略二：宏观技术共振单
  if (settings.res.enabled) {
    const res = resonanceCheck(db, coin, symbol, snaps, settings.res);
    if (res) {
      const plan = buildPlan(res.direction, coin.current_price, arr, coin, c, swingPct);
      if (plan && Number(plan.rr) >= c.min_rr) {
        result.hit = { symbol, ...res, plan, coin, trend };
        return result;
      }
    }
  }
  // 策略三：云端共识单
  if (settings.cloud.enabled) {
    const cloud = cloudScore(db, symbol, fgi, liq, trend);
    if (cloud && cloud.direction && cloud.hasConsensus && Math.abs(cloud.score) >= settings.cloud.threshold) {
      const isStrong = Math.abs(cloud.score) >= settings.cloud.threshold + settings.cloud.strong_bonus;
      const confOk = isStrong || cloud.conf >= settings.cloud.conf_min;
      if (confOk) {
        const plan = buildPlan(cloud.direction, coin.current_price, arr, coin, c, swingPct);
        if (plan && Number(plan.rr) >= c.min_rr) {
          result.hit = { symbol, strategy: 'CLOUD', direction: cloud.direction, factors: cloud.detail, plan, coin, trend, cloud };
          return result;
        }
      }
    }
  }
  // 策略四：三维共振单
  if (settings.r3d.enabled) {
    const chg1hR3 = Number(coin.price_change_percent_1h || 0);
    const dPrice = Math.abs(chg1hR3) >= settings.r3d.price_pct ? (chg1hR3 > 0 ? 'long' : 'short') : null; // 1h 变动
    const fa = fundingAnomaly(coin, prevCoin, 0.0005);
    const la = lsrAnomaly(db, symbol, coin, traderMap, whaleMap, 0.5, 1.0);
    const dims = { price: dPrice, funding: fa.hit ? fa.direction : null, lsr: la.hit ? la.direction : null };
    const dirs = Object.values(dims).filter(Boolean);
    const isFull = dirs.length === 3 && dirs.every(d => d === dirs[0]);
    if (isFull && trend !== 'neutral' && trend !== dirs[0]) {
      result.skipNote = `三维共振但逆势(${trend})`;
      return result;
    }
    if (isFull) {
      const plan = buildPlan(dirs[0], coin.current_price, arr, coin, c, swingPct);
      if (plan && Number(plan.rr) >= c.min_rr) {
        result.hit = { symbol, strategy: 'R3D', direction: dirs[0], factors: [`1h价格${dPrice}`, `费率${fa.direction}`, `LSR${la.direction}`], plan, coin, trend, dims };
        return result;
      }
    } else if (dirs.length >= 2) {
      result.near = { price: dims.price, funding: dims.funding, lsr: dims.lsr };
    }
  }
  return result;
}

/* ---------- 主入口 ---------- */
async function checkAll(ctx, opts = {}) {
  const { db, env } = ctx;
  const settings = opts.settings || loadSettings(db);
  if (!settings.enabled) {
    debug('[signal] 引擎已关闭（settings.enabled=false），跳过扫描');
    return { skipped: true, reason: 'disabled' };
  }
  const now = Date.now();
  if (!opts.force && now - lastCheckTs < 60 * 1000) return { skipped: true, reason: 'min_gap' };
  lastCheckTs = now;

  const snaps = futuresSnapshots(db, 30);
  const cur = snaps[snaps.length - 1] || null;
  const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  if (!cur || cur.m.size === 0) {
    debug('[signal] no futures data, skip');
    return { coins: 0, hits: 0, pushed: 0, reason: 'no_data' };
  }
  try { await resolveOpenSignals(db, snaps, env); } catch (e) { warn('[signal] 战绩结算异常:', e.message); }
  try {
    const fn = await followUpCheck(ctx, snaps, settings);
    if (fn) info(`[signal] 跟进建议推送 ${fn} 条`);
  } catch (e) { warn('[signal] 跟进检查异常:', e.message); }

  const traderMap = lsrMap(db, 'trader');
  const whaleMap = lsrMap(db, 'whale');
  let hits = [];
  const scans = [];
  const pushSet = new Set(Array.isArray(settings.push_symbols) && settings.push_symbols.length ? settings.push_symbols : ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'XAU']);
  let scannedCount = 0;
  for (const coin of cur.m.values()) {
    const symbol = coin.symbol;
    if (!pushSet.has(symbol)) continue; // 非白名单：不实盘扫描/推送（回测系统独立可用）
    scannedCount++;
    try {
      const r = scanCoin(ctx, coin, symbol, snaps, prev ? prev.m : null, settings, traderMap, whaleMap);
      scans.push({ symbol, strategy: r.hit ? r.hit.strategy : null, direction: r.hit ? r.hit.direction : null, trend: r.trend, pct: r.pct });
      if (r.hit) hits.push(r.hit);
    } catch (e) { warn(`[signal] scan ${symbol} error:`, e.message); }
  }

  // AI 智能体研判：2h 缓存，失败降级；AI 反向否决该单，同向标注验证
  let ai = null;
  try { const adv = require('./ai_advisor'); ai = await adv.getAdvisory(ctx); } catch (e) { warn('[signal] ai advisory fail:', e.message); }
  if (ai && ai.ok && Array.isArray(ai.trades) && ai.trades.length) {
    for (const h of hits) {
      const t = ai.trades.find(x => String(x.symbol || '').toUpperCase() === String(h.symbol || '').toUpperCase());
      if (!t || !t.direction || t.direction === 'none') continue;
      if ((h.direction === 'long' && t.direction === 'short') || (h.direction === 'short' && t.direction === 'long')) {
        h.aiVote = { agree: false, reason: t.reason || '' };
        debug(`[signal] AI 否决 ${h.symbol} ${h.direction}（AI 建议 ${t.direction}）`);
      } else if (h.direction === t.direction) {
        h.aiVote = { agree: true, reason: t.reason || '', conf: t.confidence };
      }
    }
    hits = hits.filter(h => !h.aiVote || h.aiVote.agree !== false);
  }
  const disc = fgiDiscount(fgiValue(db));
  if (disc < 1) {
    for (const h of hits) {
      h.plan.posPct = Number((h.plan.posPct * disc).toFixed(3));
      h.plan.lev = settings.common.lev || 100;
    }
  }
  let pushed = 0;
  // 日亏损熔断检查（2026-08-29 分方向）：该方向今日已结算亏损 ≥3% 则只记录不推送
  const todayK = new Date().toISOString().slice(0, 10);
  const lossHaltDir = d => Number(kvGet(db, `signal:dayloss:${d}:${todayK}`, 0) || 0) >= 3;
  const halted = hits.filter(h => h && h.direction && lossHaltDir(h.direction));
  if (halted.length) warn(`[signal] 日亏损熔断：${halted.map(h => h.direction).join('/')} 方向今日已亏≥3%，仅记录不推送`);
  for (const h of hits) {
    try { if (!(h && h.direction && lossHaltDir(h.direction)) && await tryPush(ctx, h, settings)) pushed++; } catch (e) { warn('[signal] push loop error:', e.message); }
  }
  info(`[signal] checked ${scannedCount}/${cur.m.size} coins(白名单), ${hits.length} hit, pushed ${pushed} (FGI×${disc})`);
  return { coins: scannedCount, total_coins: cur.m.size, hits: hits.length, pushed, strategies: [...new Set(hits.map(h => h.strategy))] };
}

module.exports = { checkAll, buildMessage, buildPlan, buildWeeklyReport, resolveOpenSignals, futuresSnapshots, priceSeries, trendFilter, fgiValue, cloudScore, liqSignal, loadSettings, saveSettings, scanCoin, macroSentiment, momentumCheck, resonanceCheck, bollinger, stopScale, sma, atr, structLevels, fgiDiscount, followUpCheck, DEFAULTS };
