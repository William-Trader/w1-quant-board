'use strict';
// ============================================================
// 全球资产清单 v2.0（2026-08-14 OKX 版）
//  - 数据源：OKX SWAP 永续（免 key），s = OKX instId
//  - 覆盖：美股指数/ETF/个股代币化永续 + 大宗（金/银/铜/油/气）+ 加密
//  - 说明：代币化永续与正股存在小溢价，分析时按合约价
// ============================================================
const ASSETS = [
  // ---- 美股指数/ETF ----
  { s: 'QQQ-USDT-SWAP',  cls: 'index', zh: '纳指100ETF', en: 'Nasdaq100', grp: '美股指数' },
  { s: 'SPY-USDT-SWAP',  cls: 'index', zh: '标普500', en: 'S&P 500', grp: '美股指数' },
  { s: 'IWM-USDT-SWAP',  cls: 'index', zh: '罗素2000', en: 'Russell 2000', grp: '美股指数' },
  { s: 'JP225-USDT-SWAP', cls: 'index', zh: '日经225', en: 'Nikkei 225', grp: '美股指数' },
  { s: 'SMH-USDT-SWAP',  cls: 'index', zh: '半导体ETF', en: 'SMH', grp: '美股指数' },
  { s: 'SOXL-USDT-SWAP', cls: 'index', zh: '半导体3x多', en: 'SOXL', grp: '美股指数' },
  { s: 'UVXY-USDT-SWAP', cls: 'index', zh: 'VIX 2x多', en: 'UVXY', grp: '美股指数' },
  { s: 'TQQQ-USDT-SWAP', cls: 'index', zh: '纳指3x多', en: 'TQQQ', grp: '美股指数' },
  { s: 'USO-USDT-SWAP',  cls: 'index', zh: '原油ETF', en: 'USO', grp: '美股指数' },
  { s: 'XLE-USDT-SWAP',  cls: 'index', zh: '能源ETF', en: 'XLE', grp: '美股指数' },
  // ---- 美股个股（机构关注池） ----
  { s: 'NVDA-USDT-SWAP', cls: 'stock', zh: '英伟达', en: 'NVIDIA', grp: '美股个股' },
  { s: 'AAPL-USDT-SWAP', cls: 'stock', zh: '苹果', en: 'Apple', grp: '美股个股' },
  { s: 'MSFT-USDT-SWAP', cls: 'stock', zh: '微软', en: 'Microsoft', grp: '美股个股' },
  { s: 'TSLA-USDT-SWAP', cls: 'stock', zh: '特斯拉', en: 'Tesla', grp: '美股个股' },
  { s: 'META-USDT-SWAP', cls: 'stock', zh: 'Meta', en: 'Meta', grp: '美股个股' },
  { s: 'AMZN-USDT-SWAP', cls: 'stock', zh: '亚马逊', en: 'Amazon', grp: '美股个股' },
  { s: 'GOOGL-USDT-SWAP', cls: 'stock', zh: '谷歌', en: 'Alphabet', grp: '美股个股' },
  { s: 'AMD-USDT-SWAP',  cls: 'stock', zh: '超威', en: 'AMD', grp: '美股个股' },
  { s: 'MU-USDT-SWAP',   cls: 'stock', zh: '美光', en: 'Micron', grp: '美股个股' },
  { s: 'SNDK-USDT-SWAP', cls: 'stock', zh: '闪迪', en: 'SanDisk', grp: '美股个股' },
  { s: 'WDC-USDT-SWAP',  cls: 'stock', zh: '西部数据', en: 'WD', grp: '美股个股' },
  { s: 'MRVL-USDT-SWAP', cls: 'stock', zh: '迈威尔', en: 'Marvell', grp: '美股个股' },
  { s: 'AVGO-USDT-SWAP', cls: 'stock', zh: '博通', en: 'Broadcom', grp: '美股个股' },
  { s: 'QCOM-USDT-SWAP', cls: 'stock', zh: '高通', en: 'Qualcomm', grp: '美股个股' },
  { s: 'ARM-USDT-SWAP',  cls: 'stock', zh: 'ARM', en: 'ARM', grp: '美股个股' },
  { s: 'ASML-USDT-SWAP', cls: 'stock', zh: '阿斯麦', en: 'ASML', grp: '美股个股' },
  { s: 'AMAT-USDT-SWAP', cls: 'stock', zh: '应用材料', en: 'AMAT', grp: '美股个股' },
  { s: 'KLAC-USDT-SWAP', cls: 'stock', zh: '科磊', en: 'KLA', grp: '美股个股' },
  { s: 'LRCX-USDT-SWAP', cls: 'stock', zh: '泛林', en: 'Lam', grp: '美股个股' },
  { s: 'CRM-USDT-SWAP',  cls: 'stock', zh: '赛富时', en: 'Salesforce', grp: '美股个股' },
  { s: 'ORCL-USDT-SWAP', cls: 'stock', zh: '甲骨文', en: 'Oracle', grp: '美股个股' },
  { s: 'NFLX-USDT-SWAP', cls: 'stock', zh: '奈飞', en: 'Netflix', grp: '美股个股' },
  { s: 'COIN-USDT-SWAP', cls: 'stock', zh: 'Coinbase', en: 'Coinbase', grp: '美股个股' },
  { s: 'MSTR-USDT-SWAP', cls: 'stock', zh: '微策略', en: 'MicroStrategy', grp: '美股个股' },
  { s: 'PLTR-USDT-SWAP', cls: 'stock', zh: 'Palantir', en: 'Palantir', grp: '美股个股' },
  { s: 'SMCI-USDT-SWAP', cls: 'stock', zh: '超微电脑', en: 'SMCI', grp: '美股个股' },
  { s: 'TSM-USDT-SWAP',  cls: 'stock', zh: '台积电', en: 'TSMC', grp: '美股个股' },
  { s: 'IBM-USDT-SWAP',  cls: 'stock', zh: 'IBM', en: 'IBM', grp: '美股个股' },
  { s: 'JNJ-USDT-SWAP',  cls: 'stock', zh: '强生', en: 'J&J', grp: '美股个股' },
  { s: 'KO-USDT-SWAP',   cls: 'stock', zh: '可口可乐', en: 'Coca-Cola', grp: '美股个股' },
  { s: 'CVX-USDT-SWAP',  cls: 'stock', zh: '雪佛龙', en: 'Chevron', grp: '美股个股' },
  { s: 'COST-USDT-SWAP', cls: 'stock', zh: '好市多', en: 'Costco', grp: '美股个股' },
  { s: 'UNH-USDT-SWAP',  cls: 'stock', zh: '联合健康', en: 'UnitedHealth', grp: '美股个股' },
  { s: 'LLY-USDT-SWAP',  cls: 'stock', zh: '礼来', en: 'Eli Lilly', grp: '美股个股' },
  { s: 'ISRG-USDT-SWAP', cls: 'stock', zh: '直觉外科', en: 'Intuitive', grp: '美股个股' },
  { s: 'HOOD-USDT-SWAP', cls: 'stock', zh: 'Robinhood', en: 'Robinhood', grp: '美股个股' },
  { s: 'SHOP-USDT-SWAP', cls: 'stock', zh: 'Shopify', en: 'Shopify', grp: '美股个股' },
  { s: 'SNOW-USDT-SWAP', cls: 'stock', zh: 'Snowflake', en: 'Snowflake', grp: '美股个股' },
  { s: 'DELL-USDT-SWAP', cls: 'stock', zh: '戴尔', en: 'Dell', grp: '美股个股' },
  { s: 'CRWD-USDT-SWAP', cls: 'stock', zh: 'CrowdStrike', en: 'CrowdStrike', grp: '美股个股' },
  { s: 'RIOT-USDT-SWAP', cls: 'stock', zh: 'Riot矿企', en: 'Riot', grp: '美股个股' },
  { s: 'SONY-USDT-SWAP', cls: 'stock', zh: '索尼', en: 'Sony', grp: '美股个股' },
  { s: 'SAMSUNG-USDT-SWAP', cls: 'stock', zh: '三星', en: 'Samsung', grp: '美股个股' },
  { s: 'SKHY-USDT-SWAP', cls: 'stock', zh: 'SK海力士', en: 'SK Hynix', grp: '美股个股' },
  { s: 'XIAOMI-USDT-SWAP', cls: 'stock', zh: '小米', en: 'Xiaomi', grp: '美股个股' },
  // ---- 大宗商品 ----
  { s: 'XAU-USDT-SWAP',  cls: 'commodity', zh: '黄金', en: 'Gold', grp: '大宗商品' },
  { s: 'XAG-USDT-SWAP',  cls: 'commodity', zh: '白银', en: 'Silver', grp: '大宗商品' },
  { s: 'XCU-USDT-SWAP',  cls: 'commodity', zh: '铜', en: 'Copper', grp: '大宗商品' },
  { s: 'XPT-USDT-SWAP',  cls: 'commodity', zh: '铂金', en: 'Platinum', grp: '大宗商品' },
  { s: 'XPD-USDT-SWAP',  cls: 'commodity', zh: '钯金', en: 'Palladium', grp: '大宗商品' },
  { s: 'CL-USDT-SWAP',   cls: 'commodity', zh: 'WTI原油', en: 'WTI', grp: '大宗商品' },
  { s: 'BZ-USDT-SWAP',   cls: 'commodity', zh: '布伦特油', en: 'Brent', grp: '大宗商品' },
  { s: 'NG-USDT-SWAP',   cls: 'commodity', zh: '天然气', en: 'Nat Gas', grp: '大宗商品' },
  // ---- 加密（现货数据走 Gate，这里仅永续参考） ----
  { s: 'BTC-USDT-SWAP',  cls: 'crypto', zh: '比特币永续', en: 'BTC Perp', grp: '加密永续' },
  { s: 'ETH-USDT-SWAP',  cls: 'crypto', zh: '以太坊永续', en: 'ETH Perp', grp: '加密永续' },
  { s: 'SOL-USDT-SWAP',  cls: 'crypto', zh: 'Solana永续', en: 'SOL Perp', grp: '加密永续' },
];

const SYMBOL_MAP = new Map(ASSETS.map(a => [a.s, a]));

function assetOf(symbol) { return SYMBOL_MAP.get(symbol) || null; }

function byGroup() {
  const g = {};
  for (const a of ASSETS) { (g[a.grp] = g[a.grp] || []).push(a); }
  return g;
}

module.exports = { ASSETS, assetOf, byGroup };
