// lib/daily_analysis.js — William 每日分析 v2（智能体个性 + 深度结论 + 五维框架）
'use strict';
const { debug, warn } = require('./log');
const { chat } = require('./ai');

const FRAME = `你是 William —— 一名有 8 年实战经验的加密量化分析师，性格直率、敢下结论、观点鲜明，但每个结论都必须有数据支撑。今天是你的每日盘面分析任务。
分析对象：BTC 与 ETH 整个盘面。
分析框架（五维，缺数据的维度如实标注）：
1. 宏观面：美联储/宏观数据/地缘/政策事件对风险资产的驱动
2. 资金面：资金费率、OI 变化、多空比 LSR、清算流向、稳定币
3. 情绪面：FGI 恐惧贪婪指数、市场情绪、散户/大户结构
4. 技术面：EMA/RSI/ATR/布林带、支撑阻力、趋势结构（BTC 与 ETH 分别讲）
5. 短期事件：新闻、数据公布、催化剂
深度数据（快照中有则必须引用）：OI 变化、多空清算失衡、LSR 多周期、费率热度、KOL 共识、成交量变化

硬性要求：
- 每维必须引用快照中的具体数据（数字、价位、百分比），禁止空话套话（如"窄幅震荡"必须给出震荡区间和量能依据）
- 必须结合【联网消息面】+【本地数据】双引擎研判，消息面新闻必须被引用进分析
- 必须给出【明确方向论断】：看涨/看跌/中性，明确表态，禁止模糊（"可能/或许/谨慎"单独出现不算论断）
- 核心理由 2-3 条（引用消息面 + 数据交叉验证）+ 关键位（BTC/ETH 上方压力位/下方支撑位，具体价格）
- 要有 William 的口吻：直接、专业、带观点，但严禁夸大和承诺收益
- 输出严格 JSON（不要 markdown 代码块）：
{
  "sentiment": 1-5整数,
  "label": "看跌|偏空|中性|偏多|看涨",
  "color": "#c06a5e|#d9885e|#d9a441|#7fb069|#5f9e7a",
  "summary": "60字以内核心结论",
  "conclusion": "150字以内：方向+核心理由+关键位（BTC压力/支撑、ETH压力/支撑）",
  "details": {
    "macro": "宏观分析（引数据）",
    "fund": "资金分析（费率/OI/LSR/清算，引数据）",
    "sentiment": "情绪分析（FGI等，引数据）",
    "tech": "技术分析（BTC与ETH分述，引价位/指标）",
    "events": "事件与催化（引新闻）"
  }
}`;

function emaArr(arr, n) { const k = 2 / (n + 1); const o = [arr[0]]; for (let i = 1; i < arr.length; i++) o.push(arr[i] * k + o[i - 1] * (1 - k)); return o; }
function rsiArr(closes, n = 14) {
  const out = new Array(closes.length).fill(50);
  for (let i = n; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let j = i - n + 1; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d > 0) g += d; else l -= d; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function atrArr(bars, n = 14) {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    out[i] = i === 1 ? tr : (out[i - 1] * (n - 1) + tr) / n;
  }
  return out;
}

async function collectData(db, dateStr) {
  const engine = require('./engine');
  const t0 = new Date(dateStr + 'T00:00:00+08:00').getTime();
  const t1 = t0 + 86400 * 1000;
  const out = { date: dateStr, btc: {}, eth: {}, fgi: null, news: [], funding: null, lsr: null, oi: null, liq: null };
  for (const sym of ['BTC', 'ETH']) {
    try {
      const kl = await engine.getKL(sym, '1h');
      const day = kl.filter(b => b.t * 1000 >= t0 && b.t * 1000 < t1);
      if (day.length) {
        const closes = day.map(b => b.c);
        const last = day[day.length - 1];
        const all = kl.slice(0, kl.length); // 全部历史用于指标
        const allC = all.map(b => b.c);
        const i = allC.length - 1;
        const e20 = emaArr(allC, 20), e50 = emaArr(allC, 50), R = rsiArr(allC), A = atrArr(all);
        out[sym.toLowerCase()] = {
          open: day[0].o, close: last.c,
          high: Math.max(...day.map(b => b.h)), low: Math.min(...day.map(b => b.l)),
          chg_24h: day.length > 1 ? (last.c / day[0].o - 1) * 100 : 0,
          ema20: +e20[i].toFixed(2), ema50: +e50[i].toFixed(2),
          rsi14: +R[i].toFixed(1), atr14: +(A[i] / last.c * 100).toFixed(2),
          high_24h: +Math.max(...day.map(b => b.h)).toFixed(2), low_24h: +Math.min(...day.map(b => b.l)).toFixed(2),
          vol_24h_usd: Math.round(day.reduce((a, b) => a + b.v * b.c, 0))
        };
      }
    } catch (e) { debug('[daily] kline collect err:', e.message); }
  }
  try { const f = db.prepare('SELECT value, ts FROM fear_greed WHERE ts*1000 >= ? ORDER BY ts LIMIT 1').get(t0); if (f) out.fgi = f.value; } catch (e) { debug('[daily] fgi err:', e.message); }
  try {
    const rows = db.prepare("SELECT title, sentiment FROM news WHERE ts*1000 >= ? AND ts*1000 < ? AND sentiment != 'neutral' ORDER BY ts DESC LIMIT 10").all(t0, t1);
    out.news = rows.map(r => `[${r.sentiment}] ${String(r.title).slice(0, 60)}`);
  } catch (e) { debug('[daily] news err:', e.message); }
  try {
    const r = db.prepare('SELECT payload FROM futures_markets WHERE ts*1000 >= ? ORDER BY ts LIMIT 1').get(t0);
    if (r) {
      const d = JSON.parse(r.payload).data || [];
      const b = d.find(x => x.symbol === 'BTC');
      if (b) {
        out.funding = b.avg_funding_rate_by_oi != null ? +(b.avg_funding_rate_by_oi * 100).toFixed(4) : null;
        out.lsr = { m5: b.long_short_ratio_5m, h4: b.long_short_ratio_4h, h24: b.long_short_ratio_24h };
        out.oi = { btc_usd: b.open_interest_usd ? Math.round(b.open_interest_usd / 1e9 * 10) / 10 + 'B' : null, chg_24h: b.open_interest_change_percent_24h };
        out.liq = { long_24h: b.long_liquidation_usd_24h ? Math.round(b.long_liquidation_usd_24h / 1e6) + 'M' : null, short_24h: b.short_liquidation_usd_24h ? Math.round(b.short_liquidation_usd_24h / 1e6) + 'M' : null };
        out.vol_chg_24h = b.volume_change_percent_24h;
      }
    }
  } catch (e) { debug('[daily] futures_markets err:', e.message); }
  // Coinglass Pro 数据（清算墙/最大痛点/鲸鱼仓位/清算图, cglass-pro 采集器）
  try {
    const cg = {};
    const rows = db.prepare(
      "SELECT endpoint, payload, ts FROM cgpro_snapshots WHERE endpoint IN " +
      "('liq_agg_map','liq_max_pain','liq_agg_history','hl_posdist_bytag','liq_agg_heatmap_model1')").all();
    const snap = {};
    for (const r of rows) snap[r.endpoint] = JSON.parse(r.payload).data;
    if (snap.liq_agg_map) {
      const d = snap.liq_agg_map;
      const last = Number(d.last_price || 0);
      const lv = [];
      for (const e of (d.data || [])) {
        for (const [k, v] of Object.entries(e.liqMapV2 || {})) {
          const q = (v || []).reduce((a, x) => a + Number(x[1] || 0), 0);
          if (q > 0) lv.push([Number(k), q]);
        }
      }
      if (last > 0 && lv.length) {
        const below = lv.filter(x => x[0] < last);
        const above = lv.filter(x => x[0] > last);
        if (below.length && above.length) {
          cg.walls = {
            price: last,
            sb: below.reduce((a, b) => (b[1] > a[1] ? b : a)),
            sa: above.reduce((a, b) => (b[1] > a[1] ? b : a))
          };
        }
      }
    }
    if (snap.liq_max_pain) {
      const b = (snap.liq_max_pain || []).find(x => x.symbol === 'BTC');
      if (b) cg.max_pain = { price: b.price, long: b.long_max_pain_liq_price, short: b.short_max_pain_liq_price };
    }
    if (snap.hl_posdist_bytag) {
      const w = (snap.hl_posdist_bytag || []).find(x => x.group_name === 'whale');
      if (w) cg.whale = { bias: w.bias_score, remark: w.bias_remark, long: Math.round(w.long_position_usd / 1e6), short: Math.round(w.short_position_usd / 1e6) };
    }
    if (snap.liq_agg_heatmap_model1) {
      const h = snap.liq_agg_heatmap_model1;
      const y = h.y_axis || [];
      const lld = h.liquidation_leverage_data || [];
      const xs = [...new Set(lld.map(r => r[0]))].sort((a, b) => a - b);
      const latest = xs[xs.length - 1];
      let prev = null;
      for (let i = xs.length - 1; i >= 0; i--) if (xs[i] <= latest - 12) { prev = xs[i]; break; }
      const col = (tx) => {
        const by = new Map();
        for (const [x, yi, v] of lld) {
          if (x !== tx) continue;
          const i = Number(yi);
          if (!Number.isInteger(i) || i < 0 || i >= y.length) continue;
          by.set(Number(y[i]), (by.get(Number(y[i])) || 0) + Number(v || 0));
        }
        return by;
      };
      const cur = col(latest);
      if (cur.size) {
        const pc = h.price_candlesticks || [];
        const lastPrice = pc.length ? Number(pc[pc.length - 1][1]) : 0;
        const dense = [...cur.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(x => ({ p: Math.round(x[0]), m: Math.round(x[1] / 1e6) }));
        cg.heatmap = { price: lastPrice, dense };
        if (prev != null) {
          const old = col(prev);
          if (old.size) {
            let nb = 0, na = 0;
            for (const [p, v] of cur) {
              const dv = v - (old.get(p) || 0);
              if (dv <= 0) continue;
              if (lastPrice > 0 && p < lastPrice) nb += dv; else na += dv;
            }
            cg.heatmap.h1 = { above: Math.round(na / 1e6), below: Math.round(nb / 1e6) };
          }
        }
      }
    }
    out.cgpro = cg;
  } catch (e) { debug('[daily] news err:', e.message); }
  // KOL 共识（当日）
  try {
    const r = db.prepare('SELECT payload FROM consensus ORDER BY ts DESC LIMIT 1').get();
    if (r) {
      const p = JSON.parse(r.payload);
      const items = p && typeof p === 'object' ? Object.values(p) : [];
      const b = items.find(x => (x.symbol || '').toUpperCase().startsWith('BTC'));
      if (b) out.kol = { decision: b.decision, bias: b.trust_adjusted_bias, conf: b.confidence };
    }
  } catch (e) { debug('[daily] kol err:', e.message); }
  return out;
}

async function generateOne(db, env, dateStr, force = false) {
  if (!force) {
    const ex = db.prepare('SELECT date FROM daily_analysis WHERE date=?').get(dateStr);
    if (ex) return { ok: true, date: dateStr, cached: true };
  }
  const data = await collectData(db, dateStr);
  // v2.1 联网消息面：聚合 8 源实时新闻，AI 必须结合消息面 + 本地数据双引擎研判
  const news = await collectWebNews(db, 36);
  const prompt = `日期：${dateStr}\n【联网消息面（近36小时 8源聚合）】：\n${news.length ? news.join('\n') : '(暂无新闻，标注消息面缺失)'}\n\n【本地实时数据快照（北京时间）】：\n${JSON.stringify(data, null, 1)}\n\n请以 William 的口吻完成今日盘面分析。硬性要求：\n1. 必须给出【明确方向论断】：看涨 / 看跌 / 中性，不许模糊两可（如"可能震荡上行"不合格）；\n2. 每个论断必须有依据：引用消息面新闻 + 本地数据（价位/百分比/OI/费率/清算）交叉验证；\n3. 消息面与数据矛盾时，明确指出矛盾并给出你的取舍判断；\n4. 给出 BTC/ETH 具体关键位（上方压力/下方支撑，带价格）；\n5. 输出严格 JSON（不要 markdown 代码块）。`;
  let r = null;
  try {
    r = await chat(env, [
      { role: 'system', content: FRAME },
      { role: 'user', content: prompt }
    ], env.DEEPSEEK_MODEL_REASON || 'deepseek-reasoner');
  } catch (e) {
    warn('[daily] reasoner 失败，降级 chat 模型:', e.message);
    r = await chat(env, [
      { role: 'system', content: FRAME },
      { role: 'user', content: prompt }
    ]);
  }
  if (!r || !r.text) throw new Error('deepseek empty');
  let parsed = null;
  try {
    const m = r.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : r.text);
  } catch (e) { throw new Error('json parse: ' + r.text.slice(0, 120)); }
  const details = parsed.details || {};
  details.conclusion = parsed.conclusion || '';
  db.prepare(`INSERT OR REPLACE INTO daily_analysis (date, sentiment, label, color, summary, details, btc, eth, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(dateStr, parsed.sentiment || 3, parsed.label || '中性', parsed.color || '#d9a441',
      parsed.summary || '', JSON.stringify(details),
      JSON.stringify(data.btc || {}), JSON.stringify(data.eth || {}), Date.now());
  db.prepare("DELETE FROM daily_analysis WHERE date < date('now','localtime','-30 day')").run();
  return { ok: true, date: dateStr, cached: false, sentiment: parsed.sentiment, label: parsed.label };
}

async function generateRange(db, env, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try { out.push(await generateOne(db, env, ds, true)); } catch (e) { out.push({ ok: false, date: ds, error: e.message }); }
  }
  return out;
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_analysis (
    date TEXT PRIMARY KEY, sentiment INTEGER, label TEXT, color TEXT,
    summary TEXT, details TEXT, btc TEXT, eth TEXT, created_at INTEGER
  )`);
}

function list(db, limit = 30) {
  const rows = db.prepare('SELECT date, sentiment, label, color, summary, details, btc, eth FROM daily_analysis ORDER BY date DESC LIMIT ?').all(limit);
  return rows.map(r => {
    const det = JSON.parse(r.details || '{}');
    return { date: r.date, sentiment: r.sentiment, label: r.label, color: r.color, summary: r.summary, conclusion: det.conclusion || '', details: det, btc: JSON.parse(r.btc || '{}'), eth: JSON.parse(r.eth || '{}') };
  });
}

module.exports = { ensureTable, generateOne, generateRange, list };

/* ================= v2.1 联网消息面采集 ================= */
// William 老板 2026-08-13 指令：每日分析必须「AI智能体 = 联网搜索 + 本地数据研判」
// 用 W1 已接入的 8 源新闻聚合（金十/深潮/律动/华尔街见闻/Cointelegraph/Decrypt等）作为联网消息面
async function collectWebNews(db, hours = 36) {
  const out = [];
  try {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const rows = db.prepare("SELECT title, source_label, sentiment, influence, ts FROM news WHERE ts >= ? AND title != '' ORDER BY ts DESC LIMIT 15").all(since);
    for (const r of rows) {
      out.push(`[${r.sentiment || 'neutral'}·影响${r.influence || 1}] ${String(r.title).slice(0, 90)}（${r.source_label || r.source}）`);
    }
  } catch (e) { warn('[daily] news fetch err:', e.message); }
  return out;
}
