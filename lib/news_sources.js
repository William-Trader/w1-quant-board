'use strict';
// 消息面来源画像与地域影响力 v1（2026-11-06）
// 目标：中文财经源数量远多于英文加密源，但大量是国内宏观/本地事件，对加密多空影响弱。
// 本模块给每条新闻算三件事：
//   1) region / tier：来源地域与可信层级；
//   2) relevance：与加密市场的相关度（0-1），低相关直接不计入多空占比；
//   3) geo：地域/来源折价（0-1），乘到该条新闻的多空权重上。
// 只做画像，不改采集；未知来源按中性处理，不误杀。

const SOURCES = {
  cointelegraph: { label: 'CoinTelegraph', region: 'global', lang: 'en', tier: 1, scope: 'crypto', geo: 1.00 },
  decrypt:       { label: 'Decrypt',       region: 'global', lang: 'en', tier: 1, scope: 'crypto', geo: 1.00 },
  cryptonews:    { label: 'CryptoNews',    region: 'global', lang: 'en', tier: 2, scope: 'crypto', geo: 0.90 },
  odaily:        { label: 'Odaily',        region: 'cn',     lang: 'zh', tier: 2, scope: 'crypto', geo: 0.85 },
  blockbeats:    { label: '律动 BlockBeats', region: 'cn',   lang: 'zh', tier: 2, scope: 'crypto', geo: 0.85 },
  chainthink:    { label: '链智库',        region: 'cn',     lang: 'zh', tier: 3, scope: 'crypto', geo: 0.70 },
  jin10:         { label: '金十数据',      region: 'cn',     lang: 'zh', tier: 2, scope: 'finance', geo: 0.55 },
  wallstreetcn:  { label: '华尔街见闻',    region: 'cn',     lang: 'zh', tier: 2, scope: 'finance', geo: 0.55 }
};

const CRYPTO_RE = /(比特币|btc|以太坊|eth|加密货币|数字货币|稳定币|虚拟货币|区块链|web3|defi|nft|币安|okx|coinbase|usdt|usdc|solana|dogecoin|doge|xrp|链上|代币|挖矿|冷钱包|加密资产|币圈|(?:加密|数字资产|虚拟货币).{0,6}交易所|交易所.{0,4}(?:被盗|被黑|黑客|攻击|跑路|宕机))/i;
const MACRO_RE = /(美联储|fomc|cpi|pce|非农|通胀|加息|降息|美元指数|美债|国债收益率|关税|原油|黄金|道琼斯|纳斯达克|标普|gdp|pmi|失业率|欧洲央行|日本央行|英国央行)/i;
const LOCAL_CN = [
  'A股', '沪指', '深证成指', '创业板指', '科创板', '人民币汇率', '在岸人民币', '离岸人民币',
  '中国人民银行', '中国央行', '国务院', '发改委', '财政部', '证监会', '商务部', '住建部',
  '金融监管总局', '国资委', '工信部', '海关总署', '楼市', '房地产', '地方债', '城投',
  '进博会', '两会', '社保', '医保', '高考', '天气', '台风', '暴雨', '地震', '火灾', '车祸',
  '足球', '篮球', '奥运', '明星', '电影票房', '游戏版号', '金饰', '国内金价', '上海黄金交易所'
];

function metaOf(source) {
  const k = String(source || '').toLowerCase();
  return SOURCES[k] || { label: source || '未知', region: 'unknown', lang: '', tier: 3, scope: 'unknown', geo: 0.80 };
}

function analyze(item) {
  const title = String((item && item.title) || '');
  const content = String((item && item.content) || '').slice(0, 1200);
  const text = title + ' ' + content;
  const src = metaOf(item && item.source);

  const cryptoHit = CRYPTO_RE.test(text);
  const macroHit = MACRO_RE.test(text);
  const localHit = LOCAL_CN.some(k => text.includes(k));

  // 相关度：明确加密事件最高；纯宏观有传导但较弱；中文本地/非加密最低
  let relevance = 0.15;
  if (cryptoHit) relevance = 0.85;
  else if (macroHit) relevance = 0.55;
  if (src.scope === 'crypto' && !cryptoHit) relevance = Math.max(relevance, 0.35);
  if (localHit && !cryptoHit) relevance = Math.min(relevance, 0.10);

  // 地域折价：英文加密源 1.0；中文加密源 0.85；中文财经 0.55；非加密本地 0.25
  let geo = src.geo;
  if (cryptoHit) geo = Math.max(geo, 0.85);
  if (localHit && !cryptoHit) geo = Math.min(geo, 0.25);

  return {
    source: item && item.source,
    source_label: src.label,
    region: src.region,
    lang: src.lang,
    source_tier: src.tier,
    source_scope: src.scope,
    crypto_hit: cryptoHit,
    macro_hit: macroHit,
    local_cn: localHit,
    relevance: +relevance.toFixed(2),
    geo: +geo.toFixed(2),
    ignored: relevance < 0.25
  };
}

// 标题归一化：跨源转载去重用（去标点/数字/空格，保留前 48 字符）
function normTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[0-9.,%％+\-—:：；;，,。.!！?？"'“”‘’()（）\[\]【】<>《》|/\\]/g, '')
    .slice(0, 48);
}

module.exports = { SOURCES, metaOf, analyze, normTitle, CRYPTO_RE, MACRO_RE, LOCAL_CN };
