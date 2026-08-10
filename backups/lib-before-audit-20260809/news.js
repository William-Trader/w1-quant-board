'use strict';
// 消息面采集器 v3 — 聚合 金十 / Odaily / BlockBeats / 链智库 / 华尔街见闻 / CoinTelegraph / Decrypt / Cryptonews
// 3 分钟采集一次，SQLite 持久化，7天自动清理

const DB_FILE = __dirname + '/../data/w1.db';

let cache = { items: [], ts: 0, loading: false };

/* ---------- SQLite 初始化 ---------- */
const sqlite3 = require('better-sqlite3');
function getDb() {
  const db = new sqlite3(DB_FILE, { readonly: false });
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    title TEXT,
    content TEXT,
    source TEXT,
    source_label TEXT,
    url TEXT,
    ts INTEGER,
    sentiment TEXT DEFAULT 'neutral',
    influence INTEGER DEFAULT 1,
    created_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_news_ts ON news(ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_news_source ON news(source)`);
  return db;
}

/* ---------- 7天 清理 ---------- */
function pruneNews() {
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - 2592000; // 30天
    const info = db.prepare('DELETE FROM news WHERE ts < ?').run(cutoff);
    db.close();
    if (info.changes > 0) console.log('[news] pruned ' + info.changes + ' items (>30d)');
  } catch (e) { console.warn('[news] prune error:', e.message); }
}

/* ---------- 华尔街见闻（公开 API） ---------- */
async function fetchWallStreetCN(count) {
  if (!count) count = 10;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(
      'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=' + count,
      {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'https://wallstreetcn.com',
          'Referer': 'https://wallstreetcn.com/live/global',
          'Accept': 'application/json'
        }
      }
    );
    if (!r.ok) throw new Error('wscn http ' + r.status);
    const body = await r.json();
    if (body.code !== 20000) throw new Error('wscn api fail: ' + body.code);
    const items = body.data && body.data.items || [];
    return items.map(function(item) {
      const content = (item.content_text || item.title || '').trim();
      return {
        id: 'wscn_' + item.id,
        title: item.title || content.slice(0, 60) || '',
        content: content,
        time: item.display_time ? new Date(item.display_time * 1000).toISOString() : '',
        ts: item.display_time || 0,
        url: item.uri || 'https://wallstreetcn.com/live/' + item.id,
        sourceUrl: '',
        source: 'wallstreetcn',
        sourceLabel: '华尔街',
      };
    });
  } finally { clearTimeout(timer); }
}

/* ---------- Odaily（公开 API） ---------- */
async function fetchOdaily(count) {
  if (!count) count = 30;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(
      'https://api.odaily.news/api/v1/newsflash?page=1&size=' + count + '&lang=zh-cn',
      { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!r.ok) throw new Error('odaily http ' + r.status);
    const body = await r.json();
    if (!body.success) throw new Error('odaily api fail');
    const list = body.data && body.data.list || [];
    return list.map(function(item) {
      return {
        id: 'odaily_' + item.id,
        title: item.title || '',
        content: (item.content || '').replace(/<[^>]+>/g, '').trim(),
        time: item.publishDate || '',
        ts: item.publishTimestamp ? Math.floor(item.publishTimestamp / 1000) : 0,
        url: item.link || 'https://www.odaily.news/zh-CN/newsflash/' + item.id,
        sourceUrl: item.sourceUrl || '',
        source: 'odaily',
        sourceLabel: '深潮',
      };
    });
  } finally { clearTimeout(timer); }
}

/* Decode \\uXXXX unicode escapes */
function unicodeDecode(str) { return str.replace(/\\u[0-9a-fA-F]{4}/g, function(m){ return String.fromCharCode(parseInt(m.slice(2), 16)); }); }

/* ---------- BlockBeats（SSR 页面解析） ---------- */
async function fetchBlockBeats(count) {
  if (!count) count = 15;
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ ctrl.abort(); }, 20000);
  try {
    const r = await fetch('https://www.theblockbeats.info/newsflash', {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) throw new Error('bb http ' + r.status);
    const html = await r.text();

    var scriptStart = html.indexOf('__NUXT__=');
    if (scriptStart < 0) throw new Error('bb no nuxt');
    var scriptEnd = html.indexOf('</script>', scriptStart);
    var script = html.slice(scriptStart, scriptEnd);

    var funcMatch = script.match(/function\(([^)]+)\)\{return /);
    if (!funcMatch) throw new Error('bb no function pattern');
    var params = funcMatch[1].split(',').map(function(p){ return p.trim(); });

    var afterFunc = script.slice(funcMatch.index + funcMatch[0].length);
    var depth = 1;
    var retEnd = 0;
    for (var i = 0; i < afterFunc.length; i++) {
      var ch = afterFunc[i];
      if (ch === '{') { depth++; }
      else if (ch === '}') { depth--; if (depth === 0) { retEnd = i + 1; break; } }
    }
    if (retEnd === 0) throw new Error('bb no return object');

    var afterRet = afterFunc.slice(retEnd);
    var argsStart = afterRet.indexOf('(');
    if (argsStart < 0) throw new Error('bb no iife call');

    var parenDepth = 1;
    var argsEnd = argsStart + 1;
    for (var i = argsEnd; i < afterRet.length; i++) {
      var ch = afterRet[i];
      if (ch === '(') parenDepth++;
      else if (ch === ')') { parenDepth--; if (parenDepth === 0) { argsEnd = i; break; } }
    }

    var argsStr = afterRet.slice(argsStart + 1, argsEnd);
    var argValues = [];
    var _depth = 0, _cur = '', _inStr = false;
    for (var i = 0; i < argsStr.length; i++) {
      var ch = argsStr[i];
      if (_inStr) { if (ch === '\\') _cur += ch; else if (ch === '"') _inStr = false; _cur += ch; continue; }
      if (ch === '"') { _inStr = true; _cur += ch; }
      else if (ch === '{' || ch === '[' || ch === '(') { _depth++; _cur += ch; }
      else if (ch === '}' || ch === ']' || ch === ')') { _depth--; _cur += ch; }
      else if (ch === ',' && _depth === 0) { argValues.push(_cur.trim()); _cur = ''; }
      else { _cur += ch; }
    }
    if (_cur.trim()) argValues.push(_cur.trim());

    var argMap = {};
    for (var i = 0; i < params.length && i < argValues.length; i++) {
      var v = argValues[i];
      if ((v.startsWith('"') && v.endsWith('"'))) argMap[params[i]] = v.slice(1, -1);
      else if ((v.startsWith("'") && v.endsWith("'"))) argMap[params[i]] = v.slice(1, -1);
      else argMap[params[i]] = v;
    }

    function resolve(val) {
      if (!val || val === 'null' || val === 'undefined' || val === 'void 0') return '';
      if (typeof val === 'string' && (val.startsWith('"') || val.startsWith("'"))) return val.slice(1, -1);
      if (typeof val === 'string' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(val)) {
        var resolved = argMap[val];
        return resolved !== undefined ? String(resolved) : '';
      }
      return String(val || '');
    }

    var retObj = afterFunc.slice(0, retEnd);
    var childIdx = retObj.indexOf('children:');
    if (childIdx < 0) throw new Error('bb no children');
    var arrStart = retObj.indexOf('[', childIdx);
    depth = 1;
    var arrEnd = arrStart + 1;
    for (var i = arrStart + 1; i < retObj.length; i++) {
      if (retObj[i] === '[') depth++;
      else if (retObj[i] === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
    }
    var childrenStr = retObj.slice(arrStart, arrEnd);

    var objects = [], objDepth = 0, inObj = false, curObj = '';
    for (var i = 1; i < childrenStr.length - 1; i++) {
      var ch = childrenStr[i];
      if (ch === '{') { if (!inObj) { inObj = true; objDepth = 1; curObj = ''; } else { objDepth++; curObj += ch; } }
      else if (ch === '}') { if (inObj) { objDepth--; if (objDepth === 0) { inObj = false; objects.push(curObj); } else curObj += ch; } }
      else if (inObj) curObj += ch;
    }

    var now = Math.floor(Date.now() / 1000);
    var items = [];
    for (var i = 0; i < objects.length && i < count; i++) {
      var obj = objects[i];
      var tMatch = obj.match(/title:([^,}]+)/);
      var cMatch = obj.match(/content:"((?:[^"\\]|\\.)*)"/);
      var aMatch = obj.match(/add_time:([^,}]+)/);
      var idMatch = obj.match(/article_id:([^,}]+)/);
      if (!tMatch) continue;

      var titleRaw = tMatch[1].trim();
      var title = resolve(titleRaw);
      if (titleRaw.startsWith('"')) {
        try { title = title.replace(/\\u[0-9a-fA-F]{4}/g, function(m){ return String.fromCharCode(parseInt(m.slice(2), 16)); }); } catch(e) {}
      }

      var contentRaw = cMatch ? cMatch[1] : '';
      var content = contentRaw.replace(/\\u[0-9a-fA-F]{4}/g, function(m){ return String.fromCharCode(parseInt(m.slice(2), 16)); })
                              .replace(/<[^>]+>/g, ' ').trim();
      var timeVal = aMatch ? resolve(aMatch[1].trim()) : '';
      var artId = idMatch ? resolve(idMatch[1].trim()) : '';
      if (title.length < 5) title = content.slice(0, 40);

      items.push({
        id: 'bb_' + (artId || i),
        title: title,
        content: content,
        time: typeof timeVal === 'string' ? timeVal : '',
        ts: parseInt(timeVal, 10) || (now - (objects.length - i) * 1800),
        url: artId ? 'https://www.theblockbeats.info/newsflash/' + artId : 'https://www.theblockbeats.info/newsflash',
        sourceUrl: '',
        source: 'blockbeats',
        sourceLabel: '律动',
      });
    }
    return items;
  } finally { clearTimeout(timer); }
}

/* ---------- 链智库 ChainThink ---------- */

/* ---------- RSS 通用解析 ---------- */
const { XMLParser } = require('fast-xml-parser');
const _rssParser = new XMLParser({ignoreAttributes: false, attributeNamePrefix: '@_'});

async function fetchRss(url, count) {
  if (!count) count = 10;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) throw new Error('rss http ' + r.status);
    const xml = await r.text();
    const parsed = _rssParser.parse(xml);
    const items = (parsed.rss && parsed.rss.channel && parsed.rss.channel.item) || [];
    const arr = Array.isArray(items) ? items : [items];
    const now = Math.floor(Date.now() / 1000);
    return arr.slice(0, count).map(function(item, i) {
      var title = (item.title || '').replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
      var desc = (item.description || item['content:encoded'] || '').replace(/<[^>]+>/g, ' ').replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim().slice(0, 300);
      var pubDate = item.pubDate || '';
      var ts = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : (now - i * 3600);
      if (!isFinite(ts)) ts = now - i * 3600;
      var link = '';
      if (typeof item.link === 'string') link = item.link;
      else if (item.link && typeof item.link === 'object' && item.link['#text']) link = item.link['#text'];
      else if (item.guid && typeof item.guid === 'string') link = item.guid;
      return { title: title, content: desc, time: pubDate, ts: ts, url: link, sourceUrl: '', source: '', sourceLabel: '' };
    });
  } finally { clearTimeout(timer); }
}

/* ---------- CoinTelegraph（RSS） ---------- */
async function fetchCoinTelegraph(count) {
  var items = await fetchRss('https://cointelegraph.com/rss', count || 15);
  items.forEach(function(i){ i.id = 'ct_' + (i.url.split('/').pop() || Math.random().toString(36).slice(2,8)); i.source = 'cointelegraph'; i.sourceLabel = 'CoinTelegraph'; });
  return items;
}

/* ---------- Decrypt（RSS） ---------- */
async function fetchDecrypt(count) {
  var items = await fetchRss('https://decrypt.co/feed', count || 10);
  items.forEach(function(i){ i.id = 'dec_' + (i.url.split('/').pop() || Math.random().toString(36).slice(2,8)); i.source = 'decrypt'; i.sourceLabel = 'Decrypt'; });
  return items;
}

/* ---------- Cryptonews（RSS，2026-08-02 替代被封的 theblock.co） ---------- */
async function fetchCryptonews(count) {
  var items = await fetchRss('https://cryptonews.com/news/feed/', count || 10);
  items.forEach(function(i){ i.id = 'cn_' + (i.url.split('/').pop() || Math.random().toString(36).slice(2,8)); i.source = 'cryptonews'; i.sourceLabel = 'Cryptonews'; });
  return items;
}

/* ---------- 金十数据（公开 API） ---------- */
async function fetchJin10(count) {
  if (!count) count = 30;
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
      var d = item.data || {};
      var content = (d.content || '').replace(/<[^>]+>/g, ' ').trim();
      var title = d.title || content.slice(0, 60) || '';
      return {
        id: 'jin10_' + item.id,
        title: title,
        content: content,
        time: item.time || '',
        ts: item.time ? Math.floor(new Date(item.time.replace(/-/g, '/')).getTime() / 1000) : 0,
        url: 'https://www.jin10.com/flash/' + item.id,
        sourceUrl: '',
        source: 'jin10',
        sourceLabel: '金十',
      };
    });
  } finally { clearTimeout(timer); }
}

async function fetchChainThink(count) {
  if (!count) count = 10;
  const ctrl = new AbortController();
  const timer = setTimeout(function(){ ctrl.abort(); }, 20000);
  try {
    const r = await fetch('https://chainthink.cn/', {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) throw new Error('ct http ' + r.status);
    const html = await r.text();

    // v4 解析（2026-08-02 改版后）：用 HTML 结构精确提取 h3 > span.cursor-pointer 标题 + 紧随 div 的时间
    var blockRegex = /<h3[^>]*>[\s\S]*?<span class="cursor-pointer">([\s\S]*?)<\/span>[\s\S]*?<\/h3>\s*<div[^>]*>\s*(\d{2}-\d{2}\s+\d{2}:\d{2})/g;
    var match;
    var blocks = [];
    while ((match = blockRegex.exec(html)) !== null) {
      var title = match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#8217;/g, "'").trim();
      if (title.length < 5) continue;
      blocks.push({ title: title, timeStr: match[2], start: match.index });
    }

    // 回退：若 HTML 结构匹配不到，用旧版纯文本正则兜底
    if (blocks.length === 0) {
      var text = html.replace(/<script[\s\S]*?<\/script>/g, '')
                     .replace(/<style[\s\S]*?<\/style>/g, '')
                     .replace(/<[^>]+>/g, '\n')
                     .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      var fallbackRegex = /(\d{2}-\d{2}\s+\d{2}:\d{2})\s*\n\s*([^\n]{5,120})/g;
      while ((match = fallbackRegex.exec(text)) !== null) {
        var fTitle = match[2].trim();
        if (fTitle.length < 5 || fTitle.indexOf('ChainThink 消息') === 0) continue;
        blocks.push({ title: fTitle, timeStr: match[1], start: match.index });
      }
    }

    var items = [];
    for (var i = 0; i < blocks.length && items.length < count; i++) {
      var b = blocks[i];
      var end = i + 1 < blocks.length ? blocks[i + 1].start : b.start + 2000;
      var seg = html.slice(b.start, end);
      var content = seg.replace(/<script[\s\S]*?<\/script>/g, '')
                       .replace(/<style[\s\S]*?<\/style>/g, '')
                       .replace(/<[^>]+>/g, ' ')
                       .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8217;/g, "'")
                       .replace(/\s+/g, ' ').trim()
                       .replace(/^.*?ChainThink 消息[，,]?\s*/, '')
                       .slice(0, 300);

      var timeStr = '2026-' + b.timeStr;
      items.push({
        id: 'ct_' + items.length,
        title: b.title,
        content: content,
        time: timeStr,
        ts: (function(d){ var t = new Date(d); return isNaN(t.getTime()) ? 0 : Math.floor(t.getTime() / 1000); })(timeStr),
        url: 'https://chainthink.cn/',
        sourceUrl: '',
        source: 'chainthink',
        sourceLabel: '链智库',
      });
    }
    return items;
  } finally { clearTimeout(timer); }
}

/* ---------- 影响力 & 多空判断 ---------- */
var BULLISH_KW = ['上涨','突破','创新高','利好','批准','通过','上线','增持','买入','看涨','ETF','涨幅','反弹','做多','多头','牛市','牛回','合规','牌照','采用','合作','投资','扩张','增长','新高','批','利好','放量','回暖','走强','突破','飙升','大涨','强于预期'];
var BEARISH_KW = ['下跌','跌破','利空','看跌','禁止','监管','减持','卖出','做空','空头','黑客','被盗','攻击','漏洞','崩盘','暴跌','暂停','关闭','熊市','熊','起诉','诉讼','罚款','调查','清算','强制','跌','暴跌','下挫','恐慌','抛售','做空','减持','利空','清退','叫停'];
var INFLUENCE_5 = ['美联储','SEC','ETF批','利率决议','加息','降息','央行','白宫','特朗普','比特币','以太坊','BTC','ETH','中国人民银行'];
var INFLUENCE_4 = ['ETF','贝莱德','灰度','币安','Coinbase','MicroStrategy','萨尔瓦多','华尔街','摩根','富达','Bitwise','华尔街见闻'];

function assessSentiment(title, content) {
  var text = (title + ' ' + content).toLowerCase();
  var score = 0;
  for (var i = 0; i < BULLISH_KW.length; i++) { if (text.indexOf(BULLISH_KW[i].toLowerCase()) >= 0) score++; }
  for (var i = 0; i < BEARISH_KW.length; i++) { if (text.indexOf(BEARISH_KW[i].toLowerCase()) >= 0) score--; }
  if (score > 0) return 'bullish';
  if (score < 0) return 'bearish';
  return 'neutral';
}

function assessInfluence(title, content) {
  var text = (title + ' ' + content).toLowerCase();
  for (var i = 0; i < INFLUENCE_5.length; i++) { if (text.indexOf(INFLUENCE_5[i].toLowerCase()) >= 0) return 5; }
  for (var i = 0; i < INFLUENCE_4.length; i++) { if (text.indexOf(INFLUENCE_4[i].toLowerCase()) >= 0) return 4; }
  var len = title.length + content.length;
  if (len > 300) return 3;
  if (len > 100) return 2;
  return 1;
}

/* ---------- DB 读写 ---------- */
function saveToDb(items) {
  try {
    const db = getDb();
    const ins = db.prepare('INSERT OR REPLACE INTO news(id,title,content,source,source_label,url,ts,sentiment,influence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const now = Math.floor(Date.now() / 1000);
    const tx = db.transaction(function(items){
      for (var i = 0; i < items.length; i++) {
        var n = items[i];
        ins.run(n.id, n.title || '', n.content || '', n.source || '', n.sourceLabel || n.source || '', n.url || '', n.ts || now, n.sentiment || 'neutral', n.influence || 1, now);
      }
    });
    tx(items);
    db.close();
  } catch (e) { console.warn('[news] db save error:', e.message); }
}

function loadFromDb(limit) {
  if (!limit) limit = 100;
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM news ORDER BY ts DESC, influence DESC LIMIT ?').all(limit);
    db.close();
    return rows.map(function(r){
      return {
        id: r.id,
        title: r.title,
        content: r.content,
        source: r.source,
        sourceLabel: r.source_label,
        url: r.url,
        ts: r.ts,
        sentiment: r.sentiment,
        influence: r.influence,
        time: r.ts ? new Date(r.ts * 1000).toISOString() : '',
        sourceUrl: '',
      };
    });
  } catch (e) {
    console.warn('[news] db load error:', e.message);
    return [];
  }
}

/* ---------- 主采集 ---------- */
async function collectNews() {
  console.log('[news] collecting...');
  var all = [];

  var tasks = [
    { name: 'jin10', fn: function(){ return fetchJin10(30); } },
    { name: 'odaily', fn: function(){ return fetchOdaily(30); } },
    { name: 'blockbeats', fn: function(){ return fetchBlockBeats(15); } },
    { name: 'wallstreetcn', fn: function(){ return fetchWallStreetCN(10); } },
    { name: 'chainthink', fn: function(){ return fetchChainThink(10); } },
    { name: 'cointelegraph', fn: function(){ return fetchCoinTelegraph(15); } },
    { name: 'decrypt', fn: function(){ return fetchDecrypt(10); } },
    { name: 'cryptonews', fn: function(){ return fetchCryptonews(10); } },
  ];

  var results = await Promise.allSettled(tasks.map(function(t){ return t.fn(); }));
  for (var i = 0; i < tasks.length; i++) {
    if (results[i].status === 'fulfilled') {
      var items = results[i].value;
      console.log('[news] ' + tasks[i].name + ': ' + items.length + ' items');
      all = all.concat(items);
    } else {
      console.warn('[news] ' + tasks[i].name + ' failed: ' + (results[i].reason && results[i].reason.message || 'unknown'));
    }
  }

  // Dedup
  var seen = {};
  var deduped = [];
  for (var i = 0; i < all.length; i++) {
    var key = (all[i].title || '').slice(0, 25) + all[i].source;
    if (seen[key]) continue;
    seen[key] = true;
    all[i].sentiment = assessSentiment(all[i].title, all[i].content);
    all[i].influence = assessInfluence(all[i].title, all[i].content);
    deduped.push(all[i]);
  }

  // Sort by influence desc, then time desc
  deduped.sort(function(a, b) {
    if (b.influence !== a.influence) return b.influence - a.influence;
    return (b.ts || 0) - (a.ts || 0);
  });

  // Save to DB (always keep a persistent copy)
  saveToDb(deduped);

  // Prune old items (48h)
  pruneNews();

  // Load from DB to ensure we respect pruning
  var dbItems = loadFromDb(100);

  cache = { items: dbItems, ts: Math.floor(Date.now() / 1000), loading: false };
  console.log('[news] cache: ' + dbItems.length + ' items');
  return dbItems;
}

function getCached() { return cache; }
function getItems() { return cache.items; }

var _interval = null;

function startCollector(ctx, intervalMs) {
  if (!intervalMs) intervalMs = 180000; // 3 min
  collectNews().catch(function(e){ console.error('[news] init fail:', e.message); });
  _interval = setInterval(function(){
    collectNews().catch(function(e){ console.error('[news] cron fail:', e.message); });
  }, intervalMs);
  console.log('[news] collector every ' + (intervalMs / 1000) + 's');
}

function stopCollector() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { collectNews, getCached, getItems, startCollector, stopCollector, pruneNews };
