'use strict';
// 非加密合约黑名单（2026-10-31）：Coinglass futures_markets 会混入代币化股票/指数/商品/法币，
// 市场地图等只展示「加密」的场景用它过滤。符号按去 USDT 后缀后的裸代码匹配。

const NON_CRYPTO = new Set([
  // 美股/代币化股票
  'GOOGL','GOOG','SNDK','SOXL','SKHYNIX','SKHY','SKHX','INTC','TSLA','MSTR','CRWD','NVDA','AAPL',
  'MSFT','AMZN','META','NFLX','AMD','COIN','HOOD','PLTR','ORCL','JPM','GS','MU','SMCI','AVGO','QCOM','WDC','STX',
  // 指数
  'SPCX','SPX','NDX','SP500','BTCDOM',
  // 商品（金/银/油）
  'XAU','XAG','XAUT','PAXG','GOLD','SILVER','CL','BZ','BRENTOIL','WTI','USOIL',
  // 法币
  'EUR','GBP','JPY'
]);

function isNonCrypto(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/USDT$/, '').replace(/USD$/, '');
  if (!s || NON_CRYPTO.has(s)) return true;
  // 法币对：EURUSD / USDBRL / GBPJPY 等
  if (/^(USD|EUR|GBP|JPY|AUD|CAD|CHF|CNY|HKD|SGD)[A-Z]{2,4}$/.test(s)) return true;
  return false;
}

module.exports = { NON_CRYPTO, isNonCrypto };

