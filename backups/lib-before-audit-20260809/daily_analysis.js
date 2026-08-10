// lib/daily_analysis.js — William 每日分析 v2（智能体个性 + 深度结论 + 五维框架）
'use strict';
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
- 必须给出【结论】：明确方向（看涨/看跌/中性）+ 核心理由（2-3条，引用数据）+ 关键位（上方压力位/下方支撑位，用具体价格）
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
    } catch (e) {}
  }
  try { const f = db.prepare('SELECT value, ts FROM fear_greed WHERE ts*1000 >= ? ORDER BY ts LIMIT 1').get(t0); if (f) out.fgi = f.value; } catch {}
  try {
    const rows = db.prepare("SELECT title, sentiment FROM news WHERE ts*1000 >= ? AND ts*1000 < ? AND sentiment != 'neutral' ORDER BY ts DESC LIMIT 10").all(t0, t1);
    out.news = rows.map(r => `[${r.sentiment}] ${String(r.title).slice(0, 60)}`);
  } catch {}
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
  } catch {}
  // KOL 共识（当日）
  try {
    const r = db.prepare('SELECT payload FROM consensus ORDER BY ts DESC LIMIT 1').get();
    if (r) {
      const p = JSON.parse(r.payload);
      const items = p && typeof p === 'object' ? Object.values(p) : [];
      const b = items.find(x => (x.symbol || '').toUpperCase().startsWith('BTC'));
      if (b) out.kol = { decision: b.decision, bias: b.trust_adjusted_bias, conf: b.confidence };
    }
  } catch {}
  return out;
}

async function generateOne(db, env, dateStr, force = false) {
  if (!force) {
    const ex = db.prepare('SELECT date FROM daily_analysis WHERE date=?').get(dateStr);
    if (ex) return { ok: true, date: dateStr, cached: true };
  }
  const data = await collectData(db, dateStr);
  const prompt = `日期：${dateStr}\n数据快照（北京时间）：\n${JSON.stringify(data, null, 1)}\n请以 William 的口吻完成今日盘面分析，输出 JSON。`;
  let r = null;
  try {
    r = await chat(env, [
      { role: 'system', content: FRAME },
      { role: 'user', content: prompt }
    ], env.DEEPSEEK_MODEL_REASON || 'deepseek-reasoner');
  } catch (e) {
    console.warn('[daily] reasoner 失败，降级 chat 模型:', e.message);
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
