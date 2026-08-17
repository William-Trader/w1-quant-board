const { debug, info } = require('./log');
'use strict';
// ═══════════════════════════════════════════════════════════
// SmartSignal Trader v1.0 — AI信号给单引擎
// 2026-08-14 William老板升级令 · 全球市场AI给单智能体
// 融合五维：消息面 × 技术面 × 资金面 × KOL共识 × 七宝因子
// 高胜率设计：五维共振 + 动量确认 + FGI/体制/事件门控 + AI审查 + 冷却限频
// ═══════════════════════════════════════════════════════════
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const { store } = require('./store');
const { futuresSnapshots, priceSeries, fgiValue } = require('./signal');
const ai = require('./ai');

const TZ = 'Asia/Shanghai';
const MAX_HOLD_H = 48;
const WATCH = ['BTC','ETH','SOL','BNB','XRP','DOGE','LINK','ADA','XAU'];

// 币种新闻关键词映射（含中英文）
const KEYWORDS = {
  BTC: ['btc','bitcoin','比特币','大饼','crypto','数字货币','加密'],
  ETH: ['eth','ethereum','以太坊','以太'],
  SOL: ['sol','solana','索拉纳'],
  BNB: ['bnb','binance coin','币安'],
  XRP: ['xrp','ripple','瑞波'],
  DOGE: ['doge','dogecoin','狗狗币','马斯克'],
  LINK: ['link','chainlink','预言机'],
  ADA: ['ada','cardano','卡尔达诺'],
  XAU: ['xau','gold','黄金','金价','贵金属','comex']
};

const CFG = {
  min_score: 4.0,        // 综合分阈值（-9~+9），≥4 才给单
  min_dims: 3,           // 至少3个维度同向
  cooldown_h: 6,         // 每币每方向冷却
  daily_limit: 3,        // 每日给单上限（宁缺毋滥）
  min_rr: 1.5,           // 最低盈亏比
  atr_mult: 2.0,         // 止损 ATR 倍数
  macro_weight: 0.8,     // 消息面权重
  tech_weight: 1.0,      // 技术面权重
  fund_weight: 1.0,      // 资金面权重
  con_weight: 0.6,       // KOL共识权重
  qibao_weight: 1.2      // 七宝因子权重（最高）
};

/* ---------- 周末风控：美股交易时段判定（ET） ----------
 * 周五 16:00（美股收盘）后 → 周一 09:30（美股开盘）前，系统不开单
 * 覆盖周六周日全天 + 周一盘前 + 周五盘后
 */
function etNow(dt) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(dt || new Date());
  const get = (t) => { const p = parts.find(x => x.type === t); return p ? p.value : ''; };
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const h = parseInt(get('hour')) || 0;
  const m = parseInt(get('minute')) || 0;
  return { day: dayMap[get('weekday')] ?? -1, mins: h * 60 + m };
}
function weekendBlocked(dt) {
  try {
    const et = etNow(dt);
    // 周六/周日全天
    if (et.day === 6 || et.day === 0) return true;
    // 周五 16:00 ET 收盘后
    if (et.day === 5 && et.mins >= 16 * 60) return true;
    // 周一 09:30 ET 开盘前
    if (et.day === 1 && et.mins < 9 * 60 + 30) return true;
  } catch (e) { warn('[tianji] 周末风控判定异常:', e.message); }
  return false;
}

/* ---------- 维度1：消息面情绪 (-3~+3) ---------- */
function newsScore(db, symbol) {
  try {
    const kw = KEYWORDS[symbol] || [symbol.toLowerCase()];
    const since = Math.floor(Date.now()/1000) - 3*3600; // 近3h（短窗口更灵敏）
    const rows = db.prepare('SELECT title, sentiment, influence FROM news WHERE ts>=?').all(since);
    let bull = 0, bear = 0, coinBull = 0, coinBear = 0, coinTotal = 0;
    for (const n of rows) {
      const w = Number(n.influence || 1);
      const title = String(n.title || '').toLowerCase();
      const isCoin = kw.some(k => title.includes(k));
      if (n.sentiment === 'bullish') { bull += w; if (isCoin) { coinBull += w; coinTotal++; } }
      else if (n.sentiment === 'bearish') { bear += w; if (isCoin) { coinBear += w; coinTotal++; } }
    }
    const global = bull - bear;                       // 全局宏观情绪
    // 币种专属：相对强度（净情绪/总数），无专属新闻时中性
    let coinScore = 0;
    if (coinTotal >= 2) coinScore = (coinBull - coinBear) / coinTotal * 2;  // -2~+2
    else if (coinTotal === 1) coinScore = (coinBull - coinBear) * 0.8;
    // 全局仅作微弱联动（防止情绪普涨失真），并归一化到 ±0.5
    const globalNorm = Math.max(-0.5, Math.min(0.5, global / 120));
    const raw = coinScore + globalNorm;
    const score = Math.max(-3, Math.min(3, raw));
    return { score: +score.toFixed(2), coin: coinBull - coinBear, coinTotal, global: +global.toFixed(0) };
  } catch (e) { return { score: 0, coin: 0, coinTotal: 0, global: 0 }; }
}

/* ---------- 维度2：技术面 (-3~+3) ---------- */
function techScore(db, snaps, symbol) {
  try {
    const arr = priceSeries(snaps, symbol);           // 30×5min 价格序列
    if (!arr || arr.length < 20) return { score: 0 };
    const n = arr.length;
    const last = arr[n-1], prev15 = arr[n-4] || last, prev60 = arr[n-13] || last;
    const chg15 = (last - prev15) / prev15 * 100;     // 15min
    const chg60 = (last - prev60) / prev60 * 100;     // 1h
    // ATR14（5min粒度）
    let trSum = 0;
    for (let i = n-14; i < n; i++) {
      const h = Math.max(arr[i], arr[i-1] || arr[i]);
      const l = Math.min(arr[i], arr[i-1] || arr[i]);
      trSum += h - l;
    }
    const atr5 = trSum / 14;
    const atrPct = atr5 / last * 100;
    let score = 0;
    if (chg15 >= 0.3) score += 1.0; else if (chg15 >= 0.1) score += 0.5;
    else if (chg15 <= -0.3) score -= 1.0; else if (chg15 <= -0.1) score -= 0.5;
    if (chg60 >= 0.8) score += 1.2; else if (chg60 >= 0.3) score += 0.6;
    else if (chg60 <= -0.8) score -= 1.2; else if (chg60 <= -0.3) score -= 0.6;
    // ATR 波动加成：趋势行情波动大，方向更可信
    if (atrPct >= 0.25 && Math.abs(chg60) >= 0.5) score += 0.5;
    score = Math.max(-3, Math.min(3, score));
    return { score: +score.toFixed(2), chg15: +chg15.toFixed(2), chg60: +chg60.toFixed(2), atrPct: +atrPct.toFixed(3) };
  } catch (e) { return { score: 0 }; }
}

/* ---------- 维度3：资金面 (-3~+3) ---------- */
function fundScore(db, symbol, coin) {
  try {
    let score = 0; const d = [];
    // OI 变化：增仓上涨=吸筹(+)，增仓下跌=空头进场(-)
    const oi = Number(coin.open_interest_change_percent_24h || 0);
    const chg24 = Number(coin.price_change_percent_24h || 0);
    if (Math.abs(oi) >= 3) {
      if (oi > 0 && chg24 > 0) { score += 1.2; d.push(`OI增仓上涨(+${oi.toFixed(1)}%)`); }
      else if (oi > 0 && chg24 < 0) { score -= 1.2; d.push(`OI增仓下跌(${oi.toFixed(1)}%)`); }
      else if (oi < 0 && chg24 < 0) { score += 0.6; d.push(`OI减仓抛压衰竭`); }
    }
    // 费率：负费率=空头拥挤(看多+)，正费率过高=多头拥挤(看空-)
    const fund = Number(coin.avg_funding_rate_by_oi || 0); // 已转小数
    if (fund <= -0.0003) { score += 1.0; d.push(`负费率空挤(${(fund*100).toFixed(3)}%)`); }
    else if (fund >= 0.0008) { score -= 1.0; d.push(`正费率多挤(${(fund*100).toFixed(3)}%)`); }
    // LSR：散户极端反向
    try {
      const lsr = store.lsrCoin(store.latestLsr(db,'trader'), symbol);
      const ratio = lsr ? Number(lsr.ratio || 0) : 0;
      if (ratio > 0) {
        if (ratio >= 1.6) { score -= 1.0; d.push(`散户偏多(${ratio.toFixed(2)})反向`); }
        else if (ratio <= 0.6) { score += 1.0; d.push(`散户偏空(${ratio.toFixed(2)})反向`); }
      }
    } catch (e) {}
    score = Math.max(-3, Math.min(3, score));
    return { score: +score.toFixed(2), detail: d };
  } catch (e) { return { score: 0, detail: [] }; }
}

/* ---------- 维度4：KOL共识 (-2~+2) ---------- */
function consensusScore(db, symbol) {
  try {
    const con = store.consensusCoin(store.latestConsensus(db), symbol);
    if (!con) return { score: 0 };
    const conf = Number(con.confidence || 0);
    let s = 0;
    if (con.decision === 'long') s = Math.min(2, conf * 2.5);
    else if (con.decision === 'short') s = -Math.min(2, conf * 2.5);
    return { score: +s.toFixed(2), label: con.decision_label || con.decision, conf: +conf.toFixed(2) };
  } catch (e) { return { score: 0 }; }
}

/* ---------- 维度5：七宝因子 (-3~+3) ---------- */
function qibaoScore(db, symbol) {
  try {
    const qibao = require('./qibao7');
    const r = qibao.listReport(db);
    const row = (r.rows || []).find(x => x.symbol === symbol);
    if (!row) return { score: 0 };
    const s = Number(row.score || 0);
    let score = 0;
    if (s >= 35) score = 3; else if (s >= 15) score = 2; else if (s >= 5) score = 1;
    else if (s <= -35) score = -3; else if (s <= -15) score = -2; else if (s <= -5) score = -1;
    return { score, label: row.label, raw: s };
  } catch (e) { return { score: 0 }; }
}

/* ---------- 门控1：市场安全（FGI+体制） ---------- */
function marketGate(db, direction) {
  const gates = [];
  try {
    const fgi = fgiValue(db);
    if (fgi) {
      if (direction === 'long' && fgi.value >= 85) gates.push(`FGI=${fgi.value}极度贪婪不做多`);
      if (direction === 'short' && fgi.value <= 15) gates.push(`FGI=${fgi.value}极度恐惧不做空`);
    }
  } catch (e) {}
  try {
    const reg = kvGet(db, 'signal:regime', null);
    if (reg && typeof reg === 'object' && reg.regime) {
      if (reg.regime === 'STORM') gates.push('体制STORM风暴禁言');
      if (reg.regime === 'OFF') gates.push('体制OFF过渡期不给单');
    }
  } catch (e) {}
  // 事件日历：2h内 high impact 事件
  try {
    const now = Math.floor(Date.now()/1000);
    const ev = db.prepare("SELECT payload FROM economic_calendar ORDER BY ts DESC LIMIT 1").get();
    if (ev && ev.payload) {
      const p = JSON.parse(ev.payload);
      const future = p.future || [];
      const near = future.filter(x => x.ts - now < 7200 && x.ts > now && (x.impact === 'high' || x.impact === 'medium'));
      if (near.length) gates.push(`事件风险:${near[0].title_zh || near[0].title}(${near[0].impact})`);
    }
  } catch (e) {}
  return gates;
}

/* ---------- 高胜率战绩闭环：SmartSignal专属结算（v2：T1落袋 60/40 口径，2026-08-15） ---------- */
function resolveTianjiSignals(db) {
  const opens = db.prepare("SELECT * FROM signal_track WHERE strategy='TIANJI' AND status='OPEN'").all();
  if (!opens.length) return 0;
  let settled = 0;
  const now = Date.now();
  for (const o of opens) {
    const px = Number((() => {
      try {
        const fut = store.latestFutures(db);
        const coins = fut && fut.data && fut.data.data;
        const c = Array.isArray(coins) ? coins.find(x => x.symbol === o.symbol) : null;
        return c ? c.current_price : 0;
      } catch (e) { debug('[tianji] calc:', e.message); return 0; }
    })());
    if (!isFinite(px) || !px) continue;
    const isLong = o.direction === 'long';
    const entry = Number(o.entry), t1 = Number(o.target1), t2 = Number(o.target2), stop = Number(o.stop);
    if (!entry) continue;
    let status = null, reason = null, pnl = null;

    // v2: T1 落袋 — 到达目标1 → 60%落袋，止损移保本（对齐回测/实盘 60/40 口径）
    if (!o.t1_hit && t1 > 0) {
      if ((isLong && px >= t1) || (!isLong && px <= t1)) {
        db.prepare("UPDATE signal_track SET t1_hit=1, stop=entry WHERE id=?").run(o.id);
        o.t1_hit = 1; o.stop = entry; // 同步本地对象，本轮立即按落袋逻辑继续判定
        info(`[tianji] ${o.symbol} 到达目标1 → 60%落袋，止损移保本 (id=${o.id})`);
      }
    }

    // 已落袋（t1_hit）→ 判定 T2全盈 / 保本止损；未落袋 → 判定原止损
    if (o.t1_hit) {
      if (isLong && px >= t2) { status = 'WIN'; reason = '触及目标2全盈'; pnl = (t2 - entry) / entry * 100; }
      else if (!isLong && px <= t2) { status = 'WIN'; reason = '触及目标2全盈'; pnl = (entry - t2) / entry * 100; }
      else if (isLong && px <= entry) { status = 'LOSS'; reason = '保本止损'; pnl = 0; }
      else if (!isLong && px >= entry) { status = 'LOSS'; reason = '保本止损'; pnl = 0; }
    } else {
      if (isLong && px <= stop) { status = 'LOSS'; reason = '触及止损'; pnl = (stop - entry) / entry * 100; }
      else if (!isLong && px >= stop) { status = 'LOSS'; reason = '触及止损'; pnl = (entry - stop) / entry * 100; }
    }

    // 超时判定
    if (!status && now - o.pushed_at > MAX_HOLD_H * 3600 * 1000) {
      const p = isLong ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
      status = p > 0 ? 'WIN' : 'LOSS';
      reason = '超时了结';
      pnl = p;
    }

    if (status) {
      // 已部分落袋 → 最终 pnl = 60% T1收益 + 40% 剩余（保本止损剩余为0，T2全盈剩余为T2收益）
      if (o.t1_hit && t1 > 0) {
        const t1GainPct = isLong ? (t1 - entry) / entry * 100 : (entry - t1) / entry * 100;
        const restPct = (status === 'LOSS' && reason === '保本止损') ? 0 : pnl;
        pnl = 0.6 * t1GainPct + 0.4 * restPct;
      }
      db.prepare("UPDATE signal_track SET status=?, resolved_at=?, pnl_pct=?, reason=? WHERE id=?")
        .run(status, now, Number(pnl.toFixed(2)), reason, o.id);
      if (status === 'LOSS') {
        const dk = 'signal:dayloss:' + new Date().toISOString().slice(0, 10);
        kvSet(db, dk, String(Number(kvGet(db, dk, 0) || 0) + Math.abs(pnl)));
      }
      info(`[tianji] 战绩结算 ${o.symbol} ${o.direction} → ${status} (${reason}) pnl=${pnl.toFixed(2)}%`);
      settled++;
    }
  }
  return settled;
}

/* ---------- 止盈止损计划 ---------- */
function buildPlan(direction, px, atrPct, chg24) {
  const p = Number(px);
  const atr = Math.max(p * (atrPct || 0.15) / 100, p * 0.004); // ATR5min → 换算合理距离
  const stopDist = Math.max(atr * CFG.atr_mult, Math.abs(p * (chg24 || 0) / 100 * 0.35));
  const entry = p;
  let stop, t1, t2;
  if (direction === 'long') {
    stop = entry - stopDist;
    t1 = entry + stopDist * 1.5;
    t2 = entry + stopDist * 2.5;
  } else {
    stop = entry + stopDist;
    t1 = entry - stopDist * 1.5;
    t2 = entry - stopDist * 2.5;
  }
  const rr = 1.5;
  return { entry, stop, t1, t2, rr, stopDist };
}

/* ---------- 主扫描：SmartSignal给单 ---------- */
async function tianjiScan(ctx, opts = {}) {
  const { db, env } = ctx;
  const now = Date.now();
  // 先结算SmartSignal持仓（高胜率战绩闭环：到目标2=WIN/触止损=LOSS/超时=按盈亏了结）
  try { resolveTianjiSignals(db); } catch (e) { warn('[tianji] 结算异常:', e.message); }
  // 周末风控：周五美股收盘后 → 周一美股开盘前，不开单（含 force）
  if (weekendBlocked()) {
    info('[tianji] 周末风控：美股闭市窗口（周五盘后~周一盘前），不开单');
    return { skipped: true, reason: 'weekend_closure' };
  }

  // 冷却/上限
  const dailyKey = 'tianji:daily:' + new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const dailyUsed = Number(kvGet(db, dailyKey, 0) || 0);
  if (!opts.force && dailyUsed >= CFG.daily_limit) {
    debug(`[tianji] 今日已达上限 ${CFG.daily_limit}，跳过`);
    return { skipped: true, reason: 'daily_limit' };
  }

  const snaps = futuresSnapshots(db, 30);
  const fut = store.latestFutures(db);
  const coins = fut && fut.data && fut.data.data;
  if (!Array.isArray(coins) || !coins.length) return { skipped: true, reason: 'no_data' };

  const candidates = [];
  let scannedCount = 0;
  for (const coin of coins) {
    if (!WATCH.includes(coin.symbol)) continue;
    scannedCount++;
    const symbol = coin.symbol;
    const px = Number(coin.current_price);
    if (!px) continue;

    const news = newsScore(db, symbol);
    const tech = techScore(db, snaps, symbol);
    const fund = fundScore(db, symbol, coin);
    const con = consensusScore(db, symbol);
    const qib = qibaoScore(db, symbol);

    const total = news.score * CFG.macro_weight + tech.score * CFG.tech_weight
                + fund.score * CFG.fund_weight + con.score * CFG.con_weight
                + qib.score * CFG.qibao_weight;
    const dims = [news.score, tech.score, fund.score, con.score, qib.score];
    const posDims = dims.filter(d => d > 0.3).length;
    const negDims = dims.filter(d => d < -0.3).length;

    // 综合分过滤 + 至少3维同向
    let direction = null;
    if (total >= CFG.min_score && posDims >= CFG.min_dims) direction = 'long';
    else if (total <= -CFG.min_score && negDims >= CFG.min_dims) direction = 'short';
    if (!direction) continue;

    // 动量确认（防逆势接刀）：做多需15min/1h为正，做空需为负
    if (direction === 'long' && tech.chg15 < -0.05 && tech.chg60 < -0.1) continue;
    if (direction === 'short' && tech.chg15 > 0.05 && tech.chg60 > 0.1) continue;

    // 市场门控
    const gates = marketGate(db, direction);
    if (gates.length) { debug(`[tianji] ${symbol} 被门控: ${gates.join(';')}`); continue; }

    // 冷却检查
    const cdKey = 'tianji:cd:' + symbol + ':' + direction;
    const lastPush = Number(kvGet(db, cdKey, 0) || 0);
    if (!opts.force && now - lastPush < CFG.cooldown_h * 3600 * 1000) continue;

    const chg24 = Number(coin.price_change_percent_24h || 0);
    const plan = buildPlan(direction, px, tech.atrPct, chg24);
    candidates.push({
      symbol, direction, px, plan, total: +total.toFixed(2),
      dims: { news: news.score, tech: tech.score, fund: fund.score, con: con.score, qibao: qib.score },
      newsDetail: { coin: news.coin, global: news.global },
      fundDetail: fund.detail, conLabel: con.label, qibLabel: qib.label,
      tech: { chg15: tech.chg15, chg60: tech.chg60 },
      scoreAbs: Math.abs(total),
    });
  }

  // 按 |综合分| 排序取 top3
  candidates.sort((a, b) => b.scoreAbs - a.scoreAbs);
  const top = candidates.slice(0, 3);
  if (!top.length) return { skipped: true, reason: 'no_signal', scanned: scannedCount };

  // AI 审查（一票否决制，失败降级只推 top1）
  let reviewed = top;
  try {
    reviewed = await aiReview(ctx, top);
  } catch (e) {
    warn('[tianji] AI审查失败，降级只推 top1:', e.message);
    reviewed = top.slice(0, 1);
  }
  const toPush = reviewed.filter(x => x.aiVerdict !== 'veto');
  if (!toPush.length) return { skipped: true, reason: 'ai_veto' };

  // 推送 + 入库 + 冷却
  let pushed = 0;
  for (const h of toPush) {
    const ok = await pushTianji(ctx, h);
    if (ok) {
      pushed++;
      kvSet(db, 'tianji:cd:' + h.symbol + ':' + h.direction, Date.now());
      kvSet(db, dailyKey, dailyUsed + pushed);
    }
  }
  info(`[tianji] 扫描${scannedCount}币，候选${candidates.length}，推${pushed}单`);
  return { scanned: scannedCount, candidates: candidates.length, pushed, pushedList: toPush.map(h => h.symbol + h.direction) };
}

/* ---------- AI 审查 ---------- */
async function aiReview(ctx, candidates) {
  const { env, db } = ctx;
  const snap = {
    posture: (() => { try { return kvGet(db, 'signal:regime', null); } catch (e) { debug('[tianji] regime get:', e.message); return null; } })(),
  };
  const list = candidates.map(c =>
    `${c.symbol} ${c.direction==='long'?'做多':'做空'} 现价$${c.px.toLocaleString('en-US',{maximumFractionDigits:2})} 综合分${c.total>=0?'+':''}${c.total} 维度[消息${c.dims.news}/技术${c.dims.tech}/资金${c.dims.fund}/共识${c.dims.con}/七宝${c.dims.qibao}]`
  ).join('\n');
  const r = await ai.chat(env, [
    { role: 'system', content: '你是顶级交易员AI审查官。对候选交易逐单给出判决，只输出JSON数组，格式[{"symbol":"BTC","direction":"long","verdict":"agree|veto|hold","reason":"一句话中文理由"}]。agree=认可可推，veto=否决，hold=观望。只有逻辑硬伤才veto，普通不确定用hold。' },
    { role: 'user', content: `市场体制:${JSON.stringify(snap.posture)}\n候选单：\n${list}\n请审查。` }
  ], 'deepseek-chat');
  let parsed = [];
  try { parsed = JSON.parse(r.text.replace(/```json|```/g, '').trim()); } catch (e) { debug('[tianji] ai parse:', e.message); parsed = []; }
  if (!Array.isArray(parsed) || !parsed.length) return candidates;
  return candidates.map(c => {
    const v = parsed.find(x => String(x.symbol).toUpperCase() === c.symbol);
    if (v) c.aiVerdict = v.verdict || 'hold';
    return c;
  });
}

/* ---------- 推送 ---------- */
async function pushTianji(ctx, h) {
  const { env, db } = ctx;
  const long = h.direction === 'long';
  const fmt = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : v >= 10 ? v.toFixed(2) : v.toFixed(4);
  // 仓位：按综合分分档（50x换算）
  let posPct = 3;
  if (h.scoreAbs >= 7) posPct = 8;
  else if (h.scoreAbs >= 5.5) posPct = 5;
  const fgi = fgiValue(db);
  if (fgi && fgi.value <= 30) posPct = Math.round(posPct * 0.5 * 10) / 10; // FGI恐惧折扣5折
  const lev = 50;
  const lines = [
    `🧠【SmartSignal】${h.symbol} ${long ? '做多' : '做空'}｜综合分 ${h.total >= 0 ? '+' : ''}${h.total}`,
    `入场 $${fmt(h.plan.entry)}（现价 $${fmt(h.px)}）`,
    `止损 $${fmt(h.plan.stop)}｜目标 $${fmt(h.plan.t1)} / $${fmt(h.plan.t2)}｜盈亏比 1:${h.plan.rr}`,
    `⚖️ ${lev}x杠杆：建议 ${posPct}% 仓位（=${(posPct * 0.5).toFixed(1)}x杠杆）｜单笔风险≤1%`,
    `📊 五维：消息${h.dims.news>=0?'+':''}${h.dims.news} / 技术${h.dims.tech>=0?'+':''}${h.dims.tech} / 资金${h.dims.fund>=0?'+':''}${h.dims.fund} / 共识${h.dims.con>=0?'+':''}${h.dims.con} / 七宝${h.dims.qibao>=0?'+':''}${h.dims.qibao}`,
  ];
  if (h.fundDetail && h.fundDetail.length) lines.push(`💸 资金信号：${h.fundDetail.join(' · ')}`);
  if (h.newsDetail && (h.newsDetail.coin || h.newsDetail.global)) {
    lines.push(`📰 消息面：币种${h.newsDetail.coin>=0?'+':''}${h.newsDetail.coin} / 宏观${h.newsDetail.global>=0?'+':''}${h.newsDetail.global}`);
  }
  if (h.aiVerdict === 'agree') lines.push('🤖 AI审查：✅ 认可');
  lines.push('⚠️ 仅供研究参考，不构成投资建议');
  const msg = lines.join('\n');
  const ok = await pushToGroup(env, db, msg);
  if (ok) {
    try {
      db.prepare(`INSERT INTO signal_track
        (symbol, direction, entry, stop, target1, target2, rr, pos_pct, msg, status, pushed_at, strategy, strategy_id, leverage, notional_usd, risk_usd)
        VALUES (?,?,?,?,?,?,?,?,?, 'OPEN', ?, 'TIANJI', 'tianji-v1', ?, ?, ?)`)
        .run(h.symbol, h.direction, h.plan.entry, h.plan.stop, h.plan.t1, h.plan.t2,
             h.plan.rr, posPct, msg, Date.now(), lev, posPct * 100, posPct * 1);
      info(`[tianji] SmartSignal单入库: ${h.symbol} ${h.direction} score=${h.total}`);
    } catch (e) { warn('[tianji] 入库失败:', e.message); }
  }
  return ok;
}

/* ---------- 状态/战绩 ---------- */
function tianjiStatus(db) {
  let win = 0, loss = 0, open = 0;
  try {
    const rows = db.prepare("SELECT status, pnl_pct FROM signal_track WHERE strategy='TIANJI'").all();
    for (const r of rows) {
      if (r.status === 'WIN') win++;
      else if (r.status === 'LOSS') loss++;
      else if (r.status === 'OPEN') open++;
    }
  } catch (e) {}
  const total = win + loss;
  return {
    enabled: true, win, loss, open, total,
    winRate: total ? +(win / total * 100).toFixed(1) : null,
    pushedToday: Number(kvGet(db, 'tianji:daily:' + new Date().toLocaleDateString('en-CA', { timeZone: TZ }), 0) || 0),
    cooldownH: CFG.cooldown_h, dailyLimit: CFG.daily_limit
  };
}

module.exports = { tianjiScan, tianjiStatus, resolveTianjiSignals, newsScore, techScore, fundScore, consensusScore, qibaoScore, buildPlan, WATCH, weekendBlocked, etNow };
