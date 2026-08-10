// lib/qq_ws.js — QQ 机器人 WebSocket 长连接接入（替代/补充 Webhook）
// 协议: wss 网关 → op10 Hello → op2 Identify → 心跳 op1 → op0 事件分发 → 断线重连/resume
'use strict';
const WebSocket = require('ws');
const { getAccessToken, sendGroupMessage, buildReply } = require('./qqbot');

let ws = null, heartbeatTimer = null, reconnectTimer = null;
let sessionId = null, lastSeq = null;
let stopped = false;

const INTENTS_GROUP = 1 << 25; // GROUP_AND_C2C_EVENT（群消息/单聊/好友）

async function getGatewayUrl(env) {
  const token = await getAccessToken(env);
  const r = await fetch('https://api.sgroup.qq.com/gateway', {
    headers: { Authorization: `QQBot ${token}` }
  });
  if (!r.ok) throw new Error('gateway http ' + r.status);
  const d = await r.json();
  if (!d.url) throw new Error('gateway no url: ' + JSON.stringify(d).slice(0, 120));
  return d.url;
}

async function handleDispatch(env, db, payload) {
  try {
    const d = payload.d || {};
    const t = payload.t || '';
    if (t === 'READY') {
      sessionId = d.session_id || null;
      console.log('[qqws] READY session=' + sessionId + ' bot=' + (d.user ? d.user.username : '?'));
      return;
    }
    if (t === 'RESUMED') { console.log('[qqws] RESUMED'); return; }
    if ((t === 'GROUP_AT_MESSAGE_CREATE' || t === 'C2C_MESSAGE_CREATE') && d.content) {
      const reply = await buildReply(String(d.content).replace(/<@[^>]+>/g, '').trim(), { env, db });
      if (t === 'GROUP_AT_MESSAGE_CREATE' && d.group_openid) {
        await sendGroupMessage(env, d.group_openid, reply, d.id);
        console.log('[qqws] 回复群消息 ' + d.group_openid.slice(0, 8) + '...');
      } else if (t === 'C2C_MESSAGE_CREATE' && d.author && d.author.user_openid) {
        // C2C 回复
        const r = await fetch(`https://api.sgroup.qq.com/v2/users/${d.author.user_openid}/messages`, {
          method: 'POST',
          headers: { Authorization: `QQBot ${await getAccessToken(env)}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: reply, msg_type: 0, msg_id: d.id })
        });
        console.log('[qqws] C2C 回复 status=' + r.status);
      }
    }
  } catch (e) { console.warn('[qqws] dispatch error:', e.message); }
}

function startHeartbeat(intervalMs) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: 1, d: lastSeq || null }));
    }
  }, intervalMs);
  console.log('[qqws] 心跳启动 interval=' + intervalMs + 'ms');
}

async function connect(ctx) {
  if (stopped) return;
  const { env, db } = ctx;
  try {
    const url = await getGatewayUrl(env);
    console.log('[qqws] 连接网关 ' + url);
    ws = new WebSocket(url);
    ws.on('open', () => console.log('[qqws] 已建立连接'));
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.s != null) lastSeq = msg.s;
      switch (msg.op) {
        case 10: // Hello
          startHeartbeat(msg.d.heartbeat_interval || 45000);
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${await getAccessToken(env)}`,
              intents: INTENTS_GROUP,
              shard: [0, 1],
              properties: { $os: 'linux', $browser: 'w1-board', $device: 'w1-board' }
            }
          }));
          break;
        case 0: await handleDispatch(env, db, msg); break;
        case 7: console.log('[qqws] 服务端要求重连'); ws.close(); break;
        case 9: console.log('[qqws] Invalid Session，重新 Identify'); break;
        case 11: break; // heartbeat ack
        default: break;
      }
    });
    ws.on('close', () => {
      console.log('[qqws] 连接断开，5s 后重连');
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (!stopped) reconnectTimer = setTimeout(() => connect(ctx), 5000);
    });
    ws.on('error', (e) => console.warn('[qqws] error:', e.message));
  } catch (e) {
    console.warn('[qqws] 连接失败:', e.message, '30s 后重试');
    if (!stopped) reconnectTimer = setTimeout(() => connect(ctx), 30000);
  }
}

function stop() {
  stopped = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) try { ws.close(); } catch {}
  console.log('[qqws] 已停止');
}

module.exports = { connect, stop };
