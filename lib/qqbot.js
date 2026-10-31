'use strict';
const { debug, error, info, warn } = require('./log');
// QQ 官方机器人：/qq/callback Ed25519 验签 + 群命令 + 主动推送（GROUP_OPENID 为空时静默跳过）
// 官方算法：seed = AppSecret 重复填充至 32 字节 → ed25519 密钥对
const crypto = require('crypto');
const nacl = require('tweetnacl');

// RFC 8032 标准 ed25519 seed 派生（与 QQ 平台算法一致；Node generateKeyPairSync 不支持 ed25519 seed）
function deriveKeys(appSecret) {
  if (!appSecret || appSecret.length < 8) throw new Error('app_secret_too_short');
  let seed = appSecret;
  while (seed.length < 32) seed += appSecret;
  seed = seed.slice(0, 32);
  const kp = nacl.sign.keyPair.fromSeed(Buffer.from(seed, 'utf8'));
  return { publicKey: kp.publicKey, privateKey: kp.secretKey };
}

function verifySignature(publicKey, sigHex, timestamp, rawBody) {
  try {
    const msg = Buffer.concat([Buffer.from(String(timestamp), 'utf8'), Buffer.from(rawBody, 'utf8')]);
    return nacl.sign.detached.verify(msg, Buffer.from(sigHex, 'hex'), publicKey);
  } catch (e) { debug('[qq] verify:', e.message); return false; }
}

function sign(privateKey, message) {
  return Buffer.from(nacl.sign.detached(Buffer.from(message, 'utf8'), privateKey)).toString('hex');
}

/* ---------- access token 缓存 ---------- */
let tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: env.QQ_APPID, clientSecret: env.QQ_APPSECRET })
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('qq_token_fail:' + JSON.stringify(data).slice(0, 120));
  tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

async function sendGroupMessage(env, groupOpenid, content, msgId) {
  const token = await getAccessToken(env);
  const body = { content, msg_type: 0 };
  if (msgId) body.msg_id = msgId;
  const r = await fetch(`https://api.sgroup.qq.com/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.status;
}

/* 多群隔离路由：type = monitor(监测群) / signal(跟单群) / analysis(分析群,不主动推)。
   不传 type 时回落到 signal（跟单群），保持兼容旧调用。 */
const GROUP_TYPE_MAP = {
  monitor: 'QQ_GROUP_MONITOR',
  signal: 'QQ_GROUP_SIGNAL',
  analysis: 'QQ_GROUP_ANALYSIS',
};

function resolveGroupOpenid(env, type) {
  const key = GROUP_TYPE_MAP[type];
  if (key && env[key]) return String(env[key]).trim();
  // 回退：signal 优先，其次旧变量 QQ_GROUP_OPENID
  return String(env.QQ_GROUP_SIGNAL || env.QQ_GROUP_OPENID || '').trim();
}

/* 主动推送：目标群为空 → 静默跳过并记日志 */
async function pushToGroup(env, db, content, type) {
  const gid = resolveGroupOpenid(env, type);
  if (!gid) {
    debug('[qq] 主动推送静默跳过(无目标群):', String(content).slice(0, 60));
    if (db) db.prepare('INSERT INTO source_health(source,ok,ms,detail,ts) VALUES(?,?,?,?,?)')
      .run('qq_push_skip', 1, 0, 'GROUP_OPENID empty, skipped: ' + String(content).slice(0, 80), Math.floor(Date.now() / 1000));
    return false;
  }
  try {
    const status = await sendGroupMessage(env, gid, content, null);
    if (db) db.prepare('INSERT INTO source_health(source,ok,ms,detail,ts) VALUES(?,?,?,?,?)')
      .run('qq_push', status < 300 ? 1 : 0, 0, `status=${status} type=${type||'default'}`, Math.floor(Date.now() / 1000));
    return status < 300;
  } catch (e) {
    warn('[qq] push failed:', e.message);
    return false;
  }
}

/* 按类型推送的语义别名 */
async function pushToGroupType(env, db, content, type) {
  return pushToGroup(env, db, content, type);
}

/* ---------- 命令处理 ---------- */

async function buildReply(text, ctx) {
    const { env, db } = ctx || {};
    const { buildEngineSnapshot } = require('./collectors');
    const { store } = require('./store');
    const precision = require('./precision');
    const cmd = text.trim();
    const snap = buildEngineSnapshot(ctx);
    const P = '【W1看板】';
    if (cmd.startsWith('/行情')) {
      // 2026-10-31 精度升级：多源加权 + 偏差 + 数据时间，禁止单源裸价
      const snap = precision.priceSnapshot(db, ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK']);
      const lines = [];
      for (const sym of Object.keys(snap.symbols)) {
        const s = snap.symbols[sym];
        if (!s || s.price == null) { lines.push(`${sym} —`); continue; }
        const src = s.n >= 2 ? `${s.n}源加权·偏差${s.max_dev_pct.toFixed(3)}%` : '单源';
        lines.push(`${sym} $${precision.fmtPrice(s.price)} (${s.chg24 >= 0 ? '+' : ''}${Number(s.chg24 || 0).toFixed(2)}%) · ${src}`);
      }
      return `${P} 行情（${precision.fmtTime(snap.as_of)}）\n${lines.join('\n')}\n📌 价格=Gate现货+Coinglass合约按流动性加权；偏差>0.5%会标注`;
    }
    if (cmd.startsWith('/费率')) {
      const arb = store.latestFundingArb(db);
      const top = arb && arb.data && arb.data.data ? arb.data.data.slice(0, 5) : [];
      return `${P} 费率套利 TOP5\n` + (top.map(t => `${t.symbol} APR ${Number(t.apr).toFixed(0)}% 买${t.buy && t.buy.exchange}/卖${t.sell && t.sell.exchange}`).join('\n') || '暂无数据');
    }
    if (cmd.startsWith('/多空')) {
      // 2026-10-31 精度升级：主流币走 lsr_signals（显式请求，榜单不含 BTC/ETH），
      // 同时给「持仓名义 / 账户数 / 大户持仓」三个分母，不再把 ratio 笼统叫「多空比」。
      const major = ['BTC', 'ETH', 'SOL', 'BNB'];
      const all = precision.lsrSnapshotAll(db, major);
      const lines = [];
      for (const sym of major) {
        const l = all[sym];
        if (!l) { lines.push(`${sym} —（无数据）`); continue; }
        const f = v => v == null ? '—' : v.toFixed(2);
        const d30 = l.delta_30m == null ? '' : ` · 30m ${l.delta_30m >= 0 ? '+' : ''}${(l.delta_30m * 100).toFixed(2)}%`;
        lines.push(`${sym} 持仓多空 ${f(l.notional_lsr)}｜账户 ${f(l.account_lsr)}｜大户 ${f(l.whale_qty_lsr)}${d30}`);
      }
      const t = store.latestLsr(db, 'trader');
      const arr = (t && t.data && t.data.data ? t.data.data : [])
        .filter(c => { const s = String(c.symbol || '').replace(/USDT$/, ''); return !major.includes(s); })
        .map(c => ({
          sym: String(c.symbol || '').replace(/USDT$/, ''),
          r: Number(c.ratio ?? c.trader_ratio ?? 0),
          usd: (Number(c.long_notional) || 0) + (Number(c.short_notional) || 0),
          traders: Number(c.ov_total_traders || ((Number(c.long_traders) || 0) + (Number(c.short_traders) || 0)))
        }))
        // 2026-10-31：榜单按 delta_2m 排序，前排常是低流动性新币/代币化股票，
        // 极端比值无交易意义。加流动性门槛：双侧名义 ≥$5M 且账户 ≥100。
        .filter(x => x.r > 0 && x.usd >= 5e6 && x.traders >= 100)
        .sort((a, b) => Math.abs(Math.log(b.r)) - Math.abs(Math.log(a.r)))
        .slice(0, 5);
      let alt = '';
      if (arr.length) {
        const rankAge = t && t.ts ? Math.max(0, Math.floor(Date.now() / 1000) - Number(t.ts)) : null;
        const ageTxt = rankAge == null ? '' : (rankAge > 900 ? `，榜单滞后 ${Math.round(rankAge / 60)}min` : `，榜单 ${precision.fmtTime(t.ts)}`);
        alt = `\n▍山寨持仓名义多空极端（Top5，双侧名义≥$5M${ageTxt}）\n` + arr.map(x => `${x.sym} ${x.r.toFixed(2)}（${x.r > 1 ? '多' : '空'}头名义 ${(x.r > 1 ? x.r : 1 / x.r).toFixed(2)}×，$${(x.usd / 1e6).toFixed(0)}M/${x.traders}户）`).join('\n');
      }
      return `${P} 多空比（三口径，${precision.fmtTime(Math.floor(Date.now() / 1000))}）\n${lines.join('\n')}${alt}\n📌 持仓多空=名义价值比（long_notional/short_notional）；账户=多空账户数比；大户=大户持仓量比。三者分歧=结构分歧。`;
    }
    if (cmd.startsWith('/共识')) {
      const cons = store.latestConsensus(db);
      const arr = Array.isArray(cons && cons.data) ? cons.data.slice(0, 8) : [];
      return `${P} KOL共识\n` + (arr.map(c => `${c.display_symbol || c.symbol} ${c.decision_label}(${(c.confidence * 100).toFixed(0)}%)`).join('\n') || '暂无数据');
    }
    if (cmd.startsWith('/简报')) {
      const v = snap.verdict, p = snap.posture;
      return `${P} 每日简报\n${precision.priceLine(db, ['BTC', 'ETH'])}\n姿态 ${p.state}（${p.score}分，已维持${p.days_held}天）\n结论：${v.verdict_zh}\n${v.headline_zh}\n关注：${v.watch_zh}`;
    }
    if (cmd.startsWith('/ask')) {
      const q = cmd.slice(4).trim();
      if (!q) return `${P} 用法：/ask 你的问题`;
      try {
        const ai = require('./ai');
        const r = await ai.chat(env, [
          { role: 'system', content: '你是 William 量化看板 W1 的分析师助手，回答简洁专业，200字以内。' },
          { role: 'user', content: `当前市场快照：${JSON.stringify({ posture: snap.posture.state, score: snap.posture.score, verdict: snap.verdict.verdict })}\n问题：${q}` }
        ], null, 'qq-ask');
        return `${P} AI\n${r.text}`;
      } catch (e) {
        debug('[qq] AI 双key失败:', e.message);
        return `${P} AI 暂不可用（双 key 均失败），当前判断：${snap.verdict.headline_zh}`;
      }
    }
    // v6 新命令：全球资产 / 宏观 / KOL
    if (cmd.startsWith('/资产') || cmd.startsWith('/全球')) {
      try {
        const { buildBoard } = require('./analytics/asset_board');
        const b = buildBoard(db);
        const lines = [];
        const order = ['美股指数', '美股个股', '大宗商品', '加密永续'];
        for (const g of order) {
          const items = (b.groups[g] || []).slice(0, 6);
          if (items.length) lines.push(`▍${g}`);
          for (const it of items) {
            lines.push(`${it.zh} ${it.price}${it.chg != null ? (it.chg >= 0 ? ' +' : ' ') + it.chg.toFixed(2) + '%' : ''}`);
          }
        }
        if (b.riskAppetite) lines.push(`▍风险偏好 ${b.riskAppetite.state}（${b.riskAppetite.score}）`);
        if (b.yieldCurve) lines.push(`▍10Y-3M利差 ${b.yieldCurve.s10_3m}bp${b.yieldCurve.inverted ? ' ⚠️倒挂' : ''}`);
        return `${P} 全球资产\n${lines.join('\n')}`;
      } catch (e) { return `${P} 资产数据暂不可用：${e.message}`; }
    }
    if (cmd.startsWith('/宏观')) {
      try {
        const { buildBoard } = require('./analytics/asset_board');
        const b = buildBoard(db);
        const l = [];
        l.push(`风险偏好: ${b.riskAppetite.state} (${b.riskAppetite.score})`);
        if (b.yieldCurve) l.push(`收益率曲线: 3M ${b.yieldCurve.y3m}% / 10Y ${b.yieldCurve.y10y}% / 10Y-3M ${b.yieldCurve.s10_3m}% ${b.yieldCurve.inverted ? '⚠️倒挂' : ''}`);
        if (b.inflation && b.inflation.oil) l.push(`WTI原油: $${b.inflation.oil.price} (${b.inflation.oil.chg >= 0 ? '+' : ''}${b.inflation.oil.chg.toFixed(2)}%)`);
        if (b.inflation && b.inflation.note) l.push(`铜金比: ${b.inflation.copperGold}（${b.inflation.note}）`);
        if (b.dollar) l.push(`美元指数: ${b.dollar.price} (${b.dollar.chg >= 0 ? '+' : ''}${b.dollar.chg.toFixed(2)}%) ${b.dollar.strong}`);
        return `${P} 宏观仪表盘\n${l.join('\n')}`;
      } catch (e) { return `${P} 宏观数据暂不可用：${e.message}`; }
    }
    if (cmd.startsWith('/kol') || cmd.startsWith('/KOL')) {
      try {
        const kol = require('./kol_watch');
        const sigs = kol.latestSignals(db, 8);
        if (!sigs.length) return `${P} KOL观点\n暂无数据（每小时自动抓取）`;
        const dirIcon = d => d === 'bullish' ? '📈' : d === 'bearish' ? '📉' : '➖';
        return `${P} 全网KOL观点\n` + sigs.map(s => `${dirIcon(s.direction)} ${s.symbol || '—'} ${s.summary || s.content || ''}（${s.author}）`).join('\n');
      } catch (e) { return `${P} KOL 数据暂不可用：${e.message}`; }
    }
    if (cmd.startsWith('/财报')) {
      try {
        const rows = db.prepare('SELECT * FROM earnings WHERE date >= ? ORDER BY date ASC LIMIT 8')
          .all(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
        if (!rows.length) return `${P} 财报日历\n暂无近期财报数据`;
        return `${P} 近期财报\n` + rows.map(r => `${r.date} ${r.symbol} EPS预期${r.eps_est != null ? r.eps_est : '—'}`).join('\n');
      } catch (e) { return `${P} 财报数据暂不可用：${e.message}`; }
    }
    // ═════════ SkyEye v6.0（2026-08-14 升级） ═════════
    if (cmd.startsWith('/天眼') || cmd.startsWith('/sky')) {
      try {
        const sky = require('./skyeye');
        const st = sky.status(db);
        const lines = [];
        lines.push('🚨【W1·SkyEye v6.0】');
        lines.push(`⏱ 上次扫描: ${st.lastScan ? new Date(st.lastScan).toLocaleTimeString('zh-CN',{hour12:false}) : '—'}`);
        lines.push(`🔔 活跃提醒: ${st.activeAlerts} 个`);
        if (st.alerts.length) {
          lines.push('━━━━━━━━━━━━');
          st.alerts.forEach(a => lines.push(`• ${a.symbol} ${a.dir==='down'?'≤':'≥'} $${a.target}（${a.note||''}）`));
        } else {
          lines.push('━━━━━━━━━━━━');
          lines.push('暂无到价提醒，用 `/提醒 BTC 66000` 添加');
        }
        lines.push('💡 自动扫描：价格异动/爆仓风暴/费率极端/FGI突变/因子翻转');
        return lines.join('\n');
      } catch (e) { return `${P} SkyEye状态暂不可用：${e.message}`; }
    }
    if (cmd.startsWith('/提醒') || cmd.startsWith('/alert')) {
      const parts = cmd.split(/\s+/);
      const sym = parts[1] ? parts[1].toUpperCase().replace(/USDT$/,'') : null;
      const target = parts[2] ? Number(parts[2]) : NaN;
      const note = parts.slice(3).join(' ') || '';
      if (!sym || isNaN(target)) return `${P} 用法：/提醒 BTC 66000 备注`;
      try {
        const sky = require('./skyeye');
        const px = sky.latestPrice(db, sym);
        if (px == null) return `${P} 找不到 ${sym} 价格数据（支持 BTC/ETH/SOL/BNB 等）`;
        const dir = target >= px ? 'up' : 'down';
        let list = JSON.parse(require('./db').kvGet(db, 'skyeye:alerts:list', '[]'));
        list = list.filter(a => !(a.symbol===sym && a.target===target));
        list.push({ symbol:sym, target, dir, note, created: Date.now() });
        require('./db').kvSet(db, 'skyeye:alerts:list', JSON.stringify(list));
        return `${P} 🔔 已添加提醒：${sym} ${dir==='up'?'上涨到':'下跌到'} $${target}（当前 $${px}）${note?'｜'+note:''}`;
      } catch (e) { return `${P} 提醒设置失败：${e.message}`; }
    }
    if (cmd.startsWith('/深研') || cmd.startsWith('/deep')) {
      const sym = (cmd.split(/\s+/)[1] || 'BTC').toUpperCase().replace(/USDT$/,'');
      try {
        const ai = require('./ai');
        const qibao = require('./qibao7');
        const qr = await qibao.qibaoReportAsync(db, sym);
        const px = qr.price || '—';
        const chg = qr.chg24 || 0;
        const score = qr.score || 0;
        const factors = (qr.factors || []).slice(0, 7)
          .map(f => `${f.emoji} ${f.name}: ${f.score>0?'▲':f.score<0?'▼':'◆'} ${f.state}`).join('\n');
        const market = `现价 $${px}（${chg>=0?'+':''}${chg.toFixed(2)}%） | 清算技术因子 ${score>=0?'+':''}${score}（${qr.label||''}）`;
        const r = await ai.chat(env, [
          { role: 'system', content: '你是 William 量化看板首席分析师，输出简体中文深度研判，600字内，结构：①核心结论 ②多空逻辑 ③关键位 ④操作建议（含50x仓位档位）。只给信号盘段，不透露策略内部参数。' },
          { role: 'user', content: `标的是 ${sym}。当前市场数据：${market}\n清算技术因子明细：\n${factors}\n请给出深度研究报告。` }
        ], null, 'qq-depth');
        return `${P} 🧠 深度研判 ${sym}\n${r.text}`;
      } catch (e) { return `${P} 深研生成失败：${e.message}`; }
    }
    // ═════════ SmartSignal v1.0（2026-08-14 升级） ═════════
    if (cmd.startsWith('/天机') || cmd.startsWith('/tianji') || cmd.startsWith('/给单') || cmd.startsWith('/smartsignal')) {
      try {
        const tianji = require('./tianji');
        const st = tianji.tianjiStatus(db);
        const lines = [
          '🧠【W1·SmartSignal v1.0】',
          `📈 战绩：${st.total} 单（胜 ${st.win} / 负 ${st.loss} / 持仓 ${st.open}）`,
          `🎯 胜率：${st.winRate != null ? st.winRate + '%' : '—'}`,
          `📅 今日已推：${st.pushedToday} / ${st.dailyLimit} 单`,
          `⏱ 冷却：${st.cooldownH}h/币/方向｜扫描间隔 15min`,
          '━━━━━━━━━━━━',
          '💡 Five-Dimension Auto-Signal: News × Technical × Funding × KOL × Qibao',
          '🤖 AI审查一票否决 + FGI/体制/事件三重门控',
        ];
        return lines.join('\n');
      } catch (e) { return `${P} SmartSignal状态暂不可用：${e.message}`; }
    }
    if (cmd.startsWith('/天机扫描') || cmd.startsWith('/tianji scan') || cmd.startsWith('/smartsignal scan')) {
      try {
        const tianji = require('./tianji');
        const r = await tianji.tianjiScan({ env, db }, { force: true });
        if (r.skipped) return `${P} SmartSignal扫描：${r.reason === 'daily_limit' ? '今日已达上限' : r.reason === 'no_signal' ? '当前无优质信号（宁缺毋滥）' : '暂无数据'}`;
        return `${P} SmartSignal扫描完成：扫描${r.scanned}币，候选${r.candidates}个，推送${r.pushed}单`;
      } catch (e) { return `${P} SmartSignal扫描失败：${e.message}`; }
    }
    return `${P} 支持命令：/行情 /费率 /多空 /共识 /简报 /资产 /宏观 /kol /财报 /ask 问题 /天眼 /提醒 /深研`;
  }


function registerQQ(app, ctx) {
  const { env, db } = ctx;
  let keys = null;
  try { keys = deriveKeys(env.QQ_APPSECRET || ''); } catch (e) { error('[qq] key derive failed:', e.message); }


  app.post('/qq/callback', (req, res) => {
    const sig = req.headers['x-signature-ed25519'];
    const ts = req.headers['x-signature-timestamp'];
    if (!keys || !sig || !ts || !verifySignature(keys.publicKey, sig, ts, req.rawBody || '')) {
      return res.status(401).json({ ok: false, error: 'bad_signature' });
    }
    let body;
    try { body = JSON.parse(req.rawBody || '{}'); } catch (e) { debug('[qq] body parse:', e.message); return res.status(400).json({ ok: false }); }

    // op 13：回调地址验证
    if (body.op === 13 && body.d) {
      const signature = sign(keys.privateKey, String(body.d.event_ts) + String(body.d.plain_token));
      return res.json({ plain_token: body.d.plain_token, signature });
    }
    // op 0：事件分发 —— 消息回复已移交云端 OpenClaw（qqbot 插件），此处只回 200 不处理
    if (body.op === 0 && body.d) {
      res.json({ ok: true });
      return;
    }
    res.json({ ok: true });
  });
}

module.exports = { registerQQ, pushToGroup, pushToGroupType, deriveKeys, verifySignature, sign, getAccessToken, sendGroupMessage, buildReply };
