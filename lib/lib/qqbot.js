'use strict';
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
  } catch { return false; }
}

function sign(privateKey, message) {
  return Buffer.from(nacl.sign.detached(Buffer.from(message, 'utf8'), privateKey)).toString('hex');
}

/* ---------- access token 缓存 ---------- */
let tokenCache = { token: null, expiresAt: 0 };
async function getAccessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let r;
  try { r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    signal: ctrl.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: env.QQ_APPID, clientSecret: env.QQ_APPSECRET })
  }); } finally { clearTimeout(timer); }
  const data = await r.json();
  if (!data.access_token) throw new Error('qq_token_fail:' + JSON.stringify(data).slice(0, 120));
  tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

async function sendGroupMessage(env, groupOpenid, content, msgId) {
  const token = await getAccessToken(env);
  const body = { content, msg_type: 0 };
  if (msgId) body.msg_id = msgId;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let r;
  try { r = await fetch(`https://api.sgroup.qq.com/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    signal: ctrl.signal,
    headers: { 'Authorization': `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }); } finally { clearTimeout(timer); }
  return r.status;
}

/* 主动推送：QQ_GROUP_OPENID 为空 → 静默跳过并记日志 */
async function pushToGroup(env, db, content) {
  const gid = (env.QQ_GROUP_OPENID || '').trim();
  if (!gid) {
    console.log('[qq] QQ_GROUP_OPENID 为空，主动推送静默跳过:', String(content).slice(0, 60));
    if (db) db.prepare('INSERT INTO source_health(source,ok,ms,detail,ts) VALUES(?,?,?,?,?)')
      .run('qq_push_skip', 1, 0, 'GROUP_OPENID empty, skipped: ' + String(content).slice(0, 80), Math.floor(Date.now() / 1000));
    return false;
  }
  try {
    const status = await sendGroupMessage(env, gid, content, null);
    if (db) db.prepare('INSERT INTO source_health(source,ok,ms,detail,ts) VALUES(?,?,?,?,?)')
      .run('qq_push', status < 300 ? 1 : 0, 0, `status=${status}`, Math.floor(Date.now() / 1000));
    return status < 300;
  } catch (e) {
    console.warn('[qq] push failed:', e.message);
    return false;
  }
}




function registerQQ(app, ctx) {
  const { env, db } = ctx;
  let keys = null;
  try { keys = deriveKeys(env.QQ_APPSECRET || ''); } catch (e) { console.error('[qq] key derive failed:', e.message); }


  app.post('/qq/callback', (req, res) => {
    const sig = req.headers['x-signature-ed25519'];
    const ts = req.headers['x-signature-timestamp'];
    if (!keys || !sig || !ts || !verifySignature(keys.publicKey, sig, ts, req.rawBody || '')) {
      return res.status(401).json({ ok: false, error: 'bad_signature' });
    }
    let body;
    try { body = JSON.parse(req.rawBody || '{}'); } catch { return res.status(400).json({ ok: false }); }

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

module.exports = { registerQQ, pushToGroup, deriveKeys, verifySignature, sign, getAccessToken, sendGroupMessage };
