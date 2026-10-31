const { debug, info, warn } = require('./log');
'use strict';
// ═══════════════════════════════════════════════════════════
// SmartSignal Trader v1.0 — AI信号给单引擎
// 2026-08-14 William老板升级令 · 全球市场AI给单智能体
// 融合五维：消息面 × 技术面 × 资金面 × KOL共识 × 清算技术因子
// 高胜率设计：五维共振 + 动量确认 + FGI/体制/事件门控 + AI审查 + 冷却限频
// ═══════════════════════════════════════════════════════════
const { kvGet, kvSet } = require('./db');
const { updateEvo, getEvoWeights, evoStatus } = require('./tianji_evo');
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
  short_min_score: 4.0,  // 空头门槛与多头对称（2026-08-31 v2：历史放宽空头门槛=亏损主因，回测 E2 最优）
  short_qib_min: -1.0,   // 空头清算技术强约束：做空需 qibao≤-1.0（回测 G 最优：66%胜率/多空双赚/精准拦截8-28全损批）
  min_dims: 3,           // 至少3维同向（2026-08-31 回测：2维单胜率0%全砍，3维80%胜率）
  max_dims: 4,           // 最多4维同向（2026-08-31 升级：未来函数修复后重新验证，4维=强共振非拥挤，样本外OOS转正 +73U，全窗口 PF1.41；保留3维地板 min_dims=3）
  cooldown_h: 6,         // 每币每方向冷却
  daily_limit: 5,        // 每日给单上限（2026-08-27 老板指示：策略继续推单，3→5）
  daily_limit_max: 5,    // 高质量加推硬上限（基础3单满额后，质量够好+杠杆有余量可加推，最多5单）
  extra_min_score: 6.0,  // 加推质量门槛：综合分≥6 才算"质量足够好"（比 min_score 4.0 更严）
  win_streak_min: 2,     // 连胜解锁：最近结算连胜≥N 且实盘空仓 → 加推质量门槛降至 min_score（2026-08-25 William老板指令）
  min_rr: 2.0,           // 最低盈亏比（升到2.0，确保安全垫）
  atr_mult: 2.5,         // 止损 ATR 倍数（拉宽，减少被扫）
  t1_mult: 1.2,          // T1 分级落袋倍数（60%仓位先锁利）
  t2_mult: 2.4,          // T2 剩余吃波段倍数
  macro_weight: 0.2,     // 消息面权重（2026-08-29 修复词表后降为风险开关：方向一致性18→23/25，但仍只做辅助）
  tech_weight: 1.2,      // 技术面权重
  fund_weight: 0.8,      // 资金面权重（2026-08-29 回测：降权减少噪音，正分WIN率75%但负分60%不稳定）
  con_weight: 0.3,       // KOL共识权重（2026-08-29 回测：空单时负分有价值，降权防误导）
  qibao_weight: 1.6      // 清算技术因子权重（2026-08-29 回测最优：正分WIN率80%，最高权重最可靠）
};

// 止盈缓冲表（2026-08-25 指令）：差几刀没摸到止盈太亏 → 目标价微调更易摸到
// 多单目标下调、空单目标上调；未列出的币种按 现价×0.1% 缓冲
const TP_BUFFER = {
  'ETH': 3,      // ≈0.12%（用户指定：以太3点）
  'BTC': 60,     // ≈0.09%
  'SOL': 0.08,
  'BNB': 1.5,
  'XRP': 0.0012,
  'DOGE': 0.00008,
  'ADA': 0.0002,
  'LINK': 0.012,
  'XAU': 5,
};
function tpBuffer(symbol, px) {
  const b = TP_BUFFER[String(symbol || '').toUpperCase()];
  return b != null ? b : px * 0.001;
}

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
  // 周末风控已永久关闭（William 老板 2026-08-22 指令）：任何时段均放行开单
  return false;
}


/* ---------- 趋势过滤器（多周期SMA排列，宁缺毋滥，提高胜率核心） ---------- */
function trendGate(arr, direction) {
  if (!Array.isArray(arr) || arr.length < 13) return { ok: true, reason: '数据不足放宽' };
  const t = trendFilter(arr);                      // 15min/30min/1h 多级SMA排列
  // 2026-08-31 严格化（回测最优：80%胜率）：只做明确趋势排列，震荡/中性一律不开（微弱震荡不开单）
  // 做多需 15/30/60min SMA 完整多头排列，做空需完整空头排列，neutral 直接拦
  if (direction === 'long' && t !== 'long') return { ok: false, reason: t === 'neutral' ? '震荡排列不做多' : '明确空头不接多' };
  if (direction === 'short' && t !== 'short') return { ok: false, reason: t === 'neutral' ? '震荡排列不做空' : '明确多头不接空' };
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
    // 2026-08-29 修复：原表混入看空情绪词（下跌/跌破/暴跌/利空…），bearish 新闻被误翻转成 bullish，
    // 暴跌日消息面系统性给正分 → 空头信号被埋。只保留真否定词（表示"并非如此"的表述）
    const NEG = ['not', 'no ', "n't", 'unlikely', "won't", 'deny', 'denies', 'denied', '否认', '辟谣', '并非', '不再', '不会', '未现'];
    // 加密相关全局词（全局情绪只统计与加密市场相关的，去噪）
    const CRYPTO = ['crypto', 'bitcoin', 'btc', '加密', '比特币', '数字货币', '币市',
                    '区块链', '区块链', 'eth', 'ethereum', '山寨', 'altcoin', '稳定币', 'defi', 'nft'];

    // 重要影响力新闻分类（突发新闻闸门只统计这四类，2026-08-24 William老板指令）：
    // ①美联储/央行/宏观 ②加密市场 ③政治/战争/地缘 ④重大行情异动/黑天鹅/大资金
    const IMPORTANT = [
      // ① 美联储 / 央行 / 宏观
      'fed', 'federal reserve', 'powell', 'fomc', 'jackson hole', 'warsh', '美联储', '鲍威尔', '杰克逊霍尔', '沃什',
      '央行', '加息', '降息', '利率', 'cpi', '通胀', '非农', 'nfp', '美债', 'treasury', '国债', 'tariff', '关税',
      // ② 加密市场
      'crypto', 'bitcoin', 'btc', 'ethereum', 'eth', '加密', '比特币', '以太坊', '山寨', 'altcoin', '稳定币',
      'defi', 'nft', '币安', 'binance', '交易所', '现货etf', 'etf',
      // ③ 政治 / 战争 / 地缘
      'war', '战争', '冲突', '导弹', 'missile', '制裁', 'sanction', '地缘', 'geopolitic', '选举', 'election',
      '白宫', 'white house', '乌克兰', 'ukraine', '俄罗斯', 'russia', '中东', 'middle east', '伊朗', 'iran',
      '以色列', 'israel', '胡塞', 'houthi', '特朗普', 'trump',
      // ④ 重大行情异动 / 黑天鹅 / 大资金
      'crash', '闪崩', '暴跌', '暴涨', 'surge', 'plunge', '清算', 'liquidation', '爆仓', '熔断', '崩盘',
      'hack', '黑客', 'exploit', '漏洞', '破产', 'bankruptcy', '黑天鹅', 'black swan', 'whale', '巨鲸', '鲸鱼',
      'twap', 'inflow', '流入', '流出', '大额'
    ];
    function isImportantNews(t) {
      const tl = String(t || '').toLowerCase();
      return IMPORTANT.some(k => tl.includes(k));
    }

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
    // 2026-08-29 样本量修正：大样本(>50)按50条上限防稀释（BTC/ETH 常上万条新闻，情绪被摊平），
    // 小样本(<3)打0.5折（样本太少不可信，防单条新闻误判）
    const coinCap = Math.min(coinTotal, 50);
    if (coinCap >= 3) {
      coinScore = coinNet / coinCap * 2;              // 中性新闻参与分母，极端值被稀释
      // 中性占比过高 → 情绪收敛，信号打折（观望状态）
      const neutralRatio = coinNeutral / coinTotal;
      if (neutralRatio > 0.6) coinScore *= 0.5;       // 多数观望，置信度减半
    } else if (coinTotal === 2) coinScore = coinNet / 2 * 0.8;
    else if (coinTotal === 1) coinScore = coinNet * 0.6;
    if (coinTotal < 3) coinScore *= 0.5;              // 2026-08-29 小样本置信度折扣

    // 全局加密情绪联动（去噪后更纯净），归一化 ±0.5
    const globalNorm = Math.max(-0.5, Math.min(0.5, global / 40));
    const raw = coinScore + globalNorm;
    const score = Math.max(-3, Math.min(3, raw));
    // 突发检测（2026-08-24 William老板指令）：3h内 influence≥4 的情绪新闻，仅统计四类重要影响力新闻
    // 按方向拆分：真风暴=单方向密集且占比≥70%（如全利空轰炸）；多空分裂的新闻潮不算风暴
    let burstBull = 0, burstBear = 0;
    for (const n of rows) {
      if (Number(n.influence||0) >= 4 && n.sentiment !== 'neutral' && isImportantNews(n.title)) {
        if (n.sentiment === 'bullish') burstBull++; else burstBear++;
      }
    }
    const burst = burstBull + burstBear;
    return { score: +score.toFixed(2), coin: coinNet, coinTotal, global: +global.toFixed(0), burst, burstBull, burstBear, ok: rows.length > 0 };
  } catch (e) { return { score: 0, coin: 0, coinTotal: 0, global: 0, ok: false }; }
}

/* ---------- 维度2：技术面 (-3~+3) ---------- */
function techScore(db, snaps, symbol, coin) {
  try {
    const arr = priceSeries(snaps, symbol);           // 5min 价格序列（实盘快照）
    if (!arr || arr.length < 20) return { score: 0, ok: false };
    const n = arr.length;
    const last = arr[n-1];
    // ── B方案（William 2026-08-22）：4h 主趋势定方向 + 1h 确认 + 4h ATR ──
    // 每根=5min：1h=12根、4h=48根。用「前复权」取整，避免命名错位硬伤
    const B1 = 12, B4 = 48;                            // 1h / 4h 根数
    const chg1h = (last - (arr[n-1-B1] || last)) / (arr[n-1-B1] || last) * 100;   // 1h 动量（确认）
    const chg4h = (last - (arr[n-1-B4] || last)) / (arr[n-1-B4] || last) * 100;   // 4h 主趋势（定方向）
    // ATR14（4h 粒度）：在 4h 收盘价序列上算，匹配 48h 持仓周期
    const bars4h = [];
    for (let i = n-1-B4*3; i < n; i += B4) { if (arr[i] != null) bars4h.push(arr[i]); }
    if (bars4h.length < B4 && bars4h.length < 14) { const s2 = Math.max(0, n-1-B4*14); for (let i = n-1; i >= s2; i -= B4) { if (arr[i] != null) bars4h.unshift(arr[i]); } }
    let atrPct = 0.5;
    if (bars4h.length >= 2) {
      let ts = 0;
      for (let i = 1; i < bars4h.length; i++) ts += Math.abs(bars4h[i] - bars4h[i-1]);
      atrPct = (ts / (bars4h.length - 1)) / last * 100;
    }
    let score = 0;
    // 4h 主趋势：定方向（权重高）
    if (chg4h >= 0.8) score += 1.5; else if (chg4h >= 0.3) score += 0.9;
    else if (chg4h <= -0.8) score -= 1.5; else if (chg4h <= -0.3) score -= 0.9;
    // 1h 确认：同向加分、反向压制
    if (chg1h >= 0.3) score += 0.9; else if (chg1h >= 0.1) score += 0.5;
    else if (chg1h <= -0.3) score -= 0.9; else if (chg1h <= -0.1) score -= 0.5;
    // ATR 波动加成（2026-08-29 修方向 bug：原代码下跌趋势也加正分，空头技术分被抵消）
    // 趋势行情波动大，方向更可信 → 顺势方向加成：上涨 +0.6、下跌 -0.6
    if (atrPct >= 0.25 && Math.abs(chg4h) >= 0.5) score += (chg4h >= 0 ? 0.6 : -0.6);
    // 4h 强趋势动能加成（2026-08-29 下跌行情优化）：|4h变化|≥1.5% 属于明确趋势段，顺势再加强
    if (chg4h <= -1.5) score -= 0.5;
    else if (chg4h >= 1.5) score += 0.5;
    // 量能确认（v3）：放量顺势=突破有效概率较高加分，缩量逆势=假动作概率较高减分（概率辅助）
    if (coin) {
      const vol = Number(coin.volume_change_percent_24h || 0);
      const dirUp = (chg4h >= 0);
      if (Math.abs(chg4h) >= 0.3) {                 // 有明确方向才看量
        if (vol >= 30 && dirUp) score += 0.6;       // 放量上涨=真突破
        else if (vol >= 30 && !dirUp) score -= 0.6; // 放量下跌=真跌破
        else if (vol <= -20 && dirUp) score -= 0.4; // 缩量上涨=假涨乏力
        else if (vol <= -20 && !dirUp) score += 0.4;// 缩量下跌=抛压衰竭（底部特征）
      }
    }
    score = Math.max(-3, Math.min(3, score));
    return { score: +score.toFixed(2), chg15: +chg1h.toFixed(2), chg60: +chg4h.toFixed(2), chg1h: +chg1h.toFixed(2), chg4h: +chg4h.toFixed(2), atrPct: +atrPct.toFixed(3), vol: coin ? +Number(coin.volume_change_percent_24h || 0).toFixed(1) : null, ok: true };
  } catch (e) { return { score: 0, ok: false }; }
}

/* ---------- 维度3：资金面 (-3~+3) ---------- */
function fundScore(db, symbol, coin, lsr) {
  try {
    let score = 0; const d = [];
    // OI 变化：增仓上涨=吸筹(+)，增仓下跌=空头进场(-)
    const oi = Number(coin.open_interest_change_percent_24h || 0);
    const chg24 = Number(coin.price_change_percent_24h || 0);
    if (Math.abs(oi) >= 3) {
      if (oi > 0 && chg24 > 0) { score += 1.2; d.push(`OI增仓上涨(+${oi.toFixed(1)}%)`); }
      else if (oi > 0 && chg24 < 0) { score -= 1.2; d.push(`OI增仓下跌(${oi.toFixed(1)}%)`); }
      else if (oi < 0 && chg24 < 0) {
        if (chg24 <= -3) { d.push(`OI减仓但大跌(${chg24.toFixed(1)}%)，不判见底`); } // 2026-08-29 大跌中减仓≠抛压衰竭，过早抄底
        else { score += 0.6; d.push(`OI减仓抛压衰竭`); }
      }
    }
    // 费率：负费率=空头拥挤(看多+)，正费率过高=多头拥挤(看空-)
    const fund = Number(coin.avg_funding_rate_by_oi || 0) / 100; // Coinglass markets 返回百分数（0.011346=0.011346%），÷100 转小数对齐阈值（2026-08-21 修单位 bug：原百分数当小数 → 正费率多挤恒触发）
    if (fund <= -0.0003) { score += 1.0; d.push(`负费率空挤(${(fund*100).toFixed(3)}%)`); }
    else if (fund >= 0.0008) { score -= 1.0; d.push(`正费率多挤(${(fund*100).toFixed(3)}%)`); }
    // LSR：2026-10-31 校准口径
    // futures_markets.long_short_ratio_4h 是「账户多空比（OKX 4h，聚合口径）」，
    // 与回测用的 lsr_account(exchange=OKX) 同源，固定阈值 1.6/0.6 即按该口径标定；
    // 不能拿 lsr_history 的「持仓名义比」套 1.6/0.6（两者中位数差 3~10 倍）。
    // 推送层会同时展示 notional/account/whale 三口径；评分层只使用校准过的账户口径。
    try {
      const ratio = Number(coin.long_short_ratio_4h || 0);
      if (ratio > 0) {
        if (ratio >= 1.6) { score -= 1.0; d.push(`账户多空(OKX) ${ratio.toFixed(2)} 偏多反向`); }
        else if (ratio <= 0.6) { score += 1.0; d.push(`账户多空(OKX) ${ratio.toFixed(2)} 偏空反向`); }
      }
    } catch (e) {}
    score = Math.max(-3, Math.min(3, score));
    return { score: +score.toFixed(2), detail: d, ok: !!coin };
  } catch (e) { return { score: 0, detail: [], ok: false }; }
}

/* ---------- 维度4：KOL共识 (-2~+2) ---------- */
function consensusScore(db, symbol) {
  try {
    const con = store.consensusCoin(store.latestConsensus(db), symbol);
    if (!con) return { score: 0, ok: false };
    const conf = Number(con.confidence || 0);
    let s = 0;
    if (con.decision === 'long') s = Math.min(2, conf * 2.5);
    else if (con.decision === 'short') s = -Math.min(2, conf * 2.5);
    return { score: +s.toFixed(2), label: con.decision_label || con.decision, conf: +conf.toFixed(2), ok: true };
  } catch (e) { return { score: 0, ok: false }; }
}

/* ---------- 维度5：清算技术因子 (-3~+3) ---------- */
function qibaoScore(db, symbol) {
  try {
    const qibao = require('./qibao7');
    const r = qibao.listReport(db);
    const rows = r.rows || [];
    const row = rows.find(x => x.symbol === symbol);
    if (!row) return { score: 0, ok: false };
    const s = Number(row.score || 0);
    // v4 截面居中：用 8 币截面均值为零轴，消除"上涨市清算技术天然全正分"的偏多根因
    // 让强币(相对)给正分、弱币(相对)给负分，多空对称，下跌动量大的币能出做空信号
    const scores = rows.map(x => Number(x.score || 0));
    const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
    const centered = s - mean;                       // 扣除市场均值 → 相对强弱
    let score = +(centered / 33.33).toFixed(2);
    score = Math.max(-3, Math.min(3, score));
    return { score, label: row.label, raw: s, centered: +centered.toFixed(0), ok: true };
  } catch (e) { return { score: 0, ok: false }; }
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
  const snaps = futuresSnapshots(db, 288);  // 移动止损动量+技术分上采样4h（B方案需覆盖48根×5min）
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
          if (o.okx_meta && String(o.okx_meta).indexOf('followed') >= 0 && String(o.okx_meta).indexOf('externalClosed') < 0) {
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
          if (o.okx_meta && String(o.okx_meta).indexOf('followed') >= 0 && String(o.okx_meta).indexOf('externalClosed') < 0) {
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
      // T1已落袋(60%锁利)后价格回到入场 → 整单必赚（60%利润已锁定，剩余归零不亏）→ 记 WIN 不记 LOSS
      else if (isLong && px <= entry) { status = 'WIN'; reason = 'T1落袋保本离场'; pnl = 0; }
      else if (!isLong && px >= entry) { status = 'WIN'; reason = 'T1落袋保本离场'; pnl = 0; }
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
      // externalClosed（外部已平）跳过：实盘无仓，不需要平，只走信号战绩结算
      try {
        if (o.okx_meta && String(o.okx_meta).indexOf('followed') >= 0 && String(o.okx_meta).indexOf('externalClosed') < 0) {
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
      // 2026-08-31 在线进化：每笔结算后按实际结果更新五维权重（做对加码/做错降权）
      try {
        let rzEvo = null; try { rzEvo = JSON.parse(o.reasoning_json || 'null'); } catch (e) {}
        const dimsEvo = (rzEvo && rzEvo.dims) || {};
        updateEvo(db, dimsEvo, pnl, { symbol: o.symbol, direction: o.direction, status, reason });
      } catch (e) { warn('[tianji] 进化更新失败:', e.message); }
      if (status === 'LOSS' && pnl < 0) {
        // 2026-08-29 分方向熔断：多头亏损只熔断多头，不误伤空单（下跌行情空头照推）
        const dk = 'signal:dayloss:' + o.direction + ':' + new Date().toISOString().slice(0, 10);
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
function buildPlan(symbol, direction, px, atrPct, chg24) {
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
  const buf = tpBuffer(symbol, px);               // 币种止盈缓冲（多单下调/空单上调，更易摸到）
  let stop, t1, t2;
  if (direction === 'long') {
    stop = entry - stopDistCapped;
    t1 = entry + stopDistCapped * CFG.t1_mult - buf;   // T1 分级落袋（60%先锁利）
    t2 = entry + stopDistCapped * CFG.t2_mult - buf;   // T2 剩余吃波段
  } else {
    stop = entry + stopDistCapped;
    t1 = entry - stopDistCapped * CFG.t1_mult + buf;
    t2 = entry - stopDistCapped * CFG.t2_mult + buf;
  }
  // 2026-10-31 修 RR：旧代码 rr = CFG.t2_mult，但 t1/t2 被 tpBuffer 下调，
  // 实际盈亏比会小于配置倍数（虚报）。改为按真实价位重算。
  const riskDist = Math.abs(entry - stop) || 1;
  const reward2 = direction === 'long' ? (t2 - entry) : (entry - t2);
  const reward1 = direction === 'long' ? (t1 - entry) : (entry - t1);
  const rr = +(reward2 / riskDist).toFixed(2);
  const rr1 = +(reward1 / riskDist).toFixed(2);
  return { entry, stop, t1, t2, rr, rr1, stopDist: stopDistCapped };
}

/* ---------- 主扫描：SmartSignal给单 ---------- */
async function tianjiScan(ctx, opts = {}) {
  const { db, env } = ctx;
  const now = Date.now();
  // 先结算SmartSignal持仓（高胜率战绩闭环：到目标2=WIN/触止损=LOSS/超时=按盈亏了结）
  try { await resolveTianjiSignals(db, env); } catch (e) { warn('[tianji] 结算异常:', e.message); }
  // 实盘对账巡视（2026-08-25 William老板指令）：信号层一直追踪，实盘层巡视确认平
  // 实盘有仓+挂单齐全=全自动；有仓+挂单缺失=自动补挂；无仓=外部平仓自动确认结算
  try {
    const okx = require('./okx_executor');
    const rec = await okx.reconcileFollowedPositions(db, env);
    if (rec && (rec.notified > 0 || rec.repaired > 0)) {
      info(`[tianji] 实盘对账: 扫${rec.scanned}单 autoOk=${rec.autoOk} 补挂${rec.repaired} 外部平仓提示${rec.notified}`);
    }
  } catch (e) { warn('[tianji] 实盘对账异常:', e.message); }
  // 周末风控：周五美股收盘后 → 周一美股开盘前，不开单（含 force）
  if (weekendBlocked()) {
    info('[tianji] 周末风控：美股闭市窗口（周五盘后~周一盘前），不开单');
    return { skipped: true, reason: 'weekend_closure' };
  }

  // 冷却/上限（限额检查移到候选生成后——有候选时可记录被挡信号，供未来反事实分析）
  const dailyKey = 'tianji:daily:' + new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const dailyUsed = Number(kvGet(db, dailyKey, 0) || 0);

  // 连胜统计（2026-08-25 William老板指令）：最近已结算单连续 WIN 数（LOSS 打断）
  let winStreak = 0;
  try {
    const settled = db.prepare("SELECT status FROM signal_track WHERE status IN ('WIN','LOSS') AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 20").all();
    for (const r of settled) { if (r.status === 'WIN') winStreak++; else break; }
  } catch (e) {}

  const snaps = futuresSnapshots(db, 288);  // B方案：4h上采样需48根×5min，扩窗口到288(1天)
  const fut = store.latestFutures(db);
  const coins = fut && fut.data && fut.data.data;
  if (!Array.isArray(coins) || !coins.length) return { skipped: true, reason: 'no_data' };

  const candidates = [];
  let scannedCount = 0;
  // 2026-10-31：一次读取全部主流币 LSR 快照，供 fundScore 与推送共用（口径统一）
  let lsrAll = {};
  try { lsrAll = require('./precision').lsrSnapshotAll(db, WATCH); } catch (e) { warn('[tianji] lsr snapshot err:', e.message); }
  for (const coin of coins) {
    if (!WATCH.includes(coin.symbol)) continue;
    scannedCount++;
    const symbol = coin.symbol;
    const px = Number(coin.current_price);
    if (!px) continue;

    const news = newsScore(db, symbol);
    const tech = techScore(db, snaps, symbol, coin);
    const fund = fundScore(db, symbol, coin, lsrAll[symbol]);
    const con = consensusScore(db, symbol);
    const qib = qibaoScore(db, symbol);
    // 数据完整度门控：5 维里缺 2 维以上不给单（宁缺毋滥，避免半盲信号）
    const missingDims = [];
    if (!news.ok) missingDims.push('消息');
    if (!tech.ok) missingDims.push('技术');
    if (!fund.ok) missingDims.push('资金');
    if (!con.ok) missingDims.push('共识');
    if (!qib.ok) missingDims.push('清算');
    if (missingDims.length >= 2) { debug(`[tianji] ${symbol} 维度缺失(${missingDims.join(',')})，跳过`); continue; }

    // 2026-08-31 在线进化权重：初始=CFG权重，每笔结算后按实际结果自适应（做对加码/做错降权）
    const ew = getEvoWeights(db);
    const total = news.score * ew.news + tech.score * ew.tech
                + fund.score * ew.fund + con.score * ew.con
                + qib.score * ew.qibao;
    const dims = [news.score, tech.score, fund.score, con.score, qib.score];
    const posDims = dims.filter(d => d > 0.3).length;
    const negDims = dims.filter(d => d < -0.3).length;
    // 2026-08-31 拥挤交易拦截（回测：4维同向拥挤单 0% 胜率 -53.24U）：只做主流共识，不追极端拥挤
    const activeDims = dims.filter(d => Math.abs(d) > 0.05).length;
    if (CFG.max_dims && activeDims > CFG.max_dims) { debug(`[tianji] ${symbol} 维度拥挤(${activeDims}维)拦截`); continue; }

    // 综合分过滤 + 至少2维同向（2026-08-29：空头门槛行情感知——大盘下跌日放宽）
    let direction = null;
    if (total >= CFG.min_score && posDims >= CFG.min_dims) direction = 'long';
    else {
      const shortBar = CFG.short_min_score || CFG.min_score;
      // 空头 qibao 强约束（2026-08-31 v2 回测 E2 最优）：做空需清算技术因子深度看空，避免逆势乱空
      const qibOk = qib.score <= (CFG.short_qib_min != null ? CFG.short_qib_min : -1.0);
      if (total <= -shortBar && negDims >= CFG.min_dims && qibOk) direction = 'short';
    }
    if (!direction) continue;
    // 2026-08-31 体制门控升级（修复全损根因）：震荡市只放行强信号（qibao≥1.5 或 综合分≥5.5），弱信号一律不给
    // RANGE=ADX<18+布林收窄：趋势单胜率天然低，宁可错过不可做错
    try {
      const regNow = kvGet(db, 'signal:regime', null);
      const regObj = typeof regNow === 'string' ? JSON.parse(regNow) : regNow;
      if (regObj && regObj.regime === 'RANGE') {
        // 震荡市双保险：综合分≥5.5 且 清算技术因子≥1.5 才放行（qibao 是历史胜率最高维度）
        const strongEnough = Math.abs(total) >= 5.5 && Math.abs(qib.score) >= 1.5;
        if (!strongEnough) { debug(`[tianji] ${symbol} RANGE体制弱信号拦截(total=${total.toFixed(2)} qib=${qib.score})`); continue; }
      }
    } catch (e) { warn('[tianji] regime gate err:', e.message); }

    // 黄金(XAU)只做多：做空黄金历史上方向总做反，一刀切掉
    if (symbol === 'XAU' && direction === 'short') continue;
    // 2026-08-29 数据驱动战绩熔断：近3单全亏的币暂停推单（历史 XAU 5单0胜 -3.47% 拖累战绩）
    if (symbol === 'XAU') {
      const lastN = db.prepare("SELECT status FROM signal_track WHERE symbol='XAU' AND status IN ('WIN','LOSS') ORDER BY id DESC LIMIT 3").all();
      if (lastN.length >= 3 && lastN.every(r => r.status === 'LOSS')) { debug(`[tianji] ${symbol} 近3单全亏，战绩熔断暂停推单`); continue; }
    }

    // 突发新闻风险开关（v3.1 2026-08-24 William老板指令）：
    // 仅四类重要影响力新闻（美联储/加密/政治战争/重大异动）计数；方向一致风暴（单方向≥5条且占比≥70%）才避险
    const bB = news.burstBull || 0, bS = news.burstBear || 0, bT = bB + bS;
    const oneSided = bT >= 5 && Math.max(bB, bS) / Math.max(1, bT) >= 0.7;
    if (oneSided) { debug(`[tianji] ${symbol} 重要新闻方向一致风暴(${bB}多/${bS}空)，波动放大，暂停开单`); continue; }

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
    const plan = buildPlan(symbol, direction, px, tech.atrPct, chg24);
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
      missingDims,
      dimsOk: { news: !!news.ok, tech: !!tech.ok, fund: !!fund.ok, con: !!con.ok, qib: !!qib.ok },
      lsr: lsrAll[symbol] || null,
      scoreAbs: Math.abs(total),
    });
  }

  // 按 |综合分| 排序取 top3
  candidates.sort((a, b) => b.scoreAbs - a.scoreAbs);
  const top = candidates.slice(0, 3);
  if (!top.length) return { skipped: true, reason: 'no_signal', scanned: scannedCount };

  // 每日限额（有候选才检查）：满额时记录被挡候选，不推单（反事实分析数据）
  // 2026-08-25 高质量加推（William老板指令）：基础 daily_limit 满额后，
  //   若候选质量足够好（scoreAbs ≥ extra_min_score）且总杠杆有余量 → 加推模式（上限 daily_limit_max）
  let limit = CFG.daily_limit;
  // 加推模式判定：①高质量加推（≥6分）②连胜+空仓解锁（2026-08-25 William老板指令）
  let gateScore = CFG.extra_min_score;   // 本轮加推质量门槛（连胜解锁时降至 min_score）
  let extraReason = '';
  if (!opts.force && dailyUsed >= CFG.daily_limit && dailyUsed < CFG.daily_limit_max) {
    // 实盘空仓检测：跟单持仓数 = 0 → 空仓（豁免浮盈闸 + 质量门槛放宽）
    let posCount = null;
    try { const okx0 = require('./okx_executor'); posCount = await okx0.getFollowPosCount(db); } catch (e) {}
    const noPos = posCount === 0;
    const streakOk = winStreak >= CFG.win_streak_min;
    if (noPos && streakOk) {
      gateScore = CFG.min_score;
      extraReason = `连胜${winStreak}连 + 实盘空仓 → 解锁加推（质量门槛 ${CFG.min_score}）`;
    } else if (noPos && posCount !== null && posCount > 0 && winStreak > 0) {
      // 有仓但连胜中：保持高质量门槛 + 浮盈闸（有仓要看浮盈）
      extraReason = `连胜${winStreak}连但实盘仍有仓(${posCount}个)，保持高质量门槛`;
    }
    const good = top.filter(c => c.scoreAbs >= gateScore);
    if (good.length) {
      let room = false;
      try {
        const okx = require('./okx_executor');
        const eqVal = (require('./equity').calcEquity(db).equity) || 1000;
        const curN = db.prepare("SELECT COALESCE(SUM(notional_usd),0) s FROM signal_track WHERE strategy='TIANJI' AND status='OPEN'").get().s || 0;
        const maxLev = Number(okx.getMaxLev(db)) || 15;
        let riskPct = 3, posMult = 1.5;
        try { riskPct = Number(okx.getRiskPct(db)) || 3; posMult = Number(okx.getPosMult(db)) || 1.5; } catch (e) {}
        const c = good[0];
        const stopDist = Math.abs(c.plan.entry - c.plan.stop) / c.plan.entry * 100;
        const estNotional = stopDist > 0 ? Math.round(eqVal * riskPct / 100 * posMult / (stopDist / 100)) : 0;
        room = (curN + estNotional) / eqVal <= maxLev; // 总名义杠杆（含现有OPEN）≤ 最大总杠杆
        if (!room) info(`[tianji] 加推被杠杆闸挡下：当前名义 $${Math.round(curN)} + 新单 ~$${estNotional} > 净值 $${Math.round(eqVal)} × ${maxLev}x`);
      } catch (e) { warn('[tianji] 加推杠杆检查异常:', e.message); }
      // 浮盈闸：空仓豁免（无持仓浮盈概念）；有仓保持（亏损期不加码）
      if (room && !(noPos && streakOk)) {
        try {
          const okx2 = require('./okx_executor');
          const upl = await okx2.getFollowUpl(db);
          if (upl !== null && upl <= 0) {
            room = false;
            info(`[tianji] 加推被浮盈闸挡下：现有跟单浮盈 ${upl.toFixed(2)}U ≤ 0，亏损期不加码`);
          }
        } catch (e) { warn('[tianji] 加推浮盈检查异常:', e.message); }
      }
      if (room) {
        limit = CFG.daily_limit_max;
        if (noPos && streakOk) info(`[tianji] ${extraReason} + 杠杆有余量 → 连胜解锁加推（上限 ${CFG.daily_limit_max} 单）`);
        else if (extraReason) info(`[tianji] ${extraReason} + 候选≥${gateScore} + 杠杆有余量 + 浮盈为正 → 高质量加推模式（上限 ${CFG.daily_limit_max} 单）`);
        else info(`[tianji] 基础限额已满，候选质量足够（≥${CFG.extra_min_score}）+ 杠杆有余量 + 持仓浮盈为正 → 高质量加推模式（上限 ${CFG.daily_limit_max} 单）`);
      }
    }
  }
  if (!opts.force && dailyUsed >= limit) {
    const bkKey = 'tianji:blocked:' + new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    let arr = [];
    try { const v = kvGet(db, bkKey, null); arr = Array.isArray(v) ? v : (typeof v === 'string' ? JSON.parse(v) : []); } catch (e) {}
    const names = top.map(c => c.symbol + ':' + c.direction);
    for (const n of names) if (!arr.includes(n)) arr.push(n);
    kvSet(db, bkKey, JSON.stringify(arr));
    info(`[tianji] 今日已达上限 ${limit} 单（已推 ${dailyUsed}），候选被挡: ${names.join(' / ')}（已记录 tianji:blocked）`);
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
  // 2026-09-01 方案C 分层AI门控（William指令）：TREND/默认→hold放行（避免v4随机误杀强共振顺势单）
  // RANGE/STORM→hold拦截（乱市AI从严挡弱单）。veto 一律拦。仅当RANGE体制+全被hold才不推。
  let aiRegime = 'TREND';
  try { const regNow = kvGet(db, 'signal:regime', null); const ro = typeof regNow === 'string' ? JSON.parse(regNow) : regNow; if (ro && ro.regime) aiRegime = ro.regime; } catch (e) {}
  const aiStrict = (aiRegime === 'RANGE' || aiRegime === 'STORM');
  let toPush = reviewed.filter(x => {
    if (x.aiVerdict === 'agree') return true;
    if (x.aiVerdict === 'veto') return false;
    if (x.aiVerdict === 'hold') return !aiStrict;   // TREND放行 / RANGE拦截
    return !aiStrict;                               // 无判决→非RANGE放行
  });
  if (!toPush.length) return { skipped: true, reason: aiStrict ? 'ai_hold_'+aiRegime : 'ai_no_agree' };

  // 推送 + 入库 + 冷却
  let pushed = 0;
  for (const h of toPush) {
    // 加推模式（limit > 基础）：只推质量达标的候选，低分不占用加推名额
    if (limit > CFG.daily_limit && h.scoreAbs < gateScore) continue;
    if (dailyUsed + pushed >= limit) {
      info(`[tianji] 推送中已达每日上限 ${limit} 单，停止本轮`);
      break;
    }
    const ok = await pushTianji(ctx, h);
    if (ok) {
      pushed++;
      kvSet(db, 'tianji:cd:' + h.symbol + ':' + h.direction, Date.now());
      kvSet(db, dailyKey, dailyUsed + pushed);
      try {
        const dsKey = 'tianji:daily_sym:' + new Date().toLocaleDateString('en-CA', { timeZone: TZ }) + ':' + h.symbol;
        kvSet(db, dsKey, String(Number(kvGet(db, dsKey, 0) || 0) + 1));
      } catch (e) {}
    }
  }
  info(`[tianji] 扫描${scannedCount}币，候选${candidates.length}，推${pushed}单`);
  return { scanned: scannedCount, candidates: candidates.length, pushed, pushedList: toPush.map(h => h.symbol + h.direction) };
}

/* ---------- AI 审查 ---------- */
// 实时专业金融数据聚合（供 AI 审查官联网研判，2026-08-22 William 指令）
function buildMarketContext(db) {
  const ctx = {};
  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };
  // 恐慌贪婪指数
  ctx.fgi = safe(() => { const f = store.fgCurrent(db); return f ? f.value + '(' + f.classification + ')' : null; });
  // KOL 共识（偏多/偏空力度；latestConsensus 返回 {ts,data}，data 为数组）
  ctx.consensus = safe(() => {
    const c = store.latestConsensus(db);
    const arr = c && Array.isArray(c.data) ? c.data : [];
    if (!arr.length) return null;
    const parts = arr.slice(0, 8).map(x => x.display_symbol + ':' + (x.decision_label || x.decision) + '(bias ' + (Number(x.trust_adjusted_bias||0).toFixed(3)) + ')');
    return parts.join(' ');
  });
  // 资金费率（正费率=多头拥挤，取套利 summary 概览；latestFundingArb 返回 {ts,data}）
  ctx.funding = safe(() => {
    const f = store.latestFundingArb(db);
    const s = f && f.data && f.data.summary;
    if (!s) return null;
    return '正费率标的 ' + (s.positive_count || 0) + ' 个，最高套利年化 ' + (Number(s.best_apr||0).toFixed(0)) + '%(' + (s.best_symbol || '') + ')';
  });
  // 爆仓清算（24h 多空分布，跨所聚合）
  ctx.liquidation = safe(() => {
    const rows = db.prepare('SELECT exchange, payload FROM liquidation ORDER BY ts DESC LIMIT 8').all();
    if (!rows.length) return null;
    let longSum = 0, shortSum = 0;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload || '{}');
        const arr = p.data || [];
        for (const x of arr) { longSum += Number(x.long_liquidation_usd_24h || 0); shortSum += Number(x.short_liquidation_usd_24h || 0); }
      } catch (e) {}
    }
    const total = longSum + shortSum;
    if (!total) return null;
    const longPct = (longSum / total * 100).toFixed(1);
    return '24h 清算总额 $' + (total/1e6).toFixed(1) + 'M，多头占 ' + longPct + '%';
  });
  // 宏观情绪（综合风险偏好）
  ctx.macro = safe(() => {
    const r = db.prepare('SELECT payload FROM macro_indicators_cache ORDER BY ts DESC LIMIT 1').get();
    const p = r && JSON.parse(r.payload || '{}');
    return p && p.compositeState ? p.compositeState + '(' + p.composite + ')' : null;
  });
  // 最新重磅新闻（近2h高影响度 top5）
  ctx.news = safe(() => {
    const since = Math.floor(Date.now()/1000) - 2*3600;
    const rows = db.prepare('SELECT title, sentiment, influence FROM news WHERE ts>=? ORDER BY influence DESC LIMIT 5').all(since);
    return rows.length ? rows.map(x => (x.sentiment>0 ? '【利好】' : x.sentiment<0 ? '【利空】' : '【中性】') + String(x.title).slice(0,60)).join('\n') : null;
  });
  const parts = [];
  if (ctx.fgi) parts.push('恐慌贪婪指数: ' + ctx.fgi);
  if (ctx.consensus) parts.push('KOL 共识: ' + ctx.consensus);
  if (ctx.funding) parts.push('资金费率: ' + ctx.funding);
  if (ctx.liquidation) parts.push('爆仓清算: ' + ctx.liquidation);
  if (ctx.macro) parts.push('宏观情绪: ' + ctx.macro);
  if (ctx.news) parts.push('最新重磅新闻:\n' + ctx.news);
  return parts.length ? parts.join('\n') : null;
}

async function aiReview(ctx, candidates) {
  const { env, db } = ctx;
  const snap = {
    posture: (() => { try { return kvGet(db, 'signal:regime', null); } catch (e) { debug('[tianji] regime get:', e.message); return null; } })(),
  };
  const marketCtx = buildMarketContext(db);
  const list = candidates.map(c =>
    `${c.symbol} ${c.direction==='long'?'做多':'做空'} 现价$${c.px.toLocaleString('en-US',{maximumFractionDigits:2})} 综合分${c.total>=0?'+':''}${c.total} 维度[消息${c.dims.news}/技术${c.dims.tech}/资金${c.dims.fund}/共识${c.dims.con}/清算技术${c.dims.qibao}]`
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
  // 2026-08-31 William指令：5维引擎出候选 → deepseek-v4 最终研判，agree才开单
  const r = await ai.chat(env, [
    { role: 'system', content: '你是顶级交易员AI研判官（deepseek-v4）。系统5维引擎已给出候选，你担任风险哨兵做最后把关：逐单给出判决，只输出JSON数组，格式[{"symbol":"BTC","direction":"long","verdict":"agree|veto|hold","reason":"一句话中文理由"}]。agree=无逻辑硬伤予以放行；veto=存在逻辑硬伤或与当前市场体制明显冲突而否决；hold=拿不准但不构成硬伤。判决从严towards agree：只有明确的逻辑硬伤（数据/方向/风控自相矛盾、与体制空头方向冲突、事件禁做区）才veto，其余一律agree放行，不因风格保守或不确定而拦单。' },
    { role: 'user', content: `市场体制:${JSON.stringify(snap.posture)}\n【实时专业金融数据】\n${marketCtx || '(无可用实时数据)'}\n候选单（5维引擎输出）：\n${list}\n${lessonTxt}\n请最终研判，只输出JSON。` }
  ], env.TIANJI_AI_MODEL || 'deepseek-v4-flash', 'tianji-scan');
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
  const dimNames = { news: '消息', tech: '技术', fund: '资金', con: '共识', qibao: '清算技术' };
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
  // 分散化（2026-08-22 与回测同步）：每币每日 ≤1 单 + 单币并发 ≤1（防单一币种反复入场）
  // 方案A（2026-08-26 William老板指令）：同向拦截；反向放行 → 触发执行层反手（先平旧仓再开新仓），旧单结算为 FLAT(反手换仓)
  try {
    const dsKey = 'tianji:daily_sym:' + new Date().toLocaleDateString('en-CA', { timeZone: TZ }) + ':' + h.symbol;
    const openRows = db.prepare("SELECT id, direction, entry FROM signal_track WHERE strategy='TIANJI' AND status='OPEN' AND symbol=?").all(h.symbol);
    const sameDir = openRows.find(r => r.direction === h.direction);
    if (sameDir) { debug('[tianji] 分散化：' + h.symbol + ' 已有同向持仓，跳过'); return false; }
    if (openRows.length > 0) {
      // 反向持仓 → 反手场景：结算旧单（按现价估算盈亏），放行新方向（不占每日新单名额逻辑，但推单后仍计数）
      const px = Number(h.px) || Number(h.plan && h.plan.entry) || 0;
      for (const r of openRows) {
        let pnlPct = null;
        if (px > 0 && Number(r.entry) > 0) {
          pnlPct = r.direction === 'long' ? (px - r.entry) / r.entry * 100 : (r.entry - px) / r.entry * 100;
        }
        db.prepare("UPDATE signal_track SET status='FLAT', resolved_at=?, pnl_pct=?, reason='反手换仓（反向信号）', exit_reason='flip_reverse' WHERE id=?").run(Date.now(), pnlPct, r.id);
        info(`[tianji] 反手结算旧单: ${h.symbol} ${r.direction} id=${r.id} 按现价 ${px} 估算 pnl=${pnlPct == null ? 'N/A' : pnlPct.toFixed(2)}% → FLAT(反手换仓)`);
      }
    } else if (Number(kvGet(db, dsKey, 0) || 0) >= 1) {
      debug('[tianji] 分散化：' + h.symbol + ' 今日已推过 1 单，跳过');
      return false;
    }
  } catch (e) { debug('[tianji] 分散化检查异常:', e.message); }
  const long = h.direction === 'long';
  const fmt = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : v >= 10 ? v.toFixed(2) : v.toFixed(4);
  // 仓位：按综合分分档（杠杆倍数由 okx:leverage 决定）
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
  // 2026-08-22 同步：杠杆读 OKX 设置（okx:leverage=20），不再写死 50
  let lev = 20;
  try { lev = Number(require('./okx_executor').getLevSetting(db)) || 20; } catch (e) {}
  // 仓位基数：优先用 OKX 实盘可用权益（2026-08-26 William老板指令：模拟净值是虚拟的，不决定实盘仓位）
  // 实盘权益拿不到（OKX未配置/查询失败）时退回策略净值，再退回 1000 兜底
  let eqVal = 1000;
  try {
    const okx0 = require('./okx_executor');
    const st0 = await okx0.accountStatus(db);
    if (st0 && st0.connected && st0.balance) {
      eqVal = st0.balance.availEq != null ? st0.balance.availEq : st0.balance.totalEq;
    } else {
      eqVal = require('./equity').calcEquity(db).equity;
    }
  } catch (e) {
    try { eqVal = require('./equity').calcEquity(db).equity; } catch (e2) {}
  }
  // 2026-08-22 风险定仓（与回测/手动开单同口径）：notional = 净值×risk%×mult ÷ 止损距离%；50x 档位仅作名义上限
  let riskPct = 3, posMult = 1.5;
  try { const okx = require('./okx_executor'); riskPct = Number(okx.getRiskPct(db)) || 3; posMult = Number(okx.getPosMult(db)) || 1.5; } catch (e) {}
  const stopDistPct = Math.abs(h.plan.entry - h.plan.stop) / h.plan.entry * 100;
  let notional = stopDistPct > 0 ? Math.round(eqVal * riskPct / 100 * posMult / (stopDistPct / 100)) : Math.round(eqVal * posPct / 100 * lev);
  const capNotional = Math.round(eqVal * posPct / 100 * lev);
  if (notional > capNotional) notional = capNotional;
  const riskUsd = Math.max(1, Math.round(notional * Math.abs(h.plan.entry - h.plan.stop) / h.plan.entry)); // 单笔风险金额 = 名义 × 止损距离
  // 2026-10-31 精度升级：报价来源/偏差/时间
  let pxMeta = '来源未知';
  try {
    const P = require('./precision');
    const ps = P.priceSnapshot(db, [h.symbol]).symbols[h.symbol];
    if (ps && ps.price != null) pxMeta = (ps.n >= 2 ? ps.n + '源加权·偏差' + ps.max_dev_pct.toFixed(3) + '%' : '单源') + '·' + P.fmtTime(ps.as_of);
  } catch (e) { debug('[tianji] pxMeta err:', e.message); }
  // 2026-10-31 精度升级：仓位/风险必须可复算，五维缺失显式标 —，多空口径写明。
  const entryDistPct = h.px > 0 ? Math.abs(h.plan.entry - h.px) / h.px * 100 : null;
  const entryTag = entryDistPct == null ? '' : (entryDistPct <= 0.05 ? '（≈市价）' : `（限价·距现价 ${entryDistPct.toFixed(2)}%）`);
  const notionalMultiple = eqVal > 0 ? notional / eqVal : null;
  const marginUsd = lev > 0 ? Math.round(notional / lev) : null;
  const riskEquityPct = eqVal > 0 ? riskUsd / eqVal * 100 : null;
  const dimFmt = (v, ok) => ok ? `${v >= 0 ? '+' : ''}${v}` : '—';
  const dimsDone = h.dimsOk ? Object.values(h.dimsOk).filter(Boolean).length : 5;
  const lines = [
    `🧠【SmartSignal】${h.symbol} ${long ? '做多' : '做空'}｜综合分 ${h.total >= 0 ? '+' : ''}${h.total}`,
    `入场 $${fmt(h.plan.entry)}（现价 $${fmt(h.px)}）${entryTag}`,
    `📡 报价 ${pxMeta}`,
    `止损 ${fmt(h.plan.stop)}｜目标 ${fmt(h.plan.t1)} / ${fmt(h.plan.t2)}｜盈亏比 1:${h.plan.rr}（T1 1:${h.plan.rr1}）`,
    `🎯 分级平仓：到位 T1（${fmt(h.plan.t1)}）落袋60%→止损移保本；剩余40%博 T2（${fmt(h.plan.t2)}）`,
    `⚖️ ${lev}x｜名义 $${notional.toLocaleString('en-US')}（${notionalMultiple == null ? '—' : notionalMultiple.toFixed(2) + '×权益'}）｜保证金 $${marginUsd == null ? '—' : marginUsd.toLocaleString('en-US')}｜风险 $${riskUsd}（${riskEquityPct == null ? '—' : riskEquityPct.toFixed(2) + '% 权益'}）`,
    `📊 五维(${dimsDone}/5)：消息${dimFmt(h.dims.news, h.dimsOk && h.dimsOk.news)} / 技术${dimFmt(h.dims.tech, h.dimsOk && h.dimsOk.tech)} / 资金${dimFmt(h.dims.fund, h.dimsOk && h.dimsOk.fund)} / 共识${dimFmt(h.dims.con, h.dimsOk && h.dimsOk.con)} / 清算技术${dimFmt(h.dims.qibao, h.dimsOk && h.dimsOk.qibao)}`,
  ];
  if (h.lsr && h.lsr.notional_lsr != null) {
    const f2 = v => v == null ? '—' : Number(v).toFixed(2);
    lines.push(`⚖️ 多空：持仓 ${f2(h.lsr.notional_lsr)} / 账户 ${f2(h.lsr.account_lsr)} / 大户 ${f2(h.lsr.whale_qty_lsr)}（${h.lsr.interpretation}）`);
  }
  if (h.missingDims && h.missingDims.length) lines.push(`⚠️ 维度缺失：${h.missingDims.join('、')}（已按剩余维度判定）`);
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
            target1: h.plan.t1, target2: h.plan.t2, notional: notional, pos_pct: posPct, leverage: lev, ts: Date.now()
          }, null, ctx.env);
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

module.exports = { tianjiScan, tianjiStatus, resolveTianjiSignals, newsScore, techScore, fundScore, consensusScore, qibaoScore, buildPlan, WATCH, weekendBlocked, etNow, evoStatus };
