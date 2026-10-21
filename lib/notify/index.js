'use strict';
// 通知工程层：统一适配 Telegram / Discord / Slack / Webhook / QQ。
// 默认 dry-run，不发起真实网络请求；配置齐全且 NOTIFY_LIVE=1 才真实发送。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'notify.json');

function loadConfig() {
  const file = process.env.NOTIFY_CONFIG || DEFAULT_CONFIG;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { channels: {} }; }
}
function resolveChannel(ch) {
  const out = Object.assign({}, ch);
  for (const [k, v] of Object.entries(ch || {})) {
    if (typeof v === 'string' && v.startsWith('env:')) out[k] = process.env[v.slice(4)] || null;
  }
  if (ch && ch.token_env) out.token = process.env[ch.token_env] || null;
  if (ch && ch.chat_id_env) out.chat_id = process.env[ch.chat_id_env] || null;
  if (ch && ch.webhook_env) out.webhook = process.env[ch.webhook_env] || null;
  if (ch && ch.url_env) out.url = process.env[ch.url_env] || null;
  return out;
}
function channels() {
  const cfg = loadConfig();
  return Object.entries(cfg.channels || {}).map(([name, ch]) => {
    const c = resolveChannel(ch);
    return {
      name, type: ch.type, enabled: ch.enabled !== false,
      configured: !!(c.token || c.webhook || c.url),
      secrets: false
    };
  });
}
function buildPayload(type, text, meta) {
  switch (type) {
    case 'telegram':
      return { method: 'POST', url: 'https://api.telegram.org/bot<token>/sendMessage', body: { chat_id: '<chat_id>', text, parse_mode: 'HTML', disable_web_page_preview: true } };
    case 'discord':
      return { method: 'POST', url: '<webhook>', body: { content: text, allowed_mentions: { parse: [] } } };
    case 'slack':
      return { method: 'POST', url: '<webhook>', body: { text } };
    case 'webhook':
      return { method: 'POST', url: '<url>', body: { text, meta: meta || {} } };
    case 'qq':
      return { method: 'internal', url: 'qqbot:pushToGroup', body: { text, type: 'monitor' } };
    default:
      return { method: 'POST', url: '', body: { text, meta: meta || {} } };
  }
}
async function send(opts) {
  const cfg = loadConfig();
  const name = opts.channel;
  const raw = cfg.channels && cfg.channels[name];
  if (!raw) return { ok: false, error: 'unknown_channel', channel: name };
  if (raw.enabled === false) return { ok: false, error: 'disabled', channel: name };
  const c = resolveChannel(raw);
  const type = raw.type;
  const payload = buildPayload(type, opts.text, opts.meta);
  const dryRun = opts.dryRun !== false && process.env.NOTIFY_LIVE !== '1';
  if (dryRun) return { ok: true, dryRun: true, channel: name, type, payload };

  if (type === 'qq') {
    return { ok: false, error: 'qq_requires_internal_context', channel: name };
  }
  let url = null;
  if (type === 'telegram') url = c.token ? 'https://api.telegram.org/bot' + c.token + '/sendMessage' : null;
  else if (type === 'discord' || type === 'slack' || type === 'webhook') url = c.webhook || c.url;
  if (!url) return { ok: false, error: 'not_configured', channel: name };
  const body = type === 'telegram' ? Object.assign({}, payload.body, { chat_id: c.chat_id }) : payload.body;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { ok: r.ok, status: r.status, channel: name, type };
  } catch (e) {
    return { ok: false, error: e.message, channel: name, type };
  }
}
module.exports = { loadConfig, channels, buildPayload, send };
