'use strict';
// ============================================================
// W1 资金面模块 v1.0（2026-08-07 William 老板指令·P2）
//   - 稳定币供应量：DefiLlama 免费 API（USDT/USDC 等总供应）
//   - ETF 情绪：Coinglass 无权限 → 用本地 news 关键词近似
//   - 输出资金面信号（long/short + 强度），供 signal 推送加成
// 全部 try/catch，失败不影响主流程。
// ============================================================
const { kvGet, kvSet } = require('./db');

const STABLECOIN_URL = 'https://stablecoins.llama.fi/stablecoins?includePrices=false';
const TZ = 'Asia/Shanghai';

/* DefiLlama 稳定币总供应（USDT/USDC 等主流 USD 稳定币）→ 存 kv */
async function collectStablecoinSupply(db) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(STABLECOIN_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('status ' + r.status);
    const data = await r.json();
    const assets = (data.peggedAssets || []).filter(a => a.pegType === 'peggedUSD');
    // 只看流通市值前 10 的美元稳定币（USDT/USDC/DAI 等）
    const top = assets.slice(0, 10);
    const now = Math.floor(Date.now() / 1000);
    const rec = {
      ts: now,
      total: Math.round(top.reduce((s, a) => s + (a.circulating?.peggedUSD || 0), 0)),
      totalPrevDay: Math.round(top.reduce((s, a) => s + (a.circulatingPrevDay?.peggedUSD || 0), 0)),
      totalPrevWeek: Math.round(top.reduce((s, a) => s + (a.circulatingPrevWeek?.peggedUSD || 0), 0)),
      breakdown: top.map(a => ({ symbol: a.symbol, circ: Math.round(a.circulating?.peggedUSD || 0) }))
    };
    kvSet(db, 'fund:stablecoin', rec);
    const d = (rec.total / rec.totalPrevDay - 1) * 100;
    const w = (rec.total / rec.totalPrevWeek - 1) * 100;
    console.log(`[fund] 稳定币供应 $${(rec.total / 1e9).toFixed(1)}B（24h ${d >= 0 ? '+' : ''}${d.toFixed(2)}% / 7d ${w >= 0 ? '+' : ''}${w.toFixed(2)}%）`);
    return { ok: true, total: rec.total, d, w };
  } catch (e) {
    console.warn('[fund] 稳定币采集失败:', e.message);
    return { ok: false, error: e.message };
  }
}

/* 稳定币信号：供应 24h 变化 → 流动性方向 */
function stablecoinSignal(db) {
  const rec = kvGet(db, 'fund:stablecoin', null);
  if (!rec || !rec.totalPrevDay) return { direction: null, strength: 0, detail: '无稳定币数据' };
  const d = (rec.total / rec.totalPrevDay - 1) * 100;
  const totalB = (rec.total / 1e9).toFixed(1);
  if (d >= 0.05) return { direction: 'long', strength: 1, detail: `稳定币供应 $${totalB}B（24h +${d.toFixed(2)}%）→ 流动性流入` };
  if (d <= -0.05) return { direction: 'short', strength: 1, detail: `稳定币供应 $${totalB}B（24h ${d.toFixed(2)}%）→ 流动性流出` };
  return { direction: null, strength: 0, detail: `稳定币供应 $${totalB}B（24h ${d >= 0 ? '+' : ''}${d.toFixed(2)}%）→ 中性` };
}

/* ETF 情绪：扫 news 表近 24h 关键词（Coinglass 无权限，用新闻近似） */
function etfSentimentSignal(db) {
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const rows = db.prepare(
    "SELECT title, sentiment, influence FROM news WHERE ts >= ? AND (title LIKE '%ETF%' OR title LIKE '%etf%') ORDER BY ts DESC LIMIT 30"
  ).all(dayAgo);
  if (!rows.length) return { direction: null, strength: 0, detail: '近24h无 ETF 新闻' };
  let score = 0;
  for (const r of rows) {
    const w = r.influence || 1;
    if (r.sentiment === 'bullish') score += w;
    else if (r.sentiment === 'bearish') score -= w;
    else if (/净流入|流入|增持|买入/i.test(r.title)) score += w;
    else if (/净流出|流出|减持|卖出/i.test(r.title)) score -= w;
  }
  if (score >= 5) return { direction: 'long', strength: 1, detail: `ETF 新闻偏多（${rows.length}条，净分 ${score}）` };
  if (score <= -5) return { direction: 'short', strength: 1, detail: `ETF 新闻偏空（${rows.length}条，净分 ${score}）` };
  return { direction: null, strength: 0, detail: `ETF 新闻中性（${rows.length}条，净分 ${score}）` };
}

/* 资金面综合信号 → { score: -2..+2, lines: [] }（供文案与仓位微调） */
function fundFlowScore(db) {
  const s = stablecoinSignal(db);
  const e = etfSentimentSignal(db);
  let score = 0;
  const lines = [];
  if (s.direction === 'long') { score += 1; lines.push(`💰 ${s.detail}`); }
  else if (s.direction === 'short') { score -= 1; lines.push(`💰 ${s.detail}`); }
  else lines.push(`💰 ${s.detail}`);
  if (e.direction === 'long') { score += 1; lines.push(`📰 ${e.detail}`); }
  else if (e.direction === 'short') { score -= 1; lines.push(`📰 ${e.detail}`); }
  else lines.push(`📰 ${e.detail}`);
  return { score, lines };
}

module.exports = { collectStablecoinSupply, stablecoinSignal, etfSentimentSignal, fundFlowScore };
