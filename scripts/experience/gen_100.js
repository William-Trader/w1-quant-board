// gen_100.js — 50→100 段随机波段回测生成器（2026-08-10 · William 老板指令）
// - 旧 50 场保真复制（一字不改）
// - 新 50 段：2024-03-01 ~ 2026-07-20 每14天一桶随机抽1个交易日（覆盖全周期，避免相邻重复）
//   统一引擎 eng.analyze(freeze)+eng.judge 判定 → 生成即与引擎一致（准确性天然保证）
// - summary 全量重算（ledger/equity/ctl100/ctl10/regime_stats/w100/w10）
// 用法: cd /home/ubuntu/w1-board && node scripts/experience/gen_100.js
'use strict';
const Database = require('/home/ubuntu/w1-board/node_modules/better-sqlite3');
const fs = require('fs');
const eng = require('/home/ubuntu/w1-board/lib/experience_engine.js');

const DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const PUBLIC = '/home/ubuntu/w1-board/public/experience.json';
const DATA_OUT = '/home/ubuntu/w1-board/data/experience_blind.json';
const PRINCIPAL = 10000, LEVER = 100;

const db = new Database(DB, { readonly: true });

// 交易日 + 收盘价
const rows = db.prepare(`
  SELECT date(ts/1000,'unixepoch','+8 hours') d,
         (SELECT c FROM klines k2 WHERE k2.symbol=k1.symbol AND k2.ts=(SELECT MAX(ts) FROM klines k3 WHERE k3.symbol=k1.symbol AND date(k3.ts/1000,'unixepoch','+8 hours')=date(k1.ts/1000,'unixepoch','+8 hours'))) c
  FROM klines k1 WHERE symbol='BTCUSDT' AND ts >= strftime('%s','2024-01-01')*1000
  GROUP BY d ORDER BY d
`).all();
const days = rows.map(r => ({ d: r.d, c: Number(r.c) }));
const dayIdx = {}; days.forEach((x, i) => { dayIdx[x.d] = i; });

// 旧 50 场（保真）
const old = JSON.parse(fs.readFileSync(PUBLIC, 'utf8'));
const oldResults = old.results.map(r => Object.assign({}, r));
const used = new Set(oldResults.map(r => r.date));
console.log(`旧场数: ${oldResults.length}`);

// 决策日池（保证14天后有数据：<=2026-07-20）
const poolStart = '2024-03-01', poolEnd = '2026-07-20';
const pool = days.filter(x => x.d >= poolStart && x.d <= poolEnd && !used.has(x.d));
console.log(`候选交易日: ${pool.length}`);
if (pool.length < 50) { console.error('候选不足50'); process.exit(1); }

function dateAdd(d, n) { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

// 每14天一桶，桶内随机取1天，取满50
const picks = [];
let cur = poolStart;
while (picks.length < 50 && cur <= poolEnd) {
  const end = dateAdd(cur, 13);
  const cands = pool.filter(x => x.d >= cur && x.d <= end);
  if (cands.length) { const p = cands[Math.floor(Math.random() * cands.length)]; picks.push(p.d); used.add(p.d); }
  cur = dateAdd(cur, 14);
}
// 不足则从剩余池随机补
let extra = pool.filter(x => !used.has(x.d));
for (let i = extra.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [extra[i], extra[j]] = [extra[j], extra[i]]; }
while (picks.length < 50 && extra.length) picks.push(extra.shift().d);
console.log(`随机抽到: ${picks.length} 段`);

// 生成每场（引擎判定）
function p14For(d) {
  const idx = dayIdx[d], target = dateAdd(d, 14);
  let p14 = null;
  for (let i = idx; i < days.length; i++) { if (days[i].d <= target) p14 = days[i].c; else break; }
  return p14;
}

const newResults = [];
for (const d of picks) {
  const freeze = new Date(d + 'T23:59:59+08:00').getTime();
  const a = eng.analyze(freeze);
  if (!a) { console.warn('analyze null:', d); continue; }
  const j = eng.judge(a);
  const p14 = p14For(d);
  if (p14 == null) { console.warn('无14天数据:', d); continue; }
  const chg14 = Math.round((p14 / a.price - 1) * 1000) / 10;
  const label = j.label, pos = j.pos;
  const dr = label.includes('多') ? 1 : label.includes('空') ? -1 : 0;
  let hit, status;
  if (pos === 0) { hit = true; status = '✅ 观望避险'; }
  else if ((dr > 0 && chg14 > 0) || (dr < 0 && chg14 < 0)) { hit = true; status = '✅ 命中'; }
  else { hit = false; status = '❌ 未中'; }
  let pnl = Math.round(dr * pos * chg14 * 100);
  if (!hit && pos) pnl = -Math.min(Math.abs(pnl), pos * 100);   // 爆仓截断 pos%×100
  newResults.push({
    date: d, scene: '随机波段', desc: '随机抽样·统一引擎盲测',
    cls: (dr > 0 ? 'long' : dr < 0 ? 'short' : 'flat') + (pos >= 8 ? '_agg' : pos === 3 ? '_mild' : ''),
    price: Math.round(a.price),
    rsi: a.rsi != null ? Math.round(a.rsi * 10) / 10 : null,
    macd: a.macd_hist > 0 ? '多头' : '空头',
    trend: (a.s7 && a.s25 && a.s99) ? (a.s7 > a.s25 && a.s25 > a.s99 ? '多头排列' : a.s7 < a.s25 && a.s25 < a.s99 ? '空头排列' : '均线缠绕') : '均线缠绕',
    pos20: a.pos20 != null ? Math.round(a.pos20) : null,
    mom20: a.mom20 != null ? Math.round(a.mom20 * 10) / 10 : null,
    volr: a.volr != null ? Math.round(a.volr * 100) / 100 : null,
    fgi: a.fgi != null ? Math.round(a.fgi) : 0,
    score: j.score, label, pos, reasons: j.reasons,
    p14: Math.round(p14), chg14, status, hit, pnl
  });
}
console.log(`新段生成: ${newResults.length}`);

// 合并 + 排序 + 去重校验
const results = oldResults.concat(newResults).sort((x, y) => x.date < y.date ? -1 : 1);
const ds = new Set(results.map(r => r.date));
if (ds.size !== results.length) { console.error('⚠️ 日期重复!'); process.exit(1); }
if (results.length !== 100) { console.error(`⚠️ 总场数 ${results.length} ≠ 100`); process.exit(1); }

// ===== summary 全量重算 =====
const settled = results.filter(r => r.hit !== null);
const wins = settled.filter(r => r.hit).length;
const pending = results.length - settled.length;
const total_pnl = results.reduce((s, r) => s + r.pnl, 0);
const acc = Math.round(wins / settled.length * 100);
const ledger = results.map(r => r.pnl);
const eq = [PRINCIPAL]; let eqCur = PRINCIPAL;
for (const r of results) { eqCur += r.pnl; eq.push(Math.round(eqCur)); }
function ctlPath(lev) {
  const p = [PRINCIPAL];
  for (const r of results) {
    if (r.chg14 == null) { p.push(p[p.length - 1]); continue; }
    const v = p[p.length - 1] * (1 + lev * r.chg14 / 100);
    p.push(Math.round(v) > 0 ? Math.round(v) : 0);
  }
  return p;
}
const ctl100 = ctlPath(100), ctl10 = ctlPath(10);
function wipeAt(path) { for (let i = 1; i < path.length; i++) { if (path[i] === 0) { const r = results[i - 1]; return { call: i, date: r.date, chg: r.chg14, label: r.label }; } } return null; }
const w100 = wipeAt(ctl100), w10 = wipeAt(ctl10);

// 行情类型分组：旧场用历史语义 regime_map，新场统一「随机波段抽样」
const regimeMap = {
  "2024-02-26":"🚀 牛市加速","2024-03-05":"📉 顶部反转","2024-03-14":"📉 顶部反转","2024-03-20":"📉 顶部反转",
  "2024-04-13":"🫨 恐慌暴跌","2024-04-30":"⚖️ 震荡盘整","2024-05-23":"⚖️ 震荡盘整","2024-06-07":"📉 顶部反转",
  "2024-06-24":"🫨 恐慌暴跌","2024-07-05":"🕳️ 底部磨底","2024-07-15":"⚖️ 震荡盘整","2024-07-29":"📉 顶部反转",
  "2024-08-05":"🫨 恐慌暴跌","2024-08-12":"🕳️ 底部磨底","2024-08-25":"⚖️ 震荡盘整","2024-09-06":"🕳️ 底部磨底",
  "2024-09-19":"📈 趋势中继","2024-09-30":"⚖️ 震荡盘整","2024-10-15":"📈 趋势中继","2024-10-29":"⚖️ 震荡盘整",
  "2024-11-06":"🚀 牛市加速","2024-11-12":"🚀 牛市加速","2024-11-22":"📉 顶部反转","2024-12-05":"📉 顶部反转",
  "2024-12-17":"📉 顶部反转","2024-12-27":"📉 顶部反转","2025-01-07":"🚀 牛市加速","2025-01-20":"📉 顶部反转",
  "2025-02-03":"🫨 恐慌暴跌","2025-02-10":"🕳️ 底部磨底",
  "2025-08-31":"📉 顶部反转","2025-10-20":"🫨 恐慌暴跌","2025-11-20":"🕳️ 底部磨底",
  "2025-12-31":"🕳️ 底部磨底","2026-01-31":"🕳️ 底部磨底","2026-02-28":"🕳️ 底部磨底",
  "2026-03-10":"📈 趋势中继","2026-04-30":"📈 趋势中继","2026-05-31":"📉 顶部反转","2026-07-31":"📉 顶部反转",
  "2025-02-15":"📉 顶部反转","2025-02-28":"🫨 恐慌暴跌","2025-03-12":"🫨 恐慌暴跌",
  "2025-03-31":"🕳️ 底部磨底","2025-04-03":"🫨 恐慌暴跌","2025-04-30":"📈 趋势中继",
  "2025-05-11":"📉 顶部反转","2025-06-30":"📈 趋势中继","2025-07-30":"📉 顶部反转",
  "2025-08-09":"📉 顶部反转"
};
const groups = {};
for (const r of results) {
  const g = regimeMap[r.date] || (r.scene === '随机波段' ? '🎲 随机波段抽样' : '📊 其他');
  (groups[g] = groups[g] || []).push(r);
}
const regime_stats = Object.keys(groups).map(name => {
  const rs = groups[name], st = rs.filter(x => x.hit !== null), gw = st.filter(x => x.hit).length;
  return { name, total: rs.length, hit: gw, pending: rs.length - st.length,
           acc: st.length ? Math.round(gw / st.length * 100) : null,
           pnl: Math.round(rs.reduce((s, x) => s + x.pnl, 0)) };
});

const summary = { total: results.length, wins, pending, acc, total_pnl,
  principal: PRINCIPAL, leverage: LEVER, ledger, equity: eq, ctl100, ctl10,
  regime_stats, w100, w10 };
const out = { generated: old.generated || '2026-08-10', summary, results };
for (const f of [DATA_OUT, PUBLIC]) fs.writeFileSync(f, JSON.stringify(out, null, 1));
console.log(`✅ 已生成 100 场 → ${PUBLIC}`);

console.log(`\n📊 最终战绩: 命中 ${wins}/${settled.length} (${acc}%) | 账本 ${total_pnl >= 0 ? '+' : ''}${total_pnl}u (+${(total_pnl / 100).toFixed(1)}%)`);
console.log(`   净值 ${PRINCIPAL} → ${eq[eq.length - 1]} | 待验证 ${pending} 场`);
console.log(`   满仓100x: ${w100 ? '第' + w100.call + '场 ' + w100.date + ' ' + w100.chg + '% 归零' : '未归零'}`);
console.log(`   满仓10x : ${w10 ? '第' + w10.call + '场 ' + w10.date + ' ' + w10.chg + '% 归零' : '未归零'}`);
for (const g of regime_stats) console.log(`   ${g.name}: ${g.hit}/${g.total - g.pending} (${g.acc}%) pnl=${g.pnl >= 0 ? '+' : ''}${g.pnl}u`);
