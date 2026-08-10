'use strict';
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
  } catch { return null; }
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
    } catch { /* ignore */ }
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

/** 模板兜底（AI 挂掉时用，保证结构完整） */
function fallbackText(sk) {
  const p0 = sk.pills[0] || { zh: '市场延续既有节奏', en: 'market continues' };
  const p1 = sk.pills[1] || { zh: '等待数据进一步确认', en: 'awaiting confirmation' };
  const hz = sk.template === 'contrast' ? `${p0.zh}，但${p1.zh}` : `${p0.zh}，${p1.zh}`;
  const qz = `今日姿态评分 ${sk.score > 0 ? '+' : ''}${sk.score.toFixed(1)}，8 币中 ${sk.stance.bull} 多 / ${sk.stance.bear} 空。`
    + `${sk.pills.map(p => p.zh).join('；')}。市场${sk.template === 'inflection' ? '正处于立场切换期' : sk.template === 'contrast' ? '多空信号并存' : '延续近期节奏'}，关注后续数据确认。`;
  return { headline_zh: hz, headline_en: hz, quote_zh: qz, quote_en: qz, fallback: true };
}

/** AI 文案生成（DeepSeek，文风对齐 openclue 且数据更全更新） */
async function generate(ctx, snap) {
  const sk = buildSkeleton(snap);
  const dataForAI = {
    date: today(),
    tone: sk.tone,
    template: sk.template,
    score: sk.score,
    stance_bull: sk.stance.bull,
    stance_bear: sk.stance.bear,
    stance_flips: sk.flips,
    inputs: (snap.posture && snap.posture.inputs) || snap.inputs || {},
    stances: (snap.stances || []).map(x => ({ symbol: x.symbol, stance: x.stance })),
    key_points: sk.pills.map(p => p.zh)
  };
  const sys = '你是 William 量化系统的首席市场叙事官，负责撰写每日「今日主要观点」简报。'
    + '你的风格：中文口语化、面向普通投资者、专业术语用括号一句话解释、数据驱动、克制不浮夸。';
  const user = `请根据数据快照写今日简报。

【写作要求】
1. headline_zh：一句话标题，≤32 字，用转折/对比结构（如「情绪在升温——但价格涨幅太窄」）
2. quote_zh：3-5 句正文（80-130 字），第一句给核心矛盾，中间引用具体数字（FGI、百分比、金额），最后一句给观察重点（「你需要看清楚的是…」句式可选）
3. headline_en / quote_en：对应英文，简洁
4. 语气与 tone 一致：${sk.tone}（bullish=明确但不浮夸；bearish=客观不恐慌；cautious=谨慎；mixed=中立）
5. template 结构：${sk.template}（contrast=正反对比；inflection=立场/趋势正在转变；continuation=延续近期节奏）
6. 禁止：预测具体价格点位、保证收益、使用「稳了/梭哈/起飞」等浮夸词、编造快照里没有的数据

【数据快照（北京时间，实时）】
${JSON.stringify(dataForAI, null, 1)}

【输出】仅输出 JSON：{"headline_zh":"","headline_en":"","quote_zh":"","quote_en":""}`;
  try {
    const { text } = await ai.chat(ctx.env,
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      'deepseek-chat');
    const j = JSON.parse(String(text).replace(/```json|```/g, '').trim());
    if (!j.headline_zh || !j.quote_zh) throw new Error('bad_fields');
    return { ...sk, headline_zh: j.headline_zh, headline_en: j.headline_en || j.headline_zh,
      quote_zh: j.quote_zh, quote_en: j.quote_en || j.quote_zh,
      source: 'ai', generated_at: new Date().toISOString() };
  } catch (e) {
    console.warn('[hero_brief] AI failed, fallback template:', e.message);
    return { ...sk, ...fallbackText(sk), source: 'template', generated_at: new Date().toISOString() };
  }
}

module.exports = { ensureTable, getToday, buildSkeleton, fallbackText, generate, today };
