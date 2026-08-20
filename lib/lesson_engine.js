// 胜负反馈回路（LLM Lesson Engine）
// 每单结算后 → DeepSeek 复盘提炼经验 → llm_lessons 库 → 下次 AI 审查时注入参考
// 设计防过拟合：经验只作为"参考因子"注入提示词，不参与硬规则；经验带 confidence 与命中统计
'use strict';
const { warn, info } = require('./log');

function ensureTable(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS llm_lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER,
    symbol TEXT,
    direction TEXT,
    result TEXT,
    pnl_pct REAL,
    lesson TEXT,
    tag TEXT,
    confidence REAL,
    created_at INTEGER,
    hits INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active'
  )`).run();
}

// 结算后复盘：调 DeepSeek 提炼经验
async function reviewTrade(db, env, trade) {
  try {
    ensureTable(db);
    // 防重复复盘
    const dup = db.prepare("SELECT id FROM llm_lessons WHERE trade_id=?").get(trade.id);
    if (dup) return null;
    const ai = require('./ai');
    const now = Date.now();
    const msgs = [
      { role: 'system', content: '你是量化交易复盘教练。根据一笔已完结交易的完整信息，提炼 1~3 条【可复用的、具体的】交易经验。要求：1) 只提炼有普适性的模式（如"FGI<40 时追多胜率低"），不要复述单次事件；2) 每条经验给出 tag（简短英文标识如 fgi_low_long）和 confidence（0~1 你认为这条经验可靠度）；3) 只输出 JSON 数组，格式 [{"lesson":"中文经验","tag":"xxx","confidence":0.7}]，不要其他文字。' },
      { role: 'user', content: JSON.stringify({
        交易: { id: trade.id, symbol: trade.symbol, direction: trade.direction,
                entry: trade.entry, stop: trade.stop, target1: trade.target1, target2: trade.target2,
                pos_pct: trade.pos_pct, leverage: trade.leverage },
        结果: { status: trade.status, pnl_pct: trade.pnl_pct, reason: trade.reason || '' },
        信号原文: String(trade.msg || '').slice(0, 800),
        结算时间: new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      }) }
    ];
    const r = await ai.chat(env, msgs);
    let lessons = [];
    try { lessons = JSON.parse(r.text.replace(/```json|```/g, '').trim()); } catch (e) { warn('[lesson] 解析失败:', e.message); return null; }
    if (!Array.isArray(lessons)) lessons = [];
    let n = 0;
    const ins = db.prepare("INSERT INTO llm_lessons(trade_id,symbol,direction,result,pnl_pct,lesson,tag,confidence,created_at,hits,status) VALUES(?,?,?,?,?,?,?,?,?,1,'active')");
    for (const l of lessons.slice(0, 3)) {
      if (!l || !l.lesson) continue;
      ins.run(trade.id, trade.symbol, trade.direction, trade.status, trade.pnl_pct != null ? Number(trade.pnl_pct) : null,
        String(l.lesson).slice(0, 300), String(l.tag || '').slice(0, 40), Math.min(1, Math.max(0, Number(l.confidence) || 0.5)), now);
      n++;
    }
    if (n) info(`[lesson] 复盘 #${trade.id} ${trade.symbol} ${trade.status} → 提炼 ${n} 条经验`);
    return n;
  } catch (e) { warn('[lesson] 复盘失败:', e.message); return null; }
}

// 查询相关经验（同币/同方向 + 高分通用经验），供 AI 审查注入
function getLessons(db, { symbol, direction }, limit = 5) {
  try {
    ensureTable(db);
    const rows = db.prepare(`SELECT lesson, tag, confidence, hits, result FROM llm_lessons
      WHERE status='active' AND (symbol=? OR confidence>=0.75)
      ORDER BY (CASE WHEN symbol=? THEN 2 ELSE 0 END) + confidence*3 + (CASE WHEN hits>5 THEN 5 ELSE hits END)*0.3 DESC LIMIT ?`).all(symbol, symbol, limit);
    return rows;
  } catch (e) { return []; }
}

// 经验命中统计（可选：手动验证时用）
function hitLesson(db, id) {
  try { db.prepare("UPDATE llm_lessons SET hits=hits+1 WHERE id=?").run(id); } catch (e) {}
}

module.exports = { ensureTable, reviewTrade, getLessons, hitLesson };
