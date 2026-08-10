'use strict';
/**
 * lib/eco_calendar.js — 关键经济事件预览（消息面顶部时间表）
 * 数据源（全免费、已验证）：
 *   [未来事件] ForexFactory 本周日历 nfs.faireconomy.media（免费公开）
 *              → 过滤 impact=High/Medium（足够重要），含 forecast/previous/actual
 *   [历史事件] 金十快讯翻页 flash-api.jin10.com（macro_alert 同源已验证）
 *              → 提取宏观事件 + 标题情绪（利多/利空）
 * 展示：当日前后 7 天；未来事件显示预期/前值，历史事件红绿标注利多利空
 * 存储：economic_calendar(ts PK, payload{updated_at, future[], past[]})
 * 刷新：每 30 分钟（FF 的 actual 会更新，历史利多利空随之刷新）
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const TZ = 'Asia/Shanghai';
const PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const JIN10_API = 'https://flash-api.jin10.com/get_flash_list';
const JIN10_APP_ID = 'bVBF4FyRTn5NJF5n';

/* ---------- FF 事件名 → 中文（重点事件映射，未命中显示英文） ---------- */
const EVENT_ZH = {
  'Non-Farm Employment Change': '美国非农就业',
  'Unemployment Rate': '美国失业率',
  'Average Hourly Earnings m/m': '美国平均时薪环比',
  'CPI y/y': '美国CPI同比',
  'CPI m/m': '美国CPI环比',
  'Core CPI m/m': '美国核心CPI环比',
  'Core CPI y/y': '美国核心CPI同比',
  'PPI m/m': '美国PPI环比',
  'Core PPI m/m': '美国核心PPI环比',
  'Core PCE Price Index m/m': '美国核心PCE环比',
  'Core PCE Price Index y/y': '美国核心PCE同比',
  'PCE Price Index m/m': '美国PCE物价环比',
  'GDP q/q': '美国GDP季率',
  'GDP y/y': '美国GDP同比',
  'Retail Sales m/m': '美国零售销售环比',
  'Retail Sales y/y': '美国零售销售同比',
  'Core Retail Sales m/m': '美国核心零售环比',
  'ISM Manufacturing PMI': '美国ISM制造业PMI',
  'ISM Services PMI': '美国ISM服务业PMI',
  'S&P Global Manufacturing PMI': '美国标普制造业PMI',
  'S&P Global Services PMI': '美国标普服务业PMI',
  'Jobless Claims': '美国初请失业金',
  'Continuing Jobless Claims': '美国续请失业金',
  'Fed Interest Rate Decision': '美联储利率决议',
  'FOMC Statement': 'FOMC 声明',
  'FOMC Press Conference': '美联储主席新闻发布会',
  'FOMC Member Williams Speaks': '美联储威廉姆斯讲话',
  'FOMC Member Waller Speaks': '美联储沃勒讲话',
  'Fed Chair Powell Speaks': '美联储主席鲍威尔讲话',
  'ECB Interest Rate Decision': '欧央行利率决议',
  'ECB Press Conference': '欧央行行长发布会',
  'BoE Interest Rate Decision': '英央行利率决议',
  'BoJ Interest Rate Decision': '日央行利率决议',
  'BoJ Press Conference': '日央行行长发布会',
  'CB Consumer Confidence': '美国谘商会消费者信心',
  'Michigan Consumer Sentiment': '美国密歇根消费者信心',
  'Building Permits': '美国营建许可',
  'Housing Starts': '美国新屋开工',
  'Existing Home Sales': '美国成屋销售',
  'New Home Sales': '美国新屋销售',
  'Durable Goods Orders m/m': '美国耐用品订单环比',
  'Industrial Production m/m': '美国工业产出环比',
  'Trade Balance': '美国贸易帐',
  'Treasury Currency Report': '美国财政部货币报告',
  'China CPI y/y': '中国CPI同比',
  'China GDP y/y': '中国GDP同比',
  'China Retail Sales y/y': '中国零售销售同比',
  'China Industrial Production y/y': '中国工业产出同比',
  'German CPI m/m': '德国CPI环比',
  'German CPI y/y': '德国CPI同比',
  'Eurozone CPI y/y': '欧元区CPI同比',
  'Eurozone CPI Flash Estimate y/y': '欧元区CPI初值同比',
  'Eurozone Core CPI Flash Estimate y/y': '欧元区核心CPI初值',
  'Eurozone GDP q/q': '欧元区GDP季率',
  'Eurozone Employment Change q/q': '欧元区就业变化',
  'UK GDP m/m': '英国GDP环比',
  'UK GDP y/y': '英国GDP同比',
  'UK CPI y/y': '英国CPI同比',
  'UK Core CPI y/y': '英国核心CPI同比',
  'UK Claimant Count Change': '英国申领失业金人数',
  'Japan CPI y/y': '日本CPI同比',
  'Canada CPI y/y': '加拿大CPI同比',
  'Canada Employment Change': '加拿大就业人数',
  'Australia CPI q/q': '澳洲CPI季率',
  'RBA Interest Rate Decision': '澳联储利率决议',
  'SNB Interest Rate Decision': '瑞士央行利率决议',
  'BoC Interest Rate Decision': '加拿大央行利率决议',
  'OPEC Meetings': 'OPEC会议',
  'Crude Oil Inventories': '美国EIA原油库存',
  'Baker Hughes Oil Rig Count': '美国石油钻井数',
  'Cash Rate': '澳洲联储利率决议',
  'RBA Monetary Policy Statement': '澳联储货币政策声明',
  'RBA Rate Statement': '澳联储利率声明',
  'RBA Press Conference': '澳联储行长发布会',
  'Inflation Expectations q/q': '澳洲通胀预期',
  'GDP m/m': '英国GDP环比',
  'Gold Forecast': '黄金'
};

/* ---------- 数值方向映射：actual vs forecast 的利多利空（+1 高于预期=利好） ---------- */
const DIR_RULES = [
  { re: /CPI|PCE|PPI|HICP|Inflation/i, dir: -1 },          // 通胀超预期 → 利空风险资产
  { re: /Unemployment|Jobless Claims/i, dir: -1 },         // 失业/初请上升 → 利空
  { re: /Employment Change|NFP|Payrolls/i, dir: 1 },       // 就业超预期 → 利好
  { re: /GDP|Retail Sales|PMI|Confidence|Sentiment|Industrial Production|Housing|Permits|Durable|Trade Balance|Current Account|Orders/i, dir: 1 }, // 增长类 → 利好
  { re: /Rate Decision|Statement|Press Conference/i, dir: -1 } // 利率决议（加息→利空；降息标题情绪优先覆盖）
];
function judgeDirection(title, actual, forecast) {
  // 金十标题情绪优先（已发生事件由标题语义判定）
  if (/利好|利多|超预期|大涨|走高|上升|回升|反弹/i.test(title) && !/利空|不及|下跌/i.test(title)) return 'bullish';
  if (/利空|不及预期|低于预期|下跌|走低|萎缩|放缓/i.test(title) && !/利好|上涨/i.test(title)) return 'bearish';
  // 数值对比
  if (actual != null && forecast != null) {
    const a = parseFloat(String(actual).replace(/[%,TBMK]/g, ''));
    const f = parseFloat(String(forecast).replace(/[%,TBMK]/g, ''));
    if (!isNaN(a) && !isNaN(f) && a !== f) {
      for (const r of DIR_RULES) {
        if (r.re.test(title)) return (a > f ? r.dir : -r.dir) === 1 ? 'bullish' : 'bearish';
      }
    }
  }
  return 'neutral';
}

/* ---------- 金十宏观事件关键词（历史事件提取） ---------- */
const JIN10_EVENTS = [
  { name: '美联储利率决议', re: /美联储|FOMC|议息|利率决议/i },
  { name: 'CPI 通胀数据', re: /CPI|通胀数据|消费者物价/i },
  { name: '非农就业', re: /非农|就业报告/i },
  { name: '失业率', re: /失业率/i },
  { name: 'PCE 通胀', re: /PCE|核心通胀/i },
  { name: '鲍威尔讲话', re: /鲍威尔|美联储主席/i },
  { name: 'GDP 数据', re: /GDP/i },
  { name: 'PMI 数据', re: /\bPMI\b|采购经理人指数/i },
  { name: '初请失业金', re: /初请|申领失业金/i },
  { name: '零售销售', re: /零售销售/i },
  { name: '欧央行决议', re: /欧央行|ECB/i },
  { name: '英央行决议', re: /英央行|英国央行/i },
  { name: '日央行决议', re: /日央行|日本央行/i },
  { name: '澳洲CPI', re: /澳洲CPI|澳大利亚CPI/i },
  { name: '德国CPI', re: /德国CPI/i },
  { name: '欧元区CPI', re: /欧元区CPI/i },
  { name: 'EIA原油库存', re: /EIA|原油库存/i },
  { name: '消费者信心', re: /消费者信心/i },
  { name: '密歇根信心', re: /密歇根/i },
  { name: '耐用品订单', re: /耐用品/i }
];

/* ---------- FF 本周日历（UA + 重试） ---------- */
async function fetchFF() {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const { stdout } = await execFileP('curl', ['-s', '-m', '20', '--proxy', PROXY,
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '-H', 'Accept: application/json', FF_URL]);
      if (!stdout || stdout.trim().startsWith('<')) throw new Error('ff html/empty');
      const j = JSON.parse(stdout);
      if (Array.isArray(j) && j.length) return j;
      throw new Error('ff bad payload');
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw lastErr || new Error('ff fail');
}

/* ---------- 金十快讯翻页（拿历史 ~7 天宏观事件） ---------- */
async function fetchJin10Past(maxPages = 10) {
  const out = [];
  let maxTime = '';
  const cutoff = Date.now() / 1000 - 7 * 86400;
  for (let p = 0; p < maxPages; p++) {
    const url = `${JIN10_API}?channel=-8200&vip=1&max_time=${encodeURIComponent(maxTime)}&limit=50`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'x-app-id': JIN10_APP_ID, 'x-version': '1.0.0', 'Accept': 'application/json' }
    });
    if (!r.ok) break;
    const j = await r.json();
    const items = (j && j.data) || [];
    if (!items.length) break;
    out.push(...items);
    const last = items[items.length - 1];
    if (!last || !last.time) break;
    maxTime = last.time; // 翻页游标：最后一条的 time 字符串
    const lastTs = parseJin10Time(last.time);
    if (!lastTs || lastTs < cutoff) break; // 已到 7 天前
    await new Promise(res => setTimeout(res, 500));
  }
  return out;
}

function parseJin10Time(t) {
  if (!t) return 0;
  const ts = Date.parse(String(t).replace(' ', 'T') + '+08:00');
  return isNaN(ts) ? 0 : ts / 1000;
}

/* ---------- 金十事件提取 + 情绪 ---------- */
/* 时间线索（未来事件前瞻） */
const TIME_HINTS = /今晚|明日|明天|本周|下周|稍后|待公布|公布在即|将于|周[一二三四五六日]/;

function extractJin10Events(items) {
  const found = [];
  const hints = [];
  const now = Date.now() / 1000;
  for (const it of items) {
    const d = it.data || {};
    const text = ((d.title || '') + ' ' + (d.content || '')).replace(/\s+/g, ' ').slice(0, 200);
    if (!text.trim()) continue;
    const ts = parseJin10Time(it.time);
    if (!ts || now - ts > 7 * 86400 || now - ts < 0) continue;
    for (const ev of JIN10_EVENTS) {
      if (!ev.re.test(text)) continue;
      const isHint = TIME_HINTS.test(text);
      const item = {
        title: text.slice(0, 90),
        name: ev.name,
        ts,
        time: new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).slice(0, 5),
        date: new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: TZ }),
        direction: judgeDirection(text, null, null)
      };
      if (isHint) hints.push(item); else found.push(item);
      break;
    }
  }
  // 同事件同日去重
  const seen = {};
  const dedup = arr => arr.filter(f => {
    const k = f.date + f.name;
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });
  return { past: dedup(found).sort((a, b) => a.ts - b.ts), futureHints: dedup(hints).sort((a, b) => a.ts - b.ts) };
}

/* ---------- 本地 news 表扫描（15 天宏观事件，sentiment 优先） ---------- */
function extractNewsEvents(db, days = 15) {
  const out = [];
  const since = Date.now() / 1000 - days * 86400;
  let rows = [];
  try {
    rows = db.prepare("SELECT ts, source, title, content, sentiment FROM news WHERE ts>=? AND source IN ('jin10','wallstreetcn') ORDER BY ts ASC").all(since);
  } catch { return out; }
  for (const it of rows) {
    const text = ((it.title || '') + ' ' + (it.content || '')).replace(/\s+/g, ' ').slice(0, 200);
    if (!text.trim()) continue;
    for (const ev of JIN10_EVENTS) {
      if (!ev.re.test(text)) continue;
      const ts = it.ts;
      const direction = it.sentiment === 'bullish' ? 'bullish' : it.sentiment === 'bearish' ? 'bearish' : judgeDirection(text, null, null);
      out.push({
        title: text.slice(0, 90),
        name: ev.name,
        ts,
        time: new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).slice(0, 5),
        date: new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: TZ }),
        direction
      });
      break;
    }
  }
  // 同日同事件去重（取最新一条）
  const seen = {};
  const dedup = [];
  for (const e of out.reverse()) {
    const k = e.date + e.name;
    if (seen[k]) continue;
    seen[k] = true;
    dedup.push(e);
  }
  return dedup.sort((a, b) => a.ts - b.ts);
}

/* ---------- 采集：两级刷新机制 ----------
 * FF 日历：10 分钟刷新（actual 随公布实时更新，预期/前值不变）
 * 金十历史：2 小时增量刷新（历史事件低频变化）
 * 双源失败 → 保留旧数据不覆盖
 */
async function collectEcoCalendar(ctx) {
  const db = ctx.db;
  db.exec(`CREATE TABLE IF NOT EXISTS economic_calendar (
    ts INTEGER PRIMARY KEY, payload TEXT NOT NULL
  )`);
  const { kvGet, kvSet } = require('./db');
  const now = Date.now() / 1000;
  const nowSec = Math.floor(now);
  const prev = getEvents(db) || null;
  const doFF = nowSec - (kvGet(db, 'eco:ff') || 0) >= 600;    // 10min
  const doJ10 = nowSec - (kvGet(db, 'eco:j10') || 0) >= 7200; // 2h
  let future = [], past = [];
  if (prev) { future.push(...(prev.future || [])); past.push(...(prev.past || [])); }
  // 1. FF（高重要过滤，actual 实时）
  if (doFF) {
    try {
      const ff = await fetchFF();
      const ffF = [], ffP = [];
      for (const ev of ff) {
        const impact = String(ev.impact || '').toLowerCase();
        if (impact !== 'high' && impact !== 'medium') continue;
        const t = new Date(ev.date).getTime() / 1000;
        if (Math.abs(t - now) > 7 * 86400) continue;
        const item = {
          ts: t,
          date: new Date(ev.date).toLocaleDateString('en-CA', { timeZone: TZ }),
          time: new Date(ev.date).toLocaleTimeString('zh-CN', { timeZone: TZ, hour12: false }).slice(0, 5),
          title: ev.title || '',
          title_zh: EVENT_ZH[ev.title] || ev.title,
          country: ev.country || '',
          currency: ev.currency || '',
          impact,
          forecast: ev.forecast || null,
          previous: ev.previous || null,
          actual: ev.actual || null
        };
        if (t >= now) ffF.push(item);
        else { item.direction = judgeDirection(item.title_zh, ev.actual, ev.forecast); ffP.push(item); }
      }
      // FF 事件替换旧 FF 条目（同 date+title 覆盖）
      const ffKeys = new Set(ffF.concat(ffP).map(x => x.date + x.title_zh));
      future = future.filter(x => !ffKeys.has(x.date + x.title_zh));
      past = past.filter(x => x.source === 'jin10' || !ffKeys.has(x.date + x.title_zh));
      future.push(...ffF); past.push(...ffP);
      kvSet(db, 'eco:ff', nowSec);
    } catch (e) { console.warn('[eco_calendar] ff fail(keep old):', e.message); }
  }
  // 2. 金十历史（增量）
  if (doJ10) {
    try {
      const flash = await fetchJin10Past(5);
      const { past: jPast, futureHints } = extractJin10Events(flash);
      const haveP = new Set(past.map(p => p.date + p.title_zh));
      for (const e of jPast) {
        if (haveP.has(e.date + e.name)) continue;
        past.push({ ts: e.ts, date: e.date, time: e.time, title: e.title, title_zh: e.name,
          country: '', currency: '', impact: 'medium', forecast: null, previous: null, actual: null,
          direction: e.direction, source: 'jin10' });
        haveP.add(e.date + e.name);
      }
      // [2026-08-10 修复] 金十前瞻(jin10-hint)不再写入 future 日历：
      // 其时间戳是新闻发布时间而非事件时间，导致"今天有利率决议"的假事件。
      // 未来事件以 FF 官方日历为唯一权威源。
      kvSet(db, 'eco:j10', nowSec);
    } catch (e) { console.warn('[eco_calendar] jin10 fail:', e.message); }
  }
  // 3. 本地 news 扫描（15 天窗口，sentiment 优先；数据随保留期积累）
  try {
    const nEvents = extractNewsEvents(db, 15);
    const haveP = new Set(past.map(p => p.date + p.title_zh));
    for (const e of nEvents) {
      if (haveP.has(e.date + e.name)) continue;
      past.push({ ts: e.ts, date: e.date, time: e.time, title: e.title, title_zh: e.name,
        country: '', currency: '', impact: 'medium', forecast: null, previous: null, actual: null,
        direction: e.direction, source: 'news' });
      haveP.add(e.date + e.name);
    }
  } catch (e) { console.warn('[eco_calendar] news scan fail:', e.message); }
  // 窗口过滤（未来 +7 天 / 历史 15 天）+ 排序
  future = future.filter(e => e.ts >= now - 2 * 86400 && e.ts <= now + 8 * 86400).sort((a, b) => a.ts - b.ts);
  past = past.filter(e => e.ts >= now - 15 * 86400).sort((a, b) => b.ts - a.ts);
  // 双源均无新数据且无旧数据 → 不写空
  if (!future.length && !past.length && !prev) return 'empty';
  const payload = { updated_at: new Date().toISOString(), future, past };
  db.prepare('INSERT OR REPLACE INTO economic_calendar(ts,payload) VALUES(?,?)')
    .run(nowSec, JSON.stringify(payload));
  return `ff=${doFF ? 'Y' : '-'} j10=${doJ10 ? 'Y' : '-'} future=${future.length} past=${past.length}`;
}

function getEvents(db) {
  try {
    const r = db.prepare('SELECT payload FROM economic_calendar ORDER BY ts DESC LIMIT 1').get();
    return r ? JSON.parse(r.payload) : null;
  } catch { return null; }
}

module.exports = { collectEcoCalendar, getEvents, fetchFF, judgeDirection, fetchJin10Past, extractJin10Events, extractNewsEvents };
