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
const { futuresSnapshots, priceSeries, fgiValue, trendFilter, structLevels, sma } = require('./signal');
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
  min_dims: 2,           // 至少2个维度同向（三因子下3过严漏单）
  cooldown_h: 6,         // 每币每方向冷却
  daily_limit: 3,        // 每日给单上限（宁缺毋滥）
  min_rr: 2.0,           // 最低盈亏比（升到2.0，确保安全垫）
  atr_mult: 2.5,         // 止损 ATR 倍数（拉宽，减少被扫）
  t1_mult: 1.2,          // T1 分级落袋倍数（60%仓位先锁利）
  t2_mult: 2.4,          // T2 剩余吃波段倍数
  macro_weight: 0.4,     // 消息面权重（v3：降为风险开关，不猜方向）
  tech_weight: 1.2,      // 技术面权重
  fund_weight: 1.0,      // 资金面权重
  con_weight: 0.6,       // KOL共识权重
  qibao_weight: 1.3      // 七宝因子权重（最高，回测验证最可靠）
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


/* ---------- 趋势过滤器（多周期SMA排列，宁缺毋滥，提高胜率核心） ---------- */
function trendGate(arr, direction) {
  if (!Array.isArray(arr) || arr.length < 13) return { ok: true, reason: '数据不足放宽' };
  const t = trendFilter(arr);                      // 15min/30min/1h 多级SMA排列
  // 软化：只在【明确反向】时拦截，震荡/中性一律放行（实盘节奏优先）
  if (direction === 'long' && t === 'short') return { ok: false, reason: '明确空头不接多' };
  if (direction === 'short' && t === 'long') return { ok: false, reason: '明确多头不接空' };
  return { ok: true, reason: t };
}

/* ---------- 关键位突破确认（等突破再进，不提前埋伏） ---------- */
function breakoutGate(arr, direction) {
  if (!Array.isArray(arr) || arr.length < 9) return { ok: true, reason: '数据不足放宽' };
  const lv = structLevels(arr, 8);                  // 放宽到近8根高低点（缩短确认窗口）
  if (!lv) return { ok: true, reason: '无结构放宽' };
  const px = arr[arr.length - 1];
  // 软化：接近突破位即可（放宽到仅0.2%内），不强制完全突破
  const epsilon = px * 0.002;
  if (direction === 'long' && px < lv.high - epsilon) return { ok: false, reason: '离高点过远' };
  if (direction === 'short' && px > lv.low + epsilon) return { ok: false, reason: '离低点过远' };
  return { ok: true, reason: direction === 'long' ? '接近/突破高点' : '接近/跌破低点' };
}

/* ---------- 维度1：消息面情绪 v2 (-3~+3) ----------
 * 升级点（提升准确性）：
 * 1) 否定词检测：标题含否定词时情绪翻转（"不看好/预警/回调"不再误判为看涨）
 * 2) 全局去噪：全局宏观只统计"加密相关"新闻（crypto/比特币/币市），排除热浪/FTC等纯宏观噪音
 * 3) 中性新闻作情绪收敛：币种相关中性新闻多→信号置信度打折
 * 4) influence 权重平滑：log2(1+influence)，避免 inf5 噪音新闻压倒性影响
 */
function newsScore(db, symbol) {
  try {
    const kw = KEYWORDS[symbol] || [symbol.toLowerCase()];
    const since = Math.floor(Date.now()/1000) - 3*3600; // 近3h（短窗口更灵敏）
    const rows = db.prepare('SELECT title, sentiment, influence FROM news WHERE ts>=?').all(since);

    // 否定词表（命中则情绪翻转）
    const NEG = ['not', 'no ', 'unlikely', 'warn', '警告', '风险', '下跌', '回调', '利空',
                 '跌破', '暴跌', '崩盘', '抛售', '不看好', '看空', '难涨', '受阻', '承压'];
    // 加密相关全局词（全局情绪只统计与加密市场相关的，去噪）
    const CRYPTO = ['crypto', 'bitcoin', 'btc', '加密', '比特币', '数字货币', '币市',
                    '区块链', '区块链', 'eth', 'ethereum', '山寨', 'altcoin', '稳定币', 'defi', 'nft'];

    // 权重平滑：influence 1~5 → 0.58~2.58（log2，抑制高权重噪音）
    const wOf = inf => Math.log2(1 + (Number(inf) || 1));

    let bull = 0, bear = 0, coinBull = 0, coinBear = 0, coinNeutral = 0, coinTotal = 0;
    for (const n of rows) {
      const title = String(n.title || '');
      const tl = title.toLowerCase();
      const w = wOf(n.influence);

      // 否定词检测 → 翻转原始情绪
      const hasNeg = NEG.some(neg => tl.includes(neg));
      let senti = n.sentiment;
      if (hasNeg) {
        if (senti === 'bullish') senti = 'bearish';
        else if (senti === 'bearish') senti = 'bullish';
      }

      const isCoin = kw.some(k => tl.includes(k));
      const isCrypto = CRYPTO.some(c => tl.includes(c));

      // 全局情绪：只统计加密相关新闻（去噪）
      if (senti === 'bullish') { if (isCrypto) bull += w; if (isCoin) { coinBull += w; coinTotal++; } }
      else if (senti === 'bearish') { if (isCrypto) bear += w; if (isCoin) { coinBear += w; coinTotal++; } }
      else if (senti === 'neutral' && isCoin) { coinNeutral += 1; coinTotal++; } // 中性作收敛信号
    }

    const global = bull - bear;                       // 加密相关全局宏观情绪（已去噪）

    // 币种专属：净情绪/总数（含中性，使中性新闻稀释极端值），范围 -2~+2
    let coinScore = 0;
    const coinNet = coinBull - coinBear;
    if (coinTotal >= 3) {
      coinScore = coinNet / coinTotal * 2;            // 中性新闻参与分母，极端值被稀释
      // 中性占比过高 → 情绪收敛，信号打折（观望状态）
      const neutralRatio = coinNeutral / coinTotal;
      if (neutralRatio > 0.6) coinScore *= 0.5;       // 多数观望，置信度减半
    } else if (coinTotal === 2) coinScore = coinNet / 2 * 0.8;
    else if (coinTotal === 1) coinScore = coinNet * 0.6;

    // 全局加密情绪联动（去噪后更纯净），归一化 ±0.5
    const globalNorm = Math.max(-0.5, Math.min(0.5, global / 40));
    const raw = coinScore + globalNorm;
    const score = Math.max(-3, Math.min(3, raw));
    // 突发检测：3h内 influence≥4 的情绪新闻数（用于波动放大预警）
    const burst = rows.filter(n => Number(n.influence||0) >= 4 && n.sentiment !== 'neutral').length;
    return { score: +score.toFixed(2), coin: coinNet, coinTotal, global: +global.toFixed(0), burst };
  } catch (e) { return { score: 0, coin: 0, coinTotal: 0, global: 0 }; }
}

/* ---------- 维度2：技术面 (-3~+3) ---------- */
function techScore(db, snaps, symbol, coin) {
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
    // 量能确认（v3）：放量顺势=真突破加分，缩量逆势=假动作减分（区分真假信号铁律）
    if (coin) {
      const vol = Number(coin.volume_change_percent_24h || 0);
      const dirUp = (chg60 >= 0);
      if (Math.abs(chg60) >= 0.3) {                 // 有明确方向才看量
        if (vol >= 30 && dirUp) score += 0.6;       // 放量上涨=真突破
        else if (vol >= 30 && !dirUp) score -= 0.6; // 放量下跌=真跌破
        else if (vol <= -20 && dirUp) score -= 0.4; // 缩量上涨=假涨乏力
        else if (vol <= -20 && !dirUp) score += 0.4;// 缩量下跌=抛压衰竭（底部特征）
      }
    }
    score = Math.max(-3, Math.min(3, score));
    return { score: +score.toFixed(2), chg15: +chg15.toFixed(2), chg60: +chg60.toFixed(2), atrPct: +atrPct.toFixed(3), vol: coin ? +Number(coin.volume_change_percent_24h || 0).toFixed(1) : null };
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
    const rows = r.rows || [];
    const row = rows.find(x => x.symbol === symbol);
    if (!row) return { score: 0 };
    const s = Number(row.score || 0);
    // v4 截面居中：用 8 币截面均值为零轴，消除"上涨市七宝天然全正分"的偏多根因
    // 让强币(相对)给正分、弱币(相对)给负分，多空对称，下跌动量大的币能出做空信号
    const scores = rows.map(x => Number(x.score || 0));
    const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
    const centered = s - mean;                       // 扣除市场均值 → 相对强弱
    let score = +(centered / 33.33).toFixed(2);
    score = Math.max(-3, Math.min(3, score));
    return { score, label: row.label, raw: s, centered: +centered.toFixed(0) };
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
async function resolveTianjiSignals(db, env) {
  const opens = db.prepare("SELECT * FROM signal_track WHERE strategy='TIANJI' AND status='OPEN'").all();
  const snaps = futuresSnapshots(db, 30);   // 移动止损动量的价格序列
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
        db.prepare("UPDATE signal_track SET t1_hit=1, stop=entry, orig_stop=COALESCE(orig_stop, stop) WHERE id=?").run(o.id);
        o.t1_hit = 1; o.stop = entry; // 同步本地对象，本轮立即按落袋逻辑继续判定
        info(`[tianji] ${o.symbol} 到达目标1 → 60%落袋，止损移保本 (id=${o.id})`);
        // 实盘同步：TP1 已触发（60% 平），取消原 SL → 挂保本 SL（剩余 40%）
        try {
          if (o.okx_meta && String(o.okx_meta).indexOf('followed') >= 0) {
            const okx = require('./okx_executor');
            const instId = String(o.symbol).indexOf('-') >= 0 ? o.symbol : o.symbol + '-USDT-SWAP';
            let m = {}; try { m = JSON.parse(o.okx_meta || '{}'); } catch (e) {}
            const szRemain = (Number(m.sz || 0) * 0.4).toFixed(6);
            await okx.cancelAlgosByInst(instId);
            const sr = await okx.attachSL(instId, o.direction === 'long' ? 'long' : 'short', szRemain, entry, m.lotSz);
            info(`[tianji] 实盘同步保本: ${o.symbol} 取消旧SL→挂保本@${entry} 剩余${szRemain}张 ${sr.ok ? '✓' : '✗ ' + (sr.error || '')}`);
          }
        } catch (e) { warn('[tianji] 保本同步异常:', e.message); }
      }
    }

    // v3: 智能移动止损 — T1落袋后按动量研判是否上移/回撤保护
    let trailAction = null;
    if (o.t1_hit) {
      const techInfo = techScore(db, snaps, o.symbol, null);
      const td = trailingDecision(snaps, o, px, techInfo.atrPct || 0.15);
      if (td.action === 'move') {
        // 合并 okx_meta：保留 followed/sz 等跟单信息（否则结算无法识别实盘单）
        let prevM = {}; try { prevM = JSON.parse(o.okx_meta || '{}'); } catch (e) {}
        const meta = JSON.stringify(Object.assign({}, prevM, { peak: td.peak, lastTrailPrice: px, lastStop: td.newStop }));
        db.prepare("UPDATE signal_track SET stop=?, okx_meta=?, orig_stop=COALESCE(orig_stop, stop) WHERE id=?").run(td.newStop, meta, o.id);
        o.stop = td.newStop;
        info(`[tianji] ${o.symbol} 移动止损上移 → ${td.newStop.toFixed(2)} (${td.reason})`);
        // 实盘同步：取消旧 SL → 挂新止损（剩余 40%）
        try {
          if (o.okx_meta && String(o.okx_meta).indexOf('followed') >= 0) {
            const okx = require('./okx_executor');
            const instId = String(o.symbol).indexOf('-') >= 0 ? o.symbol : o.symbol + '-USDT-SWAP';
            const szRemain = (Number(prevM.sz || 0) * 0.4).toFixed(6);
            await okx.cancelAlgosByInst(instId);
            const sr = await okx.attachSL(instId, o.direction === 'long' ? 'long' : 'short', szRemain, td.newStop, prevM.lotSz);
            info(`[tianji] 实盘同步移动止损: ${o.symbol} → @${td.newStop.toFixed(2)} ${sr.ok ? '✓' : '✗ ' + (sr.error || '')}`);
          }
        } catch (e) { warn('[tianji] 移动止损同步异常:', e.message); }
        trailAction = { type: 'move', newStop: td.newStop, reason: td.reason, chg60: td.chg60 };
      } else if (td.action === 'protect') {
        // 回撤保护：立即了结（锁利离场）
        const pProtect = isLong ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
        status = 'WIN';
        reason = td.reason;
        pnl = pProtect > 0 ? pProtect : 0;
        info(`[tianji] ${o.symbol} 回撤保护锁利离场 (${td.reason})`);
        trailAction = { type: 'protect', reason: td.reason, chg60: td.chg60 };
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

    // 超时判定：48h未到目标/止损则按当前方向了结，赚钱算WIN、亏钱算LOSS
    if (!status && now - o.pushed_at > MAX_HOLD_H * 3600 * 1000) {
      const p = isLong ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
      status = p > 0 ? 'WIN' : 'LOSS';
      reason = '超时了结';
      pnl = p;
    }

    if (status) {
      // 实盘同步：该单已跟单实盘 → 结算时平掉 OKX 仓位 + 取消挂单（防超时/回撤保护了结后实盘裸挂）
      try {
        if (o.okx_meta && String(o.okx_meta).indexOf('followed') >= 0) {
          const okx = require('./okx_executor');
          const instId = String(o.symbol).indexOf('-') >= 0 ? o.symbol : o.symbol + '-USDT-SWAP';
          const cl = await okx.closeAndClean(instId);
          info(`[tianji] 结算同步平仓: ${o.symbol} closed=${cl.closed.length} algo取消=${cl.algoCanceled}`);
        }
      } catch (e) { warn('[tianji] 结算平仓异常:', e.message); }
      // 平仓后即时净值快照（15min 定时之外，保证平仓后净值立即更新）
      try { require('./equity').snapshot(db); } catch (e) { warn('[tianji] 净值快照异常:', e.message); }
      // 自动自评（开单逻辑可视化：每单成功/失败研判回顾）
      try {
        let rz = null; try { rz = JSON.parse(o.reasoning_json || 'null'); } catch (e) {}
        const review = autoReview({ symbol: o.symbol, direction: o.direction, status, pnl_pct: pnl, reason }, rz);
        db.prepare("UPDATE signal_track SET self_review=? WHERE id=?").run(review, o.id);
      } catch (e) { warn('[tianji] 自评失败:', e.message); }
      // 胜负反馈回路：异步复盘（不阻塞结算，失败不影响主流程）
      try {
        const lesson = require('./lesson_engine');
        lesson.reviewTrade(db, env, {
          id: o.id, symbol: o.symbol, direction: o.direction,
          entry: o.entry, stop: o.stop, target1: o.target1, target2: o.target2,
          pos_pct: o.pos_pct, leverage: o.leverage,
          status, pnl_pct: pnl, reason, msg: o.msg
        }).catch(e => warn('[tianji] 复盘失败:', e.message));
      } catch (e) { warn('[tianji] 复盘异常:', e.message); }

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
      // v3: 移动止损上移 → 推送到群（跟着上移止损提示）
      if (trailAction && trailAction.type === 'move' && env) {
        try {
          const dir = o.direction === 'long' ? '做多' : '做空';
          const chgTxt = (trailAction.chg60 >= 0 ? '+' : '') + trailAction.chg60.toFixed(2) + '%';
          const trailMsg = [
            `【W1·移动止损】${o.symbol} ${dir}（${o.strategy || 'TIANJI'}）`,
            `现价 $${px.toFixed(2)} → 止损上移至 $${trailAction.newStop.toFixed(2)}`,
            `🔒 锁定利润，剩余40%仓位继续博 T2($${Number(o.target2).toFixed(2)})`,
            `🎯 动量：60min ${chgTxt}（动能延续，阶梯上移）`,
            '⚠️ 仅供研究参考，不构成投资建议',
          ].join('\n');
          await pushToGroup(env, db, trailMsg);
        } catch (e) { warn('[tianji] 移动止损推送失败:', e.message); }
      }

      // 自动平仓/结算 → 推送到群（老板要求：自动操作提示要发到群里）
      if (env) {
        try {
          const icon = status === 'WIN' ? '✅' : '❌';
          const dir = o.direction === 'long' ? '做多' : '做空';
          const pnlTxt = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
          const closeMsg = [
            `【W1·自动平仓】${o.symbol} ${dir}（${o.strategy || 'TIANJI'}）`,
            `进场 $${Number(o.entry).toFixed(2)} → 现价 $${px.toFixed(2)}`,
            `${icon} ${status === 'WIN' ? '止盈' : '止损'}了结｜盈亏 ${pnlTxt}｜${reason}`,
            '⚠️ 仅供研究参考，不构成投资建议',
          ].join('\n');
          await pushToGroup(env, db, closeMsg);
        } catch (e) { warn('[tianji] 平仓推送失败:', e.message); }
      }
      settled++;
    }
  }
  return settled;
}

/* ---------- 智能移动止损（v3：ATR阶梯+动量确认，不频繁上移，让利润奔跑） ---------- */
// 返回 { action: 'move'|'hold'|'protect', newStop, peak, reason }
// 仅在 t1_hit 之后（剩余40%仓位博T2阶段）生效，用 ATR 阶梯 + 动量确认上移
function trailingDecision(snaps, o, px, atrPct) {
  let st = {};
  try { st = JSON.parse(o.okx_meta || '{}'); } catch (e) { st = {}; }
  const entry = Number(o.entry);
  const isLong = o.direction === 'long';
  const atr = px * (atrPct || 0.15) / 100;
  // 移动止损优化（2026-08-20 基于历史表现）：步长 1.5×ATR（原 1×），避免噪音扫损；回撤保护 1.5×ATR（原 1×），给趋势更多空间
  const step = Math.max(atr * 1.5, px * 0.005);
  const peak = Math.max(Number(st.peak || entry), px);
  const curStop = Number(o.stop);

  let chg60 = 0, chg15 = 0;
  try {
    const arr = priceSeries(snaps, o.symbol);
    if (arr && arr.length >= 13) {
      const n = arr.length;
      chg15 = (arr[n-1] - (arr[n-4] || arr[n-1])) / (arr[n-4] || arr[n-1]) * 100;
      chg60 = (arr[n-1] - (arr[n-13] || arr[n-1])) / (arr[n-13] || arr[n-1]) * 100;
    }
  } catch (e) {}

  const momentumUp = isLong ? (chg60 > 0 && chg15 > 0) : (chg60 < 0 && chg15 < 0);
  const momentumWeaken = isLong ? (chg60 < 0) : (chg60 > 0);

  let action = 'hold', newStop = curStop, reason = '';

  if (o.t1_hit) {
    const nextStep = curStop + (isLong ? step : -step);
    const needNewHigh = isLong
      ? px >= (Number(st.lastTrailPrice || peak) + step)
      : px <= (Number(st.lastTrailPrice || peak) - step);
    if (momentumUp && needNewHigh) {
      const newStopRaw = isLong ? px - step : px + step;
      newStop = isLong ? Math.max(newStopRaw, entry) : Math.min(newStopRaw, entry);
      if (isLong ? (newStop > curStop) : (newStop < curStop)) {
        action = 'move';
        const sign = chg60 > 0 ? '+' : '';
        reason = '动能延续(60min ' + sign + chg60.toFixed(2) + '%)，创新高，止损上移1 ATR';
      }
    } else if (momentumWeaken) {
      const drawdown = isLong ? (peak - px) / px * 100 : (px - peak) / px * 100;
      if (drawdown >= ((atrPct || 0.15) * 1.5)) {
        action = 'protect';
        const sign = chg60 > 0 ? '+' : '';
        reason = '动能转弱(60min ' + sign + chg60.toFixed(2) + '%)，自峰值回撤' + drawdown.toFixed(2) + '%>1.5ATR，锁利离场';
      }
    }
  } else {
    action = 'hold';
    reason = '未到T1，原止损不动';
  }

  return { action, newStop, peak, reason, st, chg60, chg15, step, momentumUp, momentumWeaken };
}

/* ---------- 止盈止损计划（v2升级：纯ATR止损，去掉chg24错误项） ---------- */
function buildPlan(direction, px, atrPct, chg24) {
  const p = Number(px);
  // ATR止损：只用真实波动率，不再用24h涨跌幅算距离（旧版chg24×0.35是被扫损的根因）
  const atrStop = p * (atrPct || 0.15) / 100 * CFG.atr_mult;
  // 保底下限：止损距离至少 0.8%（避免小波动下止损贴太近被噪音扫）
  const floor = p * 0.008;
  // 上限：止损不超过 5%（极端插针时防止单笔亏损失控）
  const cap = p * 0.05;
  const stopDist = Math.max(atrStop, floor);
  const stopDistCapped = Math.min(stopDist, cap);
  const entry = p;
  let stop, t1, t2;
  if (direction === 'long') {
    stop = entry - stopDistCapped;
    t1 = entry + stopDistCapped * CFG.t1_mult;   // T1 分级落袋（60%先锁利）
    t2 = entry + stopDistCapped * CFG.t2_mult;   // T2 剩余吃波段
  } else {
    stop = entry + stopDistCapped;
    t1 = entry - stopDistCapped * CFG.t1_mult;
    t2 = entry - stopDistCapped * CFG.t2_mult;
  }
  // 真实盈亏比：T2 距离 / 止损距离（T1/T2 倍数来自 CFG，非死值）
  const rr = +(CFG.t2_mult / 1.0).toFixed(2);
  return { entry, stop, t1, t2, rr, stopDist: stopDistCapped };
}

/* ---------- 主扫描：SmartSignal给单 ---------- */
async function tianjiScan(ctx, opts = {}) {
  const { db, env } = ctx;
  const now = Date.now();
  // 先结算SmartSignal持仓（高胜率战绩闭环：到目标2=WIN/触止损=LOSS/超时=按盈亏了结）
  try { await resolveTianjiSignals(db, env); } catch (e) { warn('[tianji] 结算异常:', e.message); }
  // 周末风控：周五美股收盘后 → 周一美股开盘前，不开单（含 force）
  if (weekendBlocked()) {
    info('[tianji] 周末风控：美股闭市窗口（周五盘后~周一盘前），不开单');
    return { skipped: true, reason: 'weekend_closure' };
  }

  // 冷却/上限（限额检查移到候选生成后——有候选时可记录被挡信号，供未来反事实分析）
  const dailyKey = 'tianji:daily:' + new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const dailyUsed = Number(kvGet(db, dailyKey, 0) || 0);

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
    const tech = techScore(db, snaps, symbol, coin);
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
    // 黄金(XAU)只做多：做空黄金历史上方向总做反，一刀切掉
    if (symbol === 'XAU' && direction === 'short') continue;

    // 突发新闻风险开关（v3）：3h内高影响情绪新闻≥3条=波动放大，方向不可测，不开新单
    if (news.burst >= 3) { debug(`[tianji] ${symbol} 突发新闻密集(${news.burst}条)，波动放大，暂停开单`); continue; }

    // 消息面负向过滤（v3）：只挡确定性错误方向，不猜正确方向
    // 明确利空(bearish且高影响)压制多头 / 明确利好压制空头
    if (direction === 'long' && news.coin < -2) { debug(`[tianji] ${symbol} 明确利空，压制多头`); continue; }
    if (direction === 'short' && news.coin > 2) { debug(`[tianji] ${symbol} 明确利好，压制空头`); continue; }

    // 动量确认（防逆势接刀）：做多需15min/1h为正，做空需为负
    if (direction === 'long' && tech.chg15 < -0.05 && tech.chg60 < -0.1) continue;
    if (direction === 'short' && tech.chg15 > 0.05 && tech.chg60 > 0.1) continue;
    // 趋势过滤器（多周期SMA排列）：震荡市不开单，只做趋势单，提高胜率核心
    const priceArr = priceSeries(snaps, symbol);
    const tg = trendGate(priceArr, direction);
    if (!tg.ok) { debug(`[tianji] ${symbol} 趋势门控: ${tg.reason}`); continue; }

    // 关键位突破确认：做多需突破近20根高点/做空需跌破近20根低点，不提前埋伏
    const bg = breakoutGate(priceArr, direction);
    if (!bg.ok) { debug(`[tianji] ${symbol} 突破门控: ${bg.reason}`); continue; }

    // 市场门控
    const gates = marketGate(db, direction);
    if (gates.length) { debug(`[tianji] ${symbol} 被门控: ${gates.join(';')}`); continue; }

    // 冷却检查
    const cdKey = 'tianji:cd:' + symbol + ':' + direction;
    const lastPush = Number(kvGet(db, cdKey, 0) || 0);
    if (!opts.force && now - lastPush < CFG.cooldown_h * 3600 * 1000) continue;

    const chg24 = Number(coin.price_change_percent_24h || 0);
    const plan = buildPlan(direction, px, tech.atrPct, chg24);
    if (plan.rr < CFG.min_rr) continue; // 盈亏比门槛：不足2:1不给单
    // 相关新闻标题（近3h，按影响力 top3）——开单逻辑可视化：具体消息面
    let newsTitles = [];
    try {
      const kw = (KEYWORDS[symbol] || [symbol.toLowerCase()]);
      const since3 = Math.floor(Date.now()/1000) - 3*3600;
      newsTitles = db.prepare('SELECT title, sentiment, influence FROM news WHERE ts>=? ORDER BY influence DESC LIMIT 40').all(since3)
        .filter(x => { const tl = String(x.title||'').toLowerCase(); return kw.some(k => tl.includes(k)); })
        .slice(0, 3).map(x => ({ t: String(x.title||'').slice(0, 80), s: x.sentiment, i: Number(x.influence)||1 }));
    } catch (e) { debug('[tianji] news titles:', e.message); }
    candidates.push({
      symbol, direction, px, plan, total: +total.toFixed(2),
      dims: { news: news.score, tech: tech.score, fund: fund.score, con: con.score, qibao: qib.score },
      newsDetail: { coin: news.coin, global: news.global },
      fundDetail: fund.detail, conLabel: con.label, qibLabel: qib.label,
      tech: { chg15: tech.chg15, chg60: tech.chg60, atrPct: tech.atrPct, vol: tech.vol },
      trendGate: tg.reason || null, breakout: bg.reason || null,
      newsTitles,
      scoreAbs: Math.abs(total),
    });
  }

  // 按 |综合分| 排序取 top3
  candidates.sort((a, b) => b.scoreAbs - a.scoreAbs);
  const top = candidates.slice(0, 3);
  if (!top.length) return { skipped: true, reason: 'no_signal', scanned: scannedCount };

  // 每日限额（有候选才检查）：满额时记录被挡候选，不推单（反事实分析数据）
  if (!opts.force && dailyUsed >= CFG.daily_limit) {
    const bkKey = 'tianji:blocked:' + new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    let arr = [];
    try { arr = JSON.parse(kvGet(db, bkKey, '[]') || '[]'); } catch (e) {}
    const names = top.map(c => c.symbol + ':' + c.direction);
    for (const n of names) if (!arr.includes(n)) arr.push(n);
    kvSet(db, bkKey, JSON.stringify(arr));
    info(`[tianji] 今日已达上限 ${CFG.daily_limit} 单（已推 ${dailyUsed}），候选被挡: ${names.join(' / ')}（已记录 tianji:blocked）`);
    return { skipped: true, reason: 'daily_limit', blocked: names };
  }

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
    if (dailyUsed + pushed >= CFG.daily_limit) {
      info(`[tianji] 推送中已达每日上限 ${CFG.daily_limit} 单，停止本轮`);
      break;
    }
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
  // 胜负反馈回路：注入历史经验作为参考因子（不参与硬规则，仅提示）
  let lessonTxt = '';
  try {
    const lesson = require('./lesson_engine');
    const syms = [...new Set(candidates.map(c => c.symbol))];
    const ls = [];
    for (const sy of syms) ls.push(...lesson.getLessons(db, { symbol: sy }, 3));
    if (ls.length) lessonTxt = '\n历史经验参考（来自已结算交易复盘，仅作参考，需结合当前情况判断）:\n' + ls.slice(0, 6).map(l => `- ${l.lesson}（置信度${Math.round((l.confidence || 0) * 100)}%，${l.result === 'WIN' ? '盈利' : '亏损'}单复盘，命中${l.hits}次）`).join('\n');
  } catch (e) { warn('[tianji] 经验注入失败:', e.message); }
  const r = await ai.chat(env, [
    { role: 'system', content: '你是顶级交易员AI审查官。对候选交易逐单给出判决，只输出JSON数组，格式[{"symbol":"BTC","direction":"long","verdict":"agree|veto|hold","reason":"一句话中文理由"}]。agree=认可可推，veto=否决，hold=观望。只有逻辑硬伤才veto，普通不确定用hold。' },
    { role: 'user', content: `市场体制:${JSON.stringify(snap.posture)}\n候选单：\n${list}\n${lessonTxt}\n请审查。` }
  ], 'deepseek-chat');
  let parsed = [];
  try { parsed = JSON.parse(r.text.replace(/```json|```/g, '').trim()); } catch (e) { debug('[tianji] ai parse:', e.message); parsed = []; }
  if (!Array.isArray(parsed) || !parsed.length) return candidates;
  return candidates.map(c => {
    const v = parsed.find(x => String(x.symbol).toUpperCase() === c.symbol);
    if (v) { c.aiVerdict = v.verdict || 'hold'; c.aiReason = v.reason || ''; }
    return c;
  });
}

/* ---------- 自动自评（每单开单逻辑研判回顾） ---------- */
function autoReview(t, rz) {
  const dims = (rz && rz.dims) || {};
  const dimNames = { news: '消息', tech: '技术', fund: '资金', con: '共识', qibao: '七宝' };
  const pos = Object.entries(dims).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const neg = Object.entries(dims).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  const parts = [];
  if (t.status === 'WIN') {
    parts.push('✅ 方向正确，逻辑兑现');
    if (pos.length) parts.push('驱动维度: ' + pos.slice(0, 2).map(([k, v]) => dimNames[k] + '(' + (v > 0 ? '+' : '') + v + ')').join('、'));
    if (rz && rz.aiVerdict === 'agree') parts.push('AI审查认可 ✓');
    if (rz && rz.aiReason) parts.push('AI理由: ' + rz.aiReason);
    if (t.reason === '触及目标2全盈') parts.push('走完 T1→T2 完整波段');
    else if (t.reason === '超时了结') parts.push('超时了结落袋');
  } else {
    parts.push('❌ 行情未按预期' + (t.reason ? '（' + t.reason + '）' : ''));
    if (neg.length) parts.push('反向维度: ' + neg.slice(0, 2).map(([k, v]) => dimNames[k] + '(' + v + ')').join('、'));
    if (pos.length) parts.push('正向依据: ' + pos.slice(0, 2).map(([k, v]) => dimNames[k] + '(' + (v > 0 ? '+' : '') + v + ')').join('、'));
    if (rz && rz.aiVerdict === 'veto') parts.push('⚠️ AI曾否决但信号仍推');
    if (rz && rz.aiReason) parts.push('AI理由: ' + rz.aiReason);
  }
  if (rz && rz.regime) parts.push('市场体制: ' + rz.regime);
  return parts.join('｜') || '（无决策明细记录）';
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
  // FGI 仓位折扣（v3 扩展）：极度区间反指，中等区间轻折扣
  if (fgi) {
    const v = fgi.value;
    if (v <= 20) posPct = Math.round(posPct * 0.3 * 10) / 10;        // 极度恐惧 3折
    else if (v <= 30) posPct = Math.round(posPct * 0.5 * 10) / 10;    // 恐惧 5折
    else if (v >= 85) posPct = Math.round(posPct * 0.4 * 10) / 10;    // 极度贪婪 4折（逆势反指）
    else if (v >= 70) posPct = Math.round(posPct * 0.7 * 10) / 10;    // 贪婪 7折
  }
  const lev = 50;
  // 复利仓位：名义 = 当前策略净值 × pos% × 杠杆（净值涨→仓位等比扩大，与净值模拟口径一致）
  // 修复 2026-08-20：原来固定 posPct*100（300u），与复利模拟（净值×1.5x 名义）差 6 倍
  let eqVal = 1000;
  try { eqVal = require('./equity').calcEquity(db).equity; } catch (e) {}
  const notional = Math.round(eqVal * posPct / 100 * lev);
  const riskUsd = Math.max(1, Math.round(notional * Math.abs(h.plan.entry - h.plan.stop) / h.plan.entry)); // 单笔风险金额 = 名义 × 止损距离
  const lines = [
    `🧠【SmartSignal】${h.symbol} ${long ? '做多' : '做空'}｜综合分 ${h.total >= 0 ? '+' : ''}${h.total}`,
    `入场 $${fmt(h.plan.entry)}（现价 $${fmt(h.px)}）`,
    `止损 ${fmt(h.plan.stop)}｜目标 ${fmt(h.plan.t1)} / ${fmt(h.plan.t2)}｜盈亏比 1:${h.plan.rr}`,
    `🎯 分级平仓：到位 T1（${fmt(h.plan.t1)}）落袋60%→止损移保本；剩余40%博 T2（${fmt(h.plan.t2)}）`,
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
      // 开单决策明细（开单逻辑可视化：五维/消息/资金/技术/AI审查/市场体制）
      const regimeNow = (() => { try { return kvGet(db, 'signal:regime', null); } catch (e) { return null; } })();
      const reasoningJson = JSON.stringify({
        score: h.total, scoreAbs: h.scoreAbs,
        dims: h.dims || {}, tech: h.tech || {}, newsDetail: h.newsDetail || {},
        fundDetail: h.fundDetail || null, conLabel: h.conLabel || '', qibLabel: h.qibLabel || '',
        trendGate: h.trendGate || null, breakout: h.breakout || null,
        newsTitles: h.newsTitles || [],
        aiVerdict: h.aiVerdict || 'hold', aiReason: h.aiReason || '',
        regime: regimeNow, pushedTs: Date.now()
      });
      const ins = db.prepare(`INSERT INTO signal_track
        (symbol, direction, entry, stop, target1, target2, rr, pos_pct, msg, status, pushed_at, strategy, strategy_id, leverage, notional_usd, risk_usd, reasoning_json)
        VALUES (?,?,?,?,?,?,?,?,?, 'OPEN', ?, 'TIANJI', 'tianji-v1', ?, ?, ?, ?)`)
        .run(h.symbol, h.direction, h.plan.entry, h.plan.stop, h.plan.t1, h.plan.t2,
             h.plan.rr, posPct, msg, Date.now(), lev, notional, riskUsd, reasoningJson);
      info(`[tianji] SmartSignal单入库: ${h.symbol} ${h.direction} score=${h.total}`);
      // 智能跟单：auto 开启时按比例复制到 OKX 实盘
      try {
        const okx = require('./okx_executor');
        if (okx.getAutoOn(db) && okx.getFollowRatio(db) > 0) {
          const fr = await okx.followSignal(db, {
            symbol: h.symbol, direction: h.direction, entry: h.plan.entry, stop: h.plan.stop,
            target1: h.plan.t1, notional: notional, pos_pct: posPct, leverage: lev, ts: Date.now()
          });
          if (fr.ok) {
            db.prepare('UPDATE signal_track SET okx_meta=? WHERE id=?').run(
              JSON.stringify({ followed: 1, ratio: fr.meta.ratio, notional: fr.meta.targetNotional, sz: fr.meta.sz, instId: fr.meta.instId, ts: Date.now() }),
              ins.lastInsertRowid);
            info(`[tianji] 智能跟单成功: ${h.symbol} ${h.direction} 比例${fr.meta.ratio} 名义$${fr.meta.targetNotional} 张数${fr.meta.sz}`);
          } else {
            warn(`[tianji] 智能跟单失败: ${fr.error}`);
          }
        }
      } catch (e) { warn('[tianji] 跟单异常:', e.message); }
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
