'use strict';
const { cached } = require('./util');
function parse(v, fb) { try { return JSON.parse(v); } catch (e) { return fb; } }
function compute(db) {
  return cached('research:evolution', 5 * 60 * 1000, () => {
    const rows = db.prepare('SELECT date,posture_json,verdict_json,stances_json,ai_text,ai_source,created_at FROM verdict_daily ORDER BY date DESC LIMIT 120').all();
    const out = rows.map(r => {
      const p = parse(r.posture_json, {}) || {};
      const v = parse(r.verdict_json, {}) || {};
      const st = parse(r.stances_json, []) || [];
      let bull = 0, bear = 0, neutral = 0;
      if (Array.isArray(st)) for (const x of st) { const s = x && (x.stance || x.verdict || x); if (s === 'bullish' || s === 'long') bull++; else if (s === 'bearish' || s === 'short') bear++; else neutral++; }
      return { date: r.date, score: p.score == null ? null : +Number(p.score).toFixed(2), state: p.state || null, days_held: p.days_held == null ? null : Number(p.days_held), verdict: v.verdict || null, verdict_zh: v.verdict_zh || null, headline: v.headline_zh || '', bull, bear, neutral, ai_source: r.ai_source || null };
    });
    const current = out[0] || null, prev = out[1] || null;
    const changes = [];
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1], b = out[i];
      if (a.verdict !== b.verdict || a.state !== b.state) changes.push({ date: b.date, from: a.verdict_zh || a.verdict, to: b.verdict_zh || b.verdict, score_from: b.score, score_to: a.score, headline: a.headline });
    }
    return { ok: true, as_of: Math.floor(Date.now() / 1000), current, previous: prev, score_change: current && prev && current.score != null && prev.score != null ? +(current.score - prev.score).toFixed(2) : null, changes: changes.slice(0, 20), rows: out, notes: '来源：verdict_daily 每日判断快照；用于观察观点演化，不代表未来方向。' };
  });
}
module.exports = { compute };
