'use strict';
const assert = require('assert');
const ns = require('../lib/news_sources');
const np = require('../lib/news_points');

// 1) 来源画像：中文本地/非加密 → ignore；加密事件 → keep
let m = ns.analyze({ source: 'jin10', title: '在岸人民币兑美元11月6日16:30收盘报 7.12' });
assert.strictEqual(m.ignored, true, 'local CN FX should be ignored');
m = ns.analyze({ source: 'jin10', title: '国内金饰价格较昨日上涨逾40元/克' });
assert.strictEqual(m.ignored, true, 'domestic gold jewelry should be ignored');
m = ns.analyze({ source: 'cointelegraph', title: 'Bitcoin ETF sees record $1.2B inflow as BTC breaks $100K' });
assert.strictEqual(m.ignored, false);
assert.strictEqual(m.region, 'global');
m = ns.analyze({ source: 'odaily', title: '某交易所被盗，损失约5000万美元' });
assert.strictEqual(m.ignored, false);
assert(m.relevance >= 0.85, 'crypto security event should be high relevance');

// 2) 同一条新闻，全球源权重应高于中文本地财经源
const bullItem = { title: 'SEC 批准比特币现货 ETF，资金净流入', content: 'ETF approval drives inflow' };
const global = np.scoreRule({ ...bullItem, source: 'cointelegraph' });
const cnLocal = np.scoreRule({ ...bullItem, source: 'jin10' });
assert(global.bull_w > cnLocal.bull_w, 'global source weight should exceed CN finance');
assert(Number(cnLocal.geo_mult) < Number(global.geo_mult));

// 3) 聚合：低相关条目不计入；跨源同题只算一次
const now = Math.floor(Date.now() / 1000);
const rows = [
  { title: 'BTC ETF 净流入创纪录', ts: now - 60, source: 'cointelegraph', influence: 5, bull_w: 2, bear_w: 0, category: 'etf_flow', relevance: 0.85, region: 'global', ignored: 0, points: '[]' },
  { title: 'BTC ETF 净流入创纪录', ts: now - 120, source: 'odaily', influence: 4, bull_w: 1.2, bear_w: 0, category: 'etf_flow', relevance: 0.85, region: 'cn', ignored: 0, points: '[]' },
  { title: '在岸人民币收盘', ts: now - 180, source: 'jin10', influence: 1, bull_w: 3, bear_w: 0, category: 'macro', relevance: 0.1, region: 'cn', ignored: 1, points: '[]' }
];
const agg = np.aggregate(rows, 24);
assert.strictEqual(agg.ignored, 1, 'low relevance row should be ignored');
assert.strictEqual(agg.deduped, 1, 'cross-source duplicate should be collapsed');
assert.strictEqual(agg.scored, 1, 'only one counted event');
assert(agg.bull_share > 95, 'deduped event remains bullish');

// 4) 标题归一化对重复转载有效
assert.strictEqual(ns.normTitle('BTC ETF 净流入创纪录！'), ns.normTitle('btc etf净流入创纪录'));

console.log('news_sources tests passed');
