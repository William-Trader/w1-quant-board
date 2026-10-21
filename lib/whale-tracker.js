// 巨鲸动向聚合模块 — 引擎 π1
// 聚合：① LSR 巨鲸榜单（whale_ratio/whale_delta_4h 等）② BTC 链上大额转账（mempool）
//       ③ 知名机构地址标签/转账（whale_labels 本地库）
// 纯读本地库 + 内存池外部请求（由 routes 层 withCache 控制频率）
const { fetchMempoolTxs } = require('./whale_collector');
const whaleLabels = require('./whale_labels');
const { store } = require('./store');

// 过滤异常 symbol（CSOPSKHYNIX2LUSDT 这类脏数据 / 非正常币对）
function isCleanSymbol(s) {
  if (!s || typeof s !== 'string') return false;
  const up = s.toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(up)) return false;
  // 排除已知异常前缀（Coinglass 返回的乱码币）
  if (/^(CSOPS|CSOPSKHYNIX)/.test(up)) return false;
  return true;
}

// 主流币优先排序：BTC > ETH > SOL > BNB > XRP > DOGE > ADA > LINK
const MAJOR_ORDER = { BTC: 0, ETH: 1, SOL: 2, BNB: 3, XRP: 4, DOGE: 5, ADA: 6, LINK: 7 };
function majorRank(s) {
  const b = (s || '').toUpperCase().replace(/USDT$/, '');
  return MAJOR_ORDER[b] != null ? MAJOR_ORDER[b] : 99;
}

// 从 lsr_rankings whale payload 提取干净榜单
function extractWhaleRows(whalePayload) {
  // latestLsr 返回 { ts, data: <已解析 payload> }，payload.data 即为数组
  const arr = (whalePayload && whalePayload.data && Array.isArray(whalePayload.data))
    ? whalePayload.data : [];
  const vx = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
  return arr
    .filter(w => isCleanSymbol(w.symbol))
    .map(w => ({
      symbol: w.symbol,
      ratio: vx(w.ratio),               // 综合多空比
      trader_ratio: vx(w.trader_ratio),
      whale_ratio: vx(w.whale_ratio),
      delta_2m: vx(w.delta_2m),
      delta_4h: vx(w.delta_4h),
      trader_delta_4h: vx(w.trader_delta_4h),
      whale_delta_4h: vx(w.whale_delta_4h),
      long_notional: vx(w.long_notional),
      short_notional: vx(w.short_notional),
      long_qty: vx(w.whale_long_qty),
      short_qty: vx(w.whale_short_qty),
      long_count: vx(w.whale_long_count),
      short_count: vx(w.whale_short_count),
      oi_mcap_ratio: vx(w.oi_mcap_ratio)
    }))
    .sort((a, b) => majorRank(a.symbol) - majorRank(b.symbol) || (b.whale_ratio||0) - (a.whale_ratio||0));
}

// 巨鲸动向综合信号（BTC 视角 + 全榜极端拥挤）
function buildSignals(rows, btcRow) {
  const signals = [];
  if (btcRow && btcRow.whale_ratio != null) {
    const r = btcRow.whale_ratio;
    const d = btcRow.whale_delta_4h;
    if (r >= 1.5) signals.push({ key: 'btc_whale_long', label: 'BTC 巨鲸强多', detail: `多空比 ${r.toFixed(2)}，多头占优`, level: r >= 2 ? 'strong' : 'mid' });
    else if (r <= 0.67) signals.push({ key: 'btc_whale_short', label: 'BTC 巨鲸偏空', detail: `多空比 ${r.toFixed(2)}，空头占优`, level: r <= 0.5 ? 'strong' : 'mid' });
    if (d != null && Math.abs(d) >= 0.15) {
      signals.push({ key: 'btc_whale_delta', label: d > 0 ? 'BTC 巨鲸加多' : 'BTC 巨鲸加空', detail: `4h 变化 ${(d*100).toFixed(1)}%`, level: Math.abs(d) >= 0.3 ? 'strong' : 'mid' });
    }
  }
  // 全榜极端拥挤（top20 内 whale_ratio>2 或 <0.5 的占比）
  const top = rows.slice(0, 20);
  if (top.length >= 5) {
    const extremeLong = top.filter(r => (r.whale_ratio||0) >= 2).length;
    const extremeShort = top.filter(r => (r.whale_ratio||0) <= 0.5).length;
    if (extremeLong >= 8) signals.push({ key: 'market_whale_crowded_long', label: '市场巨鲸拥挤做多', detail: `TOP20 中 ${extremeLong} 个币巨鲸多空比>2，警惕反向收割`, level: 'mid' });
    if (extremeShort >= 8) signals.push({ key: 'market_whale_crowded_short', label: '市场巨鲸拥挤做空', detail: `TOP20 中 ${extremeShort} 个币巨鲸多空比<0.5，警惕逼空`, level: 'mid' });
  }
  return signals;
}

// 主聚合函数：返回 /api/whale-tracker 的完整 payload
async function aggregate(db) {
  const lsrW = store.latestLsr(db, 'whale');
  const whalePayload = lsrW ? lsrW.data : null;
  const ts = lsrW ? lsrW.ts : 0;

  const rows = extractWhaleRows(whalePayload);
  const btcRow = rows.find(r => /^BTCUSDT$/.test(r.symbol)) || null;

  // BTC 链上大额转账（mempool 双源，失败返回空数组不阻断）
  let btcTxs = [];
  try {
    btcTxs = await fetchMempoolTxs(0.5);
    // 补 USD 估值
    const fut = store.latestFutures(db);
    const futArr = fut && fut.data && fut.data.data ? fut.data.data : [];
    const btcPrice = futArr.find(c => c.symbol === 'BTC');
    btcTxs = btcTxs.map(tx => {
      const valueBtc = Number.isFinite(Number(tx.value_btc)) ? Number(tx.value_btc) : 0;
      const valueUsd = btcPrice ? Math.round(valueBtc * (btcPrice.current_price || 0)) : 0;
      const addrLabel = (a) => {
        const lb = whaleLabels.labelOf(a);
        return lb ? { addr: a, entity: lb.entity, label: lb.label } : { addr: a, entity: null, label: null };
      };
      return {
        ...tx,
        value_usd: valueUsd,
        from_addrs: (tx.from_addrs || []).map(a => addrLabel(a)),
        to_addrs: (tx.to_addrs || []).map(o => {
          const lb = whaleLabels.labelOf(o.addr);
          return { addr: o.addr, value_btc: o.value_btc, entity: lb ? lb.entity : null, label: lb ? lb.label : null };
        }),
        has_known_entity: false
      };
    });
  } catch (e) { /* 内存池不可达时忽略 */ }

  const signals = buildSignals(rows, btcRow);

  return {
    ok: true,
    data_ts: ts,
    whales: rows.slice(0, 30),
    btc: btcRow,
    btc_whale_txs: btcTxs.slice(0, 20),
    signals,
    known_entities: whaleLabels.loadLabels(),
    whale_transfers: whaleLabels.recentWhaleTransfers(20),
    entity_activity: whaleLabels.entityActivity(12)
  };
}

module.exports = { aggregate, extractWhaleRows, buildSignals, isCleanSymbol };
