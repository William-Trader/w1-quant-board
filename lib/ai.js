'use strict';
const { warn } = require('./log');
// DeepSeek 双 key 故障转移。任何 AI 故障都不能拖垮系统 —— 调用方负责兜底模板。
async function chatOnce(base, model, key, messages, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const isReasoner = String(model).includes('reasoner');
    const res = await fetch(base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(isReasoner
        ? { model, messages, max_tokens: 8000 }
        : { model, messages, temperature: 0.4, max_tokens: 1200 }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('empty_completion');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

const mask = k => (k && k.length > 12 ? `${k.slice(0, 5)}...${k.slice(-4)}` : '(none)');

/**
 * @returns {Promise<{text, source}>} source: 'deepseek-a'|'deepseek-b'，全挂时抛错由调用方兜底
 */
async function chat(env, messages, modelOverride) {
  const base = env.DEEPSEEK_BASE || 'https://api.deepseek.com';
  const model = modelOverride || env.DEEPSEEK_MODEL || 'deepseek-chat';
  const keys = [
    ['deepseek-a', env.DEEPSEEK_KEY_A],
    ['deepseek-b', env.DEEPSEEK_KEY_B]
  ].filter(([, k]) => k);
  let lastErr = null;
  for (const [name, key] of keys) {
    try {
      const text = await chatOnce(base, model, key, messages);
      return { text, source: name };
    } catch (e) {
      lastErr = e;
      warn(`[ai] ${name} (${mask(key)}) failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('no_ai_key');
}

module.exports = { chat };
