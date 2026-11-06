'use strict';
// 历史新闻重算（2026-11-06 地域权重升级的一次性/维护脚本）
// 用法: node scripts/news_rescore.js [hours=72]
// 作用：对窗口内的新闻重新计算来源画像与多空权重；LLM 已识别的论点保留，只重算权重。
const { loadEnv } = require('../lib/env');
const { openDb } = require('../lib/db');
const np = require('../lib/news_points');
const cal = require('../lib/news_calibration');

const hours = Math.max(1, Math.min(24 * 30, Number(process.argv[2]) || 72));
const env = loadEnv();
const db = openDb(env);
const since = Math.floor(Date.now() / 1000) - hours * 3600;
const rows = db.prepare('SELECT * FROM news WHERE ts>=? ORDER BY ts DESC').all(since);
const weights = cal.weightsOf();

const up = db.prepare(`UPDATE news SET sentiment=?,influence=?,bull_w=?,bear_w=?,bull_share=?,score=?,points=?,category=?,scored_by=?,region=?,source_tier=?,geo_mult=?,relevance=?,ignored=? WHERE id=?`);
let n = 0, ignored = 0;
db.transaction(() => {
  for (const row of rows) {
    np.rescore(row, weights);
    if (row.ignored) ignored++;
    up.run(row.sentiment, row.influence, row.bull_w, row.bear_w, row.bull_share, row.score,
      row.points, row.category, row.scored_by, row.region, row.source_tier,
      row.geo_mult, row.relevance, row.ignored, row.id);
    n++;
  }
})();
console.log(JSON.stringify({ hours, rescored: n, ignored, at: new Date().toISOString() }));
db.close();
