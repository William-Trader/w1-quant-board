'use strict';
const { warn } = require('./log');
// DeepSeek 双 key 故障转移。任何 AI 故障都不能拖垮系统 —— 调用方负责兜底模板。
async function chatOnce(base, model, key, messages, timeoutMs = 30000) {
  // 2026-09-07 4核优化: reasoner 模型 chain-of-thought 长，默认 30s 常超时→hero_brief/分析退模板。非reasoner保持30s，reasoner放宽到90s。
  if (String(model).includes('reasoner')) timeoutMs = Math.max(timeoutMs, 90000);
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
    const usage = (data && data.usage) || null;
    return { text, usage };
  } finally {
    clearTimeout(timer);
  }
}

const mask = k => (k && k.length > 12 ? `${k.slice(0, 5)}...${k.slice(-4)}` : '(none)');

/**
 * @param {string} [tag] 调用方标签（如 'verdict'/'hero-brief'/'tianji'/'advisor'），用于 token 用量归因
 * @returns {Promise<{text, source}>} source: 'deepseek-a'|'deepseek-b'，全挂时抛错由调用方兜底
 */
async function chat(env, messages, modelOverride, tag) {
  const base = env.DEEPSEEK_BASE || 'https://api.deepseek.com';
  const model = modelOverride || env.DEEPSEEK_MODEL || 'deepseek-reasoner';
  const keys = [
    ['deepseek-a', env.DEEPSEEK_KEY_A],
    ['deepseek-b', env.DEEPSEEK_KEY_B]
  ].filter(([, k]) => k);
  let lastErr = null;
  // 估算输入 token（若上游未返回 usage，作为兜底：中文约 1.5 字/token）
  const estIn = messages.reduce((s, m) => s + String(m.content || '').length, 0);
  for (const [name, key] of keys) {
    try {
      const r = await chatOnce(base, model, key, messages);
      recordUsage(env, model, tag, r.usage, estIn);
      return { text: r.text, source: name };
    } catch (e) {
      lastErr = e;
      warn(`[ai] ${name} (${mask(key)}) failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('no_ai_key');
}

// ---- token 用量记账（追加到 data/ai_usage.csv，便于每日汇总） ----
const fs = require('fs');
const path = require('path');
function recordUsage(env, model, tag, usage, estInChars) {
  try {
    const file = path.join(__dirname, '..', 'data', 'ai_usage.csv');
    const pt = (usage && usage.prompt_tokens) ? usage.prompt_tokens : Math.round(estInChars / 1.5);
    const ct = (usage && usage.completion_tokens) ? usage.completion_tokens : 0;
    const rct = (usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : 0;
    const line = [Date.now(), new Date().toISOString(), model, tag || 'unknown', pt, ct, rct].join(',');
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (e) { /* 计量失败不影响主流程 */ }
}

module.exports = { chat };
