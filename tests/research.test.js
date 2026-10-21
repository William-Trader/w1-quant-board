'use strict';
const assert = require('assert');
const { classifyRegime } = require('../lib/research/regime_lab');
const { stressScore, trappedSide } = require('../lib/research/positioning');
const { corr } = require('../lib/research/cross_asset');
const { agg } = require('../lib/research/news_impact');

assert.strictEqual(classifyRegime(10, 9, 1, 0.5), 'trend_up');
assert.strictEqual(classifyRegime(9, 10, -1, 0.5), 'trend_down');
assert.strictEqual(classifyRegime(9, 10, 1, 0.5), 'range');
assert.strictEqual(classifyRegime(10, 9, 1, 0.9), 'high_vol');

const s = stressScore({ funding_z: 2, oi_change_24h: 8, lsr_ratio: 1.4, liq_imbalance_pct: 60, vol_pct: 0.8 });
assert(s > 60 && s <= 100, 'stress should be high: ' + s);
assert(trappedSide({ funding_z: 2, lsr_ratio: 1.3, price: 90, ema20: 100 }).includes('多头'));
assert(trappedSide({ funding_z: -2, lsr_ratio: 0.7, price: 110, ema20: 100 }).includes('空头'));
assert.strictEqual(trappedSide({ funding_z: 0, lsr_ratio: 1, price: 100, ema20: 100 }), '无显著错配');

assert(corr([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]) > 0.99);

const a = agg([{ sentiment: 'bullish', ret_1h: 1, ret_4h: 2 }, { sentiment: 'bearish', ret_1h: -1, ret_4h: -2 }, { sentiment: 'neutral', ret_1h: 0, ret_4h: 0 }]);
assert.strictEqual(a.n, 3);
assert.strictEqual(a.directional_n, 2);
assert.strictEqual(a.hit_rate_pct, 100);
assert.strictEqual(a.avg_ret_1h_pct, 0);

console.log('research tests passed');
