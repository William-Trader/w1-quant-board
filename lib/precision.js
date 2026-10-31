'use strict';
// ============================================================
// lib/precision.js — 价格源 & 多空比统一精度层 v1.0（2026-10-31）
//
// 目的：所有 QQ 推送 / API / 页面读取同一套「已校验」的价格与 LSR 口径，
//       禁止各模块各取一源、各用一个分母。
//
// 价格：
//   - Gate 现货（prices 表，60s 采集）
//   - Coinglass 合约聚合（futures_markets，5min 采集，current_price）
//   - 按「流动性份额 × 质量」加权；质量按偏离中位数分档（≤0.3%=1 / ≤1%=0.25 / >1%=0）
//   - 单源权重上限 60%（防止单一源绑架加权价）
//   - 输出偏差、有效源数、置信度、数据龄期；不新鲜的数据必须显式标注
//
// 多空比（LSR）：
//   Coinglass 的 ratio 是「持仓名义价值多空比」= long_notional / short_notional，
//   不是账户数多空比。本模块同时给出三个分母，并交叉校验厂商 ratio：
//     notional = long_notional / short_notional      （持仓名义，主口径）
//     account  = long_traders  / short_traders       （账户数，散户情绪）
//     whaleQty = whale_long_qty / whale_short_qty    （大户持仓量）
//     ovQty    = ov_long_qty / ov_short_qty          （全市场持仓量，备用校验）
//   |notional - vendor| / vendor > 0.5% ⇒ DATA_WARN。
// ============================================================

const W1_SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK'];
const GATE_STALE_SEC = 300;     // Gate 60s 采集，5 分钟未更新即视为 stale
const CG_STALE_SEC = 900;       // Coinglass 5min 采集
const DEV_WARN_PCT = 0.5;       // 跨源偏差告警线
const LSR_WARN_PCT = 0.5;       // LSR 交叉校验告警线
const SINGLE_WEIGHT_CAP = 0.6;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pctDiff(a, b) { return (a != null && b != null && b !== 0) ? (a - b) / b * 100 : null; }
function round(v, d = 2) { return v == null ? null : +Number(v).toFixed(d); }

function fmtTime(sec, tz = 'Asia/Shanghai') {
  if (!sec) return '—';
  try {
    return new Date(sec * 1000).toLocaleTimeString('zh-CN', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) { return new Date(sec * 1000).toISOString().slice(11, 19); }
}
function fmtPrice(v) {
  if (v == null) return '—';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 10) return v.toFixed(2);
  if (v >= 1) return v.toFixed(3);
  return v.toPrecision(4);
}
function fmtAge(sec) {
  if (sec == null) return '—';
  if (sec < 60) return Math.round(sec) + 's';
  if (sec < 3600) return Math.round(sec / 60) + 'm';
  return (sec / 3600).toFixed(1) + 'h';
}
function fmtPct(v, digits = 2) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + Number(v).toFixed(digits) + '%';
}

/* ---------------- 价格 ---------------- */

function latestGate(db, symbols) {
  const out = {};
  for (const sym of symbols) {
    try {
      const r = db.prepare('SELECT price, change_24h, high_24h, low_24h, volume, ts, source FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT 1').get(sym);
      if (r && num(r.price) != null) out[sym] = { name: 'gate', price: num(r.price), chg24: num(r.change_24h), volume: num(r.volume) || 0, ts: num(r.ts), source: r.source || 'gate' };
    } catch (e) { /* ignore */ }
  }
  return out;
}

function latestCgFutures(db, symbols) {
  const out = {};
  try {
    const row = db.prepare('SELECT ts,payload FROM futures_markets ORDER BY ts DESC LIMIT 1').get();
    if (!row) return out;
    const p = JSON.parse(row.payload);
    const arr = Array.isArray(p.data) ? p.data : [];
    for (const sym of symbols) {
      const c = arr.find(x => String(x.symbol).replace(/USDT$/i, '') === sym);
      if (c && num(c.current_price) != null) {
        out[sym] = { name: 'coinglass', price: num(c.current_price), chg24: num(c.price_change_percent_24h), volume: num(c.volume_24h_usd) || 0, ts: num(row.ts), source: 'cg_futures' };
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

// 质量分档：偏离中位数越小越可信
function qualityOf(devPct) {
  if (devPct == null) return 1;
  const a = Math.abs(devPct);
  if (a <= 0.3) return 1;
  if (a <= 1) return 0.25;
  return 0;
}

// 纯函数：给定 [{name, price, volume, ts}] 计算加权价
function weightedPrice(entries, nowSec) {
  const list = (entries || []).filter(e => e && num(e.price) != null && num(e.price) > 0);
  if (!list.length) return null;
  const prices = list.map(e => e.price).sort((a, b) => a - b);
  const median = prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;

  // 流动性份额（同计价 USDT）。
  // 2026-10-31 修正：Coinglass coins-markets 的 volume_24h_usd 实测缺失（undefined），
  // 旧代码把缺失当 0 → 权重退化成 100%/0，再被 60% 上限截断，加权价只剩单源的 60%
  // （实测 BTC 加权价 46432，而真实价约 77400）。只要有一个源缺成交量，就整体改用等权。
  const vols = list.map(e => { const v = num(e.volume); return v != null && v > 0 ? v : null; });
  const allKnown = vols.every(v => v != null);
  const vsum = allKnown ? vols.reduce((a, b) => a + b, 0) : 0;
  let ws = (allKnown && vsum > 0) ? vols.map(v => v / vsum) : list.map(() => 1 / list.length);

  // 质量分 + 偏离
  const devs = list.map(e => pctDiff(e.price, median));
  const qs = devs.map(qualityOf);

  // 2026-10-31 修正：两源互相矛盾（都偏离中位数 >1%）时，中位数本身不可信，
  // 质量分会全为 0，旧代码退化成简单平均（会把异常价算进去）。
  // 正确做法：没有共识就只信成交量最大的源，并显式标记 data_warn。
  const active = list.map((e, i) => ({ e, i, q: qs[i], w: ws[i] })).filter(x => x.q > 0);
  if (!active.length) {
    const best = list.reduce((a, b) => (num(b.volume) || 0) > (num(a.volume) || 0) ? b : a);
    const maxDev = Math.max(...devs.map(d => Math.abs(d == null ? 0 : d)));
    const newestAge = list.map(e => (nowSec && e.ts) ? Math.max(0, nowSec - e.ts) : null).filter(x => x != null);
    const age = newestAge.length ? Math.min(...newestAge) : null;
    return {
      price: +best.price, median: +median, n: 1, effective_n: 1,
      max_dev_pct: +maxDev.toFixed(3),
      weights: [{ name: best.name, weight: 1 }],
      sources: list.map(e => ({ name: e.name, price: e.price, weight: e === best ? 1 : 0, dev_pct: pctDiff(e.price, median) == null ? null : +pctDiff(e.price, median).toFixed(3), age_sec: e.ts ? Math.max(0, nowSec - e.ts) : null })),
      confidence: 'low', newest_age_sec: age == null ? null : Math.round(age),
      max_age_sec: age == null ? null : Math.round(age),
      stale: age != null && age > CG_STALE_SEC,
      data_warn: true,
      warn_reason: '跨源无共识（全部偏离中位数 >1%），仅采用成交量最大源'
    };
  }

  // 只用通过质量检查的源重新归一化
  const activeSum = active.reduce((a, x) => a + x.w, 0);
  const activeWs = active.map(x => activeSum > 0 ? x.w / activeSum : 1 / active.length);

  // 单源上限 60%（仅在 ≥2 个有效源时生效；单源时权重必须为 1）
  if (active.length >= 2) {
    for (let pass = 0; pass < 2; pass++) {
      let changed = false;
      for (let k = 0; k < activeWs.length; k++) {
        if (activeWs[k] > SINGLE_WEIGHT_CAP) {
          const excess = activeWs[k] - SINGLE_WEIGHT_CAP;
          activeWs[k] = SINGLE_WEIGHT_CAP;
          const others = activeWs.map((w, j) => j === k ? 0 : w);
          const osum = others.reduce((a, b) => a + b, 0);
          if (osum > 0) {
            for (let j = 0; j < activeWs.length; j++) if (j !== k) activeWs[j] += excess * others[j] / osum;
          } else {
            // 其余源权重为 0（不应发生，但防御）：把超出部分均分，避免总权重 <1
            const rest = activeWs.map((w, j) => j).filter(j => j !== k);
            if (rest.length) for (const j of rest) activeWs[j] += excess / rest.length;
          }
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
  // 上限处理后重新归一化，保证权重和恒为 1（否则加权价会被系统性缩小）
  const sumAfter = activeWs.reduce((a, b) => a + b, 0);
  if (sumAfter > 0 && Math.abs(sumAfter - 1) > 1e-9) {
    for (let k = 0; k < activeWs.length; k++) activeWs[k] /= sumAfter;
  }
  ws = list.map(() => 0);
  active.forEach((x, k) => { ws[x.i] = activeWs[k]; });

  const price = list.reduce((a, e, i) => a + e.price * ws[i], 0);
  const maxDev = Math.max(...devs.map(d => Math.abs(d == null ? 0 : d)));
  const effN = 1 / ws.reduce((a, w) => a + w * w, 0);
  const ages = list.map(e => (nowSec && e.ts) ? Math.max(0, nowSec - e.ts) : null).filter(x => x != null);
  const maxAge = ages.length ? Math.max(...ages) : null;
  const newestAge = ages.length ? Math.min(...ages) : null;

  let confidence = 'low';
  if (active.length >= 2 && maxDev <= 0.15 && (newestAge == null || newestAge <= GATE_STALE_SEC)) confidence = 'high';
  else if (active.length >= 2 && maxDev <= DEV_WARN_PCT) confidence = 'medium';
  else if (active.length === 1 && (newestAge == null || newestAge <= GATE_STALE_SEC)) confidence = 'medium';

  return {
    // 去掉浮点尾差（如 2244.4700000000003），12 位有效数字足够覆盖所有币价
    price: +Number(price).toPrecision(12),
    median: +Number(median).toPrecision(12),
    n: list.length,
    effective_n: +effN.toFixed(2),
    max_dev_pct: +maxDev.toFixed(3),
    weights: list.map((e, i) => ({ name: e.name, weight: +ws[i].toFixed(3) })),
    sources: list.map((e, i) => ({ name: e.name, price: e.price, weight: +ws[i].toFixed(3), dev_pct: devs[i] == null ? null : +devs[i].toFixed(3), age_sec: ages[i] == null ? null : Math.round(ages[i]) })),
    confidence,
    newest_age_sec: newestAge == null ? null : Math.round(newestAge),
    max_age_sec: maxAge == null ? null : Math.round(maxAge),
    stale: newestAge != null && newestAge > CG_STALE_SEC
  };
}

function priceSnapshot(db, symbols, opts) {
  const syms = (symbols && symbols.length ? symbols : W1_SYMBOLS).map(s => String(s).toUpperCase().replace(/USDT$/, ''));
  const now = Math.floor(Date.now() / 1000);
  const gate = latestGate(db, syms);
  const cg = latestCgFutures(db, syms);
  const out = {};
  for (const sym of syms) {
    const entries = [];
    if (gate[sym]) entries.push(gate[sym]);
    if (cg[sym]) entries.push(cg[sym]);
    const w = weightedPrice(entries, now);
    if (!w) { out[sym] = { symbol: sym, price: null, error: 'no_source' }; continue; }
    out[sym] = Object.assign({ symbol: sym }, w, {
      chg24: gate[sym] ? gate[sym].chg24 : (cg[sym] ? cg[sym].chg24 : null),
      high_24h: gate[sym] ? gate[sym].high_24h : null,
      low_24h: gate[sym] ? gate[sym].low_24h : null,
      // as_of 取「最新源」的时间戳（max），不是最旧源
      as_of: w.sources.reduce((m, s) => s.age_sec == null ? m : Math.max(m, now - s.age_sec), 0)
    });
  }
  return { as_of: now, symbols: out };
}

function priceLine(db, symbols) {
  const snap = priceSnapshot(db, symbols);
  const parts = [];
  for (const sym of Object.keys(snap.symbols)) {
    const s = snap.symbols[sym];
    if (!s || s.price == null) { parts.push(`${sym} —`); continue; }
    const src = s.n >= 2 ? `${s.n}源加权` : (s.sources[0] ? s.sources[0].name : '单源');
    const dev = s.max_dev_pct != null && s.n >= 2 ? ` · 偏差${s.max_dev_pct.toFixed(3)}%` : '';
    parts.push(`${sym} $${fmtPrice(s.price)}（${src}${dev} · ${fmtTime(s.as_of)}${s.stale ? ' ⚠️滞后' : ''}）`);
  }
  return parts.join('\n');
}

/* ---------------- 多空比 ---------------- */

// 纯函数：给定一行 LSR 记录，计算三种口径 + 交叉校验
function computeLsr(row) {
  if (!row) return null;
  const longN = num(row.long_notional), shortN = num(row.short_notional);
  const longT = num(row.long_traders), shortT = num(row.short_traders);
  const wl = num(row.whale_long_qty), ws = num(row.whale_short_qty);
  const ol = num(row.ov_long_qty), os = num(row.ov_short_qty);

  const ratioOf = (a, b) => (a != null && b != null && b > 0) ? a / b : null;
  const notional = ratioOf(longN, shortN);
  const account = ratioOf(longT, shortT);
  const whaleQty = ratioOf(wl, ws);
  const ovQty = ratioOf(ol, os);
  const vendor = num(row.ratio != null ? row.ratio : row.trader_ratio);

  const check = (notional != null && vendor != null && vendor > 0)
    ? Math.abs(notional - vendor) / vendor * 100 : null;
  const ovCheck = (notional != null && ovQty != null && ovQty > 0)
    ? Math.abs(notional - ovQty) / ovQty * 100 : null;

  const skew = (r) => (r == null || r < 0) ? null : (r - 1) / (r + 1);
  return {
    symbol: String(row.symbol || '').replace(/USDT$/, ''),
    notional_lsr: notional == null ? null : +notional.toFixed(4),
    account_lsr: account == null ? null : +account.toFixed(4),
    whale_qty_lsr: whaleQty == null ? null : +whaleQty.toFixed(4),
    ov_qty_lsr: ovQty == null ? null : +ovQty.toFixed(4),
    vendor_ratio: vendor == null ? null : +vendor.toFixed(4),
    cross_check_pct: check == null ? null : +check.toFixed(3),
    ov_check_pct: ovCheck == null ? null : +ovCheck.toFixed(3),
    skew_notional: skew(notional) == null ? null : +skew(notional).toFixed(4),
    skew_account: skew(account) == null ? null : +skew(account).toFixed(4),
    delta_2m: num(row.delta_2m),
    delta_30m: num(row.delta_30m),
    delta_4h: num(row.delta_4h),
    long_notional: longN, short_notional: shortN,
    long_traders: longT, short_traders: shortT,
    oi_mcap_ratio: num(row.oi_mcap_ratio)
  };
}

// 方向解读：持仓名义 + 账户数两个分母交叉
function interpretLsr(l) {
  if (!l) return '数据不足';
  const n = l.notional_lsr, a = l.account_lsr;
  if (n == null) return '数据不足';
  const sizeTxt = n < 0.8 ? '大单偏空' : n > 1.25 ? '大单偏多' : '大单均衡';
  let acctTxt = '';
  if (a != null) acctTxt = a < 0.9 ? ' · 空头账户占多数' : a > 1.1 ? ' · 多头账户占多数' : ' · 账户多空均衡';
  let divergence = '';
  if (a != null) {
    if (n < 0.8 && a > 1.1) divergence = '（分歧：大单偏空、散户偏多）';
    else if (n > 1.25 && a < 0.9) divergence = '（分歧：大单偏多、散户偏空）';
  }
  return sizeTxt + acctTxt + divergence;
}

function latestLsrRow(db, symbol) {
  const sym = String(symbol).toUpperCase().replace(/USDT$/, '');
  // 1) lsr_signals 是显式按币种请求，主流币一定有
  try {
    const r = db.prepare('SELECT ts,payload FROM lsr_signals ORDER BY ts DESC LIMIT 1').get();
    if (r) {
      const p = JSON.parse(r.payload);
      const arr = Array.isArray(p.data) ? p.data : [];
      const row = arr.find(x => String(x.symbol).toUpperCase().replace(/USDT$/, '') === sym);
      if (row) return { row, ts: num(r.ts), origin: 'lsr_signals' };
    }
  } catch (e) { /* ignore */ }
  // 2) ranking 只按 delta 排序取前 50~100，主流币可能不在榜内，仅作兜底
  for (const mode of ['trader', 'whale']) {
    try {
      const r = db.prepare('SELECT ts,payload FROM lsr_rankings WHERE mode=? ORDER BY ts DESC LIMIT 1').get(mode);
      if (!r) continue;
      const p = JSON.parse(r.payload);
      const arr = Array.isArray(p.data) ? p.data : [];
      const row = arr.find(x => String(x.symbol).toUpperCase().replace(/USDT$/, '') === sym);
      if (row) return { row, ts: num(r.ts), origin: 'lsr_rankings:' + mode };
    } catch (e) { /* ignore */ }
  }
  return null;
}

function lsrSnapshot(db, symbol) {
  const found = latestLsrRow(db, symbol);
  if (!found) return { symbol: String(symbol).toUpperCase(), error: 'not_found' };
  const l = computeLsr(found.row);
  const now = Math.floor(Date.now() / 1000);
  const age = found.ts ? Math.max(0, now - found.ts) : null;
  const conf = (age != null && age <= CG_STALE_SEC && l.cross_check_pct != null && l.cross_check_pct <= LSR_WARN_PCT) ? 'high'
    : (age != null && age <= 2 * CG_STALE_SEC) ? 'medium' : 'low';
  return Object.assign(l, {
    origin: found.origin,
    ts: found.ts,
    age_sec: age,
    stale: age != null && age > CG_STALE_SEC,
    data_warn: l.cross_check_pct != null && l.cross_check_pct > LSR_WARN_PCT,
    confidence: conf,
    interpretation: interpretLsr(l)
  });
}

// 单币 60 日 LSR 分位（口径：lsr_history.ratio = 持仓名义多空比）
// 用于把「固定阈值」换成「该币自身历史分位」，样本 <200 返回 null。
function lsrPercentile(db, symbol, days = 60) {
  const sym = String(symbol).toUpperCase().replace(/USDT$/, '') + 'USDT';
  try {
    const rows = db.prepare('SELECT ratio FROM lsr_history WHERE symbol=? AND ts>=? AND ratio>0')
      .all(sym, Math.floor(Date.now() / 1000) - days * 86400).map(r => Number(r.ratio)).filter(v => v > 0);
    if (rows.length < 200) return { n: rows.length, p5: null, p50: null, p95: null };
    rows.sort((a, b) => a - b);
    const q = (p) => rows[Math.min(rows.length - 1, Math.floor(rows.length * p))];
    return { n: rows.length, p5: +q(0.05).toFixed(4), p50: +q(0.5).toFixed(4), p95: +q(0.95).toFixed(4) };
  } catch (e) { return { n: 0, p5: null, p50: null, p95: null }; }
}

// 所有主流币的 LSR 快照（一次读 payload，避免 N 次查询）
function lsrSnapshotAll(db, symbols) {
  const syms = (symbols && symbols.length ? symbols : W1_SYMBOLS).map(s => String(s).toUpperCase().replace(/USDT$/, ''));
  const out = {};
  try {
    const r = db.prepare('SELECT ts,payload FROM lsr_signals ORDER BY ts DESC LIMIT 1').get();
    if (r) {
      const p = JSON.parse(r.payload);
      const arr = Array.isArray(p.data) ? p.data : [];
      const map = new Map(arr.map(x => [String(x.symbol).toUpperCase().replace(/USDT$/, ''), x]));
      for (const sym of syms) {
        const row = map.get(sym);
        if (row) {
          const l = computeLsr(row);
          out[sym] = Object.assign(l, { origin: 'lsr_signals', ts: num(r.ts), age_sec: Math.max(0, Math.floor(Date.now() / 1000) - num(r.ts)), interpretation: interpretLsr(l) });
        }
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

// QQ 单行：三种口径 + 30m 变化
function lsrLine(db, symbol) {
  const l = lsrSnapshot(db, symbol);
  if (l.error) return `${symbol} 多空比 —（无数据）`;
  const f = v => v == null ? '—' : v.toFixed(2);
  const d30 = l.delta_30m == null ? '' : ` · 30m ${l.delta_30m >= 0 ? '+' : ''}${(l.delta_30m * 100).toFixed(2)}%`;
  const warn = l.data_warn ? ' ⚠️口径校验超差' : '';
  return `${l.symbol} 持仓多空 ${f(l.notional_lsr)}（名义）｜账户多空 ${f(l.account_lsr)}｜大户持仓 ${f(l.whale_qty_lsr)}${d30}${warn}\n  ↳ ${l.interpretation} · ${l.origin} · ${fmtTime(l.ts)}`;
}

module.exports = {
  W1_SYMBOLS, GATE_STALE_SEC, CG_STALE_SEC, DEV_WARN_PCT, LSR_WARN_PCT,
  num, pctDiff, qualityOf, weightedPrice, priceSnapshot, priceLine,
  computeLsr, interpretLsr, lsrSnapshot, lsrSnapshotAll, lsrLine, lsrPercentile,
  latestGate, latestCgFutures, fmtTime, fmtPrice, fmtAge, fmtPct
};
