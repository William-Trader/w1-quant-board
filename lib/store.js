// 本地库读取层 — API 只读本地库，永不穿透打上游
function latestRow(db, sql, ...args) {
  const row = db.prepare(sql).get(...args);
  if (!row) return null;
  try { return { ts: row.ts, data: JSON.parse(row.payload) }; } catch { return { ts: row.ts, data: null }; }
}

const store = {
  latestPrices(db) {
    // 每个 symbol 最新一条
    const rows = db.prepare(`
      SELECT p.* FROM prices p
      JOIN (SELECT symbol, MAX(ts) mts FROM prices GROUP BY symbol) q
        ON p.symbol=q.symbol AND p.ts=q.mts`).all();
    const ts = rows.reduce((m, r) => Math.max(m, r.ts), 0);
    return { ts, rows };
  },
  latestFutures(db) {
    return latestRow(db, 'SELECT ts,payload FROM futures_markets ORDER BY ts DESC LIMIT 1');
  },
  latestLsr(db, mode) {
    return latestRow(db, 'SELECT ts,payload FROM lsr_rankings WHERE mode=? ORDER BY ts DESC LIMIT 1', mode);
  },
  latestFundingArb(db) {
    return latestRow(db, 'SELECT ts,payload FROM funding_arb ORDER BY ts DESC LIMIT 1');
  },
  latestConsensus(db) {
    return latestRow(db, 'SELECT ts,payload FROM consensus ORDER BY ts DESC LIMIT 1');
  },
  latestLiquidation(db, exchange) {
    return latestRow(db, 'SELECT ts,payload FROM liquidation WHERE exchange=? ORDER BY ts DESC LIMIT 1', exchange);
  },
  latestOpenclue(db) {
    return latestRow(db, 'SELECT ts,payload FROM openclue_archive ORDER BY ts DESC LIMIT 1');
  },
  fgSeries(db, limit = 90) {
    return db.prepare('SELECT ts,value,classification FROM fear_greed ORDER BY ts DESC LIMIT ?').all(limit).reverse();
  },
  fgCurrent(db) {
    return db.prepare('SELECT ts,value,classification FROM fear_greed ORDER BY ts DESC LIMIT 1').get() || null;
  },
  verdictDaily(db, date) {
    return db.prepare('SELECT * FROM verdict_daily WHERE date=?').get(date) || null;
  },
  verdictHistory(db, days = 30) {
    return db.prepare('SELECT * FROM verdict_daily ORDER BY date DESC LIMIT ?').all(days);
  },
  // futures payload 中找某币
  futuresCoin(futuresPayload, symbol) {
    const arr = futuresPayload && futuresPayload.data;
    if (!Array.isArray(arr)) return null;
    return arr.find(c => c.symbol === symbol) || null;
  },
  // lsr payload 中找某币（symbol 形如 BTC 或 BTCUSDT）
  lsrCoin(lsrPayload, symbol) {
    const arr = lsrPayload && lsrPayload.data;
    if (!Array.isArray(arr)) return null;
    return arr.find(c => c.symbol === symbol || c.symbol === symbol + 'USDT') || null;
  },
  consensusCoin(consPayload, symbol) {
    const arr = Array.isArray(consPayload) ? consPayload : (consPayload && consPayload.data) || [];
    return arr.find(c => c.symbol === symbol + 'USDT' || c.display_symbol === symbol || c.symbol === symbol) || null;
  }
};

function staleOf(ts, maxAgeSec) {
  if (!ts) return true;
  const age = Date.now() / 1000 - ts;
  return age > maxAgeSec;
}
function ageSec(ts) {
  return ts ? Math.max(0, Math.round(Date.now() / 1000 - ts)) : null;
}

module.exports = { store, staleOf, ageSec };
