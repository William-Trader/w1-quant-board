'use strict';
const { warn } = require('./log');
/**
 * lib/hero_brief.js — 自研「今日主要观点」生成器
 * 逆向 openclue hero_brief 结构后重构：
 *   tone / subject / headline_zh|en / quote_zh|en / template / chart_key / stance_pills
 * 架构（三层）：
 *   1. 规则骨架 buildSkeleton —— 确定性：tone / template / pills / chart_key
 *   2. DeepSeek 文案 generate —— AI 润色 headline + quote（复刻 openclue 文风，数据更全更新）
 *   3. 模板兜底 fallbackText —— AI 挂掉时绝不空白
 * 缓存表 hero_brief_self(date PK, payload, ts, source) —— 每天生成一次
 * 回档：env HERO_SELF_MODE=openclue 时整体退回 openclue hero_brief
 */
const ai = require('./ai');

const TZ = 'Asia/Shanghai';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hero_brief_self (
    date TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL
  )`);
}

/** 读当天缓存（同步，供 snapshot 用）；无则 null */
function getToday(db) {
  try {
    ensureTable(db);
    const r = db.prepare('SELECT payload FROM hero_brief_self WHERE date=? ORDER BY ts DESC LIMIT 1').get(today());
    return r ? JSON.parse(r.payload) : null;
  } catch (e) { debug('[hero_brief] get:', e.message); return null; }
}

/** 规则骨架：tone / template / pills / chart_key / flips */
function buildSkeleton(snap) {
  const s = Number((snap.posture && snap.posture.score) ?? 0);
  const stances = snap.stances || [];
  const bull = stances.filter(x => (x.stance || '').includes('bullish')).length;
  const bear = stances.filter(x => (x.stance || '').includes('bearish')).length;
  const inp = (snap.posture && snap.posture.inputs) || snap.inputs || {};

  // ---- tone：姿态分 + 立场分布 + FGI 修正（恐慌区不喊多） ----
  let tone;
  if (s <= -1.2 || (bear >= 6 && s < 0)) tone = 'bearish';
  else if (s >= 1.2 || (bull >= 6 && s > 0)) tone = 'bullish';
  else if (s <= -0.5) tone = 'cautious';
  else if (s >= 0.5) tone = 'cautious';
  else tone = 'mixed';
  if (tone === 'bullish' && (inp.fgi ?? 50) < 35) tone = 'cautious';

  // ---- 信号池（每个信号 = {tone, zh, en}） ----
  const sig = [];
  const fgi = inp.fgi ?? null, fgiD = inp.fgi_7d_delta ?? null;
  if (fgi != null) sig.push(fgi <= 35 ? { tone: 'cautious', zh: `FGI ${fgi} 仍处恐慌区`, en: `FGI ${fgi}, still fearful` }
    : fgi >= 65 ? { tone: 'bullish', zh: `FGI ${fgi} 情绪偏热`, en: `FGI ${fgi}, hot` }
    : { tone: 'mixed', zh: `FGI ${fgi} 中性${fgi < 50 ? '偏冷' : '偏暖'}`, en: `FGI ${fgi} neutral` });
  if (fgiD != null && fgiD >= 5) sig.push({ tone: 'bullish', zh: `恐慌情绪缓解（7日 +${fgiD}）`, en: `Fear easing (+${fgiD} in 7d)` });
  if (fgiD != null && fgiD <= -5) sig.push({ tone: 'bearish', zh: `情绪再度转冷（7日 ${fgiD}）`, en: `Sentiment cooling (${fgiD} in 7d)` });

  const fund = inp.funding_avg ?? null;
  if (fund != null) sig.push(Math.abs(fund) >= 0.0005
    ? { tone: 'bearish', zh: `资金费率过热（${(fund * 100).toFixed(2)}%）`, en: `Funding hot (${(fund * 100).toFixed(2)}%)` }
    : Math.abs(fund) < 0.0003 ? { tone: 'bullish', zh: '资金费率健康', en: 'Funding healthy' }
    : { tone: 'mixed', zh: '资金费率中性', en: 'Funding neutral' });

  const oi = inp.oi_change_24h ?? null;
  if (oi != null) sig.push(oi >= 2 ? { tone: 'bullish', zh: `持仓回升 +${oi.toFixed(1)}%，新资金进场`, en: `OI +${oi.toFixed(1)}%, fresh leverage` }
    : oi <= -2 ? { tone: 'bearish', zh: `OI ${oi.toFixed(1)}%，仍在去杠杆`, en: `OI ${oi.toFixed(1)}%, deleveraging` }
    : { tone: 'mixed', zh: `OI ${oi >= 0 ? '+' : ''}${oi.toFixed(1)}%`, en: `OI ${oi >= 0 ? '+' : ''}${oi.toFixed(1)}%` });

  const etf = inp.etf_recent3_musd ?? null;
  if (etf != null) sig.push(etf > 0 ? { tone: 'bullish', zh: `ETF 近3日净流入 ${etf.toFixed(0)}M 美元`, en: `ETF +${etf.toFixed(0)}M last 3d` }
    : etf < 0 ? { tone: 'bearish', zh: `ETF 近3日净流出 ${Math.abs(etf).toFixed(0)}M 美元`, en: `ETF ${etf.toFixed(0)}M last 3d` }
    : { tone: 'mixed', zh: 'ETF 流入趋平', en: 'ETF flows flat' });

  const px = inp.price_change_24h ?? null;
  if (px != null && Math.abs(px) >= 2) sig.push(px > 0 ? { tone: 'bullish', zh: `主流币 24h +${px.toFixed(1)}%`, en: `24h +${px.toFixed(1)}%` }
    : { tone: 'bearish', zh: `主流币 24h ${px.toFixed(1)}%`, en: `24h ${px.toFixed(1)}%` });

  const lst = inp.lsr_trader_skew ?? null;
  if (lst != null && Math.abs(lst) >= 0.3) sig.push(lst > 0 ? { tone: 'bullish', zh: '散户多空偏多', en: 'Retail long skew' }
    : { tone: 'bearish', zh: '散户多空偏空', en: 'Retail short skew' });
  const lsw = inp.lsr_whale_skew ?? null;
  if (lsw != null && Math.abs(lsw) >= 0.3) sig.push(lsw > 0 ? { tone: 'bullish', zh: '大户多空偏多', en: 'Whale long skew' }
    : { tone: 'bearish', zh: '大户多空偏空', en: 'Whale short skew' });

  const cyc = inp.cycle_valuation ?? null;
  if (cyc != null && cyc >= 2) sig.push({ tone: 'bearish', zh: `周期估值偏高（${cyc.toFixed(1)}）`, en: `Cycle valuation rich (${cyc.toFixed(1)})` });

  // ---- 立场变化（对比昨日） ----
  const flips = [];
  if (snap.prevDaily) {
    try {
      const prev = JSON.parse(snap.prevDaily.stances_json || '[]');
      for (const st of stances) {
        const p = prev.find(x => x.symbol === st.symbol);
        if (p && p.stance !== st.stance) flips.push(`${st.symbol} ${p.stance}→${st.stance}`);
      }
    } catch (e) { debug('[hero_brief] ignore:', e.message); }
  }

  // ---- template：inflection 转向 / contrast 对比 / continuation 延续 ----
  let template = 'continuation';
  if (flips.length >= 2) template = 'inflection';
  else {
    const pos = sig.filter(x => x.tone === 'bullish').length;
    const neg = sig.filter(x => x.tone === 'bearish').length;
    if (pos > 0 && neg > 0) template = 'contrast';
    else if (pos >= 3 || neg >= 3) template = 'inflection';
  }

  // ---- pills：最多 3 条，tone 尽量多样（先按强度排序再平衡） ----
  const byW = { bullish: 3, bearish: 3, cautious: 2, mixed: 1 };
  const sorted = sig.slice().sort((a, b) => (byW[b.tone] || 0) - (byW[a.tone] || 0));
  const chosen = [];
  const seenTones = new Set();
  for (const x of sorted) {
    if (chosen.length >= 3) break;
    if (!seenTones.has(x.tone) || chosen.length < 2) { chosen.push(x); seenTones.add(x.tone); }
  }
  let k = 0;
  while (chosen.length < 3 && k < sorted.length) {
    const x = sorted[k++];
    if (x && !chosen.includes(x)) chosen.push(x);
  }

  return {
    tone, template, chart_key: 'stance_distribution',
    flips, pills: chosen, stance: { bull, bear }, score: s,
    // 前端兼容 openclue 结构：stance_pills = [{tone,label_zh,label_en}]
    stance_pills: chosen.map(p => ({ tone: p.tone, label_zh: p.zh, label_en: p.en }))
  };
}

/** 模板兜底（AI 挂掉时用，保证结构完整 + 带明确方向） */
function fallbackText(sk) {
  const p0 = sk.pills[0] || { zh: '市场延续既有节奏', en: 'market continues' };
  const p1 = sk.pills[1] || { zh: '等待数据进一步确认', en: 'awaiting confirmation' };
  // 依据姿态分给方向：≤-1.2 看跌 / ≥1.2 看涨 / 其余按多空分布
  let dirZh = '中性', dirEn = 'neutral', dir = '中性';
  if (sk.score <= -1.2 || (sk.stance.bear >= 6 && sk.score < 0)) { dirZh = '看跌'; dirEn = 'bearish'; dir = '看跌'; }
  else if (sk.score >= 1.2 || (sk.stance.bull >= 6 && sk.score > 0)) { dirZh = '看涨'; dirEn = 'bullish'; dir = '看涨'; }
  else if (sk.score < -0.3) { dirZh = '偏空'; dirEn = 'lean bearish'; dir = '偏空'; }
  else if (sk.score > 0.3) { dirZh = '偏多'; dirEn = 'lean bullish'; dir = '偏多'; }
  const hz = `${dirZh}：${p0.zh}${sk.template === 'contrast' ? '，但' + p1.zh : ''}`;
  const qz = `今日方向论断：${dirZh}。姿态评分 ${sk.score > 0 ? '+' : ''}${sk.score.toFixed(1)}，8 币中 ${sk.stance.bull} 多 / ${sk.stance.bear} 空。`
    + `核心理由：${sk.pills.map(p => p.zh).join('；')}。市场${sk.template === 'inflection' ? '正处于立场切换期' : sk.template === 'contrast' ? '多空信号并存' : '延续近期节奏'}，关注后续数据确认。`;
  return { headline_zh: hz, headline_en: hz, quote_zh: qz, quote_en: qz,
    direction: dir, stance_btc: '', stance_eth: '', key_levels: '', fallback: true };
}


/** 读取 BTC/ETH 实时价格与 24h 高低点（prices 表最新一行） */
function getLivePrices(db, dateStr = null) {
  const out = {};
  try {
    for (const sym of ['BTC', 'ETH']) {
      let r = null;
      if (dateStr) {
        // 历史日期：从 daily_analysis 当天快照取价格（prices 表仅保留近3天）
        const da = db.prepare('SELECT btc, eth FROM daily_analysis WHERE date=?').get(dateStr);
        if (da) {
          const j = JSON.parse(da[sym === 'BTC' ? 'btc' : 'eth'] || 'null');
          if (j && j.close) r = { price: j.close, high_24h: j.high_24h || j.close * 1.02, low_24h: j.low_24h || j.close * 0.98 };
        }
      } else {
        r = db.prepare("SELECT price, high_24h, low_24h FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT 1").get(sym);
      }
      if (r && r.price) out[sym] = { price: r.price, high: r.high_24h || r.price * 1.02, low: r.low_24h || r.price * 0.98 };
    }
  } catch (e) { warn('[hero_brief] price fetch err:', e.message); }
  return out;
}

/** 价格格式化：千分位 */
function fmtNum(v) {
  return Math.round(v).toLocaleString('en-US');
}

/** 按币种全位置分段：返回 [{sym, start, end}]，覆盖文本中该币种所有出现段 */
function allSegs(t, levels) {
  const tokens = [];
  const re = /(BTC|ETH)/g;
  let m, cur = null, last = 0;
  while ((m = re.exec(t))) {
    if (cur) tokens.push({ sym: cur, start: last, end: m.index });
    cur = m[1];
    last = m.index;
  }
  if (cur) tokens.push({ sym: cur, start: last, end: t.length });
  return tokens;
}

/** 规则校验关键位：压力必须>现价、支撑必须<现价，越界则按 24h 高低点+幅度修正 */
function sanitizeKeyLevels(j, prices) {
  const out = { ...j };
  if (!prices || !prices.BTC || !prices.ETH) return out;
  const levels = {};
  const parts = [];
  for (const sym of ['BTC', 'ETH']) {
    const p = prices[sym];
    // 从 AI 的 key_levels 中按币种分段提取压力/支撑数字
    let aiP = null, aiS = null;
    const klSeg = allSegs(out.key_levels || '', levels).find(s => s.sym === sym);
    if (klSeg) {
      const segTxt = (out.key_levels || '').slice(klSeg.start, klSeg.end);
      const mP = segTxt.match(/压力[^0-9]*([0-9][0-9,]*)/);
      const mS = segTxt.match(/支撑[^0-9]*([0-9][0-9,]*)/);
      if (mP) aiP = Number(mP[1].replace(/,/g, ''));
      if (mS) aiS = Number(mS[1].replace(/,/g, ''));
    }
    // 合理幅度：压力=现价上方 1%~3%；支撑=现价下方 1%~3%（今日关键位必须贴近现价）
    const okP = !!aiP && aiP > p.price * 1.01 && aiP < p.price * 1.03;
    const okS = !!aiS && aiS < p.price * 0.99 && aiS > p.price * 0.97;
    // 修正值：锚定 24h 真实高低点附近（压力=max(24h高,现价×1.01)、支撑=min(24h低,现价×0.99)），BTC 百位/ETH 十位取整
    const step = p.price > 10000 ? 100 : 10;
    const pressure = okP ? aiP : Math.ceil(Math.max(p.high, p.price * 1.01) / step) * step;
    const support = okS ? aiS : Math.floor(Math.min(p.low, p.price * 0.99) / step) * step;
    levels[sym] = { pressure, support };
    parts.push(`${sym}压力${fmtNum(pressure)}/支撑${fmtNum(support)}`);
  }
  // 统一 quote 中所有币种段的压力/支撑数字（覆盖多次出现）
  for (const key of ['quote_zh', 'quote_en']) {
    const t = out[key] || '';
    if (!t) continue;
    const segs = allSegs(t, levels);
    // 从后往前替换，避免下标偏移
    let res = t;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      const lv = levels[s.sym];
      if (!lv) continue;
      const seg = res.slice(s.start, s.end);
      let ns = seg.replace(/(压力[^0-9]*)[0-9][0-9,]*/g, `$1${fmtNum(lv.pressure)}`);
      ns = ns.replace(/(支撑[^0-9]*)[0-9][0-9,]*/g, `$1${fmtNum(lv.support)}`);
      // 英文：resistance/support（大小写不敏感）
      ns = ns.replace(/(resistance[^0-9]*)[0-9][0-9,]*/gi, `$1${fmtNum(lv.pressure)}`);
      ns = ns.replace(/(support[^0-9]*)[0-9][0-9,]*/gi, `$1${fmtNum(lv.support)}`);
      res = res.slice(0, s.start) + ns + res.slice(s.end);
    }
    out[key] = res;
  }
  out.key_levels = parts.join('；');
  return out;
}

/** 联网消息面：聚合 W1 已接入的 8 源新闻（金十/深潮/律动/华尔街见闻/Cointelegraph/Decrypt 等） */
function collectWebNews(db, hours = 36, endTs = null) {
  const out = [];
  try {
    const end = endTs || Math.floor(Date.now() / 1000);
    const since = end - hours * 3600;
    const rows = db.prepare("SELECT title, source_label, sentiment, influence, ts FROM news WHERE ts >= ? AND ts <= ? AND title != '' ORDER BY ts DESC LIMIT 15").all(since, end);
    for (const r of rows) {
      out.push(`[${r.sentiment || 'neutral'}·影响${r.influence || 1}] ${String(r.title).slice(0, 90)}（${r.source_label || r.source}）`);
    }
  } catch (e) { warn('[hero_brief] news fetch err:', e.message); }
  return out;
}

/** AI 文案生成（DeepSeek，联网消息面 + 本地数据双引擎研判，强制明确多空论断） */
async function generate(ctx, snap, dateStr = null) {
  const dayStr = dateStr || today();
  // 历史生成：新闻窗口锚定目标日 08:30（北京时间），价格取当天快照
  const genTs = dateStr ? Math.floor(new Date(dateStr + 'T08:30:00+08:00').getTime() / 1000) : null;
  const sk = buildSkeleton(snap);
  const news = collectWebNews(ctx.db, 36, genTs);
  const livePrices = getLivePrices(ctx.db, dateStr);
  const dataForAI = {
    date: dayStr,
    tone: sk.tone,
    template: sk.template,
    score: sk.score,
    stance_bull: sk.stance.bull,
    stance_bear: sk.stance.bear,
    stance_flips: sk.flips,
    inputs: (snap.posture && snap.posture.inputs) || snap.inputs || {},
    stances: (snap.stances || []).map(x => ({ symbol: x.symbol, stance: x.stance, headline_zh: x.headline_zh || '' })),
    key_points: sk.pills.map(p => p.zh),
    live_prices: livePrices
  };
  const sys = '你是 William —— 专业级加密货币期现分析师，性格直率、敢下结论、观点鲜明，但每个结论都必须有数据支撑。'
    + '你的任务：撰写每日「今日主要观点」简报。风格：中文口语化、面向普通投资者、专业术语用括号一句话解释、数据驱动、克制不浮夸。';
  const user = `请根据【联网消息面】+【本地实时数据】双引擎研判，写今日盘面简报。

【联网消息面（近36小时 8源聚合）】：
${news.length ? news.join('\n') : '(暂无新闻，标注消息面缺失)'}

【本地实时数据快照（北京时间）】：
${JSON.stringify(dataForAI, null, 1)}

【写作要求】
1. headline_zh：一句话标题，≤32 字，必须带明确方向词（看涨/看跌/偏多/偏空/中性），如「消息面转鸽但技术破位——短线看跌」
2. quote_zh：4-6 句正文（120-180 字），必须包含：
   - 第一句：明确方向论断（看涨/看跌/中性，不许模棱两可）
   - 中间：核心理由 2-3 条，引用【联网新闻】中的具体消息 +【本地数据】中的具体数字（FGI/费率/OI/价格/立场）交叉验证
   - 消息面与数据矛盾时，明确指出矛盾并给出取舍判断
   - 最后一句：今日关键位或观察重点（BTC 上方压力/下方支撑，具体价位）
3. headline_en / quote_en：对应英文，简洁
4. template 结构：${sk.template}（contrast=正反对比；inflection=立场/趋势正在转变；continuation=延续近期节奏）
5. 【关键位铁律】必须基于 live_prices 真实价格：压力位=现价上方 1%~3%、支撑位=现价下方 1%~3%，直接贴近 24h 高低点取整（BTC 百位、ETH 十位），禁止给出偏离现价 3% 以上的关键位
6. 禁止：预测保证收益、使用「稳了/梭哈/起飞」等浮夸词、编造快照里没有的数据、只复述数据不给判断

【输出】仅输出 JSON：{"headline_zh":"","headline_en":"","quote_zh":"","quote_en":"","direction":"看涨|看跌|偏多|偏空|中性","stance_btc":"看涨|看跌|中性","stance_eth":"看涨|看跌|中性","key_levels":"BTC压力xxx/支撑xxx；ETH压力xxx/支撑xxx"}
关键位数字必须落在 live_prices 合理范围，违者视为错误；`;
  try {
    const { text } = await ai.chat(ctx.env,
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      'deepseek-chat');
    const j = JSON.parse(String(text).replace(/```json|```/g, '').trim());
    if (!j.headline_zh || !j.quote_zh) throw new Error('bad_fields');
    const fixed = sanitizeKeyLevels(j, livePrices);
    return { ...sk, headline_zh: fixed.headline_zh, headline_en: fixed.headline_en || fixed.headline_zh,
      quote_zh: fixed.quote_zh, quote_en: fixed.quote_en || fixed.quote_zh,
      direction: fixed.direction || sk.tone, stance_btc: fixed.stance_btc || '', stance_eth: fixed.stance_eth || '',
      key_levels: fixed.key_levels || '', news_count: news.length,
      source: 'ai', generated_at: new Date().toISOString() };
  } catch (e) {
    warn('[hero_brief] AI failed, fallback template:', e.message);
    return { ...sk, ...fallbackText(sk), news_count: news.length,
      direction: sk.tone, source: 'template', generated_at: new Date().toISOString() };
  }
}

module.exports = { ensureTable, getToday, buildSkeleton, fallbackText, generate, today, getLivePrices, sanitizeKeyLevels };
