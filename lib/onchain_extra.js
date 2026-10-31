'use strict';
// 链上面板增强数据层 v1（2026-10-31）
//  - market_ls：全市场多空（OI 加权多头占比 + 24h 主动买卖量占比 + 多空拥挤度分布）
//  - stablecoin：稳定币总供应 / 24h 铸造赎回 / 7d 变化 / Top 币种
//  - exchange_flow：BTC 大额转账中被标签为交易所的净流（流入=潜在抛压，流出=潜在吸筹）
// 所有指标标注 as_of / 窗口，缺失就明确缺失，不造数。

const { debug, warn } = require('./log');
const whaleLabels = require('./whale_labels');
const { kvGet } = require('./db');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function latestFuturesArr(db, store) {
  try {
    const f = store.latestFutures(db);
    return f && f.data && Array.isArray(f.data.data) ? { ts: f.ts, rows: f.data.data } : { ts: 0, rows: [] };
  } catch (e) { return { ts: 0, rows: [] }; }
}

/* ---------------- 全市场多空 ---------------- */
function marketLs(db, store) {
  const { ts, rows } = latestFuturesArr(db, store);
  const coins = rows.filter(c => c && num(c.open_interest_usd) != null && num(c.long_short_ratio_4h) != null);
  let oiSum = 0, oiLong = 0, volLong = 0, volAll = 0;
  const longs = [], shorts = [], buckets = [0, 0, 0, 0, 0]; // <40,40-50,50-60,60-70,>70
  for (const c of coins) {
    const oi = num(c.open_interest_usd) || 0;
    const r = num(c.long_short_ratio_4h);
    if (!oi || r == null || r <= 0) continue;
    const share = r / (1 + r) * 100;
    oiSum += oi;
    oiLong += oi * (share / 100);
    const lv = num(c.long_volume_usd_24h) || 0;
    const sv = num(c.short_volume_usd_24h) || 0;
    volLong += lv; volAll += lv + sv;
    const item = { symbol: String(c.symbol || '').replace(/USDT$/, ''), ratio: +r.toFixed(3), share: +share.toFixed(1), oi_usd: Math.round(oi) };
    longs.push(item); shorts.push(item);
    const b = share < 40 ? 0 : share < 50 ? 1 : share < 60 ? 2 : share < 70 ? 3 : 4;
    buckets[b] += oi;
  }
  longs.sort((a, b) => b.share - a.share);
  shorts.sort((a, b) => a.share - b.share);
  const bucketLabels = ['<40%', '40-50%', '50-60%', '60-70%', '>70%'];
  return {
    as_of: ts,
    coins: coins.length,
    oi_weighted_long_pct: oiSum ? +(oiLong / oiSum * 100).toFixed(1) : null,
    volume_long_pct: volAll ? +(volLong / volAll * 100).toFixed(1) : null,
    total_oi_usd: Math.round(oiSum),
    top_long: longs.slice(0, 6),
    top_short: shorts.slice(0, 6),
    distribution: bucketLabels.map((label, i) => ({ label, oi_usd: Math.round(buckets[i]), pct: oiSum ? +(buckets[i] / oiSum * 100).toFixed(1) : 0 }))
  };
}

/* ---------------- 稳定币 ---------------- */
function stablecoin(db) {
  const rec = kvGet(db, 'fund:stablecoin', null);
  if (!rec || !rec.total) return { ok: false, as_of: null };
  const d24 = rec.totalPrevDay ? (rec.total / rec.totalPrevDay - 1) * 100 : null;
  const d7 = rec.totalPrevWeek ? (rec.total / rec.totalPrevWeek - 1) * 100 : null;
  let history = [];
  try {
    history = db.prepare('SELECT ts,total FROM stablecoin_history ORDER BY ts ASC LIMIT 120').all();
  } catch (e) { history = []; }
  const top = (rec.breakdown || []).slice(0, 8).map(a => ({ symbol: a.symbol, usd: a.circ }));
  return {
    ok: true,
    as_of: rec.ts || null,
    total_usd: rec.total,
    mint_24h_usd: rec.total - (rec.totalPrevDay || rec.total),
    mint_7d_usd: rec.total - (rec.totalPrevWeek || rec.total),
    change_24h_pct: d24 != null ? +d24.toFixed(3) : null,
    change_7d_pct: d7 != null ? +d7.toFixed(3) : null,
    top,
    history: history.map(h => ({ x: new Date(h.ts * 1000).toISOString().slice(5, 10), y: h.total }))
  };
}

function recordStablecoinHistory(db) {
  try {
    const rec = kvGet(db, 'fund:stablecoin', null);
    if (!rec || !rec.total) return;
    db.prepare('INSERT OR REPLACE INTO stablecoin_history(ts,total,prev_day,prev_week) VALUES(?,?,?,?)')
      .run(rec.ts || Math.floor(Date.now() / 1000), rec.total, rec.totalPrevDay || null, rec.totalPrevWeek || null);
  } catch (e) { debug('[onchain] stable history:', e.message); }
}

/* ---------------- 交易所净流 ---------------- */
function labelLeg(legs) {
  for (const a of legs || []) {
    const e = a && (a.entity || (whaleLabels.labelOf(a.addr || a) || {}).entity);
    if (e) return e;
  }
  return null;
}

function classifyTx(tx) {
  const inflow = labelLeg(tx.to_addrs);
  const outflow = labelLeg(tx.from_addrs);
  const usd = num(tx.value_usd) || 0;
  if (!usd) return null;
  // 从交易所转出 = outflow；转入交易所 = inflow。同笔两边都命中时按净额记到金额较大一侧不合适，
  // 这里分别记两条腿，读取时再算净额，保持可审计。
  const legs = [];
  if (inflow) legs.push({ direction: 'in', entity: inflow, usd });
  if (outflow) legs.push({ direction: 'out', entity: outflow, usd });
  return legs.length ? { txid: tx.txid || tx.hash || '', legs } : null;
}

function recordFlows(db, txs, token) {
  let n = 0;
  try {
    const ins = db.prepare('INSERT OR IGNORE INTO chain_flows(ts,token,direction,entity,usd,txid) VALUES(?,?,?,?,?,?)');
    const now = Math.floor(Date.now() / 1000);
    for (const tx of txs || []) {
      const c = classifyTx(tx);
      if (!c) continue;
      for (const leg of c.legs) {
        ins.run(now, token || 'BTC', leg.direction, leg.entity, Math.round(leg.usd), c.txid + ':' + leg.direction);
        n++;
      }
    }
  } catch (e) { debug('[onchain] record flows:', e.message); }
  return n;
}

function flowSummary(db, hours) {
  const since = Math.floor(Date.now() / 1000) - (hours || 24) * 3600;
  let rows = [];
  try {
    rows = db.prepare('SELECT ts,token,direction,entity,usd FROM chain_flows WHERE ts>=? ORDER BY ts DESC').all(since);
  } catch (e) { rows = []; }
  let inflow = 0, outflow = 0;
  const byEntity = {}, byToken = {};
  for (const r of rows) {
    const usd = Number(r.usd) || 0;
    if (r.direction === 'in') inflow += usd; else outflow += usd;
    const e = byEntity[r.entity] = byEntity[r.entity] || { entity: r.entity, inflow: 0, outflow: 0, count: 0 };
    if (r.direction === 'in') e.inflow += usd; else e.outflow += usd;
    e.count++;
    const t = byToken[r.token || 'BTC'] = byToken[r.token || 'BTC'] || { token: r.token || 'BTC', inflow: 0, outflow: 0 };
    if (r.direction === 'in') t.inflow += usd; else t.outflow += usd;
  }
  let coverage = null;
  try {
    const r = db.prepare('SELECT MIN(ts) m, MAX(ts) x FROM chain_flows').get();
    if (r && r.x) coverage = Math.round((r.x - r.m) / 3600);
  } catch (e) {}
  return {
    hours: hours || 24,
    coverage_hours: coverage,
    inflow_usd: Math.round(inflow),
    outflow_usd: Math.round(outflow),
    net_usd: Math.round(outflow - inflow), // 正 = 净流出交易所（潜在吸筹）
    by_entity: Object.values(byEntity).sort((a, b) => (b.inflow + b.outflow) - (a.inflow + a.outflow)).slice(0, 10),
    by_token: Object.values(byToken),
    sample: rows.length
  };
}

/* 供 cron 使用：抓一次 mempool 大额 BTC 转账，打标签后入库（积累近日净流） */
async function collect(ctx) {
  const { fetchMempoolTxs } = require('./whale_collector');
  const store = require('./store');
  const txs = await fetchMempoolTxs(0.5);
  let price = 0;
  try {
    const f = store.latestFutures(ctx.db);
    const arr = f && f.data && f.data.data ? f.data.data : [];
    const btc = arr.find(c => c.symbol === 'BTC');
    price = btc ? Number(btc.current_price) || 0 : 0;
  } catch (e) {}
  const labeled = (txs || []).map(tx => ({
    ...tx,
    value_usd: Math.round((Number(tx.value_btc) || 0) * price),
    from_addrs: (tx.from_addrs || []).map(a => ({ addr: a, entity: (whaleLabels.labelOf(a) || {}).entity || null })),
    to_addrs: (tx.to_addrs || []).map(o => ({ addr: o.addr, entity: (whaleLabels.labelOf(o.addr) || {}).entity || null }))
  }));
  return recordFlows(ctx.db, labeled, 'BTC');
}

function largeTransfers(txs) {
  const arr = (txs || []).filter(t => (Number(t.value_usd) || 0) > 0);
  const total = arr.reduce((s, t) => s + (Number(t.value_usd) || 0), 0);
  const labeled = arr.filter(t => (t.from_addrs || []).some(a => a.entity) || (t.to_addrs || []).some(a => a.entity));
  const top = arr.slice().sort((a, b) => (Number(b.value_usd) || 0) - (Number(a.value_usd) || 0)).slice(0, 8).map(t => ({
    txid: t.txid || t.hash || '',
    btc: Number(t.value_btc) || 0,
    usd: Number(t.value_usd) || 0,
    from: (t.from_addrs || [])[0] || null,
    to: (t.to_addrs || [])[0] || null
  }));
  return {
    count: arr.length,
    total_usd: Math.round(total),
    largest_usd: arr.length ? Math.round(Math.max.apply(null, arr.map(t => Number(t.value_usd) || 0))) : 0,
    labeled_count: labeled.length,
    top
  };
}

module.exports = { marketLs, stablecoin, recordStablecoinHistory, recordFlows, flowSummary, classifyTx, collect, largeTransfers };
