'use strict';
const { debug, warn, info } = require('./log');
// ============================================================
// AI 智能体研判 ai_advisor.js（2026-08-08）
//  - 采集本地市场快照（8 大币指标 + KOL + 新闻 + 持仓）
//  - DeepSeek 机构级分析 → JSON 输出（市场观点/风险/交易建议）
//  - 2h 缓存（kv: ai:advisory），失败降级（不影响量化策略）
//  - 仅供研究参考，不构成投资建议
// ============================================================
const { kvGet, kvSet } = require('./db');
const { chat } = require('./ai');

const CACHE_KEY = 'ai:advisory';
const TTL_MS = 2 * 3600 * 1000;
const MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK'];

/* ---------- 市场快照（紧凑，喂 LLM） ---------- */
function buildSnapshot(db) {
  const signal = require('./signal');
  const snaps = signal.futuresSnapshots(db, 30);
  const cur = snaps[snaps.length - 1];
  const coins = [];
  if (cur) {
    for (const s of MAJORS) {
      const c = cur.m.get(s);
      if (!c) continue;
      try {
        const arr = signal.priceSeries(snaps, s);
        const trend = signal.trendFilter(arr);
        const boll = signal.bollinger(arr);
        const funding = Number(c.avg_funding_rate_by_oi || 0);
        coins.push({
          symbol: s, price: +Number(c.current_price).toFixed(4),
          chg1h: +Number(c.price_change_percent_1h || 0).toFixed(2),
          chg24: +Number(c.price_change_percent_24h || 0).toFixed(2),
          trend15_1h: trend,
          bollPos: boll ? +boll.pos.toFixed(2) : null,
          fundingPct: +funding.toFixed(4), // Coinglass 原始即百分数（0.0113 = 0.0113%），勿再 ×100（2026-08-22 修）
          lsr4h: +Number(c.long_short_ratio_4h || 0).toFixed(2),
          oiChg24: +Number(c.open_interest_change_percent_24h || 0).toFixed(2),
          liqLongM: +(Number(c.long_liquidation_usd_24h || 0) / 1e6).toFixed(1),
          liqShortM: +(Number(c.short_liquidation_usd_24h || 0) / 1e6).toFixed(1)
        });
      } catch (e) { debug('[advisor] err:', e.message); }
    }
  }
  let fgi = null;
  try { fgi = signal.fgiValue(db); } catch (e) { debug('[advisor] fgi err:', e.message); }
  let kol = null;
  try {
    const row = db.prepare('SELECT payload FROM consensus ORDER BY ts DESC LIMIT 1').get();
    if (row) {
      const arr = JSON.parse(row.payload);
      const b = arr.find(c => String(c.symbol || '').startsWith('BTC') || c.display_symbol === 'BTC') || null;
      if (b) kol = { decision: b.decision, bias: +(b.trust_adjusted_bias || 0).toFixed(4), long: b.equal_weight && b.equal_weight.long, short: b.equal_weight && b.equal_weight.short, neutral: b.equal_weight && b.equal_weight.neutral };
    }
  } catch (e) { debug('[advisor] kol err:', e.message); }
  let macro = null;
  try {
    const m = signal.macroSentiment(db);
    if (m && m.direction) macro = { dir: m.direction, strength: +m.strength.toFixed(2), score: m.score };
  } catch (e) { debug('[advisor] macro err:', e.message); }
  let opens = [];
  try { opens = db.prepare("SELECT symbol, direction, entry, stop, target1, strategy FROM signal_track WHERE status='OPEN'").all(); } catch (e) { debug('[advisor] opens err:', e.message); }
  let signalsToday = 0;
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    signalsToday = Number(db.prepare('SELECT value FROM kv WHERE key=?').get(`signal:daily:${today}`)?.value || 0);
  } catch (e) { debug('[advisor] signalsToday err:', e.message); }
  return {
    ts: Math.floor(Date.now() / 1000),
    coins, fgi: fgi ? { value: fgi.value, cls: fgi.classification } : null,
    kol, macro, opens, signalsToday
  };
}

/* ---------- JSON 解析（容忍 markdown 代码块） ---------- */
function parseJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) t = m[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (e) { debug('[ai_advisor] parse:', e.message); return null; }
}

/* ---------- 主入口：获取 AI 研判（2h 缓存） ---------- */
async function getAdvisory(ctx, force = false) {
  const { db, env } = ctx;
  if (!force) {
    const cached = kvGet(db, CACHE_KEY, null);
    if (cached && cached.ok && cached.ts && Date.now() - cached.ts < TTL_MS) return cached;
  }
  const snap = buildSnapshot(db);
  if (!snap.coins.length) return { ok: false, error: 'no_data' };
  const prompt = [
    '你是加密货币量化交易机构的首席分析师。基于以下实时市场数据快照（本地数据库实时采集），输出你的专业交易研判。',
    '要求：',
    '1. market_view：中文，1~2 句概括当前市场主基调',
    '2. risk_level：low / medium / high',
    '3. trades：最多 3 个你认为最有优势的交易机会；confidence 0~1；入场价具体数字；order_type：limit=回踩挂限价单 / market=突破追市价单；止损和目标必须给出具体价格；reason 一句话（中文）',
    '4. 把握不足的币不要硬给，宁缺毋滥；盈亏比至少要 1:1.5',
    '5. 只输出 JSON，不要 markdown 代码块，不要任何多余文字',
    '',
    '数据快照：',
    JSON.stringify(snap, null, 1)
  ].join('\n');
  const messages = [
    { role: 'system', content: '你是一个谨慎、数据驱动、风险厌恶的机构级加密货币分析师，服务真实资金决策。必须结合 15min-1h 趋势、资金费率拥挤度、多空比、清算方向、KOL 共识、恐惧贪婪做判断，禁止逆主趋势接刀。只输出 JSON。' },
    { role: 'user', content: prompt }
  ];
  try {
    const { text, source } = await chat(env, messages, null, 'advisor');
    const parsed = parseJson(text);
    if (!parsed || !parsed.market_view) {
      warn('[ai_advisor] parse_fail, raw:', String(text).slice(0, 160));
      return { ok: false, error: 'parse_fail', raw: String(text).slice(0, 200) };
    }
    const out = {
      ok: true, ts: Date.now(), source,
      market_view: String(parsed.market_view).slice(0, 300),
      risk_level: ['low', 'medium', 'high'].includes(parsed.risk_level) ? parsed.risk_level : 'medium',
      trades: Array.isArray(parsed.trades) ? parsed.trades.slice(0, 3) : [],
      notes: parsed.notes ? String(parsed.notes).slice(0, 200) : null,
      snapshot: { ts: snap.ts, coins: snap.coins.length }
    };
    kvSet(db, CACHE_KEY, out);
    info(`[ai_advisor] 研判完成 source=${source} risk=${out.risk_level} trades=${out.trades.length}`);
    return out;
  } catch (e) {
    warn('[ai_advisor] chat failed:', e.message);
    return { ok: false, error: 'chat_fail', message: e.message };
  }
}

module.exports = { getAdvisory, buildSnapshot, parseJson, CACHE_KEY, TTL_MS };
