'use strict';
const { debug, warn, info } = require('./log');
// ============================================================
// 全网真人 KOL 实时观点/喊单抓取 v1.0（2026-08-14）
//  - 数据源：本地 search-server（Bing 封装，127.0.0.1:3334）
//  - 流程：多组中英文 KOL 查询 → 搜索 → DeepSeek 提炼（标的/方向/信心/摘要）
//  - 存储：kol_signals 表 + kol_watch_log 快照
//  - 频率：每小时（cron），去重按相似标题
// ============================================================
const SEARCH = 'http://127.0.0.1:3334/search?q=';

// 全网加密 KOL 观点抓取查询词（Bing 英文质量 > 中文；不问是谁，抓全网）
const QUERIES = [
  'bitcoin analyst target price prediction',
  'BTC price prediction crypto analyst',
  'Ethereum ETH forecast expert call',
  'bitcoin bull bear signal today',
  'crypto altcoin pick analyst recommendation',
  'bitcoin crash warning analyst',
  '比特币 目标价 预测 最新',
  'BTC 行情 分析 看涨 看跌',
  '喊单 加密货币 大V 观点',
  'crypto influencer call long short',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchWeb(q) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(SEARCH + encodeURIComponent(q), { signal: ctrl.signal });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.results || []).map(r => ({ title: r.title, url: r.url }));
  } catch (e) { warn('[kol] fetch:', e.message); return []; } finally { clearTimeout(timer); }
}

/** 去重：标题相似度（简单归一化比较） */
function dedup(list) {
  const seen = new Set(), out = [];
  for (const it of list) {
    const key = String(it.title || '').replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 24);
    if (key.length < 6 || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** 搜索 + 金十快讯 + AI 提炼一轮 */
async function collectKOL(ctx) {
  const { db, env } = ctx;
  try {
    // 源1：Bing 搜索（核心查询 + KOL 名单定向查询）
    const all = [];
    const queries = QUERIES.slice(0, 3);
    // 从 kv 读取 KOL 名单（kv:kol_list = [{name,keywords[],platform}]）
    try {
      const { kvGet } = require('./db');
      const kolList = kvGet(db, 'kol_list', []);
      if (Array.isArray(kolList)) {
        for (const k of kolList.slice(0, 10)) {
          if (k && k.name) queries.push(k.name + ' 比特币', k.name + ' crypto bitcoin');
        }
      }
    } catch (e) { debug('[catch] ' + (e && e.message)); }
    for (const q of queries.slice(0, 6)) {
      const r = await searchWeb(q);
      all.push(...r.map(x => ({ ...x, q })));
      await sleep(400);
    }
    // 过滤非观点垃圾页
    const JUNK = /bitcoin\.org|百度百科|维基百科|实时行情|live price|marketcap|open source|选择钱包|英为财情|investiong|coingecko|coinmarketcap|\bwiki\b/i;
    // 源2：金十快讯本地库（近 6 小时，加密+宏观关键词，取 30 条）——主源
    const flash = db.prepare(`SELECT content, ts FROM jin10_flash_cache
      WHERE ts >= ? AND (content LIKE '%比特币%' OR content LIKE '%BTC%' OR content LIKE '%以太坊%' OR content LIKE '%ETH%' OR content LIKE '%加密%' OR content LIKE '%数字货币%' OR content LIKE '%分析师%' OR content LIKE '%预测%' OR content LIKE '%看涨%' OR content LIKE '%看跌%' OR content LIKE '%目标价%' OR content LIKE '%美联储%')
      ORDER BY ts DESC LIMIT 30`).all(Date.now() / 1000 - 6 * 3600);
    all.push(...flash.map(f => ({ title: f.content.slice(0, 150), url: 'jin10://' + Math.floor(f.ts), desc: '' })));

    // 金十优先：先排序（jin10 在前），再 dedup + 垃圾过滤 + 限量 30
    const sorted = [...all].sort((a, b) => (a.url.startsWith('jin10') ? -1 : 1) - (b.url.startsWith('jin10') ? -1 : 1));
    const items = dedup(sorted).filter(x => !JUNK.test(x.title)).slice(0, 30);
    if (!items.length) { recordHealth(db, 'kol_watch', 0, 0, '无搜索结果'); return 0; }

    // AI 提炼
    const ai = require('./ai');
    const prompt = `你是顶级加密分析师。以下是全网 KOL/分析师最新观点（搜索结果+金十快讯，标题+链接）。
请从中提炼出 KOL 观点/喊单（金十快讯中的机构/分析师观点优先）：
1. 标题含 target/预测/看涨/看跌/买入/卖出/目标价/上调/下调/upgrade/downgrade/bullish/bearish/soar/crash/surge/分析师/预计/警告 等方向性词汇的都算观点
2. 从标题推断：author（KOL名或机构）、symbol（标的）、direction（bullish/bearish/neutral）、summary（中文一句话摘要）
3. 把握不大时 direction 用 neutral，但 summary 照实描述
4. 输出 JSON 数组：[{author, symbol, direction, target_price(可选), confidence(0-1), summary, url}]，最多 10 条，没有就输出 []
材料：
${items.map((x, i) => `${i + 1}. ${x.title} | ${x.url}`).join('\n')}`;
    const r = await ai.chat(env, [
      { role: 'system', content: '你只输出合法 JSON，不输出其他任何文字。' },
      { role: 'user', content: prompt }
    ], env.DEEPSEEK_MODEL || 'deepseek-reasoner');
    const text = r.text.replace(/```json|```/g, '').trim();
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('ai 未返回数组');
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) throw new Error('ai 返回非数组');

    const now = Math.floor(Date.now() / 1000);
    const ins = db.prepare('INSERT INTO kol_signals(ts,source,author,content,symbol,direction,confidence,summary,url) VALUES(?,?,?,?,?,?,?,?,?)');
    let n = 0;
    for (const p of parsed) {
      if (!p.summary && !p.author) continue;
      const sym = String(p.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
      ins.run(now, 'web', String(p.author || '未知KOL').slice(0, 40), String(p.summary || '').slice(0, 200),
        sym || null, String(p.direction || 'neutral').slice(0, 12),
        p.confidence != null ? Number(p.confidence) : null, String(p.summary || '').slice(0, 300),
        String(p.url || '').slice(0, 300));
      n++;
    }
    db.prepare('INSERT INTO kol_watch_log(ts,payload) VALUES(?,?)').run(now, JSON.stringify({ items: items.length, signals: n, ts: now }));
    recordHealth(db, 'kol_watch', n > 0 ? 1 : 0, 0, `${n} 条KOL观点（源${items.length}条）`);
    info(`[kol] KOL 观点抓取完成: ${n} 条`);
    return n;
  } catch (e) {
    recordHealth(db, 'kol_watch', 0, 0, e.message.slice(0, 120));
    warn('[kol] 抓取异常:', e.message);
    return 0;
  }
}

/** 查询最近 KOL 信号 */
function latestSignals(db, limit = 20) {
  return db.prepare('SELECT * FROM kol_signals ORDER BY ts DESC LIMIT ?').all(limit).map(r => ({
    ...r, time: new Date(r.ts * 1000).toISOString()
  }));
}

// 引用 recordHealth（与 collectors 共用，防止循环依赖：延迟 require）
function recordHealth(db, source, ok, ms, detail) {
  try {
    db.prepare('INSERT INTO source_health(source,ok,ms,detail,ts) VALUES(?,?,?,?,?)')
      .run(source, ok ? 1 : 0, ms || 0, String(detail || '').slice(0, 200), Math.floor(Date.now() / 1000));
  } catch (e) { debug('[catch] ' + (e && e.message)); }
}

module.exports = { collectKOL, latestSignals };
