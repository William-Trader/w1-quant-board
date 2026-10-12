'use strict';
const { info, warn } = require('./log');
/**
 * lib/altseason.js — 山寨季 / 主流季判断引擎（多维度加权，足够科学）
 *
 * 判定模型（借鉴 Blockchaincenter Altcoin Season Index 思想 + 技术面）：
 *   [1] BTC 市值占比动量（权重 35%）— BTC.D 30 日变化 + 7 日均线方向
 *       BTC.D 下跌 = 资金从 BTC 外溢到山寨（经典 altseason 信号）
 *   [2] 市场宽度（权重 30%）— 追踪币种跑赢 BTC 的比例
 *       Blockchaincenter 定义：≥75% 币种跑赢 BTC = 山寨季
 *   [3] ETH/BTC 相对强弱（权重 20%）— ETH 与 BTC 的相对超额收益
 *       ETH 是山寨风向标（ETH/BTC 上涨 = 风险偏好扩散）
 *   [4] 风险偏好（权重 15%）— 总市值动量 + FGI 情绪
 *       总市值扩张 + 贪婪 = 山寨资金活跃
 *
 * 输出：score 0-100 → <35 主流季 / 35-65 过渡期 / >65 山寨季
 * 数据不足的维度按可用性降权（置信度标注），永不报错。
 * 存储：altseason_daily(date PK, payload)
 */
const TZ = 'Asia/Shanghai';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (v == null || isNaN(v) ? d : Number(v));

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS altseason_daily (
    date TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`);
}

/** 2 日涨跌（prices 表只有近 ~2 天历史；随积累可升级为更长窗口） */
function recentChanges(db, symbols) {
  const out = {};
  for (const sym of symbols) {
    try {
      const r = db.prepare(
        "SELECT price FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT 1").get(sym);
      const o = db.prepare(
        "SELECT price FROM prices WHERE symbol=? ORDER BY ts ASC LIMIT 1").get(sym);
      if (r && o && o.price > 0) out[sym] = (r.price - o.price) / o.price * 100;
    } catch (e) { debug('[altseason] skip:', e.message); }
  }
  return out;
}

function compute(db, opts = {}) {
  const date = opts.date || today();
  const mg = opts.mg || { dom: [], mcap: [] };
  const out = { date, dims: {}, inputs: {}, generated_at: new Date().toISOString() };

  // ---- [1] BTC 集中度动量（BTC市值÷TOP8市值，365 天同口径，官方 BTC.D 的趋势等价替代） ----
  const domSeries = opts.conc && opts.conc.length ? opts.conc : (mg.dom || []);
  const domNow = domSeries.length ? domSeries[domSeries.length - 1].y : null;
  const dom30 = domSeries.length >= 2 ? domSeries[0].y : null;
  // 7 日均线
  const domLast7 = domSeries.slice(-7).map(p => p.y).filter(v => v != null);
  const domMA7 = domLast7.length ? domLast7.reduce((s, v) => s + v, 0) / domLast7.length : null;
  const domDelta30 = domNow != null && dom30 != null ? domNow - dom30 : null;
  // 短趋势（近 3 日变化，pt）——用于方向判定
  let domTrend = null;
  {
    const dd = domSeries.filter(p => p.y != null);
    if (dd.length >= 2) {
      const a = dd[Math.max(0, dd.length - 3)].y, b = dd[dd.length - 1].y;
      domTrend = Math.round((b - a) * 10) / 10;
    }
  }
  let domScore = 0;
  if (domDelta30 != null && domSeries.length >= 14) {
    domScore = clamp(-domDelta30 / 2, -1, 1); // -2pt/30d → 满分山寨信号
    if (domMA7 != null) {
      domScore = (domScore + (domNow < domMA7 ? 0.4 : -0.4)) / 1.4; // 均线方向微调
    }
    out.dims.btc_dom = {
      label_zh: 'BTC 集中度动量', label_en: 'BTC Concentration', weight: 35, score: Math.round(domScore * 100) / 100,
      detail_zh: `BTC 集中度 ${num(domNow).toFixed(1)}%（30日 ${domDelta30 >= 0 ? '+' : ''}${domDelta30.toFixed(1)}pt${domNow < num(domMA7) ? '，低于7日均线' : '，高于7日均线'}）`
    };
  }

  // ---- [2] 市场宽度：8 币跑赢 BTC 比例（回填时禁用：无历史价格） ----
  let winCount = null, altTotal = null;
  if (!opts.noWidth) {
    const chg = recentChanges(db, ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'LINK']);
    const btcChg = chg.BTC;
    const altSyms = Object.keys(chg).filter(s => s !== 'BTC');
    const win = btcChg != null ? altSyms.filter(s => num(chg[s], -999) > btcChg) : [];
    winCount = win.length; altTotal = altSyms.length;
    if (btcChg != null && altSyms.length >= 5) {
      const p = win.length / altSyms.length;
      const widthScore = p >= 0.75 ? 1 : p >= 0.5 ? 0.3 : p >= 0.25 ? -0.4 : -1;
      out.dims.width = {
        label_zh: '市场宽度（跑赢 BTC）', label_en: 'Breadth vs BTC', weight: 30, score: widthScore,
        detail_zh: `${win.length}/${altSyms.length} 币 ${btcChg >= 0 ? '+' : ''}${btcChg.toFixed(2)}% 跑赢 BTC（${altSyms.map(s => `${s}${num(chg[s]) >= 0 ? '+' : ''}${num(chg[s]).toFixed(1)}%`).join(' / ')}）`
      };
    }

    // ---- [3] ETH/BTC 相对强弱 ----
    if (btcChg != null && chg.ETH != null) {
      const rel = num(chg.ETH) - btcChg;
      const ethScore = rel >= 0.5 ? 1 : rel <= -0.5 ? -1 : rel / 0.5;
      out.dims.eth = {
        label_zh: 'ETH/BTC 相对强弱', label_en: 'ETH/BTC Rel.', weight: 20, score: Math.round(ethScore * 100) / 100,
        detail_zh: `ETH ${num(chg.ETH) >= 0 ? '+' : ''}${num(chg.ETH).toFixed(2)}% vs BTC ${btcChg >= 0 ? '+' : ''}${btcChg.toFixed(2)}%（超额 ${rel >= 0 ? '+' : ''}${rel.toFixed(2)}%）`
      };
    }
  }

  // ---- [4] 风险偏好：总市值动量 + FGI ----
  const mcapSeries = (mg && mg.mcap) || [];
  const mcapNow = mcapSeries.length ? mcapSeries[mcapSeries.length - 1].y : null;
  const mcapAgo = mcapSeries.length >= 14 ? mcapSeries[0].y : null;
  let riskScore = 0, riskParts = [];
  if (mcapNow != null && mcapAgo != null) {
    const mcapDelta = (mcapNow - mcapAgo) / mcapAgo * 100;
    riskScore += clamp(mcapDelta / 3, -1, 1) * 0.6;
    riskParts.push(`总市值 ${mcapDelta >= 0 ? '+' : ''}${mcapDelta.toFixed(1)}%`);
  }
  const fgVal = opts.fg != null ? opts.fg : (() => { try { const f = db.prepare('SELECT value FROM fear_greed ORDER BY ts DESC LIMIT 1').get(); return f ? f.value : null; } catch (e) { debug('[altseason] fg get:', e.message); return null; } })();
  if (fgVal != null) {
    riskScore += clamp((num(fgVal) - 50) / 25, -1, 1) * 0.4;
    riskParts.push(`FGI ${fgVal}`);
  }
  if (riskParts.length) {
    out.dims.risk = {
      label_zh: '风险偏好', label_en: 'Risk Appetite', weight: 15, score: Math.round(riskScore * 100) / 100,
      detail_zh: riskParts.join('；')
    };
  }

  // ---- 汇总：加权（按可用维度归一化权重） ----
  const dims = Object.values(out.dims);
  const totalW = dims.reduce((s, d) => s + d.weight, 0);
  const weighted = dims.reduce((s, d) => s + d.score * d.weight, 0);
  const score = totalW ? Math.round(clamp((weighted / totalW) * 50 + 50, 0, 100)) : 50;
  const stage = score < 35 ? 'btc_season' : score > 65 ? 'altseason' : 'transition';
  out.score = score;
  out.stage = stage;
  out.stage_zh = { btc_season: '主流季', transition: '过渡期', altseason: '山寨季' }[stage];
  out.stage_en = { btc_season: 'BTC Season', transition: 'Transition', altseason: 'Altseason' }[stage];
  out.confidence = totalW >= 95 ? 'high' : totalW >= 55 ? 'medium' : 'low';
  out.coverage_zh = dims.map(d => d.label_zh).join(' + ') || '数据不足';
  out.inputs = { btc_dom: domNow, btc_chg_2d: null, alt_win: winCount, alt_total: altTotal };
  out.dom_trend = domTrend; // BTC.D 近3日变化（pt，负=向山寨）

  // 结论文本
  const lines = [];
  if (stage === 'altseason') lines.push('资金明显外溢，山寨跑赢 BTC 的概率占优');
  else if (stage === 'btc_season') lines.push('资金聚焦 BTC，山寨整体跑输');
  else lines.push('两类资产交替占优，方向尚未明确');
  for (const d of dims) lines.push(d.detail_zh);
  out.note_zh = `综合 ${dims.map(d => d.label_zh).join('、')}：` + lines.join('；') + `。判断分 ${score}/100（${out.stage_zh}）。`;
  return out;
}

/** 每日生成（缓存当天）；历史不足时自动回填 365 天 */
async function collectAltseason(ctx) {
  const db = ctx.db;
  ensureTable(db);
  const t = today();
  // 回填历史（BTC 集中度 365 天 + FGI 8 年；width/eth 无历史价格则降权）
  try {
    const cnt = db.prepare('SELECT COUNT(*) c FROM altseason_daily').get().c;
    if (cnt < 300) {
      const n = backfill(db, 365);
      if (n) info(`[altseason] 回填历史 ${n} 天`);
    }
  } catch (e) { warn('[altseason] backfill error:', e.message); }
  const ex = db.prepare('SELECT date, ts FROM altseason_daily WHERE date=?').get(t);
if (ex) {
        // 2026-08-22：凌晨预生成（早于当天 08:20）不视为正式缓存，08:35 cron 允许覆盖刷新
        const dayFloor = Math.floor(new Date(t + 'T08:20:00+08:00').getTime() / 1000);
        if (ex.ts >= dayFloor) return 'cached';
      }
  const mg = require('./market_global');
  const ms = require('./market_structure');
  const r = compute(db, { mg: mg.getSeries(db, 30), conc: ms.getSeries(db, 365).concentration });
  db.prepare('INSERT OR REPLACE INTO altseason_daily(date,payload,ts) VALUES(?,?,?)')
    .run(t, JSON.stringify(r), Math.floor(Date.now() / 1000));
  return `stage=${r.stage} score=${r.score}`;
}

/** 用 BTC 集中度（365天）+ 总市值 + FGI（8年）回填过去 N 天分数 */
function backfill(db, days = 365) {
  const ms = require('./market_structure');
  const conc = ms.getSeries(db, days).concentration;
  if (!conc.length) return 0;
  const mg = require('./market_global');
  const mcap = mg.getSeries(db, Math.min(days, 60)).mcap; // 总市值仅 ~30 天，超出部分 risk 维度自动降权
  // FGI 按天（历史充足）
  const fgByDay = {};
  try {
    const rows = db.prepare('SELECT ts,value FROM fear_greed ORDER BY ts ASC').all();
    for (const r of rows) {
      const d = new Date(r.ts * 1000).toLocaleDateString('en-CA', { timeZone: TZ });
      fgByDay[d] = r.value;
    }
  } catch (e) { debug('[altseason] skip:', e.message); }
  const insert = db.prepare('INSERT OR REPLACE INTO altseason_daily(date,payload,ts) VALUES(?,?,?)');
  let filled = 0;
  for (let i = 0; i < conc.length; i++) {
    const date = conc[i].x;
    if (date === today()) continue; // 今天由全量 compute 生成
    const subMg = { mcap: mcap.filter(p => p.x <= date) };
    const r = compute(db, { date, fg: fgByDay[date] ?? null, noWidth: true, conc: conc.slice(0, i + 1), mg: subMg });
    const ts = Math.floor(new Date(date + 'T00:00:00+08:00').getTime() / 1000);
    insert.run(date, JSON.stringify(r), ts);
    filled++;
  }
  return filled;
}

function getToday(db) {
  ensureTable(db);
  const r = db.prepare('SELECT payload FROM altseason_daily WHERE date=? ORDER BY ts DESC LIMIT 1').get(today());
  return r ? JSON.parse(r.payload) : null;
}

function getHistory(db, days = 7) {
  ensureTable(db);
  return db.prepare('SELECT date, payload FROM altseason_daily WHERE date <= ? ORDER BY date DESC LIMIT ?')
    .all(today(), days)
    .map(r => {
      const p = JSON.parse(r.payload);
      return { date: r.date, score: p.score, stage: p.stage };
    });
}

module.exports = { ensureTable, compute, collectAltseason, backfill, getToday, getHistory };
