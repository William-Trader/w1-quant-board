'use strict';
// 消息面「多空权重点占比」评分框架 v1
// 设计原则：
//  1) 一条新闻拆成若干“论点”（point），每个 类别+方向 只计一次，重复关键词不再叠加（不加重）。
//  2) 权重 = 类别基础权重 × 强度 × 作用范围；单边总权重封顶，防止一条长文压过整个市场。
//  3) 规则先给结构化底稿；LLM 只做“论点识别/分类”，权重仍由本框架统一计算，模型不能直接改分。
//  4) LLM 结果按标题+正文哈希缓存，失败自动回退规则分，不阻断采集。

const crypto = require('crypto');
const { chat } = require('./ai');
const { debug, warn } = require('./log');

// 类别基础权重：货币政策 > 安全事件 > 监管 > ETF 资金 > 宏观数据 > 机构 > 交易所 > 价格行为
const CATEGORIES = {
  monetary:      { weight: 1.00, label: '货币政策' },
  security:      { weight: 0.90, label: '安全事件' },
  regulation:    { weight: 0.75, label: '监管执法' },
  etf_flow:      { weight: 0.75, label: 'ETF/资金流' },
  macro:         { weight: 0.65, label: '宏观数据' },
  institutional: { weight: 0.50, label: '机构动作' },
  exchange:      { weight: 0.50, label: '交易所动作' },
  market:        { weight: 0.20, label: '价格/技术' }
};
const MAX_SIDE_WEIGHT = 3.0;   // 单边总权重封顶，避免堆词
const MAX_POINTS = 6;          // 单条新闻最多论点

// 方向词表（只用于规则底稿，命中即一个论据，不做次数累加）
const RULES = {
  monetary: {
    bear: ['加息', '鹰派', '紧缩', '缩表', 'higher for longer', 'hawkish', 'rate hike', 'tightening'],
    bull: ['降息', '鸽派', '宽松', '放水', 'qe', 'dovish', 'rate cut', 'easing'],
    strong: ['加息', '降息', '紧急', '意外', '超预期']
  },
  security: {
    bear: ['被盗', '黑客', '攻击', '漏洞', 'exploit', 'hack', 'stolen', 'breach', 'rug', '跑路', '盗走', '安全问题', '风险事件', '异常提现', '资不抵债'],
    bull: ['追回', '冻结', '恢复', 'recovered', 'frozen'],
    strong: ['被盗', '黑客', '攻击', 'exploit', 'hack', 'stolen']
  },
  regulation: {
    bear: ['起诉', '诉讼', '罚款', '调查', '禁令', '禁止', '叫停', '下架', '处罚', 'lawsuit', 'sec sues', 'ban', 'fine'],
    bull: ['批准', '获批', '牌照', '合规', '通过', 'approval', 'approved', 'license', 'settlement'],
    strong: ['禁令', '起诉', '罚款', 'ban', 'lawsuit']
  },
  etf_flow: {
    bear: ['净流出', '流出', '减持', '赎回', 'outflow', 'redemption'],
    bull: ['净流入', '流入', '增持', '申购', 'inflow', 'purchase'],
    strong: ['净流入', '净流出', '创纪录', 'record']
  },
  macro: {
    bear: ['高于预期', '超预期', '升温', '反弹', 'hotter', 'above expectations', 'stronger than expected'],
    bull: ['低于预期', '不及预期', '降温', '放缓', 'cooler', 'below expectations', 'weaker than expected'],
    strong: ['cpi', '通胀', '非农', 'gdp', 'pce']
  },
  institutional: {
    bear: ['减持', '抛售', '清仓', '卖出', 'dump', 'sell-off'],
    bull: ['增持', '买入', '储备', '建仓', 'accumulate', 'treasury', 'buy'],
    strong: ['贝莱德', '微策略', 'mstr', 'blackrock', '主权基金']
  },
  exchange: {
    bear: ['暂停提现', '暂停充提', '下架', '宕机', '维护', 'delist', 'halt', 'outage'],
    bull: ['上线', '上架', '恢复提现', 'list', 'listing', 'resume'],
    strong: ['暂停提现', '下架', '宕机', 'delist', 'halt']
  },
  market: {
    bear: ['暴跌', '崩盘', '跳水', '跌破', '下跌', 'crash', 'plunge', 'dump'],
    bull: ['暴涨', '新高', '突破', '上涨', 'rally', 'surge', 'breakout'],
    strong: ['暴跌', '崩盘', '暴涨', '新高', 'crash', 'plunge']
  }
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function scopeOf(text) {
  const t = String(text || '').toLowerCase();
  if (/比特币|btc/.test(t)) return { scope: 'btc', mult: 0.90 };
  if (/以太坊|eth/.test(t)) return { scope: 'eth', mult: 0.90 };
  if (/山寨|altcoin|sol|doge|xrp/.test(t)) return { scope: 'alt', mult: 0.60 };
  return { scope: 'market', mult: 1.00 };
}

function strengthOf(text, cat) {
  const t = String(text || '').toLowerCase();
  const strong = RULES[cat] && RULES[cat].strong || [];
  for (const k of strong) if (t.includes(k)) return 1.0;
  return 0.75;
}

// 规则底稿：返回 points[]
function rulePoints(title, content) {
  const text = (title || '') + ' ' + String(content || '').slice(0, 600);
  const t = text.toLowerCase();
  const points = [];
  for (const cat of Object.keys(RULES)) {
    const r = RULES[cat];
    let bullHit = c => (r.bull || []).some(k => t.includes(k));
    let bearHit = c => (r.bear || []).some(k => t.includes(k));
    // 特殊：政策方向词同时出现时取程度/明确性更高的一侧，避免“加息预期降温”被误判
    if (cat === 'monetary') {
      const bearN = (r.bear || []).filter(k => t.includes(k)).length;
      const bullN = (r.bull || []).filter(k => t.includes(k)).length;
      if (!bearN && !bullN) continue;
      // 否定式政策语境：排除/推迟加息 = 偏多；排除/推迟降息 = 偏空
      const negHike = /(排除|推迟|取消|暂停|无需|不会|不大可能|概率下降|降温).{0,12}(加息|紧缩)|不加息|暂停加息/.test(t);
      const negCut = /(排除|推迟|取消|暂停|不会|不大可能|概率下降|降温).{0,12}(降息|宽松)|不降息|暂停降息/.test(t);
      let side;
      if (negHike && !negCut) side = 'bull';
      else if (negCut && !negHike) side = 'bear';
      else side = bearN >= bullN ? 'bear' : 'bull';
      points.push({ category: cat, side, strength: strengthOf(text, cat), confidence: 0.8, text: pointsText(text, r[side]) });
      continue;
    }
    if (cat === 'security' && bearHit()) {
      points.push({ category: cat, side: 'bear', strength: strengthOf(text, cat), confidence: 0.9, text: pointsText(text, r.bear) });
      continue;
    }
    if (bullHit() && !bearHit()) {
      points.push({ category: cat, side: 'bull', strength: strengthOf(text, cat), confidence: 0.7, text: pointsText(text, r.bull) });
    } else if (bearHit() && !bullHit()) {
      points.push({ category: cat, side: 'bear', strength: strengthOf(text, cat), confidence: 0.7, text: pointsText(text, r.bear) });
    }
  }
  // 价格行为不是独立利好消息：只要存在真实事件类别，就丢弃 market 论点，
  // 避免“上涨/突破”这类价格描述把多空占比拉偏（不加重价格噪声）。
  const substantive = points.filter(p => p.category !== 'market');
  return (substantive.length ? substantive : points).slice(0, MAX_POINTS);
}

function pointsText(text, keys) {
  const hit = (keys || []).find(k => String(text).toLowerCase().includes(k));
  return hit ? String(hit).slice(0, 24) : '';
}

// 统一权重计算：类别互斥、方向去重、单边封顶
function scorePoints(points, title, content, weights) {
  const sc = scopeOf((title || '') + ' ' + (content || ''));
  const best = {};
  for (const p of points || []) {
    const cat = CATEGORIES[p.category] ? p.category : 'market';
    if (p.side !== 'bull' && p.side !== 'bear') continue;
    const strength = clamp(Number(p.strength) || 0.75, 0.3, 1);
    const conf = clamp(Number(p.confidence) || 0.7, 0.3, 1);
    const baseW = (weights && weights[cat] != null) ? weights[cat] : CATEGORIES[cat].weight;
    const w = baseW * strength * conf * sc.mult;
    const key = cat + ':' + p.side;
    if (!best[key] || best[key].w < w) best[key] = { category: cat, side: p.side, w, text: p.text || '', strength, confidence: conf };
  }
  const pts = Object.values(best).sort((a, b) => b.w - a.w).slice(0, MAX_POINTS);
  let bull = pts.filter(p => p.side === 'bull').reduce((s, p) => s + p.w, 0);
  let bear = pts.filter(p => p.side === 'bear').reduce((s, p) => s + p.w, 0);
  bull = Math.min(bull, MAX_SIDE_WEIGHT);
  bear = Math.min(bear, MAX_SIDE_WEIGHT);
  const total = bull + bear;
  const share = total > 0 ? Math.round(bull / total * 1000) / 10 : null; // 多头权重点占比 %
  const score = total > 0 ? Math.round((bull - bear) / total * 1000) / 1000 : 0;
  let sentiment = 'neutral';
  if (share != null && share >= 58) sentiment = 'bullish';
  else if (share != null && share <= 42) sentiment = 'bearish';
  const top = pts[0];
  let influence = 1;
  if (top) {
    const w = top.w;
    influence = w >= 0.85 ? 5 : w >= 0.65 ? 4 : w >= 0.45 ? 3 : w >= 0.28 ? 2 : 1;
  }
  return { bull_w: +bull.toFixed(3), bear_w: +bear.toFixed(3), bull_share: share, score, sentiment, influence, points: pts, category: top ? top.category : 'market', scored_by: 'rules', scope: sc.scope };
}

function scoreRule(item, weights) {
  const points = rulePoints(item.title, item.content);
  const r = scorePoints(points, item.title, item.content, weights);
  item.sentiment = r.sentiment;
  item.influence = r.influence;
  item.bull_w = r.bull_w;
  item.bear_w = r.bear_w;
  item.bull_share = r.bull_share;
  item.score = r.score;
  item.points = JSON.stringify(r.points);
  item.category = r.category;
  item.scored_by = r.scored_by;
  return item;
}

/* ---------------- LLM 论点识别（只识别，不改权重） ---------------- */

const SYSTEM = `你是加密市场新闻拆解器。只输出 JSON，不要解释。
把新闻拆成“影响方向明确的论点”，每条论点必须属于以下类别之一：
monetary(货币政策/美联储/利率), security(黑客/被盗/漏洞), regulation(监管/诉讼/禁令/批准),
etf_flow(ETF申赎/机构资金流), macro(宏观数据), institutional(机构增持/减持),
exchange(交易所上币/下架/停机), market(价格技术面)。
返回格式：
{"points":[{"text":"简短论点","side":"bull|bear|neutral","category":"...","strength":0.3-1,"scope":"market|btc|eth|alt","confidence":0.3-1}],"importance":1-5}
要求：同类同方向只留一条最强论点；不要因为重复词增加条数；中性事件 side=neutral。`;

function cacheKey(item) {
  return crypto.createHash('sha1').update(String(item.title || '') + '\n' + String(item.content || '').slice(0, 400)).digest('hex');
}

function getCache(db, key) {
  try {
    const r = db.prepare('SELECT payload FROM news_llm_cache WHERE cache_key=?').get(key);
    return r ? JSON.parse(r.payload) : null;
  } catch (e) { return null; }
}

function setCache(db, key, payload) {
  try {
    db.prepare('INSERT OR REPLACE INTO news_llm_cache(cache_key,ts,payload) VALUES(?,?,?)')
      .run(key, Math.floor(Date.now() / 1000), JSON.stringify(payload));
  } catch (e) { /* 缓存失败不影响评分 */ }
}

function parseJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('no_json');
  return JSON.parse(s.slice(i, j + 1));
}

async function llmBatch(env, batch) {
  const lines = batch.map((it, i) => `${i + 1}. [${it.source || ''}] ${it.title || ''}｜${String(it.content || '').slice(0, 200)}`).join('\n');
  const model = env.NEWS_LLM_MODEL || 'deepseek-chat';
  const r = await chat(env, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `新闻列表：\n${lines}\n\n对每条分别返回 JSON：{"results":[{"index":1,"points":[...],"importance":1-5}]}` }
  ], model, 'news-points');
  const data = parseJson(r.text);
  return Array.isArray(data.results) ? data.results : [];
}

/**
 * 对一批新闻做 LLM 论点识别并回写 DB。失败静默回退规则分。
 * @param {object} db better-sqlite3 连接
 * @param {object} env 环境变量
 * @param {Array} items 新闻数组（需含 id/title/content/source）
 * @param {number} limit 每轮最多调用条数
 */
async function enrichWithLLM(db, env, items, limit, weights) {
  if (!env || (!env.DEEPSEEK_KEY_A && !env.DEEPSEEK_KEY_B)) return 0;
  const max = Math.max(0, Math.min(Number(limit) || 12, 24));
  if (!items || !items.length) return 0;
  // 先用缓存命中（免费），再对未命中且方向不明确的条目调用 LLM
  const todo = [];
  for (const it of items) {
    if (!it || !it.title) continue;
    const key = cacheKey(it);
    const cached = getCache(db, key);
    if (cached && Array.isArray(cached.points)) applyLLM(it, cached, weights);
    else todo.push({ it, key });
  }
  // 优先高影响、最新、且规则分接近中性的条目
  todo.sort((a, b) => (Math.abs(a.it.score || 0) < Math.abs(b.it.score || 0) ? -1 : 1)
    || (b.it.influence || 1) - (a.it.influence || 1)
    || (b.it.ts || 0) - (a.it.ts || 0));
  const picked = todo.slice(0, max);
  let done = 0;
  const BATCH = 4;
  for (let i = 0; i < picked.length; i += BATCH) {
    const batch = picked.slice(i, i + BATCH);
    try {
      const results = await llmBatch(env, batch.map(x => x.it));
      for (const row of results) {
        const idx = Number(row.index) - 1;
        const target = batch[idx];
        if (!target) continue;
        const payload = { points: Array.isArray(row.points) ? row.points : [], importance: row.importance };
        setCache(db, target.key, payload);
        applyLLM(target.it, payload, weights);
        done++;
      }
    } catch (e) {
      warn('[news-points] llm failed, keep rules:', e.message);
    }
  }
  persistScores(db, items);
  return done;
}

function persistScores(db, items) {
  try {
    const up = db.prepare('UPDATE news SET sentiment=?,influence=?,bull_w=?,bear_w=?,bull_share=?,score=?,points=?,category=?,scored_by=? WHERE id=?');
    const tx = db.transaction(() => {
      for (const it of items || []) {
        if (!it || !it.id) continue;
        up.run(it.sentiment, it.influence, it.bull_w, it.bear_w, it.bull_share, it.score, it.points, it.category, it.scored_by, it.id);
      }
    });
    tx();
  } catch (e) { /* 写入失败不阻断 */ }
}

function applyLLM(item, payload, weights) {
  const pts = (payload.points || []).filter(p => p && (p.side === 'bull' || p.side === 'bear') && CATEGORIES[p.category]);
  const r = scorePoints(pts.map(p => ({
    category: p.category,
    side: p.side,
    strength: p.strength,
    confidence: p.confidence,
    text: p.text
  })), item.title, item.content, weights);
  item.sentiment = r.sentiment;
  item.influence = clamp(Number(payload.importance) || r.influence, 1, 5);
  item.bull_w = r.bull_w;
  item.bear_w = r.bear_w;
  item.bull_share = r.bull_share;
  item.score = r.score;
  item.points = JSON.stringify(r.points);
  item.category = r.category;
  item.scored_by = 'llm';
}

/* ---------------- 聚合（供 /api/news 使用） ---------------- */
function aggregate(rows, hours) {
  const since = Math.floor(Date.now() / 1000) - (hours || 24) * 3600;
  const arr = (rows || []).filter(r => Number(r.ts) >= since);
  let bull = 0, bear = 0, weighted = 0;
  const byCat = {};
  const topPoints = [];
  for (const r of arr) {
    const b = Number(r.bull_w) || 0, s = Number(r.bear_w) || 0;
    if (!b && !s) continue;
    bull += b; bear += s;
    weighted++;
    const cat = r.category || 'market';
    const c = byCat[cat] = byCat[cat] || { category: cat, label: (CATEGORIES[cat] || CATEGORIES.market).label, bull: 0, bear: 0, count: 0 };
    c.bull += b; c.bear += s; c.count++;
    try {
      const pts = JSON.parse(r.points || '[]');
      for (const p of pts) topPoints.push({ ...p, title: r.title, ts: r.ts, source: r.source });
    } catch (e) {}
  }
  const total = bull + bear;
  const share = total > 0 ? +(bull / total * 100).toFixed(1) : null;
  topPoints.sort((a, b) => (b.w || 0) - (a.w || 0));
  return {
    hours: hours || 24,
    count: arr.length,
    scored: weighted,
    bull_weight: +bull.toFixed(2),
    bear_weight: +bear.toFixed(2),
    bull_share: share,
    bias: share == null ? 'none' : share >= 58 ? 'bullish' : share <= 42 ? 'bearish' : 'neutral',
    categories: Object.values(byCat).sort((a, b) => (b.bull + b.bear) - (a.bull + a.bear)).map(c => ({
      ...c, share: c.bull + c.bear > 0 ? +(c.bull / (c.bull + c.bear) * 100).toFixed(1) : null
    })),
    top_points: topPoints.slice(0, 12)
  };
}

module.exports = {
  CATEGORIES, MAX_SIDE_WEIGHT, rulePoints, scorePoints, scoreRule,
  enrichWithLLM, aggregate, cacheKey, parseJson, persistScores
};
