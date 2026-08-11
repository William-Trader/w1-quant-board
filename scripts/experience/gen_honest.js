'use strict';
// ============================================================
// 指标战绩严谨重生成 v2（2026-08-11 · William 老板审计指令）
// v2 关键修正：信号 100% 保持原统一引擎输出（从备份读回 label/pos/score/price/fgi，
// 不再二次判定）——严格遵守"同分同判"铁律，只换结算口径：
//   1. 盈亏对称（移除亏损封顶）
//   2. 真实持仓模拟：逐1H bar 止损/止盈/爆仓/14天超时（settleTrade）
//   3. 观望场（pos=0）不计命中率，指标全量重算
// 用法: cd /home/ubuntu/w1-board && node scripts/experience/gen_honest.js
// ============================================================
const fs = require('fs');
const Database = require('/home/ubuntu/w1-board/node_modules/better-sqlite3');
const { settleTrade, FEE, SLIP } = require('/home/ubuntu/w1-board/scripts/experience/honest_settle.js');

const DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const BACKUP = '/home/ubuntu/w1-board/public/experience.json.bak-audit-20260811';
const PUBLIC = '/home/ubuntu/w1-board/public/experience.json';
const DATA_OUT = '/home/ubuntu/w1-board/data/experience_blind.json';
const LEVER = 100, PRINCIPAL = 10000;

const db = new Database(DB, { readonly: true });
const allBars = db.prepare("SELECT ts,o,h,l,c,v FROM klines WHERE symbol='BTCUSDT' ORDER BY ts").all();
const barIdx = new Map(allBars.map((b, i) => [b.ts, i]));

// 日线聚合
const dayMap = new Map(); const dayArr = [];
for (const b of allBars) {
  const d = new Date(b.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  let g = dayMap.get(d);
  if (!g) { g = { d, o: b.o, h: b.h, l: b.l, c: b.c, v: 0 }; dayMap.set(d, g); dayArr.push(g); }
  g.h = Math.max(g.h, b.h); g.l = Math.min(g.l, b.l); g.c = b.c; g.v += b.v;
}
const dayIdxOf = d => dayArr.findIndex(g => g.d === d);

// ATR（冻结时点前14日收盘差，与统一引擎 buildOrder 同口径）
function atrAt(freezeMs) {
  const tsEnd = freezeMs;
  const closes = [];
  for (let i = allBars.length - 1; i >= 0 && closes.length < 15; i--) {
    if (allBars[i].ts < tsEnd) closes.push(allBars[i].c);
  }
  closes.reverse();
  return closes.length >= 2 ? Math.abs(closes[closes.length - 1] - closes[closes.length - 2]) : null;
}

// 订单计划：与 experience_engine.buildOrder 完全一致
function buildOrder(r, freezeMs) {
  const price = r.price;
  const label = r.label;
  const dir = label.includes('多') ? 'long' : label.includes('空') ? 'short' : null;
  if (!dir || !r.pos || r.pos <= 0) return null;
  const atr = atrAt(freezeMs) || price * 0.01;
  const stopMult = r.pos >= 8 ? 2.0 : r.pos >= 3 ? 1.5 : 1.2;
  const stopDist = Math.max(atr * stopMult, price * 0.008);
  const fgiDisc = r.fgi != null ? (r.fgi <= 20 ? 0.3 : r.fgi <= 30 ? 0.5 : r.fgi <= 45 ? 0.7 : 1) : 1;
  const posPct = Math.min(12, Math.max(0, Math.round(r.pos * fgiDisc * 100) / 100));
  let entry, stop, t1, t2;
  if (dir === 'long') { entry = price; stop = price - stopDist; t1 = entry + stopDist * 1.5; t2 = entry + stopDist * 2.5; }
  else { entry = price; stop = price + stopDist; t1 = entry - stopDist * 1.5; t2 = entry - stopDist * 2.5; }
  return { dir, entry, stop, t1, t2, posPct };
}

// ===== 主流程：读备份（信号保真）→ 真实结算 → 全量重算 =====
const data = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
let settledCount = 0;
for (const r of data.results) {
  const freeze = new Date(r.date + 'T23:59:59+08:00').getTime();
  const startTs = freeze + 3600000;
  const bars = allBars.filter(b => b.ts > startTs && b.ts <= freeze + 15 * 86400000);
  const p14 = bars.length ? bars[bars.length - 1].c : null;

  const ord = buildOrder(r, freeze);
  if (ord && bars.length) {
    const st = settleTrade({ entry: ord.entry, dir: ord.dir, stop: ord.stop, t1: ord.t1, t2: ord.t2, bars, leverage: LEVER, posPct: ord.posPct, equity: PRINCIPAL });
    r.pnl = st.pnlUsd;
    r.hit = st.pnlUsd > 0;
    r.status = st.pnlUsd > 0 ? '✅ 命中' : '❌ 未中';
    r.p14 = p14 != null ? Math.round(p14) : null;
    r.chg14 = p14 != null ? Math.round((p14 / r.price - 1) * 1000) / 10 : null;
    r.entry = ord.entry;
    r.exit_reason = st.reason;
    r.exit_px = st.exitPx;
    r.exit_rr = st.rr;
    r.pos_pct_actual = ord.posPct;
    settledCount++;
  } else {
    r.pnl = 0; r.hit = null;
    r.status = '⚪ 观望（不计入命中率）';
    r.exit_reason = '观望';
    if (p14 != null) { r.p14 = Math.round(p14); r.chg14 = Math.round((p14 / r.price - 1) * 1000) / 10; }
  }
}
console.log(`已结算持仓场次: ${settledCount}`);

// ===== summary 全量重算 =====
const results = data.results;
const settled = results.filter(r => r.hit !== null);
const wins = settled.filter(r => r.hit).length;
const total_pnl = results.reduce((s, r) => s + r.pnl, 0);
const acc = settled.length ? Math.round(wins / settled.length * 100) : 0;
const eq = [PRINCIPAL]; let eqCur = PRINCIPAL;
for (const r of results) { eqCur += r.pnl; eq.push(Math.round(eqCur)); }
let peak = PRINCIPAL, maxDd = 0;
for (const v of eq) { if (v > peak) peak = v; maxDd = Math.max(maxDd, peak - v); }
function ctlPath(lev) { const p = [PRINCIPAL]; for (const r of results) { if (r.chg14 == null) { p.push(p[p.length - 1]); continue; } const v = p[p.length - 1] * (1 + lev * r.chg14 / 100); p.push(Math.round(v) > 0 ? Math.round(v) : 0); } return p; }
const ctl100 = ctlPath(100), ctl10 = ctlPath(10);
function wipeAt(path) { for (let i = 1; i < path.length; i++) { if (path[i] === 0) { const r = results[i - 1]; return { call: i, date: r.date, chg: r.chg14, label: r.label }; } } return null; }
const w100 = wipeAt(ctl100), w10 = wipeAt(ctl10);

const groups = {};
for (const r of results) {
  const g = r.regime || (r.scene === '随机波段' ? '🎲 随机波段抽样' : '📊 其他');
  (groups[g] = groups[g] || []).push(r);
}
const regime_stats = Object.keys(groups).map(name => {
  const rs = groups[name], st = rs.filter(x => x.hit !== null), gw = st.filter(x => x.hit).length;
  return { name, total: rs.length, hit: gw, pending: rs.length - st.length, acc: st.length ? Math.round(gw / st.length * 100) : null, pnl: Math.round(rs.reduce((s, x) => s + x.pnl, 0)) };
});

const pnls = results.map(r => r.pnl);
const rets = pnls.map(p => p / PRINCIPAL);
const dates = results.map(r => r.date).sort();
const years = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (365.25 * 86400000) + 14 / 365.25;
const cagr = total_pnl > -PRINCIPAL ? (Math.pow(1 + total_pnl / PRINCIPAL, 1 / years) - 1) * 100 : -100;
const meanR = rets.reduce((s, x) => s + x, 0) / rets.length;
const stdR = Math.sqrt(rets.reduce((s, x) => s + (x - meanR) ** 2, 0) / rets.length);
const sharpe = stdR > 0 ? meanR / stdR * Math.sqrt(365 / 14) : null;
const downDev = Math.sqrt(rets.reduce((s, x) => s + (x < 0 ? x * x : 0), 0) / rets.length);
const sortino = downDev > 0 ? meanR / downDev * Math.sqrt(365 / 14) : null;
const wl = pnls.filter(p => p > 0), ls = pnls.filter(p => p < 0);
const grossWin = wl.reduce((s, x) => s + x, 0), grossLoss = Math.abs(ls.reduce((s, x) => s + x, 0));
const profit_factor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : null);
const avg_win = wl.length ? grossWin / wl.length : 0, avg_loss = ls.length ? -grossLoss / ls.length : 0;
const expectancy = settled.length ? (wins / settled.length) * avg_win + (1 - wins / settled.length) * avg_loss : 0;
const longs = results.filter(r => r.cls && r.cls.startsWith('long')).length;
const shorts = results.filter(r => r.cls && r.cls.startsWith('short')).length;
const flats = results.filter(r => r.cls && r.cls.startsWith('flat')).length;
const posArr = results.filter(r => r.pos > 0).map(r => r.pos);
const avg_pos = posArr.length ? posArr.reduce((s, x) => s + x, 0) / posArr.length : 0;
let cur = 0, bestWin = 0, bestLoss = 0;
for (const r of results) {
  if (r.hit === true || r.hit === false) {
    if (r.hit) { cur = cur > 0 ? cur + 1 : 1; if (cur > bestWin) bestWin = cur; }
    else { cur = cur < 0 ? cur - 1 : -1; if (cur < bestLoss) bestLoss = cur; }
  }
}
let gapSum = 0, gapN = 0;
for (let i = 1; i < results.length; i++) {
  gapSum += (new Date(results[i].date + 'T00:00:00Z') - new Date(results[i - 1].date + 'T00:00:00Z')) / 86400000; gapN++;
}
const avg_gap = gapN ? Math.round(gapSum / gapN) : 0;
const dirBalance = Math.max(longs, shorts) / (longs + shorts || 1);
let styleTag;
if (avg_pos >= 8) styleTag = '重仓进攻型';
else if (avg_pos >= 5) styleTag = '稳健波段型';
else styleTag = '轻仓试探型';
const styleDesc = `${styleTag} · 多${longs}/空${shorts}/观望${flats} · 平均仓位${avg_pos.toFixed(1)}% · 约${avg_gap}天一出手 · 14日持仓`;

const summary = {
  total: results.length, wins, pending: results.length - settled.length, acc, total_pnl,
  principal: PRINCIPAL, leverage: LEVER, ledger: pnls, equity: eq, ctl100, ctl10,
  regime_stats, w100, w10,
  metrics: {
    sharpe: sharpe != null ? +sharpe.toFixed(2) : null,
    sortino: sortino != null ? +sortino.toFixed(2) : null,
    profit_factor: profit_factor != null ? +profit_factor.toFixed(2) : null,
    expectancy: Math.round(expectancy),
    cagr: +cagr.toFixed(1),
    vol_ann: +((stdR * Math.sqrt(365 / 14) * 100).toFixed(1)),
    calmar: (peak > 0 && maxDd / peak > 0) ? +(cagr / (maxDd / peak * 100)).toFixed(2) : null,
    recovery: maxDd > 0 ? +(total_pnl / maxDd).toFixed(2) : null,
    max_dd: Math.round(maxDd),
    max_dd_pct: peak > 0 ? +(maxDd / peak * 100).toFixed(1) : 0,
    avg_win: Math.round(avg_win), avg_loss: Math.round(avg_loss),
    max_win: wl.length ? Math.max(...wl) : 0, max_loss: ls.length ? Math.min(...ls) : 0,
    avg_pnl: Math.round(total_pnl / results.length),
    longs, shorts, flats, avg_pos: +avg_pos.toFixed(1),
    win_rate: acc,
    win_streak: bestWin, loss_streak: -bestLoss,
    avg_gap,
    style: styleDesc, style_tag: styleTag,
    liq_count: results.filter(r => String(r.exit_reason).includes('爆仓')).length,
    stop_count: results.filter(r => String(r.exit_reason).includes('止损')).length,
    tp_count: results.filter(r => String(r.exit_reason).includes('止盈')).length,
    time_count: results.filter(r => String(r.exit_reason).includes('超时')).length
  }
};
data.summary = summary;
data.generated = new Date().toISOString().slice(0, 10);
data.caliber = 'honest_v2';
for (const f of [DATA_OUT, PUBLIC]) fs.writeFileSync(f, JSON.stringify(data, null, 1));
console.log('✅ 严谨重生成 v2 完成（信号保真，仅换结算）→ ' + PUBLIC);
console.log(JSON.stringify(summary.metrics, null, 1));
console.log(`\n命中 ${wins}/${settled.length} (${acc}%) | 账本 ${total_pnl >= 0 ? '+' : ''}${total_pnl}u | 净值 ${eq[eq.length - 1]}`);
console.log(`满仓100x归零: ${w100 ? w100.date + ' ' + w100.chg + '%' : '无'} | 满仓10x: ${w10 ? w10.date + ' ' + w10.chg + '%' : '无'}`);
