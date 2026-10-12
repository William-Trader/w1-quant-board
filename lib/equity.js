const { debug } = require('./log');
// 实盘净值快照引擎：1000u 复利 + 持仓浮盈，15分钟计点
const { store } = require('./store');

const INIT = 1000;

// 解析 futures_markets payload → {symbol: price}
function parsePrices(payload) {
  try {
    let p = JSON.parse(payload);
    if (Array.isArray(p)) p = p[0] || {};
    const data = p.data || [];
    const list = Array.isArray(data) ? data : (data.data || []);
    const m = {};
    for (const c of list) if (c && c.symbol) m[c.symbol] = Number(c.current_price);
    return m;
  } catch (e) { debug('[equity] load:', e.message); return {}; }
}

// 获取指定时间点最近的历史价格（优先 prices 分钟级表，fallback futures_markets 快照）
function pxAt(db, ts, symbols) {
  const m = {};
  for (const sym of symbols || []) {
    // prices 表：分钟级，取该点前最近一条
    const p = db.prepare("SELECT price FROM prices WHERE symbol=? AND ts<=? ORDER BY ts DESC LIMIT 1").get(sym, ts);
    if (p) { m[sym] = Number(p.price); continue; }
    // fallback：futures_markets 最近快照
    const row = db.prepare("SELECT payload FROM futures_markets WHERE ts <= ? ORDER BY ts DESC LIMIT 1").get(ts);
    if (row) {
      const pm = parsePrices(row.payload);
      if (pm[sym] != null) m[sym] = pm[sym];
    }
  }
  return Object.keys(m).length ? m : null;
}

// 计算当前净值（最新价格）
function calcEquity(db) {
  const rows = db.prepare("SELECT * FROM signal_track WHERE strategy='TIANJI' OR strategy='LIVE' OR strategy='ALPHA1' ORDER BY pushed_at").all();
  const fut = store.latestFutures(db);
  const coins = (fut && fut.data && fut.data.data) || [];
  const pxOf = (sym) => { const c = coins.find(x => x.symbol === sym); return c ? Number(c.current_price) : 0; };
  let equity = INIT;
  let openCount = 0;
  for (const r of rows) {
    let pnl = Number(r.pnl_pct || 0);
    if (r.status === 'OPEN') {
      openCount++;
      const px = pxOf(r.symbol), entry = Number(r.entry);
      if (px && entry) {
        const floatPct = r.direction === 'long' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
        // T1已落袋 → 60%利润已锁定 + 剩余40%按浮盈（对齐回测 60/40 口径）
        if (r.t1_hit && Number(r.target1)) {
          const t1Gain = r.direction === 'long' ? (Number(r.target1) - entry) / entry * 100 : (entry - Number(r.target1)) / entry * 100;
          pnl = 0.6 * t1Gain + 0.4 * floatPct;
        } else {
          pnl = floatPct;
        }
      }
    }
    // 2026-08-26 修复：单笔盈亏 = 实际名义 × 涨跌%（加法累计，与单笔显示/风控口径一致）
    // 旧复利口径 净值×杠杆×pos_pct 把风险预算%(2.1)当保证金占比，虚高近一倍（DOGE -50u 事故）
    const lev = Number(r.leverage || 50), pos = Number(r.pos_pct || 0);
    const notional = Number(r.notional_usd || 0);
    const base = notional > 0 ? notional : equity * lev * pos / 100; // 旧单无名义才回退估算
    equity += base * pnl / 100;
  }
  return { equity: +equity.toFixed(2), pnl: +(equity - INIT).toFixed(2), openCount };
}

// 计算指定时间点的净值（用历史快照价格，只算已开仓单）
function calcEquityAt(db, ts) {
  const rows = db.prepare("SELECT * FROM signal_track WHERE strategy='TIANJI' OR strategy='LIVE' OR strategy='ALPHA1' ORDER BY pushed_at").all();
  const openSyms = rows.filter(r => Number(r.pushed_at) <= (ts + 900) * 1000 && r.status === 'OPEN').map(r => r.symbol);
  const pxMap = pxAt(db, ts, openSyms) || {};
  let equity = INIT;
  let openCount = 0;
  for (const r of rows) {
    if (Number(r.pushed_at) > (ts + 900) * 1000) continue; // 该15分钟窗口内已开仓才计入
    let pnl = Number(r.pnl_pct || 0);
    if (r.status === 'OPEN') {
      openCount++;
      const px = pxMap[r.symbol], entry = Number(r.entry);
      if (px && entry) {
        const floatPct = r.direction === 'long' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
        if (r.t1_hit && Number(r.target1)) {
          const t1Gain = r.direction === 'long' ? (Number(r.target1) - entry) / entry * 100 : (entry - Number(r.target1)) / entry * 100;
          pnl = 0.6 * t1Gain + 0.4 * floatPct;
        } else {
          pnl = floatPct;
        }
      }
    }
    const lev = Number(r.leverage || 50), pos = Number(r.pos_pct || 0);
    const notional = Number(r.notional_usd || 0);
    const base = notional > 0 ? notional : equity * lev * pos / 100;
    equity += base * pnl / 100;
  }
  return { equity: +equity.toFixed(2), pnl: +(equity - INIT).toFixed(2), openCount };
}

// 记录一个 15 分钟快照点（幂等）
function snapshot(db, now = Date.now()) {
  const ts = Math.floor(now / 900000) * 900; // 15min 桶对齐（幂等，避免秒偏移双点）
  const { equity, pnl, openCount } = calcEquity(db);
  db.prepare("INSERT OR REPLACE INTO equity_history(ts, equity, pnl, open_count) VALUES(?,?,?,?)")
    .run(ts, equity, pnl, openCount);
  return { ts, equity, pnl, openCount };
}

// 实盘真实权益（OKX 账户，60s 缓存）—— 供资金头卡显示真实净值
let _okxCache = { ts: 0, value: null };
async function okxEquity(db) {
  if (Date.now() - _okxCache.ts < 60000 && _okxCache.value) return _okxCache.value;
  try {
    const okx = require('./okx_executor');
    const st = await okx.accountStatus(db);
    const v = (st.connected && st.balance) ? {
      connected: true,
      equity: Number(st.balance.totalEq) || 0,
      avail: Number(st.balance.availEq) || 0,
      positions: (st.positions || []).length,
      ts: Date.now()
    } : { connected: false, equity: null, avail: null, positions: 0, ts: Date.now() };
    _okxCache = { ts: Date.now(), value: v };
    return v;
  } catch (e) { return { connected: false, equity: null, avail: null, positions: 0, ts: Date.now() }; }
}

// 取净值曲线（15分钟计点，limit 个点）
function curve(db, limit = 500) {
  const rows = db.prepare("SELECT ts, equity, pnl, open_count FROM equity_history ORDER BY ts DESC LIMIT ?").all(limit);
  // ts 归一化到 15min 桶：同桶取最新一条，消除秒偏移点与整点并存的双点抖动
  const byBucket = new Map();
  for (const r of rows) {
    const b = Math.floor(r.ts / 900) * 900;
    if (!byBucket.has(b) || r.ts > byBucket.get(b).ts) byBucket.set(b, r);
  }
  return [...byBucket.values()].sort((a, b) => a.ts - b.ts)
    .map(r => ({ ts: r.ts, label: fmtTs(r.ts), y: r.equity, pnl: r.pnl, open: r.open_count }));
}

// 回填历史：从首单开单时间到当前，按15分钟间隔补点（用历史快照价格，真实浮动）
function backfill(db) {
  const first = db.prepare("SELECT MIN(pushed_at) first FROM signal_track WHERE strategy='TIANJI' OR strategy='LIVE' OR strategy='ALPHA1'").get();
  if (!first || !first.first) return 0;
  const start = Math.floor(first.first / 1000);
  const now = Math.floor(Date.now() / 1000);
  const STEP = 900; // 15min
  let added = 0;
  for (let ts = start; ts <= now; ts += STEP) {
    const exists = db.prepare("SELECT 1 FROM equity_history WHERE ts=?").get(ts);
    if (exists) { added++; continue; }
    const { equity, pnl, openCount } = calcEquityAt(db, ts);
    db.prepare("INSERT OR REPLACE INTO equity_history(ts, equity, pnl, open_count) VALUES(?,?,?,?)")
      .run(ts, equity, pnl, openCount);
    added++;
  }
  return added;
}

function fmtTs(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

module.exports = { INIT, calcEquity, calcEquityAt, snapshot, curve, backfill, fmtTs, okxEquity };
