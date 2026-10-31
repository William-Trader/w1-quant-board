'use strict';
// 用 v5.2 多空权重点规则回填历史新闻（默认近 7 天，只补未评分/旧规则行）
const path = require('path');
const Database = require('better-sqlite3');
const np = require('../lib/news_points');
const db = new Database(process.env.W1_DB || path.join(__dirname, '..', 'data', 'w1.db'));
const days = Number(process.env.DAYS || 7);
const since = Math.floor(Date.now() / 1000) - days * 86400;
const rows = db.prepare("SELECT id,title,content,ts FROM news WHERE ts>=? AND (bull_share IS NULL OR scored_by IS NULL OR scored_by!='llm') ORDER BY ts DESC LIMIT 20000").all(since);
const up = db.prepare('UPDATE news SET sentiment=?, influence=?, bull_w=?, bear_w=?, bull_share=?, score=?, points=?, category=?, scored_by=? WHERE id=?');
let n = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    const it = { title: r.title, content: r.content };
    np.scoreRule(it);
    up.run(it.sentiment, it.influence, it.bull_w, it.bear_w, it.bull_share, it.score, it.points, it.category, 'rules', r.id);
    n++;
  }
});
tx();
console.log(`rescore ${n} rows / last ${days}d`);
db.close();
