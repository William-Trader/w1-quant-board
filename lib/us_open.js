'use strict';
// lib/us_open.js — 美股开盘播报引擎 v1.0（2026-11-02 William 老板指令：修复开盘播报体系）
// 背景：旧链路依赖 Yahoo v7 quote（2025 起对云 IP 返回 401 Unauthorized）+ OKX 代币化永续（无正股真实盘前），
//      导致开盘播报长期拿不到正股价格/盘前数据。本模块改为：
//   ① 正股/ETF/指数快照 → 新浪美股行情（gb_ 前缀，含盘前盘后）+ 东方财富（兜底）
//   ② 失败再退回本地 OKX SWAP 最新价（asset_prices），保证任何情况下都能出稿
//   ③ 播报时段：盘前（北京 16:00）、开盘（北京 21:30 夏令时 / 22:30 冬令时）、收盘（北京 04:00 夏令时 / 05:00 冬令时）
//   ④ 去重：kv 记录「日期+场次」，重启不重复推；dryRun 可本地预览
const { warn, info } = require('./log');
const { kvGet, kvSet } = require('./db');

let _sessCache = null;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 播报关注池（正股代码，顺序即展示顺序）
const WATCH = [
  { sym: 'SPY', zh: '标普500', em: '105.SPY' },
  { sym: 'QQQ', zh: '纳指100', em: '105.QQQ' },
  { sym: 'NVDA', zh: '英伟达', em: '105.NVDA' },
  { sym: 'AAPL', zh: '苹果', em: '105.AAPL' },
  { sym: 'MSFT', zh: '微软', em: '105.MSFT' },
  { sym: 'TSLA', zh: '特斯拉', em: '105.TSLA' },
  { sym: 'META', zh: 'Meta', em: '105.META' },
  { sym: 'AMZN', zh: '亚马逊', em: '105.AMZN' },
  { sym: 'GOOGL', zh: '谷歌', em: '105.GOOGL' },
  { sym: 'AMD', zh: 'AMD', em: '105.AMD' },
  { sym: 'MU', zh: '美光', em: '105.MU' },
  { sym: 'SNDK', zh: '闪迪', em: '105.SNDK' },
  { sym: 'ASML', zh: '阿斯麦', em: '105.ASML' },
  { sym: 'INTC', zh: '英特尔', em: '105.INTC' },
  { sym: 'MSTR', zh: '微策略', em: '105.MSTR' },
  { sym: 'COIN', zh: 'Coinbase', em: '105.COIN' }
];
// 指数（东方财富代码）
const INDEXES = [
  { sym: '.IXIC', zh: '纳指', em: '100.NDX' },
  { sym: '.INX', zh: '标普500', em: '100.SPX' },
  { sym: '.DJI', zh: '道指', em: '100.DJIA' }
];
// OKX 兜底映射
const OKX_FALLBACK = {
  SPY: 'SPY-USDT-SWAP', QQQ: 'QQQ-USDT-SWAP', NVDA: 'NVDA-USDT-SWAP', AAPL: 'AAPL-USDT-SWAP',
  MSFT: 'MSFT-USDT-SWAP', TSLA: 'TSLA-USDT-SWAP', META: 'META-USDT-SWAP', AMZN: 'AMZN-USDT-SWAP',
  GOOGL: 'GOOGL-USDT-SWAP', AMD: 'AMD-USDT-SWAP', MU: 'MU-USDT-SWAP', SNDK: 'SNDK-USDT-SWAP',
  ASML: 'ASML-USDT-SWAP', INTC: 'INTC-USDT-SWAP', MSTR: 'MSTR-USDT-SWAP', COIN: 'COIN-USDT-SWAP'
};

/* ---------------- 交易时段判定（美东，自动处理夏令时） ---------------- */
function etNow(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    weekday: 'short', hour: '2-digit', minute: '2-digit'
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { wd, hh: Number(p.hour) % 24, mm: Number(p.minute) };
}
/** 是否美东夏令时（EDT）：3月第2个周日 ~ 11月第1个周日 */
function isDST(d = new Date()) {
  const y = d.getUTCFullYear();
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })
    .formatToParts(d).find(x => x.type === 'timeZoneName');
  return !!off && /EDT/i.test(off.value);
}
/** 北京时间的开盘小时：夏令时 21:30，冬令时 22:30 */
function openHourBJ(d = new Date()) { return isDST(d) ? 21 : 22; }
/** 当前处于哪个场次（北京时区判定，cron 用） */
function sessionNow(d = new Date()) {
  const { wd, hh, mm } = etNow(d);
  const mins = hh * 60 + mm;
  let day = wd;
  if (day === 6) day = 0;           // 周六凌晨 -> 视为周五盘后
  if (day === 0 || day === 6) return 'closed';
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'premarket';
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'open';
  if (mins >= 16 * 60 && mins < 20 * 60) return 'afterhours';
  return 'closed';
}

/* ---------------- 数据源 ① 新浪美股 gb_（含盘前盘后） ---------------- */
async function sinaQuote(syms) {
  const list = syms.map(s => 'gb_' + s.toLowerCase().replace(/^\./, '')).join(',');
  const r = await fetch('https://hq.sinajs.cn/list=' + list, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error('sina_http_' + r.status);
  const txt = await r.text();
  const out = {};
  const re = /hq_str_gb_([a-z0-9.]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(txt))) {
    const sym = m[1].toUpperCase();
    const f = m[2].split(',');
    if (f.length < 10) continue;
    const price = Number(f[1]);
    const chgPct = Number(f[2]);
    if (!Number.isFinite(price) || price <= 0) continue;
    out[sym] = {
      sym, price, chgPct,
      chg: Number(f[4]), prevClose: Number(f[26]) || (price - Number(f[4] || 0)),
      open: Number(f[5]), high: Number(f[6]), low: Number(f[7]),
      time: f[3] || '', src: 'sina'
    };
    // 盘前/盘后价（新浪 f[22] 为盘前最新价，f[23]/f[24] 为对应涨跌幅）
    // 盘前/盘后价：仅在当前处于盘前(4:00-9:30 ET)或盘后(16:00-20:00 ET)时才采用，
    // 否则新浪该字段是上一场次的陈旧价，会误报"盘前异动"
    const sess = _sessCache || (_sessCache = sessionNow());
    const pre = Number(f[22]);
    const preChg = Number(f[23]);
    if ((sess === 'premarket' || sess === 'afterhours') && Number.isFinite(pre) && pre > 0 && Number.isFinite(preChg)) {
      out[sym].prePrice = pre;
      out[sym].preChgPct = preChg;
    }
  }
  return out;
}

/* ---------------- 数据源 ② 东方财富（兜底正股 + 指数） ---------------- */
async function emQuote(items) {
  const secids = items.map(x => x.em).join(',');
  const r = await fetch(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${encodeURIComponent(secids)}&fields=f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error('em_http_' + r.status);
  const j = await r.json();
  const diff = (j && j.data && j.data.diff) || [];
  const out = {};
  for (const x of diff) {
    const price = Number(x.f2);
    if (!Number.isFinite(price) || price <= 0) continue;
    out[String(x.f12).toUpperCase()] = {
      sym: String(x.f12).toUpperCase(), price,
      chgPct: Number(x.f3), chg: Number(x.f4),
      open: Number(x.f17), high: Number(x.f15), low: Number(x.f16), prevClose: Number(x.f18),
      name: x.f14, src: 'eastmoney'
    };
  }
  return out;
}

/* ---------------- 数据源 ③ 本地 OKX 兜底 ---------------- */
function okxFallback(db, syms) {
  const out = {};
  try {
    const q = db.prepare('SELECT symbol,price,change_pct,ts FROM asset_prices WHERE symbol=? ORDER BY ts DESC LIMIT 1');
    for (const s of syms) {
      const inst = OKX_FALLBACK[s];
      if (!inst) continue;
      const r = q.get(inst);
      if (r && Number(r.price) > 0) out[s] = { sym: s, price: Number(r.price), chgPct: Number(r.change_pct || 0), ts: r.ts, src: 'okx_perp' };
    }
  } catch (e) { warn('[us_open] okx fallback:', e.message); }
  return out;
}

/** 聚合快照：sina → eastmoney → okx */
async function snapshot(db) {
  const want = WATCH.map(x => x.sym);
  let quotes = {};
  let src = 'none';
  try {
    quotes = await sinaQuote(want);
    if (Object.keys(quotes).length >= 5) src = 'sina';
  } catch (e) { warn('[us_open] sina 失败:', e.message); }
  if (src === 'none') {
    try {
      const em = await emQuote(WATCH);
      for (const [k, v] of Object.entries(em)) quotes[k] = v;
      if (Object.keys(quotes).length >= 5) src = 'eastmoney';
    } catch (e) { warn('[us_open] eastmoney 失败:', e.message); }
  }
  if (Object.keys(quotes).length < 5) {
    const fb = okxFallback(db, want);
    quotes = Object.assign(fb, quotes);
    if (Object.keys(quotes).length) src = 'okx_perp';
  }
  // 指数
  let idx = {};
  try { idx = await emQuote(INDEXES); } catch (e) { warn('[us_open] 指数失败:', e.message); }
  return { quotes, idx, src, ts: Date.now() };
}

/* ---------------- 播报正文 ---------------- */
function fmtPct(v) { const n = Number(v); if (!Number.isFinite(n)) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtPx(v) { const n = Number(v); if (!Number.isFinite(n)) return '—'; return n >= 1000 ? n.toFixed(0) : n >= 100 ? n.toFixed(2) : n.toFixed(2); }

function buildBrief(kind, snap, extra = {}) {
  const { quotes, idx, src, ts } = snap;
  const bj = new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const L = [];
  const title = kind === 'premarket' ? '美股盘前播报' : kind === 'open' ? '美股开盘播报' : kind === 'afterhours' ? '美股盘后播报' : '美股收盘复盘';
  L.push(`🇺🇸【W1·${title}】${bj} 北京`);
  L.push(`数据源：${src === 'sina' ? '新浪美股实时' : src === 'eastmoney' ? '东方财富实时' : 'OKX代币化永续(兜底)'}`);

  if (Object.keys(idx).length) {
    const ip = INDEXES.map(x => { const q = idx[x.em.split('.')[1]] || idx[x.em] || Object.values(idx).find(v => v.sym === x.em.split('.')[1]); return q ? `${x.zh} ${fmtPx(q.price)} ${fmtPct(q.chgPct)}` : null; }).filter(Boolean);
    if (ip.length) L.push('📊 ' + ip.join(' ｜ '));
  } else {
    const sp = quotes.SPY, qq = quotes.QQQ;
    if (sp || qq) L.push('📊 ' + [sp ? `标普ETF ${fmtPx(sp.price)} ${fmtPct(sp.chgPct)}` : null, qq ? `纳指ETF ${fmtPx(qq.price)} ${fmtPct(qq.chgPct)}` : null].filter(Boolean).join(' ｜ '));
  }

  // 个股按涨跌排序展示（只列有数据的）
  const rows = WATCH.map(w => ({ ...w, q: quotes[w.sym] })).filter(r => r.q && Number.isFinite(r.q.price));
  rows.sort((a, b) => Number(b.q.chgPct || 0) - Number(a.q.chgPct || 0));
  const up = rows.filter(r => Number(r.q.chgPct) > 0).length;
  const down = rows.filter(r => Number(r.q.chgPct) < 0).length;

  if (rows.length) {
    const top = rows.slice(0, 3).map(r => `${r.sym} ${fmtPct(r.q.chgPct)}`).join('｜');
    const bot = rows.slice(-3).reverse().map(r => `${r.sym} ${fmtPct(r.q.chgPct)}`).join('｜');
    L.push(`🔺 领涨 ${top}`);
    L.push(`🔻 领跌 ${bot}`);
    // 关键票
    const key = ['NVDA', 'TSLA', 'AAPL', 'SNDK', 'MU'].map(s => rows.find(r => r.sym === s)).filter(Boolean);
    if (key.length) L.push('⭐ ' + key.map(r => `${r.zh} ${fmtPx(r.q.price)}(${fmtPct(r.q.chgPct)})`).join(' ｜ '));
    L.push(`📈 涨跌家数 ${up}涨 / ${down}跌（观察池 ${rows.length} 只）`);
  } else {
    L.push('⚠️ 暂无正股行情数据，请检查数据源');
  }

  // 盘前/盘后异动
  const pre = rows.filter(r => Number.isFinite(Number(r.q.preChgPct)) && Math.abs(Number(r.q.preChgPct)) >= 2);
  if (pre.length && kind === 'premarket') {
    L.push('⚡ 盘前异动 ' + pre.slice(0, 5).map(r => `${r.sym} ${fmtPct(r.q.preChgPct)}`).join('｜'));
  }

  if (extra.macro && extra.macro.length) L.push('🌐 ' + extra.macro.join(' ｜ '));
  L.push(kind === 'open' ? '💡 开盘30分钟不追单，等首根K线定型；财报敏感期禁做空' : kind === 'premarket' ? '💡 盘前流动性差仅观察，禁按盘前价追单' : '💡 复盘为主，次日计划按开盘前数据再定');
  L.push('⚠️ 仅供研究参考，不构成投资建议');
  return L.join('\n');
}

/* ---------------- 宏观/加密联动（可选） ---------------- */
function macroLines(db) {
  const out = [];
  try {
    const { kvGet: kg } = require('./db');
    const b = kg(db, 'macro_indicators', null);
    if (b && b.riskAppetite) out.push(`风险偏好 ${b.riskAppetite.state}(${b.riskAppetite.score})`);
    if (b && b.yieldCurve && b.yieldCurve.s10_3m != null) out.push(`10Y-3M ${b.yieldCurve.s10_3m}bp${b.yieldCurve.inverted ? ' ⚠️倒挂' : ''}`);
    const r = db.prepare('SELECT price,change_pct FROM asset_prices WHERE symbol=? ORDER BY ts DESC LIMIT 1').get('BTC-USDT-SWAP');
    if (r && Number(r.price) > 0) out.push(`BTC $${fmtPx(r.price)}(${fmtPct(r.change_pct)})`);
  } catch (e) { /* 静默 */ }
  return out;
}

/* ---------------- 发送 + 去重 ---------------- */
function todayKey(kind) {
  const d = new Date();
  const ds = new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return `us_open:${ds}:${kind}`;
}

async function run(ctx, kind, opts = {}) {
  const { env, db } = ctx;
  const key = todayKey(kind);
  if (!opts.force && !opts.dryRun) {
    const last = kvGet(db, key, null);
    if (last) { info(`[us_open] ${key} 已推过，跳过`); return { ok: true, skipped: true }; }
  }
  const snap = await snapshot(db);
  const brief = buildBrief(kind, snap, { macro: macroLines(db) });
  if (opts.dryRun) return { ok: true, dryRun: true, text: brief, src: snap.src };
  let sent = false;
  try {
    const { pushToGroup } = require('./qqbot');
    // 方向A：开盘播报推「信号群」；盘前/盘后推「监测群」（env 未配置时 pushToGroup 自动回退）
    const type = kind === 'open' ? 'signal' : 'monitor';
    sent = await pushToGroup(env, db, brief, type);
  } catch (e) { warn('[us_open] 推送失败:', e.message); }
  if (sent) { kvSet(db, key, Date.now()); info(`[us_open] ${kind} 播报已推送(${snap.src})`); }
  else warn('[us_open] 播报未送达');
  return { ok: sent, text: brief, src: snap.src };
}

/** cron 入口：北京时间整点触发，自行判定场次（自动识别夏令时） */
async function cronRun(ctx, want) {
  const kind = sessionNow();
  if (kind === 'closed') { info('[us_open] 非交易场次窗口，跳过'); return { ok: true, skipped: true }; }
  if (want && kind !== want) {
    // 开盘场次做夏令时校验：21:30 那班在冬令时对应的是美东 8:30（未开盘），顺延到 22:30 再推
    if (want === 'open' && kind === 'premarket') { info('[us_open] 冬令时，开盘播报顺延 1 小时'); return { ok: true, skipped: true }; }
    return { ok: true, skipped: true };
  }
  return run(ctx, kind);
}

module.exports = { run, cronRun, sessionNow, isDST, openHourBJ, snapshot, buildBrief, WATCH, INDEXES };
