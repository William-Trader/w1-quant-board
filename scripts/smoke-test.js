'use strict';
// SMOKE 冒烟测试：不起真实采集（SMOKE=1 跳过 cron 与外部请求，用假数据）
// 检查：路由注册数 / 库表创建 / verdict 引擎输出结构 / 认证流程 / version 指纹 / 权限拦截
process.env.SMOKE = '1';
process.env.PORT = process.env.SMOKE_PORT || '3391';
// 确保密钥环境存在（避免依赖外部 .env）
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'smoke-admin-pass';
process.env.COINGLASS_API_KEY = process.env.COINGLASS_API_KEY || 'cg_smoke_key';
process.env.QQ_APPSECRET = process.env.QQ_APPSECRET || 'smoke-secret-seed-0123456789';
process.env.DEEPSEEK_KEY_A = process.env.DEEPSEEK_KEY_A || '';
process.env.DEEPSEEK_KEY_B = process.env.DEEPSEEK_KEY_B || '';

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0, fail = 0, total = 0;
const fails = [];
function check(name, cond, extra) {
  total++;
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

async function req(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (opts.cookie) headers.Cookie = opts.cookie;
  const r = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data, setCookie: r.headers.get('set-cookie') || '' };
}

(async () => {
  const { app, ctx } = require('../server');
  const server = app.listen(Number(process.env.PORT), '127.0.0.1');
  await new Promise(r => server.on('listening', r));

  console.log('== W1 smoke test ==');

  // 1. 路由注册数
  let routeCount = 0;
  for (const layer of app._router.stack) {
    if (layer.route) routeCount += Object.keys(layer.route.methods).length;
  }
  check('路由注册数 >= 25', routeCount >= 25, `got ${routeCount}`);

  // 2. 库表创建
  const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const needTables = ['prices', 'futures_markets', 'lsr_rankings', 'funding_arb', 'consensus', 'fear_greed', 'openclue_archive', 'verdict_daily', 'source_health', 'users', 'sessions', 'kv'];
  check('库表创建 12 张', needTables.every(t => tables.includes(t)), tables.join(','));
  const wal = ctx.db.pragma('journal_mode', { simple: true });
  check('WAL 模式', String(wal).toLowerCase() === 'wal', String(wal));

  // 3. verdict 引擎输出结构
  const engine = require('../lib/verdict');
  const posture = engine.computePosture({ fgi: 30, dvol: 5, funding_avg: 0.0001, etf_recent3_musd: -100, lsr_trader_skew: 0.1, consensus_bias: -0.05 }, 3);
  check('posture 结构', posture && typeof posture.score === 'number' && posture.score >= -5 && posture.score <= 5
    && ['aggressive', 'neutral', 'defensive'].includes(posture.state)
    && Array.isArray(posture.factors) && posture.factors.length === 11
    && posture.conviction && posture.flip_trigger_zh && posture.days_held === 3);
  const st = engine.computeStance('BTC', { price_24h: 2, funding: -0.0001, trader_ratio: 1.2, whale_ratio: 1.1 });
  check('stance 结构', st && ['bullish', 'cautiously_bullish', 'neutral', 'cautiously_bearish', 'bearish'].includes(st.stance)
    && st.confidence >= 0 && st.confidence <= 1 && !!st.headline_zh);
  const verd = engine.synthesizeVerdict(posture, [st], null, null);
  check('verdict 结构', verd && ['cautious', 'risk_on', 'risk_off', 'neutral'].includes(verd.verdict) && !!verd.rationale_zh && !!verd.watch_zh);
  const cd = engine.computeCountdown(posture, [st]);
  check('countdown 结构', cd && Array.isArray(cd.conditions) && cd.conditions.length >= 4 && cd.conditions.every(c => c.progress >= 0 && c.progress <= 1));
  const snap = ctx.db && require('../lib/collectors').buildEngineSnapshot(ctx);
  check('buildEngineSnapshot', snap && snap.posture && snap.stances.length === 8 && snap.verdict && snap.countdown);

  // 4. /api/version 指纹
  const v = await req('/api/version');
  check('version 指纹', v.status === 200 && v.data.ok && v.data.name === 'william-quant-board-w1' && v.data.version === '5.0.0');
  check('version.dashboard_html 指纹字段', v.data.dashboard_html && typeof v.data.dashboard_html.bytes === 'number'
    && /^[0-9a-f]{16}$/.test(v.data.dashboard_html.sha256_16 || '') && typeof v.data.dashboard_html.is_full_terminal === 'boolean');

  // 5. 权限拦截：未登录访问 /api/member/* → 401 {need_login:true}
  const m1 = await req('/api/member/lsr');
  check('会员路由未登录 401 need_login', m1.status === 401 && m1.data && m1.data.need_login === true);
  const m2 = await req('/api/member/countdown');
  check('member/countdown 未登录拦截', m2.status === 401 && m2.data.need_login === true);

  // 6. 认证流程
  const uname = 'smoke_user_' + Date.now().toString(36);
  const reg = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname, password: 'smoke123456' }) });
  check('注册 → pending', reg.status === 200 && reg.data.ok && reg.data.status === 'pending');
  const loginPending = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: 'smoke123456' }) });
  check('未审批登录被拒 403', loginPending.status === 403 && loginPending.data.error === 'pending_approval');
  // 强制审批（模拟管理员）
  const uid = reg.data.id;
  ctx.db.prepare("UPDATE users SET status='approved', approved_at=? WHERE id=?").run(Date.now(), uid);
  const login = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname, password: 'smoke123456' }) });
  check('审批后登录成功 + httpOnly cookie', login.status === 200 && login.data.ok && /HttpOnly/i.test(login.setCookie));
  const cookie = (login.setCookie.split(';')[0] || '');
  const me = await req('/api/auth/me', { cookie });
  check('auth/me 返回用户且无哈希泄露', me.data.ok && me.data.user && me.data.user.username === uname && !('password_hash' in me.data.user) && !JSON.stringify(me.data).includes('$2'));
  const mlsr = await req('/api/member/lsr', { cookie });
  check('会员API通 /api/member/lsr', mlsr.status === 200 && mlsr.data.ok && Array.isArray(mlsr.data.trader) && Array.isArray(mlsr.data.whale));
  const mday = await req('/api/member/ai-daily', { cookie });
  check('会员API通 /api/member/ai-daily', mday.status === 200 && mday.data.ok && Array.isArray(mday.data.days));
  const logout = await req('/api/auth/logout', { method: 'POST', body: '{}', cookie });
  const mAfter = await req('/api/member/lsr', { cookie });
  check('登出后会话失效', logout.data.ok && mAfter.status === 401);

  // 7. 后台流程
  const badAdmin = await req('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  check('错误管理密码拒绝', badAdmin.status === 401);
  const adLogin = await req('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
  check('管理员登录', adLogin.status === 200 && adLogin.data.ok);
  const adCookie = (adLogin.setCookie.split(';')[0] || '');
  const users = await req('/api/admin/users?status=approved', { cookie: adCookie });
  check('后台用户列表（无哈希）', users.data.ok && users.data.users.length >= 1 && !JSON.stringify(users.data).includes('$2'));
  const health = await req('/api/admin/health', { cookie: adCookie });
  check('后台健康表', health.data.ok && Array.isArray(health.data.latest_by_source) && health.data.cg_key && health.data.cg_key.masked.includes('...'));
  const trig = await req('/api/admin/trigger/daily-verdict', { method: 'POST', body: '{}', cookie: adCookie });
  check('手动触发采集(daily-verdict)', trig.data.ok === true && typeof trig.data.success === 'boolean');
  const rejectFlow = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: uname + '_r', password: 'smoke123456' }) });
  const rid = rejectFlow.data.id;
  const rej = await req(`/api/admin/users/${rid}/reject`, { method: 'POST', body: '{}', cookie: adCookie });
  const rejLogin = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: uname + '_r', password: 'smoke123456' }) });
  check('拒绝后登录被拒', rej.data.ok && rejLogin.status === 403 && rejLogin.data.error === 'rejected');
  const del = await req(`/api/admin/users/${rid}/delete`, { method: 'POST', body: '{}', cookie: adCookie });
  check('删除用户', del.data.ok === true);

  // 8. 公开 API 结构
  for (const [p, key] of [['/api/overview', 'verdict'], ['/api/coins', 'coins'], ['/api/fear-greed', 'series'], ['/api/markets', 'spot'], ['/api/openclue', 'official'], ['/api/glossary', 'terms'], ['/api/etf-flows', 'based_on']]) {
    const r = await req(p);
    check(`公开路由 ${p}`, r.status === 200 && r.data.ok === true && r.data[key] !== undefined);
  }
  const gloss = await req('/api/glossary');
  check('词典 ≥30 术语', gloss.data.terms.length >= 30, String(gloss.data.terms.length));
  const ov = await req('/api/overview');
  check('overview 含 data_ts+stale', 'data_ts' in ov.data && 'stale' in ov.data && 'posture' in ov.data && 'hero_brief' in ov.data);

  // 9. QQ 验签（坏签名必须 401）
  const qqBad = await fetch(BASE + '/qq/callback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': '1' }, body: '{}' });
  check('QQ 坏签名 401', qqBad.status === 401);

  // 10. Coinglass 客户端重试/判定单测（假 fetch）
  const { CoinglassClient } = require('../lib/coinglass');
  {
    const cg = new CoinglassClient({ COINGLASS_BASE: 'https://x.test', COINGLASS_API_KEY: 'cg_test_1234567890abcd' }, ctx.db);
    check('key 脱敏', cg.maskedKey() === 'cg_tes...abcd', cg.maskedKey());
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { calls++; return new Response(JSON.stringify({ code: '0', data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const r1 = await cg.request('/api/futures/coins-markets?per_page=1');
    check('CG 业务判定 code==="0"', r1.ok === true && r1.businessOk === true);
    global.fetch = async () => new Response(JSON.stringify({ code: '400', msg: 'x' }), { status: 200 });
    const r2 = await cg.request('/api/futures/coins-markets?per_page=1');
    check('CG 业务失败判定', r2.ok === false);
    global.fetch = async () => { calls++; return new Response('{}', { status: 404 }); };
    calls = 0;
    await cg.request('/api/futures/x');
    check('404 不重试', calls === 1, `calls=${calls}`);
    global.fetch = async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    const r3 = await cg.request('/api/lsr/v2/status');
    check('LSR 业务判定 success!==false', r3.ok === true);
    // 401 冷却
    global.fetch = async () => new Response('{}', { status: 401 });
    const r4 = await cg.request('/api/futures/x');
    check('401 标记冷却', r4.status === 401 && cg.isKeyCoolingDown());
    global.fetch = realFetch;
  }

  server.close();
  console.log(`\n== ${pass}/${total} PASS${fail ? ` · FAIL: ${fails.join(', ')}` : ''} ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SMOKE FATAL', e); process.exit(1); });
