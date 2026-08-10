'use strict';
// ============================================================
// W1 事件风控模块 v1.0（2026-08-07 William 老板指令·P3）
//   - 宏观事件：CPI / 美联储议息 / 非农 等（用本地 news 关键词探测）
//   - 财报事件：news 中个股财报关键词（NVDA/TSLA 等）
//   - 输出风险等级：safe / caution / high，供 signal 降频与文案提示
// 全部读本地 SQLite news 表，禁止额外打上游 API。
// ============================================================

const TZ = 'Asia/Shanghai';
const HOURS = 24; // 扫描窗口：近 24h

const MACRO_KEYWORDS = [
  { re: /CPI|通胀数据|消费者物价/i, label: 'CPI' },
  { re: /美联储|FOMC|议息|利率决议|加息|降息/i, label: '美联储决议' },
  { re: /非农|就业报告|失业率/i, label: '非农就业' },
  { re: /PCE|核心通胀/i, label: 'PCE通胀' },
  { re: /GDP|经济数据/i, label: 'GDP数据' }
];
const EARNINGS_RE = /财报|业绩|盈利预测|营收|earnings/i;

/*
 * 近 24h 事件扫描：返回
 * { risk: 'safe'|'caution'|'high', events: [{label, count, sentiment}], lines: [] }
 * 规则：宏观事件出现 → caution；重大（CPI/议息）出现且情绪激烈 → high；
 *       财报高频出现 → caution。
 */
function scanEvents(db) {
  const dayAgo = Math.floor(Date.now() / 1000) - HOURS * 3600;
  const rows = db.prepare(
    "SELECT title, sentiment, influence, source FROM news WHERE ts >= ? ORDER BY ts DESC LIMIT 200"
  ).all(dayAgo);
  if (!rows.length) return { risk: 'safe', events: [], lines: ['📅 近24h无新闻数据'] };

  const events = [];
  for (const kw of MACRO_KEYWORDS) {
    const hits = rows.filter(r => kw.re.test(r.title));
    if (hits.length) {
      const neg = hits.filter(r => r.sentiment === 'bearish' || /推迟|不及预期|爆雷|风险/i.test(r.title)).length;
      events.push({ label: kw.label, count: hits.length, neg, maxInfluence: Math.max(...hits.map(r => r.influence || 1)) });
    }
  }
  const earningsHits = rows.filter(r => EARNINGS_RE.test(r.title));
  if (earningsHits.length >= 3) events.push({ label: '财报季', count: earningsHits.length, neg: 0, maxInfluence: 3 });

  if (!events.length) return { risk: 'safe', events: [], lines: ['📅 近24h无重大宏观事件'] };

  let risk = 'caution';
  const heavy = events.some(e => ['CPI', '美联储决议', '非农就业'].includes(e.label) && (e.count >= 2 || e.neg >= 1 || e.maxInfluence >= 5));
  if (heavy) risk = 'high';

  const lines = [`📅 事件风控：${risk === 'high' ? '🔴 高风险' : risk === 'caution' ? '🟡 谨慎' : '🟢 安全'}`];
  for (const e of events) {
    lines.push(`  ${e.label} ×${e.count}（利空 ${e.neg} 条${e.maxInfluence >= 4 ? '，影响力大' : ''}）`);
  }
  return { risk, events, lines };
}

/* 事件风控对推送的修正：high → 今日推送减半；caution → 文案附提示 */
function eventRiskAdjustment(db) {
  const scan = scanEvents(db);
  let dailyLimitMult = 1;
  let hint = '';
  if (scan.risk === 'high') {
    dailyLimitMult = 0.5;
    hint = '⚠️ 重大事件窗口，仓位减半、不追单';
  } else if (scan.risk === 'caution') {
    hint = '⚠️ 事件窗口，注意波动';
  }
  return { ...scan, dailyLimitMult, hint };
}

module.exports = { scanEvents, eventRiskAdjustment };
