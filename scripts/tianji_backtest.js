'use strict';
// ═══════════════════════════════════════════════════════════
// TIANJI 五维回测引擎 v3 (2026-08-21) —— 专业自定义回测
// 同口径移植实盘 lib/tianji.js（CFG/门控/仓位/结算全部对齐），历史重建口径：
//   消息面 news_hist 真实（8/02 起）、KOL共识 consensus_hist（8/11 起）、tech/fund/qibao 真实重建
// 自定义参数：--cfg '{"min_score":4.5,"t2_mult":2.0,...}'（默认值 = 实盘当前 CFG，见 lib/tianji_bt_cfg.js）
// 专业绩效：年化CAGR/夏普/索提诺/卡玛/波动率/回撤持续/期望值/连赢连亏/B&H对比/月度表
// 用法:
//   node tianji_backtest.js --ui --llm --cfg '{"daily_limit":5,"atr_mult":3}'   # UI 自定义
//   node tianji_backtest.js --cfg-file /tmp/cfg.json
//   node tianji_backtest.js --from 2026-03-08 --to 2026-06-01 --list-trades
//   node tianji_backtest.js --split | --no-cost | --no-compound | --lev 1
// 输出: data/tianji_bt_report_YYYYMMDD.json + trades/equity CSV + 控制台摘要
// ═══════════════════════════════════════════════════════════
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { loadEnv } = require('../lib/env');
const ai = require('../lib/ai');
const { DEFAULTS, PRESETS } = require('../lib/tianji_bt_cfg');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.argv.includes('--db')
  ? path.resolve(process.argv[process.argv.indexOf('--db') + 1])
  : path.join(ROOT, 'data', 'tianji_full.sqlite');
const LIST_TRADES = process.argv.includes('--list-trades');
const SPLIT = process.argv.includes('--split');
const UI_MODE = process.argv.includes('--ui');          // UI 模式：写 state/latest 文件（routes 调用）
const LLM_GAP_MS = 1200;                                // LLM 串行限流（不挤占实盘 AI 用量）
const argVal = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

// ── 自定义参数：--cfg JSON / --cfg-file / 旧 CLI 兼容参数 合并覆盖 ──
const CFG = Object.assign({}, DEFAULTS);
const cfgFile = argVal('--cfg-file', null);
if (cfgFile) { try { Object.assign(CFG, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch (e) { console.error('cfg-file 解析失败:', e.message); process.exit(1); } }
const cfgJson = argVal('--cfg', null);
if (cfgJson) { try { Object.assign(CFG, JSON.parse(cfgJson)); } catch (e) { console.error('--cfg JSON 解析失败:', e.message); process.exit(1); } }
const presetName = argVal('--preset', null);
if (presetName) {
  const p = PRESETS[presetName];
  if (p) { Object.assign(CFG, p.params); console.log(`预设: ${p.name}（${p.note}）`); }
  else { console.error('未知预设:', presetName, '可选:', Object.keys(PRESETS).join('/')); process.exit(1); }
}
// 旧 CLI 兼容（优先级低于 --cfg）
if (process.argv.includes('--no-cost')) CFG.cost_bps = 0;
if (process.argv.includes('--no-compound')) CFG.compound = false;
if (process.argv.includes('--no-llm')) CFG.llm = false;
if (process.argv.includes('--llm')) CFG.llm = true;
if (process.argv.includes('--no-news')) CFG.news = false;
if (process.argv.includes('--lev')) CFG.leverage = +argVal('--lev', CFG.leverage);
if (process.argv.includes('--cost-bps')) CFG.cost_bps = +argVal('--cost-bps', CFG.cost_bps);
if (process.argv.includes('--capital')) CFG.capital = +argVal('--capital', CFG.capital);
const LLM = CFG.llm, WITH_NEWS = CFG.news, WITH_COST = CFG.cost_bps > 0, COMPOUND = CFG.compound;
const LEV = CFG.leverage, ACCOUNT0 = CFG.capital, MAX_TOTAL_LEV = CFG.max_total_lev, MAX_HOLD_H = CFG.max_hold_h, COST_BPS = CFG.cost_bps;
// 复现模式：5m tick（tech/门控对齐实盘 30×5min 快照逻辑），默认窗口=完整五维边界 8/11 起
const REPLAY = CFG.tick === '5m' || process.argv.includes('--replay');
// 2026-08-31 在线进化模式 v2：专家池 + Hedge 在线混合（--evo）
const EVO = process.argv.includes('--evo');
const EVO_EXPERTS = [
  { id: 'e_current', w: { news: 0.2, tech: 1.2, fund: 0.8, con: 0.3, qibao: 1.6 } },
  { id: 'e_tech',    w: { news: 0.2, tech: 1.6, fund: 0.6, con: 0.2, qibao: 1.4 } },
  { id: 'e_qib',     w: { news: 0.1, tech: 1.0, fund: 0.6, con: 0.2, qibao: 2.0 } },
  { id: 'e_balance', w: { news: 0.5, tech: 1.0, fund: 1.0, con: 0.5, qibao: 1.0 } },
  { id: 'e_conserv', w: { news: 0.2, tech: 0.8, fund: 0.8, con: 0.3, qibao: 1.2 } },
  { id: 'e_fund',    w: { news: 0.2, tech: 0.8, fund: 1.4, con: 0.3, qibao: 1.4 } },
  { id: 'e_news',    w: { news: 0.8, tech: 1.0, fund: 0.8, con: 0.5, qibao: 1.2 } },
  { id: 'e_equal',   w: { news: 0.82, tech: 0.82, fund: 0.82, con: 0.82, qibao: 0.82 } },
];
// 2026-08-31 v5 机构级改进（对齐实盘 lib/tianji_evo.js v5）：e_current 先验=1.0 + 30笔门控 + 影子战绩/晋升
const EVO_ETA = 0.3;
const EVO_PRIOR = 1.0;                        // e_current 先验（1.0 = 默认完全用当前CFG）
const EVO_MIN_N = 30;                         // 最小学习样本：少于 N 笔不更新（防早期噪声带偏）
let evoProbs = EVO_EXPERTS.reduce((a, e) => { a[e.id] = (e.id === 'e_current' ? EVO_PRIOR : 0); return a; }, {});
let evoN = 0;
const evoPerf = EVO_EXPERTS.reduce((a, e) => { a[e.id] = { trades: 0, correct: 0, pnl: 0 }; return a; }, {});  // v5 影子战绩
const evoPromotions = [];                     // v5 晋升记录
const DIMS_EVO = ['news', 'tech', 'fund', 'con', 'qibao'];
const LOGIC_V0814 = CFG.logic === 'v0814';   // 8/14-19 实盘打分逻辑（考古版）
const DIAG_LIVE = process.argv.includes('--diag-live');
// 实盘历史单（复现/诊断用）
const liveTrades = [];
try {
  const ldb = new Database(path.join(ROOT, 'data', 'w1.db'), { readonly: true });
  liveTrades.push(...ldb.prepare("SELECT pushed_at, symbol, direction, status, entry, pnl_pct, reason FROM signal_track WHERE strategy='TIANJI' ORDER BY pushed_at").all());
  ldb.close();
} catch (e) {}

const db = new Database(DB_PATH, { readonly: true });
const env = loadEnv();

// UI 状态文件
const UI_STATE = path.join(ROOT, 'data', 'tianji_bt_state.json');
const UI_LATEST = path.join(ROOT, 'data', 'tianji_bt_latest.json');
const BT_STARTED = Date.now();
let lastStateWrite = 0;
// 防并发：UI 模式下若已有存活回测进程则直接退出（routes 也会拦，双保险）
if (UI_MODE) {
  try {
    const prev = JSON.parse(fs.readFileSync(UI_STATE, 'utf8'));
    if (prev && prev.status === 'running' && prev.pid && prev.pid !== process.pid) {
      try { process.kill(prev.pid, 0); console.log('已有回测运行中 pid=' + prev.pid + '，退出'); process.exit(0); } catch (e) {}
    }
  } catch (e) {}
}
function writeState(phase, progress, message) {
  if (!UI_MODE) return;
  const now = Date.now();
  if (now - lastStateWrite < 1500 && phase !== 'report' && phase !== 'error') return; // 限频
  lastStateWrite = now;
  try {
    fs.writeFileSync(UI_STATE, JSON.stringify({ status: 'running', phase, progress: Math.round(progress), message, startedAt: BT_STARTED, pid: process.pid, updatedAt: now }));
  } catch (e) {}
}

// ═════ 全局常量 ═════
const TZ = 'Asia/Shanghai';
// 回测币种（前端多选；null=全部 9 币）
const ALL_SYMS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'ADA', 'XAU'];
const SYMS = (Array.isArray(CFG.symbols) && CFG.symbols.length) ? CFG.symbols.map(s => String(s).toUpperCase()) : ALL_SYMS;

// ═════ 数据预载（全部 O(1) 索引） ═════
const klines = {}, kIdx = {}, lsrAcc = {}, oiRows = {}, fundMap = {}, liqRows = {}, conRows = [], fgiRows = [];
// 5m tick 数据（复现模式）
const k5 = {};
if (REPLAY) {
  for (const s of SYMS) {
    k5[s] = db.prepare("SELECT * FROM klines WHERE symbol=? AND interval='5m' ORDER BY time").all(s);
    if (!k5[s].length) { console.error('⚠️ 5m K线缺失，请先: node scripts/tianji_fetch.js --interval 5m（' + s + '）'); process.exit(1); }
  }
}
const EX = 'OKX';
const pbDiag = { tot: 0, cand1: 0, cand2: 0, cand3: 0, fired: 0 };  // 因子交易所（与实盘 fund 数据同源：Coinglass markets 用 OKX 合约）
for (const s of SYMS) {
  klines[s] = db.prepare("SELECT * FROM klines WHERE symbol=? AND interval='4h' ORDER BY time").all(s);
  kIdx[s] = new Map(klines[s].map((k, i) => [k.time, i]));
  lsrAcc[s] = new Map(db.prepare('SELECT time, ratio FROM lsr_account WHERE exchange=? AND symbol=? ORDER BY time').all(EX, s).map(r => [r.time, r.ratio ? +r.ratio : 0]));
  oiRows[s] = db.prepare('SELECT time, close FROM oi_history WHERE exchange=? AND symbol=? ORDER BY time').all(EX, s);
  fundMap[s] = new Map(db.prepare('SELECT time, c FROM funding_hist WHERE exchange=? AND symbol=? ORDER BY time').all(EX, s).map(r => [r.time, r.c != null ? +r.c : 0]));
  liqRows[s] = db.prepare('SELECT time, long_usd, short_usd FROM liquidation_hist WHERE exchange=? AND symbol=? ORDER BY time').all(EX, s);
}
// tick 源：REPLAY 用 5m，否则 4h（必须在 klines 预载之后）
const TICK = {}, TIDX = {};
for (const s of SYMS) {
  TICK[s] = REPLAY ? k5[s] : klines[s];
  TIDX[s] = new Map(TICK[s].map((k, i) => [k.time, i]));
}
try { conRows.push(...db.prepare('SELECT ts, payload FROM consensus_hist ORDER BY ts').all().map(r => ({ time: r.ts, payload: r.payload }))); } catch (e) {}
try { fgiRows.push(...db.prepare('SELECT ts, value FROM fgi_hist ORDER BY ts').all().map(r => ({ time: r.ts, value: r.value }))); } catch (e) {}
// 实盘因子快照（snapshot_factors.js 每 5min 采集：未来回测用真实 qibao/fund 复现实盘；无数据时回退 4h 重建）
const snapRows = {};
for (const s of SYMS) {
  snapRows[s] = [];
  try { snapRows[s] = db.prepare('SELECT ts, oi_chg_24h, funding, lsr, qibao_raw FROM factor_snapshots WHERE symbol=? ORDER BY ts').all(s); } catch (e) {}
}
function snapAt(sym, tSec) {
  const rows = snapRows[sym];
  if (!rows.length) return null;
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].ts <= tSec) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 ? rows[ans] : null;
}
// 真实消息面：news_hist（w1.db + 备份库合并，8/02 起），按币关键词预分组
const KEYWORDS = {
  BTC: ['btc', 'bitcoin', '比特币', '大饼', 'crypto', '数字货币', '加密'],
  ETH: ['eth', 'ethereum', '以太坊', '以太'],
  SOL: ['sol', 'solana', '索拉纳'],
  BNB: ['bnb', 'binance coin', '币安'],
  XRP: ['xrp', 'ripple', '瑞波'],
  DOGE: ['doge', 'dogecoin', '狗狗币', '马斯克'],
  LINK: ['link', 'chainlink', '预言机'],
  ADA: ['ada', 'cardano', '卡尔达诺'],
  XAU: ['xau', 'gold', '黄金', '金价', '贵金属', 'comex'],
};
const newsAll = [];
try { newsAll.push(...db.prepare('SELECT ts, title, sentiment, influence FROM news_hist ORDER BY ts').all()); } catch (e) {}
const newsBySym = {};
const newsT0 = newsAll.length ? newsAll[0].ts : 0, newsT1 = newsAll.length ? newsAll[newsAll.length - 1].ts : 0;
for (const s of SYMS) {
  const kw = KEYWORDS[s] || [s.toLowerCase()];
  newsBySym[s] = newsAll.filter(r => kw.some(k => String(r.title).toLowerCase().includes(k)));
}
// 二分：news 数组内找 ts >= tSec-3h 的起点
function newsStartIdx(rows, tSec) {
  let lo = 0, hi = rows.length - 1, ans = rows.length;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].ts >= tSec - 3 * 3600) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  return ans;
}
// ═════ 维度1：消息面（实盘 newsScore 同口径：否定词翻转/加密去噪/influence 平滑/突发检测） ═════
const NEG = ['not', 'no ', 'unlikely', 'warn', '警告', '风险', '下跌', '回调', '利空', '跌破', '暴跌', '崩盘', '抛售', '不看好', '看空', '难涨', '受阻', '承压'];
const CRYPTO = ['crypto', 'bitcoin', 'btc', '加密', '比特币', '数字货币', '币市', '区块链', 'eth', 'ethereum', '山寨', 'altcoin', '稳定币', 'defi', 'nft'];
const wOf = inf => Math.log2(1 + (Number(inf) || 1));
// 8/14-19 实盘版 newsScore（考古 closepush 备份）：influence 直接加权、无否定词/去噪/中性稀释、global/120
function newsScoreV0814(sym, tSec) {
  const rows = newsBySym[sym];
  let bull = 0, bear = 0, coinBull = 0, coinBear = 0, coinTotal = 0;
  const start = rows && rows.length ? newsStartIdx(rows, tSec) : 0;
  if (rows) {
    for (let i = start; i < rows.length && rows[i].ts <= tSec; i++) {
      const n = rows[i]; const w = Number(n.influence || 1);
      if (n.sentiment === 'bullish') { coinBull += w; coinTotal++; }
      else if (n.sentiment === 'bearish') { coinBear += w; coinTotal++; }
    }
  }
  // global 用全部新闻（无去噪）
  const gstart = newsStartIdx(newsAll, tSec);
  for (let i = gstart; i < newsAll.length && newsAll[i].ts <= tSec; i++) {
    const n = newsAll[i]; const w = Number(n.influence || 1);
    if (n.sentiment === 'bullish') bull += w; else if (n.sentiment === 'bearish') bear += w;
  }
  let coinScore = 0;
  if (coinTotal >= 2) coinScore = (coinBull - coinBear) / coinTotal * 2;
  else if (coinTotal === 1) coinScore = (coinBull - coinBear) * 0.8;
  const globalNorm = Math.max(-0.5, Math.min(0.5, (bull - bear) / 120));
  return { score: +Math.max(-3, Math.min(3, coinScore + globalNorm)).toFixed(2), coin: coinBull - coinBear, coinTotal, global: +(bull - bear).toFixed(0), burst: 0 };
}
// 8/14-19 实盘版 qibaoScore：档位制（raw≥35→3, ≥15→2, ≥5→1, 负同理），无截面居中
function qibaoScoreV0814(raw) {
  if (raw >= 35) return 3; else if (raw >= 15) return 2; else if (raw >= 5) return 1;
  else if (raw <= -35) return -3; else if (raw <= -15) return -2; else if (raw <= -5) return -1;
  return 0;
}
// 重要影响力新闻分类（与实盘 lib/tianji.js 同口径，2026-08-24）
const IMPORTANT = [
  'fed', 'federal reserve', 'powell', 'fomc', 'jackson hole', 'warsh', '美联储', '鲍威尔', '杰克逊霍尔', '沃什',
  '央行', '加息', '降息', '利率', 'cpi', '通胀', '非农', 'nfp', '美债', 'treasury', '国债', 'tariff', '关税',
  'crypto', 'bitcoin', 'btc', 'ethereum', 'eth', '加密', '比特币', '以太坊', '山寨', 'altcoin', '稳定币',
  'defi', 'nft', '币安', 'binance', '交易所', '现货etf', 'etf',
  'war', '战争', '冲突', '导弹', 'missile', '制裁', 'sanction', '地缘', 'geopolitic', '选举', 'election',
  '白宫', 'white house', '乌克兰', 'ukraine', '俄罗斯', 'russia', '中东', 'middle east', '伊朗', 'iran',
  '以色列', 'israel', '胡塞', 'houthi', '特朗普', 'trump',
  'crash', '闪崩', '暴跌', '暴涨', 'surge', 'plunge', '清算', 'liquidation', '爆仓', '熔断', '崩盘',
  'hack', '黑客', 'exploit', '漏洞', '破产', 'bankruptcy', '黑天鹅', 'black swan', 'whale', '巨鲸', '鲸鱼',
  'twap', 'inflow', '流入', '流出', '大额'
];
function isImportantNews(t) {
  const tl = String(t || '').toLowerCase();
  return IMPORTANT.some(k => tl.includes(k));
}
function newsScore(sym, tSec) {
  const rows = newsBySym[sym];
  if (!rows || !rows.length) return { score: 0, coin: 0, coinTotal: 0, global: 0, burst: 0 };
  const start = newsStartIdx(rows, tSec);
  let bull = 0, bear = 0, coinBull = 0, coinBear = 0, coinNeutral = 0, coinTotal = 0, burst = 0, burstBull = 0, burstBear = 0;
  for (let i = start; i < rows.length && rows[i].ts <= tSec; i++) {
    const n = rows[i];
    const tl = String(n.title || '').toLowerCase();
    const w = wOf(n.influence);
    const hasNeg = NEG.some(neg => tl.includes(neg));
    let senti = n.sentiment;
    if (hasNeg) { if (senti === 'bullish') senti = 'bearish'; else if (senti === 'bearish') senti = 'bullish'; }
    const isCrypto = CRYPTO.some(c => tl.includes(c));
    if (senti === 'bullish') { if (isCrypto) bull += w; coinBull += w; coinTotal++; }
    else if (senti === 'bearish') { if (isCrypto) bear += w; coinBear += w; coinTotal++; }
    else if (senti === 'neutral') { coinNeutral++; coinTotal++; }
    if (Number(n.influence || 0) >= 4 && senti !== 'neutral' && isImportantNews(tl)) {
      if (senti === 'bullish') burstBull++; else burstBear++;
    }
  }
  const global = bull - bear;
  let coinScore = 0;
  const coinNet = coinBull - coinBear;
  if (coinTotal >= 3) { coinScore = coinNet / coinTotal * 2; const neutralRatio = coinNeutral / coinTotal; if (neutralRatio > 0.6) coinScore *= 0.5; }
  else if (coinTotal === 2) coinScore = coinNet / 2 * 0.8;
  else if (coinTotal === 1) coinScore = coinNet * 0.6;
  const globalNorm = Math.max(-0.5, Math.min(0.5, global / 40));
  const score = Math.max(-3, Math.min(3, coinScore + globalNorm));
  return { score: +score.toFixed(2), coin: coinNet, coinTotal, global: +global.toFixed(0), burst, burstBull, burstBear };
}

// 二分查找：最后一个 time <= tMs 的行
function lastLe(arr, tMs) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].time <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function nearestMap(map, tMs) {
  let b = null;
  for (const k of map.keys()) { if (k <= tMs && (b === null || k > b)) b = k; }
  return b;
}

// ═════ 指标 ═════
function smaArr(arr, n) { if (arr.length < n) return null; let s = 0; for (let i = arr.length - n; i < arr.length; i++) s += arr[i]; return s / n; }
function atrPctOf(bars, n = 14) {
  if (bars.length < n + 1) return 0.5;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) s += Math.max(bars[i].h, bars[i - 1].h) - Math.min(bars[i].l, bars[i - 1].l);
  return (s / n) / bars[bars.length - 1].c * 100;
}
// 趋势过滤（实盘 signal.trendFilter 多级 SMA 排列；4h 近似）
function trendFilter(arr) {
  if (!Array.isArray(arr) || arr.length < 13) return 'neutral';
  const px = arr[arr.length - 1];
  const s3 = smaArr(arr, 3), s6 = smaArr(arr, 6), s12 = smaArr(arr, 12);
  if (s3 === null || s6 === null || s12 === null) return 'neutral';
  if (px > s3 && s3 > s6 && s6 > s12) return 'long';
  if (px < s3 && s3 < s6 && s6 < s12) return 'short';
  return 'neutral';
}
function structLevels(arr, n = 8) { if (arr.length < 2) return null; const sl = arr.slice(-n); return { high: Math.max(...sl), low: Math.min(...sl) }; }

// ═════ 体制判定辅助（2026-08-31 对齐 lib/regime.js：ADX<18 + 布林带宽分位<60% → RANGE） ═════
// 日线 bars：4h K线按 UTC 日聚合（预缓存一次，回测窗口内不变）
function buildD1Bars(sym) {
  const bars = klines[sym];
  if (!bars || !bars.length) return null;
  const dayMap = new Map();
  for (const b of bars) {
    const d = new Date(b.time);
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const cur = dayMap.get(key);
    if (!cur) dayMap.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  return [...dayMap.values()].sort((a, b) => a.t - b.t);
}
const d1CacheMap = {};
function d1BarsFor(sym, tMs) {
  if (!d1CacheMap[sym]) d1CacheMap[sym] = buildD1Bars(sym);
  const d1 = d1CacheMap[sym];
  if (!d1) return null;
  // 截至 tMs（无未来函数：只含已收盘的 4h bar，b.t < tMs；不含开盘中的当前 bar）
  const out = [];
  for (const b of d1) { if (b.t < tMs) out.push(b); else break; }
  return out.length >= 40 ? out : null;
}
// ADX（Wilder 平滑，与 lib/regime.js 逐行同口径）
function adxCalcBars(bars, n = 14) {
  const out = new Array(bars.length).fill(0);
  let pDM = 0, mDM = 0, trSum = 0;
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    const pDm = up > dn && up > 0 ? up : 0;
    const mDm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    if (i <= n) { pDM += pDm; mDM += mDm; trSum += tr; if (i < n) continue; }
    else { pDM = pDM - pDM / n + pDm; mDM = mDM - mDM / n + mDm; trSum = trSum - trSum / n + tr; }
    const pdi = 100 * pDM / (trSum || 1), mdi = 100 * mDM / (trSum || 1);
    const dx = 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1);
    out[i] = i === n ? dx : (out[i - 1] * (n - 1) + dx) / n;
  }
  return out;
}
// 布林带宽当前值 / 近120日分位（与 lib/regime.js bbWidthPct 同口径）
function bbWidthPctD1(bars) {
  const n = 20;
  const arr = bars.map(b => b.c);
  const i = arr.length - 1;
  if (i < n - 1) return null;
  const seg = arr.slice(i - n + 1, i + 1);
  const m = seg.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(seg.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  const last = arr[i];
  const cur = sd === 0 ? 0 : ((m + 2 * sd) - (m - 2 * sd)) / last;
  const hist = [];
  for (let j = Math.max(n - 1, arr.length - 120); j <= i; j++) {
    const seg2 = arr.slice(j - n + 1, j + 1);
    if (seg2.length < n) continue;
    const m2 = seg2.reduce((a, b) => a + b, 0) / n;
    const sd2 = Math.sqrt(seg2.reduce((a, b) => a + (b - m2) ** 2, 0) / n);
    const l2 = arr[j];
    if (sd2 === 0) hist.push(0); else hist.push(((m2 + 2 * sd2) - (m2 - 2 * sd2)) / l2);
  }
  if (hist.length < 30) return null;
  const sorted = [...hist].sort((a, b) => a - b);
  return sorted.filter(x => x <= cur).length / sorted.length;
}

// ═════ 维度2：技术面 B方案（2026-08-22）——4h主趋势定方向 + 16h确认 + 4h ATR ═════
// 回测标准模式输入为 4h bars：chg4h=最近1根4h动量，chg16h=最近4根(16h)主趋势
function techScore(bars) {
  const n = bars.length; if (n < 20) return { score: 0, atrPct: 0.5 };
  const arr = bars.map(b => b.c);
  const chg4h = (arr[n - 1] - arr[n - 2]) / arr[n - 2] * 100;
  const chg16h = (arr[n - 1] - arr[n - 5]) / arr[n - 5] * 100;
  const atrPct = atrPctOf(bars, 14);
  const v6 = bars.slice(-6).reduce((a, b) => a + b.v, 0), vP6 = bars.slice(-12, -6).reduce((a, b) => a + b.v, 0);
  const volChg = vP6 > 0 ? (v6 - vP6) / vP6 * 100 : 0;
  let score = 0;
  // 16h 主趋势：定方向（权重高）
  if (chg16h >= 0.8) score += 1.5; else if (chg16h >= 0.3) score += 0.9;
  else if (chg16h <= -0.8) score -= 1.5; else if (chg16h <= -0.3) score -= 0.9;
  // 4h 确认：同向加分、反向压制
  if (chg4h >= 0.3) score += 0.9; else if (chg4h >= 0.1) score += 0.5;
  else if (chg4h <= -0.3) score -= 0.9; else if (chg4h <= -0.1) score -= 0.5;
  if (atrPct >= 0.25 && Math.abs(chg16h) >= 0.5) score += 0.6;
  // 量能确认（实盘 coin.volume_change_percent_24h）
  if (Math.abs(chg16h) >= 0.3) {
    if (volChg >= 30 && chg16h > 0) score += 0.6;
    else if (volChg >= 30 && chg16h < 0) score -= 0.6;
    else if (volChg <= -20 && chg16h > 0) score -= 0.4;
    else if (volChg <= -20 && chg16h < 0) score += 0.4;
  }
  score = Math.max(-3, Math.min(3, score));
  return { score: +score.toFixed(2), atrPct: +atrPct.toFixed(3), chg1: +chg4h.toFixed(2), chg4: +chg16h.toFixed(2), chg4h: +chg4h.toFixed(2), chg16h: +chg16h.toFixed(2), volChg: +volChg.toFixed(1) };
}

// 5m tick 技术分 B方案（对齐实盘 techScore：4h主趋势=48根5m + 1h确认=12根5m + ATR14×4h）
function techScoreTick(bars, volChg4) {
  const n = bars.length; if (n < 20) return { score: 0, atrPct: 0.15, chg1: 0, chg4: 0, chg15: 0, chg60: 0 };
  const arr = bars.map(b => b.c);
  const last = arr[n - 1];
  const B1 = 12, B4 = 48;
  const chg1h = (last - (arr[n - 1 - B1] || last)) / (arr[n - 1 - B1] || last) * 100;
  const chg4h = (last - (arr[n - 1 - B4] || last)) / (arr[n - 1 - B4] || last) * 100;
  // ATR14 × 4h（在 4h 采样点上算）
  const b4 = [];
  for (let i = n - 1 - B4 * 3; i < n; i += B4) if (arr[i] != null) b4.push(arr[i]);
  if (b4.length < 2) { for (let i = n - 1; i >= 0; i -= B4) if (arr[i] != null) b4.unshift(arr[i]); }
  let ts = 0; for (let i = 1; i < b4.length; i++) ts += Math.abs(b4[i] - b4[i - 1]);
  const atrPct = b4.length >= 2 ? (ts / (b4.length - 1)) / last * 100 : 0.5;
  let score = 0;
  if (chg4h >= 0.8) score += 1.5; else if (chg4h >= 0.3) score += 0.9;
  else if (chg4h <= -0.8) score -= 1.5; else if (chg4h <= -0.3) score -= 0.9;
  if (chg1h >= 0.3) score += 0.9; else if (chg1h >= 0.1) score += 0.5;
  else if (chg1h <= -0.3) score -= 0.9; else if (chg1h <= -0.1) score -= 0.5;
  if (atrPct >= 0.25 && Math.abs(chg4h) >= 0.5) score += 0.6;
  if (volChg4 != null && Math.abs(chg4h) >= 0.3) {
    if (volChg4 >= 30 && chg4h > 0) score += 0.6;
    else if (volChg4 >= 30 && chg4h < 0) score -= 0.6;
    else if (volChg4 <= -20 && chg4h > 0) score -= 0.4;
    else if (volChg4 <= -20 && chg4h < 0) score += 0.4;
  }
  score = Math.max(-3, Math.min(3, score));
  return { score: +score.toFixed(2), atrPct: +atrPct.toFixed(3), chg1: +chg1h.toFixed(2), chg4: +chg4h.toFixed(2), chg15: +chg1h.toFixed(2), chg60: +chg4h.toFixed(2) };
}
function volChg4Of(bars) {
  const v6 = bars.slice(-6).reduce((a, b) => a + b.v, 0), vP6 = bars.slice(-12, -6).reduce((a, b) => a + b.v, 0);
  return vP6 > 0 ? (v6 - vP6) / vP6 * 100 : 0;
}

// ═════ 维度3：资金面（OI 24h / 费率(百分数→小数) / LSR 散户账户比） ═════
function fundScore(sym, tMs, chg24) {
  let score = 0; const d = [];
  const iNow = lastLe(oiRows[sym], tMs), iPrev = lastLe(oiRows[sym], tMs - 86400000);
  const oiNow = iNow >= 0 ? +oiRows[sym][iNow].close : 0;
  const oiPrev = iPrev >= 0 ? +oiRows[sym][iPrev].close : 0;
  const oiChg = oiPrev > 0 ? (oiNow - oiPrev) / oiPrev * 100 : 0;
  if (Math.abs(oiChg) >= 3) {
    if (oiChg > 0 && chg24 > 0) { score += 1.2; d.push(`OI增仓上涨(+${oiChg.toFixed(1)}%)`); }
    else if (oiChg > 0 && chg24 < 0) { score -= 1.2; d.push(`OI增仓下跌(${oiChg.toFixed(1)}%)`); }
    else if (oiChg < 0 && chg24 < 0) { score += 0.6; d.push('OI减仓抛压衰竭'); }
  }
  // Coinglass 费率单位=百分数 → /100 转小数（对齐实盘 avg_funding_rate_by_oi 口径）
  const fundPct = fundMap[sym].get(nearestMap(fundMap[sym], tMs)) || 0;
  const fund = fundPct / 100;
  if (fund <= -0.0003) { score += 1.0; d.push(`负费率空挤(${(fund * 100).toFixed(3)}%)`); }
  else if (fund >= 0.0008) { score -= 1.0; d.push(`正费率多挤(${(fund * 100).toFixed(3)}%)`); }
  const lsr = lsrAcc[sym].get(nearestMap(lsrAcc[sym], tMs)) || 0;
  if (lsr > 0) {
    if (lsr >= 1.6) { score -= 1.0; d.push(`散户偏多(${lsr.toFixed(2)})反向`); }
    else if (lsr <= 0.6) { score += 1.0; d.push(`散户偏空(${lsr.toFixed(2)})反向`); }
  }
  score = Math.max(-3, Math.min(3, score));
  return { score: +score.toFixed(2), oiChg: +oiChg.toFixed(1), fundPct, lsr: +lsr.toFixed(2), detail: d };
}

// ═════ 维度5：清算技术因子（qibao7.js 7因子权重 [1.2,1.0,0.8,0.8,1.0,0.7,1.0] 总 6.5，历史重建） ═════
function qibaoRaw(sym, bars, tMs, oiChg, fundPct, lsr) {
  const arr = bars.map(b => b.c);
  const n = arr.length; if (n < 7) return 0;
  const price = arr[n - 1];
  const chg24 = (price - arr[n - 7]) / arr[n - 7] * 100;
  const volNow = bars[n - 1].v, volAvg = bars.slice(-7, -1).reduce((a, b) => a + b.v, 0) / 6;
  const volChg = volAvg > 0 ? (volNow - volAvg) / volAvg * 100 : 0;
  const liqI = lastLe(liqRows[sym], tMs);
  const liq = liqI >= 0 ? liqRows[sym][liqI] : null;
  const long24 = liq ? +liq.long_usd : 0, short24 = liq ? +liq.short_usd : 0;
  const total24 = long24 + short24;
  const f = [];
  // 1 量能结构 w1.2
  if (chg24 < -0.3) { if (volChg < 0) f.push(0.8 * 1.2); else if (volChg > 40) f.push(-0.9 * 1.2); else f.push(0.2 * 1.2); }
  else if (chg24 > 0.3) { if (volChg > 30) f.push(0.6 * 1.2); else f.push(0.1 * 1.2); }
  else { if (Math.abs(volChg) < 20) f.push(0.3 * 1.2); else f.push(-0.2 * 1.2); }
  // 2 强平分布 w1.0（24h 多爆占比）
  if (total24 >= 1e5) { const lp = long24 / total24; if (lp > 0.6) f.push(0.7 * 1.0); else if (lp < 0.4) f.push(-0.7 * 1.0); else f.push(0); }
  else f.push(0);
  // 3 强平动能 w0.8（需1h粒度，历史无 → 0）
  f.push(0);
  // 4 波动率体制 w0.8
  const vol6 = n > 6 ? (Math.max(...arr.slice(-6)) - Math.min(...arr.slice(-6))) / price * 100 : Math.abs(chg24);
  const imbalance = total24 > 1e5 ? Math.abs(long24 - short24) / total24 : 0;
  const amplifying = (chg24 > 0 && short24 > long24 * 1.3) || (chg24 < 0 && long24 > short24 * 1.3);
  if (vol6 > 1.5 && amplifying) f.push(-0.5 * 0.8);
  else if (vol6 < 0.8 && imbalance < 0.3) f.push(0.4 * 0.8);
  else f.push(0);
  // 5 吸筹/派发 w1.0
  if (oiChg > 2 && chg24 > 0.3) f.push(0.7 * 1.0);
  else if (oiChg > 2 && chg24 < -0.3) f.push(-0.6 * 1.0);
  else if (oiChg < -2 && chg24 > 0.3) f.push(-0.4 * 1.0);
  else if (oiChg < -2 && chg24 < -0.3) f.push(0.5 * 1.0);
  else f.push(0.1 * 1.0);
  // 6 多空拥挤 w0.7（LSR + 费率，费率=百分数口径对齐 qibao7）
  let c6 = 0;
  if (lsr > 1.5) c6 -= 0.5; else if (lsr < 0.67) c6 += 0.5;
  if (fundPct > 0.1) c6 -= 0.4; else if (fundPct < -0.01) c6 += 0.4;
  f.push(c6 * 0.7);
  // 7 趋势体制 w1.0
  const tr = trendFilter(arr);
  if (tr === 'long') f.push(0.8 * 1.0); else if (tr === 'short') f.push(-0.8 * 1.0); else f.push(0);
  return Math.round(f.reduce((a, b) => a + b, 0) / 6.5 * 100);
}

// ═════ 维度5：清算技术因子 v2（5m 重建：REPLAY 用 5m bars 对齐实盘 qibao7，因子权重同 [1.2,1.0,0.8,0.8,1.0,0.7,1.0] 总 6.5） ═════
function qibaoRaw5(sym, bars5, tMs, oiChg, fundPct, lsr) {
  const n = bars5.length; if (n < 290) return 0;
  const arr = bars5.map(b => b.c);
  const price = arr[n - 1];
  const chg24 = (price - arr[n - 289]) / arr[n - 289] * 100;           // 288根5m=24h
  const vNow = bars5.slice(-288).reduce((a, b) => a + b.v, 0);
  const vPrev = bars5.slice(-576, -288).reduce((a, b) => a + b.v, 0);
  const volChg = vPrev > 0 ? (vNow - vPrev) / vPrev * 100 : 0;
  const liqI = lastLe(liqRows[sym], tMs);
  const liq = liqI >= 0 ? liqRows[sym][liqI] : null;
  const long24 = liq ? +liq.long_usd : 0, short24 = liq ? +liq.short_usd : 0;
  const total24 = long24 + short24;
  const f = [];
  // 1 量能结构 w1.2（同实盘 factorWashout）
  if (chg24 < -0.3) { if (volChg < 0) f.push(0.8 * 1.2); else if (volChg > 40) f.push(-0.9 * 1.2); else f.push(0.2 * 1.2); }
  else if (chg24 > 0.3) { if (volChg > 30) f.push(0.6 * 1.2); else f.push(0.1 * 1.2); }
  else { if (Math.abs(volChg) < 20) f.push(0.3 * 1.2); else f.push(-0.2 * 1.2); }
  // 2 强平分布 w1.0
  if (total24 >= 1e5) { const lp = long24 / total24; if (lp > 0.6) f.push(0.7 * 1.0); else if (lp < 0.4) f.push(-0.7 * 1.0); else f.push(0); }
  else f.push(0);
  // 3 强平动能 w0.8（需1h粒度，历史无 → 0）
  f.push(0);
  // 4 波动率体制 w0.8（vol6=近6根5m=30min，同实盘）
  const vol6 = (Math.max(...arr.slice(-6)) - Math.min(...arr.slice(-6))) / price * 100;
  const imbalance = total24 > 1e5 ? Math.abs(long24 - short24) / total24 : 0;
  const amplifying = (chg24 > 0 && short24 > long24 * 1.3) || (chg24 < 0 && long24 > short24 * 1.3);
  if (vol6 > 0.3 && amplifying) f.push(-0.5 * 0.8);
  else if (vol6 < 0.15 && imbalance < 0.3) f.push(0.4 * 0.8);
  else f.push(0);
  // 5 吸筹/派发 w1.0（OI 4h）
  if (oiChg > 2 && chg24 > 0.3) f.push(0.7 * 1.0);
  else if (oiChg > 2 && chg24 < -0.3) f.push(-0.6 * 1.0);
  else if (oiChg < -2 && chg24 > 0.3) f.push(-0.4 * 1.0);
  else if (oiChg < -2 && chg24 < -0.3) f.push(0.5 * 1.0);
  else f.push(0.1 * 1.0);
  // 6 多空拥挤 w0.7（OKX LSR + OKX 费率）
  let c6 = 0;
  if (lsr > 1.5) c6 -= 0.5; else if (lsr < 0.67) c6 += 0.5;
  if (fundPct > 0.1) c6 -= 0.4; else if (fundPct < -0.01) c6 += 0.4;
  f.push(c6 * 0.7);
  // 7 趋势体制 w1.0（5m 序列 SMA3/6/12，同实盘 trendFilter）
  const tr = trendFilter(arr);
  if (tr === 'long') f.push(0.8 * 1.0); else if (tr === 'short') f.push(-0.8 * 1.0); else f.push(0);
  return Math.round(f.reduce((a, b) => a + b, 0) / 6.5 * 100);
}

// ═════ 维度4：KOL共识（consensus_hist，最近一条 ≤ tMs） ═════
function conScore(sym, tMs) {
  if (!conRows.length) return 0;
  const i = lastLe(conRows, tMs);
  if (i < 0) return 0;
  let p; try { p = JSON.parse(conRows[i].payload); } catch (e) { return 0; }
  if (!Array.isArray(p)) return 0;
  const row = p.find(x => x.display_symbol === sym);
  if (!row) return 0;
  const conf = +row.confidence || 0;
  if (row.decision === 'long') return Math.min(2, conf * 2.5);
  if (row.decision === 'short') return -Math.min(2, conf * 2.5);
  return 0;
}

// ═════ 门控：FGI（历史最近值） ═════
function fgiAt(tMs) {
  const i = lastLe(fgiRows, tMs);
  return i >= 0 ? fgiRows[i].value : null;
}

// ═════ 周末风控（实盘 etNow/weekendBlocked：周五16:00ET~周一09:30ET 不开单） ═════
function weekendBlockedAt(tMs) {
  const dt = new Date(tMs);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(dt);
  const get = t => { const p = parts.find(x => x.type === t); return p ? p.value : ''; };
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const h = parseInt(get('hour')) || 0, m = parseInt(get('minute')) || 0;
  const day = dayMap[get('weekday')] ?? -1, mins = h * 60 + m;
  if (day === 6 || day === 0) return true;
  if (day === 5 && mins >= 16 * 60) return true;
  if (day === 1 && mins < 9 * 60 + 30) return true;
  return false;
}

// ═════ 主回测 ═════
const FROM = argVal('--from', null);
const TO = argVal('--to', null);
let windowStart = Infinity, windowEnd = 0;
for (const s of SYMS) {
  if (klines[s].length) { windowStart = Math.min(windowStart, klines[s][0].time); windowEnd = Math.max(windowEnd, klines[s][klines[s].length - 1].time); }
}
// 因子窗口起点 = 各因子 MIN（取不到因子的时段打分退化为低维）
const factorStart = Math.min(
  ...[...SYMS].map(s => Math.min(
    oiRows[s].length ? oiRows[s][0].time : Infinity,
    fundMap[s].size ? Math.min(...fundMap[s].keys()) : Infinity,
    lsrAcc[s].size ? Math.min(...lsrAcc[s].keys()) : Infinity,
    liqRows[s].length ? liqRows[s][0].time : Infinity
  ))
);
// 2026-08-31 机构级长历史验证：no_factor_clamp=true 时绕过因子起点钳制
// （仅用于降维验证：纯技术面跑 8 年，验证维度 edge 是否存在）
if (!CFG.no_factor_clamp) windowStart = Math.max(windowStart, factorStart);
// 数据完整边界：强制窗口 ≥ min_window_start（news/con 全量），防止降维回测
if (CFG.min_window_start && !CFG.no_factor_clamp) {
  const bound = new Date(CFG.min_window_start).getTime();
  if (windowStart < bound) { console.log(`⚠️ 窗口起点 ${new Date(windowStart).toISOString().slice(0,10)} < 数据完整边界 ${CFG.min_window_start}，已强制提升（完整五维最早 ${CFG.min_window_start}）`); windowStart = bound; }
}
if (FROM) windowStart = Math.max(windowStart, new Date(FROM).getTime());
if (TO) windowEnd = Math.min(windowEnd, new Date(TO).getTime());

const equitySeries = [];
let equity = ACCOUNT0, peak = ACCOUNT0, maxDd = 0;
const positions = [], trades = [], cooldown = {}, dailyUsed = {}, dailyUsedSym = {};
let dynMaxLev = MAX_TOTAL_LEV, ddTriggers = 0;
let blockedCount = 0, rangeBlocked = 0;

// 时间轴：BTC 的网格（REPLAY=5m / 标准=4h，各币同网格）
const timePoints = TICK['BTC'].map(k => k.time).filter(t => t >= windowStart && t <= windowEnd);

function openPnlPct(pos, exitPx) { return pos.dir === 'long' ? (exitPx - pos.entry) / pos.entry * 100 : (pos.entry - exitPx) / pos.entry * 100; }

// ═════ LLM AI 审查（实盘 aiReview 同口径，串行限流 1.2s 不挤占实盘用量） ═════
let llmStats = { reviewed: 0, vetoed: 0, agreed: 0, held: 0, failed: 0 };
let aiWatch = [];   // 2026-09-01 AI判决→结局审计：记录每个被review的候选
let llmTotal = 0;
let lastLlmAt = 0;
const sleepL = ms => new Promise(r => setTimeout(r, ms));
async function aiReviewBt(cands, ctxInfo) {
  const list = cands.map(c => `${c.sym} ${c.direction === 'long' ? '做多' : '做空'} 现价$${c.px.toLocaleString('en-US', { maximumFractionDigits: 2 })} 综合分${c.total >= 0 ? '+' : ''}${c.total} 维度[消息${c.news}/技术${c.tech}/资金${c.fund}/共识${c.con}/清算技术${c.qib}]`).join('\n');
  const regimeTxt = ctxInfo ? `市场体制:FGI=${ctxInfo.fgi == null ? '?' : ctxInfo.fgi} | BTC近16h ${ctxInfo.btcChg16 >= 0 ? '+' : ''}${ctxInfo.btcChg16}% | ${ctxInfo.regimeTxt || ''}` : '(无体制数据)';
  const HOLD_PASS = process.argv.includes('--holdpass');   // 2026-08-31 实验：hold 视同通过，只 veto 挡单
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {           // 失败重试1次（避免网络抖动误杀）
    const wait = Math.max(0, LLM_GAP_MS - (Date.now() - lastLlmAt));
    if (wait > 0) await sleepL(wait);
    lastLlmAt = Date.now();
    try {
      const r = await ai.chat(env, [
        { role: 'system', content: '你是顶级交易员AI研判官。系统5维引擎已给出候选，你负责最终研判：逐单给出判决，只输出JSON数组，格式[{"symbol":"BTC","direction":"long","verdict":"agree|veto|hold","reason":"一句话中文理由"}]。agree=认可开单，veto=否决，hold=观望。只有逻辑硬伤或与市场体制明显冲突才veto；普通不确定用hold。' },
        { role: 'user', content: `市场体制:${regimeTxt}\n回测候选单（历史时点，模拟实盘 AI 审查）：\n${list}\n请最终研判，只输出JSON。` }
      ], env.TIANJI_AI_MODEL || 'deepseek-v4-flash', 'tianji-backtest');
      let parsed = [];
      try { parsed = JSON.parse(r.text.replace(/```json|```/g, '').trim()); } catch (e) { parsed = []; }
      if (Array.isArray(parsed) && parsed.length) {
        return cands.map(c => {
          const v = parsed.find(x => String(x.symbol).toUpperCase() === c.sym);
          if (v) { c.aiVerdict = HOLD_PASS ? (v.verdict === 'veto' ? 'veto' : 'agree') : (v.verdict || 'hold'); c.aiReason = v.reason || ''; }
          return c;
        });
      }
    } catch (e) { lastErr = e; }
    if (attempt === 0) await sleepL(800);
  }
  throw new Error('LLM审查失败(重试2次): ' + (lastErr ? lastErr.message : '空响应'));
}
function maybeState(phase, progress, message) { writeState(phase, progress, message); }

(async () => {
for (let _i = 0; _i < timePoints.length; _i++) {
  const tMs = timePoints[_i];
  const day = new Date(tMs).toLocaleDateString('en-CA', { timeZone: TZ });
  if ((_i % (REPLAY ? 300 : 40)) === 0) maybeState('scan', 3 + _i / timePoints.length * 70, `扫描评分 ${_i}/${timePoints.length} 根${REPLAY ? '5m' : '4h'}K线`);
  // 回撤熔断：动态整体杠杆（方案B，2026-08-22）
  if (CFG.dd_lev) {
    const ddPct = peak > 0 ? (peak - equity) / peak * 100 : 0;
    let sc = 1;
    for (const r of (CFG.dd_scales || [])) { if (ddPct >= r[0]) sc = r[1]; }
    dynMaxLev = MAX_TOTAL_LEV * sc;
    if (sc < 1) ddTriggers++;
  }

  // 1. 结算持仓
  for (let p = positions.length - 1; p >= 0; p--) {
    const pos = positions[p];
    const i = TIDX[pos.sym].get(tMs);
    if (i === undefined) continue;
    if (i < 1) continue;                 // 2026-08-31 无未来函数：只用已收盘 bar（i-1 在 tMs 完全已知）
    const bar = TICK[pos.sym][i - 1];
    const px = bar.c;
    let status = null, exitPx = null, reason = null;
    const isLong = pos.dir === 'long';

    // T1 落袋：已收盘 bar 内 h/l 触及（无未来函数）
    if (!pos.t1hit && ((isLong && bar.h >= pos.t1) || (!isLong && bar.l <= pos.t1))) {
      pos.t1hit = true;
      pos.t1GainPct = isLong ? (pos.t1 - pos.entry) / pos.entry * 100 : (pos.entry - pos.t1) / pos.entry * 100;
      pos.stop = pos.entry;
      pos.peak = pos.t1;
      pos.lastTrail = pos.t1;
      reason = 'T1落袋60%+移保本';
    }
    // 移动止损（t1 后：1.5ATR 阶梯 + 动量确认 + 回撤保护）
    if (pos.t1hit) {
      const bars = TICK[pos.sym].slice(Math.max(0, i - 61), i);   // 只用已收盘（不含当前bar）
      const tech = REPLAY ? techScoreTick(bars) : techScore(bars);
      pos._stopBefore = pos.stop;
      const atr = px * (tech.atrPct || 0.15) / 100;
      const step = Math.max(atr * 1.5, px * 0.005);
      pos.peak = Math.max(pos.peak || pos.entry, px);
      const momentumUp = isLong ? (tech.chg4 > 0 && tech.chg1 > 0) : (tech.chg4 < 0 && tech.chg1 < 0);
      const momentumWeaken = isLong ? tech.chg4 < 0 : tech.chg4 > 0;
      if (momentumUp && px >= (pos.lastTrail || pos.peak) + (isLong ? step : -step)) {
        const newStopRaw = isLong ? px - step : px + step;
        const newStop = isLong ? Math.max(newStopRaw, pos.entry) : Math.min(newStopRaw, pos.entry);
        if (isLong ? newStop > pos.stop : newStop < pos.stop) { pos.stop = newStop; pos.lastTrail = px; pos.stopMoved = true; }
      } else if (momentumWeaken) {
        const dd = isLong ? (pos.peak - px) / px * 100 : (px - pos.peak) / px * 100;
        if (dd >= (tech.atrPct || 0.15) * 1.5) { status = 'WIN'; exitPx = px; reason = '回撤保护锁利'; }
      }
    }
    // 止盈止损（已收盘 bar 内 h/l，先止损后止盈保守顺序；无未来函数）
    if (!status) {
      const hitStop = isLong ? bar.l <= pos.stop : bar.h >= pos.stop;
      if (pos.t1hit) {
        if (hitStop) { status = 'LOSS'; exitPx = pos.stop; reason = '保本止损'; }
        else if ((isLong && bar.h >= pos.t2) || (!isLong && bar.l <= pos.t2)) { status = 'WIN'; exitPx = pos.t2; reason = '触及T2全盈'; }
      } else {
        if (hitStop) { status = 'LOSS'; exitPx = pos.stop; reason = '触及止损'; }
      }
    }
    // 超时 48h
    if (!status && tMs - pos.ts > MAX_HOLD_H * 3600 * 1000) {
      const pnlNow = openPnlPct(pos, px);
      status = pnlNow > 0 ? 'WIN' : 'LOSS';
      exitPx = px; reason = '超时了结';
    }
    if (status) {
      // 60/40 结算口径（实盘 resolveTianjiSignals）
      let pnlPct;
      if (pos.t1hit) {
        const restPct = (status === 'LOSS' && reason === '保本止损') ? 0 : openPnlPct(pos, exitPx);
        pnlPct = 0.6 * pos.t1GainPct + 0.4 * restPct;
      } else {
        pnlPct = openPnlPct(pos, exitPx);
      }
      pnlPct -= WITH_COST ? COST_BPS / 100 : 0; // 8bps 双边成本
      const notional = pos.notional; // 开仓时冻结的名义（对齐实盘：入场净值×pos%×杠杆）
      const pnlUsd = notional * pnlPct / 100;
      equity += pnlUsd;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, (peak - equity) / peak * 100);
      trades.push({ sym: pos.sym, dir: pos.dir, entry: pos.entry, exit: exitPx, stop: pos.stop,
        t1: pos.t1, t2: pos.t2, pnlPct: +pnlPct.toFixed(3), pnlUsd: +pnlUsd.toFixed(2),
        status, reason, ts: tMs, entryTs: pos.ts, holdH: +((tMs - pos.ts) / 3600000).toFixed(1),
        t1Hit: !!pos.t1hit, stopMoved: !!pos.stopMoved, protect: reason === '回撤保护锁利',
        posPct: pos.posPct, notional: +notional.toFixed(0), score: pos.score, tech: pos.tech, fund: pos.fund, qib: pos.qib, con: pos.con, news: pos.news, ai: pos.ai || null, activeDims: pos.activeDims });
      // 2026-08-31 在线进化 v5（--evo）：专家池 Hedge 混合更新 + 门控 + 影子战绩/晋升（对齐实盘）
      if (EVO && status) {
        const dimsEvo = { news: pos.news, tech: pos.tech, fund: pos.fund, con: pos.con, qibao: pos.qib };
        const pnlSignEvo2 = pnlPct >= 0 ? 1 : -1;
        // 影子战绩：每个专家独立累计（无论门控）
        let touchedEvo = false;
        for (const d of DIMS_EVO) if (Math.abs(Number(dimsEvo[d]) || 0) > 0.05) touchedEvo = true;
        if (touchedEvo) {
          evoN++;
          for (const e of EVO_EXPERTS) {
            const totalE2 = DIMS_EVO.reduce((a, d) => a + (Number(dimsEvo[d]) || 0) * e.w[d], 0);
            const supDir = totalE2 >= 0 ? 'long' : 'short';
            const correct2 = supDir === pos.dir ? (pnlSignEvo2 >= 0) : (pnlSignEvo2 < 0);
            evoPerf[e.id].trades++;
            if (correct2) evoPerf[e.id].correct++;
            evoPerf[e.id].pnl += Number(pnlPct) || 0;
          }
          // 晋升检查：影子≥30 且显著优于当前 → 提升概率（对齐实盘 checkPromotion）
          const curP = evoPerf['e_current'];
          if (curP.trades >= 30) {
            const curWR = curP.correct / curP.trades;
            for (const e of EVO_EXPERTS) {
              if (e.id === 'e_current') continue;
              const pp = evoPerf[e.id];
              if (pp.trades >= 30 && pp.correct / pp.trades >= curWR + 0.05 && pp.pnl > curP.pnl) {
                if ((evoProbs[e.id] || 0) < 0.5) {
                  evoProbs[e.id] = 0.5;
                  let tt = 0;
                  for (const x of EVO_EXPERTS) { if (x.id !== e.id) { evoProbs[x.id] = (evoProbs[x.id] || 0) * 0.5; tt += evoProbs[x.id]; } }
                  evoPromotions.push({ ts: new Date().toISOString(), expert: e.id, curWR: +(curWR * 100).toFixed(1), newWR: +(pp.correct / pp.trades * 100).toFixed(1) });
                }
              }
            }
          }
        }
        if (evoN < EVO_MIN_N) { /* 门控期：不更新，用先验混合权重 */ }
        else {
        const pnlSignEvo = pnlPct >= 0 ? 1 : -1;
        const magEvo = Math.min(Math.abs(pnlPct) / 5, 2.0);
        const losses = {};
        for (const e of EVO_EXPERTS) {
          const totalE = DIMS_EVO ? DIMS_EVO.reduce((a, d) => a + (Number(dimsEvo[d]) || 0) * e.w[d], 0) : 0;
          const supportDir = totalE >= 0 ? 'long' : 'short';
          const correct = supportDir === pos.dir ? (pnlSignEvo >= 0) : (pnlSignEvo < 0);
          let loss;
          if (correct && Math.abs(totalE) >= 0.5) loss = 0.1 * (1 - magEvo) + 0.2;
          else if (correct) loss = 0.35 * (1 - magEvo) + 0.2;
          else if (!correct && Math.abs(totalE) >= 0.5) loss = 0.5 + 0.5 * magEvo;
          else loss = 0.4 + 0.4 * magEvo;
          losses[e.id] = Math.max(0.05, Math.min(1, loss));
        }
        let sumP = 0;
        for (const e of EVO_EXPERTS) { evoProbs[e.id] *= Math.exp(-EVO_ETA * losses[e.id]); sumP += evoProbs[e.id]; }
        if (sumP > 0) for (const e of EVO_EXPERTS) evoProbs[e.id] /= sumP;
        for (const e of EVO_EXPERTS) evoProbs[e.id] = Math.max(0.02, Math.min(0.6, evoProbs[e.id]));
        sumP = EVO_EXPERTS.reduce((a, e) => a + evoProbs[e.id], 0);
        for (const e of EVO_EXPERTS) evoProbs[e.id] /= sumP;
        }
      }
      positions.splice(p, 1);
    }
  }

  // 2. 扫描（周末不开单）
  if (CFG.weekend_gate && weekendBlockedAt(tMs)) continue;
  const candidates = [];
  const qibRaws = {};
  // 第一遍：算所有币 qibao 原始分（截面居中需要全市场；REPLAY 用 5m 300 根重建，否则 4h 已收盘 bar）
  for (const sym of SYMS) {
    const _bkt4 = Math.floor(tMs / 14400000) * 14400000;   // 当前 4h 桶起点
    const i4 = lastLe(klines[sym], _bkt4 - 1);             // 只用已收盘（标准=上一根；REPLAY=桶前一根）
    if (i4 < 20) continue;
    const oiI = lastLe(oiRows[sym], tMs), oiJ = lastLe(oiRows[sym], tMs - 86400000);
    const oiNow = oiI >= 0 ? +oiRows[sym][oiI].close : 0, oiPrev = oiJ >= 0 ? +oiRows[sym][oiJ].close : 0;
    const oiChg = oiPrev > 0 ? (oiNow - oiPrev) / oiPrev * 100 : 0;
    const fundPct = fundMap[sym].get(nearestMap(fundMap[sym], tMs)) || 0;
    const lsr = lsrAcc[sym].get(nearestMap(lsrAcc[sym], tMs)) || 0;
    if (REPLAY && false) { // 5m qibao 重建噪声过大（复现率反而降），弃用；统一用 4h 重建
      const i5 = TIDX[sym].get(tMs);
      if (i5 !== undefined && i5 >= 290) {
        const bars5 = TICK[sym].slice(i5 - 300, i5 + 1);
        qibRaws[sym] = qibaoRaw5(sym, bars5, tMs, oiChg, fundPct, lsr);
        continue;
      }
    }
    const bars = klines[sym].slice(i4 - 60, i4 + 1);
    qibRaws[sym] = qibaoRaw(sym, bars, tMs, oiChg, fundPct, lsr);
  }
  const qibVals = Object.values(qibRaws).filter(v => isFinite(v));
  const qibMean = qibVals.length ? qibVals.reduce((a, b) => a + b, 0) / qibVals.length : 0;

  for (const sym of SYMS) {
    const _bkt4 = Math.floor(tMs / 14400000) * 14400000;   // 当前 4h 桶起点
    const i4 = lastLe(klines[sym], _bkt4 - 1);             // 2026-08-31 无未来函数：只用已收盘（REPLAY=桶前一根）
    if (i4 < 20) continue;
    const s4 = Math.max(0, i4 - 60);                 // 2026-08-31 修复：早期数据不足60根时 slice 负数索引取尾部→空
    const bars4 = klines[sym].slice(s4, i4 + 1);
    if (!bars4.length) continue;
    const bar4 = bars4[bars4.length - 1];
    if (!bar4) continue;
    // tick bars：REPLAY(5m) 用 5m 序列（对齐实盘 30×5min 快照），否则 4h
    const i5 = TIDX[sym].get(tMs);
    // 2026-08-31 无未来函数：slice 上界 i5（不含当前开盘中的 bar），只用已收盘
    const tickBars = (REPLAY && i5 !== undefined) ? TICK[sym].slice(Math.max(0, i5 - 288), i5) : bars4;
    if (!tickBars || !tickBars.length) { console.error(`[BUG] ${sym} @ ${new Date(tMs).toISOString()} tickBars空 i4=${i4} i5=${i5} REPLAY=${REPLAY} klines=${klines[sym].length}`); continue; }
    const px = tickBars[tickBars.length - 1].c;
    const tech = REPLAY ? techScoreTick(tickBars, LOGIC_V0814 ? null : volChg4Of(bars4)) : techScore(tickBars);
    const chg24 = bars4.length >= 7 ? (bar4.c - bars4[bars4.length - 7].c) / bars4[bars4.length - 7].c * 100 : 0;
    const fund = fundScore(sym, tMs, chg24);
    const qibRaw0 = qibRaws[sym] || 0;
    // 实盘快照优先（真实 qibao raw），无则 4h 重建
    const snap = snapAt(sym, Math.floor(tMs / 1000));
    const qibRaw = (snap && snap.qibao_raw != null) ? +snap.qibao_raw : qibRaw0;
    const qib = LOGIC_V0814 ? qibaoScoreV0814(qibRaw) : +Math.max(-3, Math.min(3, (qibRaw - qibMean) / 33.33)).toFixed(2);
    const con = conScore(sym, tMs);
    // 真实消息面（news_hist 覆盖 8/02 起；更早无新闻 → 0 分）
    // 真实消息面（news_hist 覆盖 8/02 起；更早无新闻 → 0 分）
    const news = WITH_NEWS ? (LOGIC_V0814 ? newsScoreV0814(sym, Math.floor(tMs / 1000)) : newsScore(sym, Math.floor(tMs / 1000))) : { score: 0, coin: 0, coinTotal: 0, global: 0, burst: 0 };
    const w_ = EVO ? (() => {
      const mw = {};
      for (const d of ['news','tech','fund','con','qibao']) mw[d] = EVO_EXPERTS.reduce((a, e) => a + evoProbs[e.id] * e.w[d], 0);
      return mw;
    })() : { news: CFG.macro_weight, tech: CFG.tech_weight, fund: CFG.fund_weight, con: CFG.con_weight, qibao: CFG.qibao_weight };
    const total = news.score * w_.news + tech.score * w_.tech + fund.score * w_.fund + con * w_.con + qib * w_.qibao;
    // 诊断：实盘单触发时刻 ±6min 内打印回测同刻五维分
    if (DIAG_LIVE && REPLAY) {
      const near = liveTrades.find(l => l.symbol === sym && Math.abs(l.pushed_at - tMs) <= 6 * 60 * 1000);
      if (near) console.log(`[DIAG] ${new Date(tMs).toISOString().slice(0, 16)} ${sym} 实盘${near.direction === 'long' ? '多' : '空'} | news=${news.score} tech=${tech.score} fund=${fund.score} con=${con} qib=${qib} | total=${total.toFixed(2)} | ${near.direction === 'long' ? '需≥' + CFG.min_score : '需≤-' + CFG.min_score}`);
    }
    const dims = [news.score, tech.score, fund.score, con, qib];
    // 实际参与维度数（|score|>0.05 算有信号，不要求方向同向）——数据覆盖完整度的直接体现
    const activeDims = dims.filter(d => Math.abs(d) > 0.05).length;
    const posDims = dims.filter(d => d > 0.3).length;
    const negDims = dims.filter(d => d < -0.3).length;
    let direction = null;
    // 空头专属门槛（2026-08-31 对齐实盘 short_min_score）：多头 min_score / 空头 short_min_score（默认对称）
    const shortBar = CFG.short_min_score != null ? CFG.short_min_score : CFG.min_score;
    // 高维陷阱过滤（2026-08-31 实验）：4+维同向=拥挤交易，历史0%胜率，默认关闭(0=不限)
    if (CFG.max_dims && activeDims > CFG.max_dims) continue;
    if (total >= CFG.min_score && posDims >= CFG.min_dims) direction = 'long';
    else if (total <= -shortBar && negDims >= CFG.min_dims) direction = 'short';
    // ── 反抽空分支（2026-08-26 William老板提议·可选优化）──
    // 大周期超买回落、未破位时，在反弹高点头部试空：
    //   入场 = 5m 扫描时刻收盘价（真实可进，非事后挂单）
    //   止损 = 近20根高点 + 0.2% 缓冲（结构止损，墙外）
    //   目标 = 按止损距 × t2_mult（沿用 T1/T2 分级）
    let isPullback = false, pbStop = null;
    const closes = tickBars.map(b => b.c);   // 提前定义（反抽分支 + 趋势门控共用）
    const fgi = fgiAt(tMs);                  // 提前定义（反抽分支 + FGI 门控共用）
    if (CFG.pullback_short && !direction && sym !== 'XAU') {
      pbDiag.tot++;
      if (total < -0.8) pbDiag.cand2++;
      if (total < -0.8 && tickBars.length >= 20) {
        const _hi20 = Math.max(...tickBars.slice(-20).map(b => b.h));
        const _pb = (_hi20 - px) / _hi20 * 100;
        if (_pb >= 0.3 && _pb <= 6) pbDiag.cand3++;
      }
      if (total < -0.8 && tickBars.length >= 20) {
        const pbBars = tickBars.slice(-20);
        const hi20 = Math.max(...pbBars.map(b => b.h));
        const lv8 = structLevels(closes, 8);
        const notBroken = !lv8 || px > lv8.low + px * 0.002;   // 未跌破近8根低点（未破位）
        const pullbackPct = (hi20 - px) / hi20 * 100;          // 从高点回撤幅度
        const momNeg = tech.chg1 < -0.05;                      // 短线动量已转负（回落进行中）
        const fgiOk = fgi === null || fgi > 20;                // 不极度恐惧才空
        if (pullbackPct >= 0.3 && pullbackPct <= 6 && notBroken && momNeg && fgiOk && hi20 > px) {
          const structStop = hi20 + hi20 * 0.002;
          const sdPct = (structStop - px) / px * 100;
          if (sdPct >= 0.3 && sdPct <= 5) {                    // 止损距离合理区间（0.3%~5%）
            direction = 'short'; isPullback = true; pbStop = structStop; pbDiag.fired++;
          }
        }
      }
    }
    if (!direction) continue;
    // 2026-08-31 体制门控升级（对齐实盘）：RANGE 震荡市只放行强信号（qibao≥1.5 或 综合分≥5.5），弱信号一律不给
    // RANGE 判定（与 lib/regime.js 同口径）：ADX<18 且 布林带宽分位<60% → 震荡
    // 回测用当前 tMs 前的日线重建 ADX + 布林带宽（无历史 regime 存档，按同口径在线重建）
    if (CFG.range_gate !== false) {
      try {
        const d1 = d1BarsFor(sym, tMs);  // 日线 bars（截至 tMs）
        if (d1 && d1.length >= 40) {
          const _adxArr = adxCalcBars(d1, 14);
          const _adxV = _adxArr[_adxArr.length - 1] || 0;
          const _bbw = bbWidthPctD1(d1);
          const _isRange = _adxV < 18 && _bbw != null && _bbw < 0.6;
          if (_isRange) {
            const strongEnough = Math.abs(total) >= 5.5 && Math.abs(qib) >= 1.5;
            if (!strongEnough) { rangeBlocked++; continue; }
          }
        }
      } catch (e) { /* 门控失败不阻断 */ }
    }
    if (sym === 'XAU' && CFG.xau_short_ban && direction === 'short') continue;
    // 空头 qibao 强约束（2026-08-31 实验）：做空需清算技术因子深度看空（qib<=阈值，默认-0.5）
    if (CFG.short_qib_min != null && direction === 'short' && qib > CFG.short_qib_min) continue;
    // 空头禁币黑名单（2026-08-31 实验）：历史空头 0% 胜率的币禁空
    if (CFG.short_ban_symbols && direction === 'short' && CFG.short_ban_symbols.includes(sym)) continue;
    // 突发新闻密集 / 明确利空利多压制（实盘 v3 规则；v0814 版无此门控）
    if (CFG.news_gate && !LOGIC_V0814) {
      // 方向一致性风暴（2026-08-24 同实盘）：单方向≥5且占比≥70%才避险
      const bB = news.burstBull || 0, bS = news.burstBear || 0, bT = bB + bS;
      if (bT >= CFG.burst_news_limit && Math.max(bB, bS) / Math.max(1, bT) >= 0.7) continue;
      if (direction === 'long' && news.coin < -2) continue;
      if (direction === 'short' && news.coin > 2) continue;
    }

    // 动量确认（实盘：做多需 15m/1h 不为双负）
    if (CFG.momentum_gate) {
      if (direction === 'long' && tech.chg1 < -0.05 && tech.chg4 < -0.1) continue;
      if (direction === 'short' && tech.chg1 > 0.05 && tech.chg4 > 0.1) continue;
    }
    // 趋势门控（实盘 trendGate：只拦明确反向；反抽空豁免——反抽本质在短趋势未破时试空）
    const tr = trendFilter(closes);
    if (CFG.trend_gate && !isPullback) {
      if (direction === 'long' && tr === 'short') continue;
      if (direction === 'short' && tr === 'long') continue;
      // 空头趋势严格（2026-08-31 实验）：震荡(neutral)也不做空，只做明确下降排列的空
      if (CFG.short_trend_strict && direction === 'short' && tr !== 'short') continue;
      // 多头趋势严格（2026-08-31 实验）：震荡(neutral)也不做多，只做明确上升排列的多
      if (CFG.long_trend_strict && direction === 'long' && tr !== 'long') continue;
    }
    // 突破门控（实盘 breakoutGate：近8根高低点 ±0.2%；REPLAY 时近8根=40min 同实盘）
    if (CFG.breakout_gate && !isPullback) {
      const lv = structLevels(closes, 8);
      if (lv) {
        const eps = px * 0.002;
        if (direction === 'long' && px < lv.high - eps) continue;
        if (direction === 'short' && px > lv.low + eps) continue;
      }
    }
    // FGI 门控（实盘 marketGate）
    if (CFG.fgi_gate && fgi !== null) {
      if (direction === 'long' && fgi >= 85) continue;
      if (direction === 'short' && fgi <= 15) continue;
    }
    // 冷却
    const ck = sym + ':' + direction;
    if (cooldown[ck] && tMs - cooldown[ck] < CFG.cooldown_h * 3600 * 1000) continue;
    // 分散化（2026-08-22）：每币每日 ≤1 单 + 单币并发 ≤1
    if ((CFG.max_per_symbol_per_day || 0) > 0 && (dailyUsedSym[day] || {})[sym] >= CFG.max_per_symbol_per_day) continue;
    if ((CFG.max_same_symbol_positions || 0) > 0 && positions.some(p => p.sym === sym)) continue;
    // 敞口上限（实盘 max_total_lev 30x）
    if (COMPOUND) {
      const exposure = positions.reduce((a, p) => a + p.notional, 0);
      if (equity > 0 && exposure / equity >= dynMaxLev) continue;
    }
    // 计划（实盘 buildPlan：ATR×2.5 止损，0.8%~5% 夹取，T1=1.2×止损距，T2=2.4×）
    let stopDist, stop;
    if (pbStop != null) {
      stopDist = Math.abs(pbStop - px);          // 反抽空：结构止损（近20根高点外）
      stop = pbStop;
    } else {
      const atrStop = px * (tech.atrPct || 0.15) / 100 * CFG.atr_mult;
      const floor = px * CFG.stop_floor_pct / 100, cap = px * CFG.stop_cap_pct / 100;
      stopDist = Math.min(Math.max(atrStop, floor), cap);
      stop = direction === 'long' ? px - stopDist : px + stopDist;
    }
    // 币种止盈缓冲（对齐实盘 buildPlan：多单下调/空单上调）
    const TP_BUFFER = { 'ETH':3, 'BTC':60, 'SOL':0.08, 'BNB':1.5, 'XRP':0.0012, 'DOGE':0.00008, 'ADA':0.0002, 'LINK':0.012, 'XAU':5 };
    const buf = TP_BUFFER[sym] != null ? TP_BUFFER[sym] : px * 0.001;
    const t1 = direction === 'long' ? px + stopDist * CFG.t1_mult - buf : px - stopDist * CFG.t1_mult + buf;
    const t2 = direction === 'long' ? px + stopDist * CFG.t2_mult - buf : px - stopDist * CFG.t2_mult + buf;
    const rr = CFG.t2_mult; // 实盘口径：T2距/止损距 = t2_mult = 2.4（v1 误算成 0.96 → 全部被 min_rr 拦死）
    if (rr < CFG.min_rr) continue;

    const scoreAbs = Math.abs(total);
    let posPct = CFG.pos_pct_low;
    if (scoreAbs >= CFG.score_high) posPct = CFG.pos_pct_high;
    else if (scoreAbs >= CFG.score_mid) posPct = CFG.pos_pct_mid;
    // 仓位倍数（前端主输入：整体缩放仓位档）
    posPct = Math.round(posPct * (CFG.pos_scale || 1) * 10) / 10;
    // FGI 仓位折扣（实盘 pushTianji）
    if (CFG.fgi_discount && fgi !== null) {
      if (fgi <= 20) posPct = Math.round(posPct * 0.3 * 10) / 10;
      else if (fgi <= 30) posPct = Math.round(posPct * 0.5 * 10) / 10;
      else if (fgi >= 85) posPct = Math.round(posPct * 0.4 * 10) / 10;
      else if (fgi >= 70) posPct = Math.round(posPct * 0.7 * 10) / 10;
    }
    candidates.push({ sym, direction, px, stop, t1, t2, rr, total: +total.toFixed(2), scoreAbs, posPct, tech: tech.score, fund: fund.score, qib, con, news: news.score, activeDims, isPullback, pbStop });
  }

  // top3 + 每日限额（实盘：限额满则记录 blocked，不推）
  candidates.sort((a, b) => b.scoreAbs - a.scoreAbs);
  const top = candidates.slice(0, 3);
  if (top.length && (dailyUsed[day] || 0) >= CFG.daily_limit) { blockedCount += top.length; continue; }
  // LLM AI 审查（2026-08-31 升级对齐实盘：仅 agree 才推；失败降级只推 top1）
  let toPush = top;
  if (LLM && top.length) {
    llmTotal += top.length;
    let reviewed, aiFailed = false;
        const ctxInfo = { fgi: fgiAt(tMs), btcChg16: (() => { const i4 = lastLe(klines['BTC'], tMs); if (i4 < 5) return 0; const c0 = +klines['BTC'][i4].c, c4 = +klines['BTC'][i4 - 4].c; return c4 ? (c0 - c4) / c4 * 100 : 0; })(), regimeTxt: '' };
    try { reviewed = await aiReviewBt(top, ctxInfo); } catch (e) { reviewed = top.slice(0, 1); aiFailed = true; llmStats.failed += top.length; }
    if (aiFailed) {
      toPush = reviewed;
      maybeState('llm', 73 + llmStats.reviewed / Math.max(1, llmTotal) * 20, `LLM 审查失败，降级推 top1`);
    } else {
      const vetoed = reviewed.filter(c => c.aiVerdict === 'veto').length;
      llmStats.reviewed += top.length; llmStats.vetoed += vetoed;
      llmStats.agreed += reviewed.filter(c => c.aiVerdict === 'agree').length;
      llmStats.held += reviewed.filter(c => c.aiVerdict === 'hold' || !c.aiVerdict).length;
      // 2026-09-01 方案C 分层AI门控：TREND/默认→hold放行（避免误杀强共振顺势单）；RANGE/STORM→hold拦截（乱市AI从严）
      toPush = reviewed.filter(c => {
        if (c.aiVerdict === 'agree') return true;
        if (c.aiVerdict !== 'hold') return false;   // veto 一律拦
        try {
          const d1 = d1BarsFor(c.sym, tMs);
          if (!d1 || d1.length < 40) return true;   // 无体制数据→放行（保守不杀）
          const adx = (adxCalcBars(d1, 14).pop() || 0);
          const bbw = bbWidthPctD1(d1);
          const isRange = adx < 18 && bbw != null && bbw < 0.6;
          c.aiRegime = isRange ? 'RANGE' : 'TREND';
          c.aiHoldPassed = !isRange;                 // 非震荡(TREND)→hold放行
          return !isRange;
        } catch (e) { return true; }
      });
      maybeState('llm', 73 + llmStats.reviewed / Math.max(1, llmTotal) * 20, `LLM 审查 ${llmStats.reviewed}/${llmTotal} 候选 · 否决 ${llmStats.vetoed} · 分层(TREND放行hold/RANGE拦截)`);
      for (const c of reviewed) aiWatch.push({ ts: tMs, sym: c.sym, dir: c.direction, px: c.px, score: c.total, verdict: c.aiVerdict || 'none', passed: (c.aiVerdict==='agree')||c.aiHoldPassed, regime: c.aiRegime || '', reason: c.aiReason || '' });
    }
  }
  for (const c of toPush) {
    if ((dailyUsed[day] || 0) >= CFG.daily_limit) break;
    dailyUsed[day] = (dailyUsed[day] || 0) + 1;
    dailyUsedSym[day] = dailyUsedSym[day] || {};
    dailyUsedSym[day][c.sym] = (dailyUsedSym[day][c.sym] || 0) + 1;
    cooldown[c.sym + ':' + c.direction] = tMs;
    // 风险定仓（2026-08-22 与实盘 calcSize 同口径）：notional = 净值×risk%×mult ÷ 止损距离%
    // 单仓名义上限：≤ 净值×pos%×杠杆档位（策略仓位档为名义上限）
    const stopDistPct = Math.abs(c.px - c.stop) / c.px * 100;
    const riskUsd = (COMPOUND ? equity : ACCOUNT0) * (CFG.risk_pct || 2) / 100 * (CFG.pos_mult || 1);
    let notional = stopDistPct > 0 ? riskUsd / (stopDistPct / 100) : riskUsd;
    const capNotional = (COMPOUND ? equity : ACCOUNT0) * c.posPct / 100 * LEV;
    if (notional > capNotional) notional = capNotional;  // 名义上限 = 仓位档×档位（策略建议名义）
    positions.push({ sym: c.sym, dir: c.direction, entry: c.px, stop: c.stop, t1: c.t1, t2: c.t2,
      posPct: c.posPct, ts: tMs, t1hit: false, t1GainPct: 0, peak: c.px, lastTrail: c.px, notional, stopMoved: false,
      score: c.total, tech: c.tech, fund: c.fund, qib: c.qib, con: c.con, news: c.news, ai: c.aiVerdict || null, activeDims: c.activeDims });
  }

  // 净值曲线（每日收盘）
  const lastDay = equitySeries.length ? equitySeries[equitySeries.length - 1] : null;
  if (!lastDay || lastDay.t !== day) equitySeries.push({ t: day, ts: tMs, equity: +equity.toFixed(2), positions: positions.length });
}

// 结算剩余持仓（用最后一根 K 线）
for (const pos of positions.slice()) {
  const ks = TICK[pos.sym]; const bar = ks[ks.length - 1];
  const pnlPct = openPnlPct(pos, bar.c) - (WITH_COST ? COST_BPS / 100 : 0);
  const notional = pos.notional;
  const pnlUsd = notional * pnlPct / 100;
  equity += pnlUsd;
  trades.push({ sym: pos.sym, dir: pos.dir, entry: pos.entry, exit: bar.c, stop: pos.stop, t1: pos.t1, t2: pos.t2,
    pnlPct: +pnlPct.toFixed(3), pnlUsd: +pnlUsd.toFixed(2), status: 'OPEN', reason: '期末未结', ts: pos.ts, entryTs: pos.ts,
    t1Hit: !!pos.t1hit, stopMoved: !!pos.stopMoved, protect: false,
    holdH: +((bar.time - pos.ts) / 3600000).toFixed(1), posPct: pos.posPct, notional: +notional.toFixed(0),
    score: pos.score, tech: pos.tech, fund: pos.fund, qib: pos.qib, con: pos.con, news: pos.news, ai: pos.ai || null, activeDims: pos.activeDims });
}

// ═════ 统计 ═════
function stats(trs) {
  // 与实盘同口径：胜率按 status（保本止损=LOSS 但 pnl 为正），盈亏额只算已结算（OPEN 浮盈单独列）
  const closed = trs.filter(t => t.status === 'WIN' || t.status === 'LOSS');
  const open = trs.filter(t => t.status === 'OPEN');
  const wins = closed.filter(t => t.status === 'WIN'), losses = closed.filter(t => t.status === 'LOSS');
  const gross = closed.reduce((a, t) => a + t.pnlUsd, 0);  // 已实现盈亏（不含 OPEN 浮盈）
  const openPnl = open.reduce((a, t) => a + t.pnlUsd, 0);  // 未实现浮盈
  const sumW = wins.reduce((a, t) => a + t.pnlUsd, 0), sumL = losses.reduce((a, t) => a + t.pnlUsd, 0);
  const avgWin = wins.length ? sumW / wins.length : 0;
  const avgLoss = losses.length ? sumL / losses.length : 0;
  return {
    trades: trs.length, closed: closed.length, open: open.length, openPnl: +openPnl.toFixed(2),
    wins: wins.length, losses: losses.length,
    winRate: closed.length ? +(wins.length / closed.length * 100).toFixed(1) : null,
    gross: +gross.toFixed(2), avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
    payoff: avgLoss ? +Math.abs(avgWin / avgLoss).toFixed(2) : null,
    pf: sumL ? +(sumW / Math.abs(sumL)).toFixed(2) : null,
    maxDd: +maxDd.toFixed(2),
  };
}
const summary = stats(trades);

// ═════ 数据覆盖完整度：按实际参与维度数分组 + 按数据边界自动分段 ═════
// 用户核心关切：news 仅 8/02 起、consensus 仅 8/11 起 → 早期窗口是降维回测，必须显性化
const byDims = {};
for (const t of trades) {
  const d = t.activeDims || 3;
  byDims[d] = byDims[d] || [];
  byDims[d].push(t);
}
const byDimsStats = {};
for (const d of Object.keys(byDims).sort((a, b) => +a - +b)) byDimsStats[d + '维'] = stats(byDims[d]);
// 数据覆盖时间线
const dataCoverage = {
  klines: { start: new Date(klines['BTC'][0].time).toISOString().slice(0, 10), end: new Date(klines['BTC'][klines['BTC'].length - 1].time).toISOString().slice(0, 10), count: klines['BTC'].length * SYMS.length },
  factors: { start: new Date(oiRows['BTC'][0].time).toISOString().slice(0, 10), end: new Date(oiRows['BTC'][oiRows['BTC'].length - 1].time).toISOString().slice(0, 10), count: oiRows['BTC'].length * SYMS.length },
  news: WITH_NEWS ? { start: newsT0 ? new Date(newsT0 * 1000).toISOString().slice(0, 10) : null, end: newsT1 ? new Date(newsT1 * 1000).toISOString().slice(0, 10) : null, count: newsAll.length } : null,
  consensus: { start: conRows.length ? new Date(conRows[0].time).toISOString().slice(0, 10) : null, end: conRows.length ? new Date(conRows[conRows.length - 1].time).toISOString().slice(0, 10) : null, count: conRows.length },
  fgi: { start: fgiRows.length ? new Date(fgiRows[0].time).toISOString().slice(0, 10) : null, end: fgiRows.length ? new Date(fgiRows[fgiRows.length - 1].time).toISOString().slice(0, 10) : null, count: fgiRows.length },
};
// 自动分段：完整五维期（news+con 都有） / 中间期（news 有 con 无） / 降维期（news con 均无）
const segBoundaries = [];
const covNews = dataCoverage.news, covCon = dataCoverage.consensus;
if (covNews && covCon) {
  const n0 = new Date(covNews.start).getTime(), c0 = new Date(covCon.start).getTime();
  if (c0 > n0) { segBoundaries.push({ name: '五维完整期（news+consensus）', from: c0 }); segBoundaries.push({ name: 'news 有 · consensus 无', from: n0, to: c0 }); }
  else { segBoundaries.push({ name: '五维完整期（news+consensus）', from: n0 }); segBoundaries.push({ name: 'consensus 有 · news 无', from: c0, to: n0 }); }
  segBoundaries.push({ name: '降维期（news/consensus 均无 → 三维）', to: Math.max(n0, c0) });
} else if (covNews) {
  segBoundaries.push({ name: 'news 有 · consensus 无', from: new Date(covNews.start).getTime() });
  segBoundaries.push({ name: '降维期（news/consensus 均无 → 三维）', to: new Date(covNews.start).getTime() });
} else if (covCon) {
  segBoundaries.push({ name: 'consensus 有 · news 无', from: new Date(covCon.start).getTime() });
  segBoundaries.push({ name: '降维期（news/consensus 均无 → 三维）', to: new Date(covCon.start).getTime() });
}
const segments = segBoundaries.map(s => {
  const f = s.from || windowStart, t = s.to || windowEnd;
  return { name: s.name, from: new Date(f).toISOString().slice(0, 10), to: new Date(t).toISOString().slice(0, 10), stats: stats(trades.filter(x => x.ts >= f && x.ts < t)) };
});

// ═════ 专业绩效指标（年化/风险/期望/对比） ═════
function computeMetrics(trs, eqSeries, cfg, wStart, wEnd, btcKlines) {
  const closed = trs.filter(t => t.status === 'WIN' || t.status === 'LOSS');
  const gross = closed.reduce((a, t) => a + t.pnlUsd, 0);  // 已实现（同 stats 口径）
  const grossPct = cfg.capital ? gross / cfg.capital * 100 : 0;
  const days = Math.max(1, (wEnd - wStart) / 86400000);
  const years = days / 365.25;
  const finalEq = eqSeries.length ? eqSeries[eqSeries.length - 1].equity : cfg.capital;
  const cagr = years > 0 && finalEq > 0 && cfg.capital > 0 ? (Math.pow(finalEq / cfg.capital, 1 / years) - 1) * 100 : null;
  // 日收益序列（净值日收盘）
  const dailyRet = [];
  for (let i = 1; i < eqSeries.length; i++) {
    const prev = eqSeries[i - 1].equity;
    if (prev > 0) dailyRet.push((eqSeries[i].equity - prev) / prev);
  }
  const n = dailyRet.length;
  const mean = n ? dailyRet.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(dailyRet.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const annVol = sd * Math.sqrt(365) * 100;
  const sharpe = sd > 0 ? +(mean / sd * Math.sqrt(365)).toFixed(2) : null;
  const down = dailyRet.filter(r => r < 0);
  const dsd = down.length > 1 ? Math.sqrt(down.reduce((a, b) => a + (b - mean) ** 2, 0) / (down.length - 1)) : 0;
  const sortino = dsd > 0 ? +(mean / dsd * Math.sqrt(365)).toFixed(2) : null;
  const maxDdPct = summary.maxDd;
  const calmar = maxDdPct > 0 && cagr != null ? +(cagr / maxDdPct).toFixed(2) : null;
  // 最长回撤持续（净值未创新高天数）
  let maxDdDur = 0, peakEq = cfg.capital, peakT = eqSeries.length ? eqSeries[0].ts : wStart;
  for (const e of eqSeries) {
    if (e.equity >= peakEq) { peakEq = e.equity; peakT = e.ts; }
    const dd = (peakEq - e.equity) / peakEq;
    if (dd > 0.001) { const dur = (e.ts - peakT) / 86400000; if (dur > maxDdDur) maxDdDur = dur; }
  }
  // 期望值 / 连赢连亏 / 平均持仓
  const expectancy = trs.length ? gross / trs.length : 0;
  let streak = 0, maxWin = 0, maxLoss = 0;
  for (const t of closed) {
    if (t.pnlUsd > 0) { streak = streak > 0 ? streak + 1 : 1; maxWin = Math.max(maxWin, streak); }
    else { streak = streak < 0 ? streak - 1 : -1; maxLoss = Math.max(maxLoss, -streak); }
  }
  const avgHold = closed.length ? closed.reduce((a, t) => a + (t.holdH || 0), 0) / closed.length : 0;
  // BTC 买入持有对比（同窗口首尾）
  let buyHold = null;
  if (btcKlines && btcKlines.length > 1) {
    const win = btcKlines.filter(k => k.time >= wStart && k.time <= wEnd);
    if (win.length > 1) {
      const f = win[0], l = win[win.length - 1];
      buyHold = { symbol: 'BTC', startPx: +f.c.toFixed(2), endPx: +l.c.toFixed(2), pct: +((l.c - f.c) / f.c * 100).toFixed(2) };
    }
  }
  // 回撤序列（画图用）
  const drawdown = [];
  let pk = cfg.capital;
  for (const e of eqSeries) {
    pk = Math.max(pk, e.equity);
    drawdown.push({ t: e.t, ts: e.ts, dd: +((pk - e.equity) / pk * 100).toFixed(2) });
  }
  // 月度收益（USD 已有 monthly；这里补 %，按月初净值）
  const monthlyPct = {};
  let monthStart = cfg.capital, lastEq = cfg.capital;
  for (const e of eqSeries) {
    const m = e.t.slice(0, 7);
    if (monthlyPct[m] === undefined) monthlyPct[m] = { startEq: +(lastEq).toFixed(2), endEq: null };
    monthlyPct[m].endEq = +e.equity.toFixed(2);
    lastEq = e.equity;
  }
  for (const m in monthlyPct) {
    const o = monthlyPct[m];
    o.pct = o.startEq > 0 ? +((o.endEq - o.startEq) / o.startEq * 100).toFixed(2) : 0;
  }
  return {
    gross: +gross.toFixed(2), grossPct: +grossPct.toFixed(2), finalEq: +finalEq.toFixed(2),
    cagr: cagr != null ? +cagr.toFixed(2) : null, annVol: +annVol.toFixed(2),
    sharpe, sortino, calmar, maxDdPct, maxDdDurDays: +maxDdDur.toFixed(1),
    expectancy: +expectancy.toFixed(2), maxWinStreak: maxWin, maxLossStreak: maxLoss,
    avgHoldH: +avgHold.toFixed(1), buyHold, drawdown, monthlyPct,
  };
}
const metrics = computeMetrics(trades, equitySeries, CFG, windowStart, windowEnd, klines['BTC']);
const perSym = {};
for (const s of SYMS) perSym[s] = stats(trades.filter(t => t.sym === s));
const perDir = { long: stats(trades.filter(t => t.dir === 'long')), short: stats(trades.filter(t => t.dir === 'short')) };
const monthly = {};
for (const t of trades) { const m = new Date(t.ts).toISOString().slice(0, 7); monthly[m] = (monthly[m] || 0) + t.pnlUsd; }
for (const m in monthly) monthly[m] = +monthly[m].toFixed(2);
const byReason = {};
for (const t of trades) { const r = t.reason || '?'; byReason[r] = (byReason[r] || 0) + 1; }

// ═════ 输出 ═════
maybeState('report', 96, '结算统计中…');
console.log('══════════ TIANJI 回测 v2 ══════════');
console.log(`窗口: ${new Date(windowStart).toISOString().slice(0,10)} → ${new Date(windowEnd).toISOString().slice(0,10)} | ${SYMS.length}标的 × 4h`);
console.log(`口径: ${COMPOUND ? '复利' : '固定本金'}${ACCOUNT0}U · ${LEV}x · 成本 ${WITH_COST ? COST_BPS + 'bps双边' : '0'} · 敞口上限 ${MAX_TOTAL_LEV}x · 消息面 ${WITH_NEWS ? '真实(news_hist)' : '关'} · LLM审查 ${LLM ? '开' : '关'}`);
if (WITH_NEWS) console.log(`消息面覆盖: ${newsT0 ? new Date(newsT0 * 1000).toISOString().slice(0,10) : '无'} → ${newsT1 ? new Date(newsT1 * 1000).toISOString().slice(0,10) : '无'} (${newsAll.length}条)`);
if (LLM) console.log(`AI审查: 审 ${llmStats.reviewed} 候选 · 否决 ${llmStats.vetoed} · 同意 ${llmStats.agreed} · 观望 ${llmStats.held} · 失败 ${llmStats.failed}`);
if (aiWatch.length) { try { fs.writeFileSync(path.join(ROOT, 'data', `tianji_aiwatch_${Date.now()}.json`), JSON.stringify(aiWatch, null, 2)); } catch (e) {} }
if (rangeBlocked) console.log(`RANGE门控: 拦截 ${rangeBlocked} 个弱信号（震荡市 |总分|<5.5 或 |qibao|<1.5）`);
console.log(`交易 ${summary.trades} 笔 | 胜率 ${summary.winRate}% (${summary.wins}W/${summary.losses}L)`);
console.log(`已结盈亏 ${summary.gross >= 0 ? '+' : ''}${summary.gross}U (${(summary.gross / ACCOUNT0 * 100).toFixed(1)}%)${summary.openPnl ? ` | OPEN 浮盈 ${summary.openPnl >= 0 ? '+' : ''}${summary.openPnl}U（${summary.open}笔未平仓，不计入盈亏）` : ''} | 期末净值 ${equity.toFixed(2)}U`);
console.log(`平均盈利 +${summary.avgWin}U / 平均亏损 ${summary.avgLoss}U | 盈亏比 ${summary.payoff} | PF ${summary.pf}`);
console.log(`最大回撤 ${summary.maxDd}% | 被限额挡单 ${blockedCount} 次`);
console.log('\n--- 专业指标 ---');
console.log(`年化CAGR ${metrics.cagr != null ? metrics.cagr + '%' : '—'} | 波动率(年化) ${metrics.annVol}% | 夏普 ${metrics.sharpe} | 索提诺 ${metrics.sortino} | 卡玛 ${metrics.calmar}`);
console.log(`最大回撤持续 ${metrics.maxDdDurDays} 天 | 期望值 ${metrics.expectancy >= 0 ? '+' : ''}${metrics.expectancy}U/笔 | 最大连胜 ${metrics.maxWinStreak} | 最大连亏 ${metrics.maxLossStreak} | 平均持仓 ${metrics.avgHoldH}h`);
if (metrics.buyHold) console.log(`BTC 买入持有对比: ${metrics.buyHold.startPx} → ${metrics.buyHold.endPx} (${metrics.buyHold.pct >= 0 ? '+' : ''}${metrics.buyHold.pct}%)`);
console.log('\n--- 数据覆盖完整度（用户必看：news/con 历史有限，早期为降维回测） ---');
console.log(`K线 ${dataCoverage.klines.start}→${dataCoverage.klines.end} · 因子 ${dataCoverage.factors.start}→${dataCoverage.factors.end} · news ${covNews ? covNews.start + '→' + covNews.end : '无'} · consensus ${covCon ? covCon.start + '→' + covCon.end : '无'} · FGI ${dataCoverage.fgi.start}→${dataCoverage.fgi.end}`);
for (const d of Object.keys(byDimsStats).sort((a, b) => +a - +b)) {
  const s = byDimsStats[d];
  console.log(`${d}: ${s.trades}笔 胜率${s.winRate}% 盈亏${s.gross}U PF${s.pf}`);
}
for (const s of segments) console.log(`段[${s.name}] ${s.from}→${s.to}: ${s.stats.trades}笔 胜率${s.stats.winRate}% 盈亏${s.stats.gross}U PF${s.stats.pf}`);

// ═════ 复现评估（REPLAY 5m 模式）：回测单 vs 实盘 signal_track 历史单 ═════
let replay = null;
if (REPLAY) {
  try {
    const ldb = new Database(path.join(ROOT, 'data', 'w1.db'), { readonly: true });
    const live = ldb.prepare("SELECT pushed_at, symbol, direction, status, entry, pnl_pct, reason FROM signal_track WHERE strategy='TIANJI' AND pushed_at >= ? AND pushed_at <= ?").all(windowStart, windowEnd);
    ldb.close();
    const matches = [], missed = [];
    for (const l of live) {
      const hit = trades.filter(t => t.sym === l.symbol && t.dir === l.direction && Math.abs((t.entryTs || t.ts) - l.pushed_at) <= 2 * 3600 * 1000);
      if (hit.length) matches.push({ sym: l.symbol, dir: l.direction, liveTs: l.pushed_at, liveStatus: l.status, livePnl: +Number(l.pnl_pct || 0).toFixed(2), btTs: hit[0].ts, btStatus: hit[0].status, btPnl: +hit[0].pnlPct.toFixed(2) });
      else missed.push({ sym: l.symbol, dir: l.direction, ts: l.pushed_at, status: l.status, pnl: +Number(l.pnl_pct || 0).toFixed(2), reason: l.reason });
    }
    const liveExtra = trades.filter(t => !live.some(l => l.symbol === t.sym && l.direction === t.dir && Math.abs((t.entryTs || t.ts) - l.pushed_at) <= 2 * 3600 * 1000));
    replay = { liveCount: live.length, matched: matches.length, extra: liveExtra.length, rate: live.length ? +(matches.length / live.length * 100).toFixed(1) : null, matches, missed };
    console.log('\n══════════ 复现评估（实盘历史单 vs 回测单，≤2h 同币同向） ══════════');
    console.log(`实盘 ${live.length} 单 → 复现 ${matches.length} 单（${replay.rate}%）| 回测多出 ${liveExtra.length} 单`);
    for (const m of matches) console.log(`✅ ${m.sym} ${m.dir} 实盘${new Date(m.liveTs).toISOString().slice(11,16)}(${m.liveStatus}/${m.livePnl}%) ≈ 回测${new Date(m.btTs).toISOString().slice(11,16)}(${m.btStatus}/${m.btPnl}%)`);
    for (const m of missed) console.log(`❌ ${m.sym} ${m.dir} ${new Date(m.ts).toISOString().slice(0,16)} ${m.status}/${m.pnl}% (${m.reason})`);
  } catch (e) { console.log('复现评估失败:', e.message); }
}
console.log('\n--- 按币种 ---');
for (const s of SYMS) { const st = perSym[s]; if (st.trades) console.log(`${s}: ${st.trades}笔 ${st.winRate}% +${st.gross}U PF${st.pf}`); }
console.log('\n--- 按方向 ---');
for (const d of ['long', 'short']) { const st = perDir[d]; console.log(`${d}: ${st.trades}笔 ${st.winRate}% +${st.gross}U PF${st.pf} 盈亏比${st.payoff}`); }
console.log('\n--- 按月 ---');
for (const m of Object.keys(monthly).sort()) console.log(`${m}: ${monthly[m] >= 0 ? '+' : ''}${monthly[m]}U`);
console.log('\n--- 结算原因分布 ---');
for (const r of Object.keys(byReason)) console.log(`${r}: ${byReason[r]}`);
if (SPLIT) {
  const mid = windowStart + (windowEnd - windowStart) * 0.7;
  const train = trades.filter(t => t.ts < mid), test = trades.filter(t => t.ts >= mid);
  const stT = stats(train), stE = stats(test);
  console.log(`\n--- 分段 (70/30 @ ${new Date(mid).toISOString().slice(0,10)}) ---`);
  console.log(`train: ${stT.trades}笔 胜率${stT.winRate}% 盈亏${stT.gross}U PF${stT.pf}`);
  console.log(`test : ${stE.trades}笔 胜率${stE.winRate}% 盈亏${stE.gross}U PF${stE.pf}`);
}
if (LIST_TRADES) {
  console.log('\n--- 明细 ---');
  for (const t of trades) {
    const d = new Date(t.ts);
    const fmt = v => v >= 1000 ? v.toFixed(0) : v.toFixed(4);
    console.log(`${d.toISOString().slice(0,16)} ${t.sym} ${t.dir==='long'?'多':'空'} ${t.status} ${t.reason} ${fmt(t.entry)}→${fmt(t.exit)} ${t.pnlPct>=0?'+':''}${t.pnlPct}% (${t.pnlUsd>=0?'+':''}${t.pnlUsd}U) score=${t.score} [消${t.news}/技${t.tech}/资${t.fund}/共${t.con}/七${t.qib}]${t.ai?' AI:'+t.ai:''} pos=${t.posPct}%`);
  }
}

// 落盘 JSON + CSV
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outBase = path.join(ROOT, 'data', `tianji_bt_${stamp}`);
const report = { builtAt: new Date().toISOString(), ddStats: { enabled: !!CFG.dd_lev, triggers: ddTriggers, scales: CFG.dd_scales }, window: { start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString() },
  config: { compound: COMPOUND, lev: LEV, costBps: WITH_COST ? COST_BPS : 0, maxTotalLev: MAX_TOTAL_LEV, acct0: ACCOUNT0, llm: LLM, news: WITH_NEWS, params: CFG },
  summary, metrics, perSymbol: perSym, perDirection: perDir, monthly, byReason, blockedCount,
  dataCoverage, byDims: byDimsStats, segments, replay,
  aiStats: LLM ? llmStats : null,
  newsCoverage: WITH_NEWS ? { count: newsAll.length, start: newsT0 ? new Date(newsT0 * 1000).toISOString() : null, end: newsT1 ? new Date(newsT1 * 1000).toISOString() : null } : null,
  equity: equitySeries, trades };
fs.writeFileSync(outBase + '.json', JSON.stringify(report, null, 2));
fs.writeFileSync(outBase + '_trades.csv', 'entryTs,ts,sym,dir,status,reason,entry,exit,stop,t1,t2,pnlPct,pnlUsd,holdH,posPct,notional,score,news,tech,fund,con,qib,ai\n' +
  trades.map(t => [new Date(t.entryTs || t.ts).toISOString(), new Date(t.ts).toISOString(), t.sym, t.dir, t.status, `"${t.reason}"`, t.entry, t.exit, t.stop, t.t1, t.t2, t.pnlPct, t.pnlUsd, t.holdH, t.posPct, t.notional, t.score, t.news, t.tech, t.fund, t.con, t.qib, t.ai || ''].join(',')).join('\n'));
fs.writeFileSync(outBase + '_equity.csv', 'day,ts,equity,positions\n' + equitySeries.map(e => `${e.t},${new Date(e.ts).toISOString()},${e.equity},${e.positions}`).join('\n'));
console.log(`\n报告: ${outBase}.json (+_trades.csv +_equity.csv)`);

// UI 模式：写 latest + done 状态
if (UI_MODE) {
  try { fs.writeFileSync(UI_LATEST, JSON.stringify(report)); } catch (e) {}
  // 回测历史存档：每次回测记录挂前端可查（摘要 + 完整报告文件路径，按 builtAt 去重，保留最近 30 条）
  try {
    const HIST = path.join(ROOT, 'data', 'tianji_bt_history.json');
    let hist = [];
    try { hist = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch (e) {}
    if (!Array.isArray(hist)) hist = [];
    hist = hist.filter(h => h && h.id !== report.builtAt);
    hist.unshift({
      id: report.builtAt,
      builtAt: report.builtAt,
      window: report.window,
      params: CFG,
      summary: report.summary,
      metrics: { cagr: report.metrics && report.metrics.cagr, sharpe: report.metrics && report.metrics.sharpe, calmar: report.metrics && report.metrics.calmar, finalEq: report.metrics && report.metrics.finalEq },
      replay: report.replay || null,
      dataCoverage: report.dataCoverage,
      file: outBase + '.json',
      symbols: SYMS.length
    });
    hist = hist.slice(0, 30);
    fs.writeFileSync(HIST, JSON.stringify(hist, null, 2));
  } catch (e) {}
  try { fs.writeFileSync(UI_STATE, JSON.stringify({ status: 'done', phase: 'report', progress: 100, message: '回测完成', startedAt: BT_STARTED, finishedAt: Date.now(), updatedAt: Date.now(), pid: process.pid })); } catch (e) {}
}
})().catch(e => {
  console.error('回测异常:', e.message, '\n', e.stack ? e.stack.split('\n').slice(0,5).join('\n') : '');
  try { fs.writeFileSync(UI_STATE, JSON.stringify({ status: 'error', phase: 'error', progress: 0, message: '回测失败: ' + e.message, startedAt: BT_STARTED, updatedAt: Date.now(), pid: process.pid })); } catch (e2) {}
  process.exit(1);
});

// 反抽空诊断（仅 pullback_short 开启时有意义）
if (CFG.pullback_short) console.log('[DIAG-pullback]', JSON.stringify(pbDiag));
