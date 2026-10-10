'use strict';
const { debug, info, warn } = require('./log');
// ============================================================
// W1 关键事件推送模块 v1.0（2026-08-07 William 老板指令）
//   - 每 12 小时检索：金十快讯 API + 本地 news 表（3.4万条）
//   - 提取未来宏观事件（CPI/美联储/非农/PCE/GDP/PMI/初请等）
//   - 利多利空研判 + 仓位减仓提醒，推送到群
//   - 冷却：12h 一次（kv: macro:lastPush），事件窗口内提示降仓
// ============================================================

const TZ = 'Asia/Shanghai';

/* ---------- 阈值集中管理 ---------- */
const MACRO_ALERT_INTERVAL_MS = 10 * 3600 * 1000;   // 冷却 10h（配合 08:00/20:00 两班 cron，避免 08:00 被 12h 冷却卡死）
const MACRO_EVENT_WINDOW_DAYS = 3;                   // 扫描未来 3 天事件
const NEWS_SCAN_HOURS = 48;                          // 本地 news 扫描窗口 48h
const MAX_EVENTS = 12;                               // 单次最多展示事件数
const POS_CUT_HINT = '⚠️ 事件窗口建议：50x 仓位上限 3%，事件落地前不追单、不加仓';

/* ---------- 宏观事件关键词表 ---------- */
const EVENTS = [
  { name: '美联储利率决议', re: /美联储|FOMC|议息|利率决议/i, impact: 'high' },
  { name: 'CPI 通胀数据',   re: /CPI|通胀数据|消费者物价/i,    impact: 'high' },
  { name: '非农就业',       re: /非农|就业报告|失业率/i,        impact: 'high' },
  { name: 'PCE 通胀',       re: /PCE|核心通胀/i,                impact: 'high' },
  { name: '美联储主席讲话', re: /鲍威尔|美联储主席/i,           impact: 'high' },
  { name: 'GDP 数据',       re: /GDP/i,                         impact: 'medium' },
  { name: 'PMI 数据',       re: /\bPMI\b|采购经理人指数/i,     impact: 'medium' },
  { name: '初请失业金',     re: /初请|申领失业金/i,             impact: 'medium' },
  { name: '零售销售',       re: /零售销售|零售数据/i,           impact: 'medium' },
  { name: '欧央行决议',     re: /欧央行|ECB/i,                  impact: 'medium' },
  { name: '日央行决议',     re: /日央行|BOJ/i,                  impact: 'medium' },
  { name: '财报季',         re: /财报|业绩|earnings/i,          impact: 'medium' }
];

/* 时间线索：未来事件前瞻提示 */
const TIME_HINTS = /今晚|明日|明天|本周|下周|稍后|待公布|公布在即|将于|北京时间|20:30|21:30|08:30|10:00|周[一二三四五六日]/;

/* 情绪线索（用于金十快讯未标注 sentiment 的条目） */
const BULLISH_RE = /利好|利多|上涨|走高|走强|支撑|反弹|超预期|大涨|流入|宽松|降息/;
const BEARISH_RE = /利空|下跌|走低|走弱|承压|打压|爆雷|不及预期|收紧|加息|风险|萎缩/;

/* ---------- 数据源 1：金十快讯 API（flash-api 已验证可用） ---------- */
async function fetchJin10Flash(count) {
  if (!count) count = 60;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(
      'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&max_time=&limit=' + count,
      {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'x-app-id': 'bVBF4FyRTn5NJF5n',
          'x-version': '1.0.0',
          'Accept': 'application/json'
        }
      }
    );
    if (!r.ok) throw new Error('jin10 http ' + r.status);
    const body = await r.json();
    if (body.status !== 200) throw new Error('jin10 api fail: ' + body.status);
    const list = body.data || [];
    return list.map(function(item) {
      const d = item.data || {};
      const content = (d.content || '').replace(/<[^>]+>/g, ' ').trim();
      const title = d.title || content.slice(0, 60) || '';
      return {
        title: title,
        content: content,
        time: item.time || '',
        ts: item.time ? Math.floor(new Date(item.time.replace(/-/g, '/')).getTime() / 1000) : 0,
        source: '金十'
      };
    });
  } finally { clearTimeout(timer); }
}

/* ---------- 数据源 2：本地 news 表（近 48h，带 sentiment 标注） ---------- */
function fetchLocalNews(db) {
  try {
    const since = Math.floor(Date.now() / 1000) - NEWS_SCAN_HOURS * 3600;
    return db.prepare(
      "SELECT title, content, sentiment, source_label AS source, ts FROM news WHERE ts >= ? ORDER BY ts DESC LIMIT 300"
    ).all(since);
  } catch (e) {
    warn('[macro] local news scan failed:', e.message);
    return [];
  }
}

/* ---------- 单条情绪判断（金十快讯无 sentiment 字段） ---------- */
function detectSentiment(text) {
  let score = 0;
  if (BULLISH_RE.test(text)) score++;
  if (BEARISH_RE.test(text)) score--;
  return score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
}

/* ---------- 事件提取 + 利多利空研判 ---------- */
function extractEvents(items) {
  const found = [];
  for (const it of items) {
    const text = (it.title || '') + ' ' + (it.content || '');
    // 只处理含宏观关键词的条目
    for (const ev of EVENTS) {
      if (!ev.re.test(text)) continue;
      // 有前瞻时间线索 或 本地已标注情绪 → 视为有效事件
      const hasTimeHint = TIME_HINTS.test(text);
      const sent = it.sentiment || detectSentiment(text);
      const isRecent = it.ts > Date.now() / 1000 - 30 * 3600; // 近30h
      if (!hasTimeHint && !isRecent) continue;
      found.push({
        name: ev.name,
        impact: ev.impact,
        sent: sent,
        title: (it.title || it.content || '').slice(0, 80),
        time: it.time ? String(it.time).slice(5, 16) : (it.ts ? new Date(it.ts * 1000).toLocaleString('zh-CN', { timeZone: TZ, hour12: false }).slice(5, 16) : ''),
        ts: it.ts || 0
      });
      break; // 每条只归属一个事件类型
    }
  }
  // 聚合去重：同事件取最新、情绪合并
  const byName = {};
  for (const f of found) {
    if (!byName[f.name] || f.ts > byName[f.name].ts) byName[f.name] = f;
  }
  return Object.values(byName).sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS);
}

/* ---------- 综合研判：利多/利空/中性 ---------- */
function judgeDirection(events) {
  let bull = 0, bear = 0;
  for (const e of events) {
    if (e.sent === 'bullish') bull++;
    else if (e.sent === 'bearish') bear++;
  }
  if (bull >= 2 && bull > bear * 1.5) return { dir: '利多', bull, bear, hint: '🟢 宏观偏多窗口，可顺势，但仍需控仓' };
  if (bear >= 2 && bear > bull * 1.5) return { dir: '利空', bull, bear, hint: '🔴 宏观偏空窗口，降仓位、不追多' };
  return { dir: '中性', bull, bear, hint: '🟡 宏观多空交织，谨慎观望' };
}

/* ---------- 生成推送文案 ---------- */
function buildMacroAlert(items) {
  const events = extractEvents(items);
  if (!events.length) return null; // 无事件安全跳过
  const judge = judgeDirection(events);
  const highCount = events.filter(e => e.impact === 'high').length;
  const lines = [
    `📅 【关键事件提醒】宏观大事一览`,
    ``,
    `🎯 综合研判：${judge.dir}（利多 ${judge.bull} / 利空 ${judge.bear}）`,
    `⚠️ 高影响事件 ${highCount} 个，仓位请从严`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━`
  ];
  for (const e of events) {
    const icon = e.impact === 'high' ? '🔴' : '🟠';
    const sentIcon = e.sent === 'bullish' ? '📈' : e.sent === 'bearish' ? '📉' : '➖';
    lines.push(`${icon} ${e.name} ${sentIcon}${e.sent === 'bullish' ? '利多' : e.sent === 'bearish' ? '利空' : '中性'}｜${e.time || '时间待定'}`);
    if (e.title) lines.push(`   ${e.title.slice(0, 60)}`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(``);
  lines.push(`🛡️ ${judge.hint}`);
  lines.push(`⚖️ ${POS_CUT_HINT}`);
  lines.push(`⏰ 每 12h 自动检索金十日历 + 全球宏观消息`);
  lines.push(`📌 仅供研究，不构成投资建议，盈亏自负`);
  return lines.join('\n');
}

/* ---------- 冷却控制：12h 一次（kv 表） ---------- */
function shouldPush(db, now) {
  try {
    const last = Number(db.prepare("SELECT value FROM kv WHERE key='macro:lastPush'").get()?.value || 0);
    return now - last >= MACRO_ALERT_INTERVAL_MS;
  } catch (e) { warn('[macro] markPushed:', e.message); return true; }
}
function markPushed(db, now) {
  try {
    db.prepare("INSERT INTO kv(key,value) VALUES('macro:lastPush',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(now));
  } catch (e) { warn('[macro] markPushed failed:', e.message); }
}

/* ---------- 主入口：检索 → 研判 → 推送（12h 冷却） ---------- */
async function pushMacroAlert(ctx) {
  const { env, db } = ctx;
  const now = Date.now();
  if (!shouldPush(db, now)) {
    debug('[macro] 12h 冷却中，跳过推送');
    return { ok: false, reason: 'cooldown' };
  }
  try {
    // 1. 双源检索：金十快讯 + 本地 news
    let items = [];
    try {
      const flash = await fetchJin10Flash(60);
      if (flash.length) items = items.concat(flash);
      debug('[macro] 金十快讯拉取:', flash.length, '条');
    } catch (e) {
      warn('[macro] 金十快讯失败，降级本地:', e.message);
    }
    const local = fetchLocalNews(db);
    if (local.length) items = items.concat(local);

    // 2. 生成文案
    const msg = buildMacroAlert(items);
    if (!msg) {
      debug('[macro] 近窗口无重大宏观事件，跳过推送');
      markPushed(db, now); // 也记冷却，避免空转
      return { ok: false, reason: 'no_events' };
    }

    // 3. 推送
    const { pushToGroup } = require('./qqbot');
    const ok = await pushToGroup(env, db, msg, 'monitor');
    info('[macro] 事件提醒推送:', ok ? '成功' : '失败');
    if (ok) markPushed(db, now);
    return { ok, reason: ok ? 'pushed' : 'push_fail' };
  } catch (e) {
    warn('[macro] 推送异常:', e.message);
    return { ok: false, reason: e.message };
  }
}

module.exports = { pushMacroAlert, buildMacroAlert, extractEvents, judgeDirection, fetchJin10Flash, shouldPush };
