'use strict';
const { error, warn } = require('./log');
// Coinglass / LSR 统一封装
// 规范要点（手册 V3）：
//  - 认证头 X-API-Key，严禁放进 URL / 日志（日志只显示 前6...后4）
//  - 只 GET；超时 8s（AbortController）
//  - 429 按 Retry-After 最多重试 2 次
//  - 502/503/504/网络错误 指数退避 1s→2s→4s 加 ±20% 抖动，最多重试 3 次
//  - 400/401/404/405 不重试；401 触发 key 失效标记 + 冷却 10 分钟
//  - 业务判定：Coinglass 路由 code==="0"；LSR 路由 success!==false
//  - V2 ranking 支持 ETag/If-None-Match/304 复用缓存
const { kvGet, kvSet } = require('./db');

const KEY_COOLDOWN_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

function maskKey(key) {
  if (!key || key.length < 12) return '(no-key)';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(base) {
  const delta = base * 0.2;
  return Math.round(base - delta + Math.random() * delta * 2);
}

class CoinglassClient {
  constructor(env, db) {
    this.base = (env.COINGLASS_BASE || 'https://api.coinglass.site').replace(/\/+$/, '');
    this.key = env.COINGLASS_API_KEY || '';
    this.db = db;
    this.etagCache = new Map(); // path -> {etag, body, ts}
    // 全局串行节流（2026-08-13 修复：5min cron 并发多个接口打爆上游 429）
    this._chain = Promise.resolve();
    this._lastReq = 0;
    this._minGapMs = 400; // 同一时刻只发一个请求，间隔≥400ms
  }

  /** 串行化 + 最小间隔：排队等待上一个请求完成并间隔 minGap */
  _throttle(fn) {
    const run = async () => {
      const wait = Math.max(0, this._lastReq + this._minGapMs - Date.now());
      if (wait > 0) await sleep(wait);
      this._lastReq = Date.now();
      return fn();
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {}); // 不阻塞后续
    return p;
  }

  maskedKey() { return maskKey(this.key); }

  keyInvalidUntil() {
    return kvGet(this.db, 'cg_key_invalid_until', 0) || 0;
  }
  isKeyCoolingDown() {
    return Date.now() < this.keyInvalidUntil();
  }
  markKeyInvalid() {
    const until = Date.now() + KEY_COOLDOWN_MS;
    kvSet(this.db, 'cg_key_invalid_until', until);
    error(`[coinglass] 401 received, key ${this.maskedKey()} marked invalid, cooldown until ${new Date(until).toISOString()}`);
  }

  /**
   * @returns {Promise<{ok,status,data,fromCache,etag,ms,error,businessOk}>}
   */
  async request(path, opts = {}) {
    return this._throttle(() => this._request(path, opts));
  }

  async _request(path, opts = {}) {
    const started = Date.now();
    const url = this.base + path;
    const isLsr = path.startsWith('/api/lsr');
    const useEtag = opts.etag !== false && path.startsWith('/api/lsr/ranking');
    const cached = useEtag ? this.etagCache.get(path) : null;

    if (this.isKeyCoolingDown()) {
      return { ok: false, status: 0, data: null, fromCache: false, ms: 0, error: 'key_cooldown', businessOk: false };
    }

    let attempt = 0;
    let retries429 = 0;
    let retries5xx = 0;
    let lastErr = null;

    while (true) {
      attempt++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const headers = { 'X-API-Key': this.key, 'Accept': 'application/json' };
      if (useEtag && cached && cached.etag) headers['If-None-Match'] = cached.etag;
      let res, bodyText;
      try {
        res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal, redirect: 'manual' });
        bodyText = await res.text();
      } catch (e) {
        clearTimeout(timer);
        lastErr = e.name === 'AbortError' ? 'timeout_8s' : `network:${e.message}`;
        if (retries5xx < 3) {
          const wait = jitter([1000, 2000, 4000][retries5xx] || 4000);
          retries5xx++;
          warn(`[coinglass] ${lastErr} on ${path}, retry ${retries5xx}/3 in ${wait}ms`);
          await sleep(wait);
          continue;
        }
        return { ok: false, status: 0, data: null, fromCache: false, ms: Date.now() - started, error: lastErr, businessOk: false };
      }
      clearTimeout(timer);
      const status = res.status;

      if (status === 304 && useEtag && cached) {
        return { ok: true, status: 304, data: cached.body, fromCache: true, etag: cached.etag, ms: Date.now() - started, error: null, businessOk: true };
      }
      if (status === 429) {
        if (retries429 < 2) {
          retries429++;
          const ra = parseInt(res.headers.get('retry-after') || '2', 10);
          const wait = Math.min(Math.max(ra, 1), 30) * 1000;
          warn(`[coinglass] 429 on ${path}, Retry-After ${ra}s, retry ${retries429}/2`);
          await sleep(wait);
          continue;
        }
        return { ok: false, status, data: null, fromCache: false, ms: Date.now() - started, error: 'rate_limited', businessOk: false };
      }
      if (status === 502 || status === 503 || status === 504) {
        if (retries5xx < 3) {
          const wait = jitter([1000, 2000, 4000][retries5xx] || 4000);
          retries5xx++;
          warn(`[coinglass] ${status} on ${path}, retry ${retries5xx}/3 in ${wait}ms`);
          await sleep(wait);
          continue;
        }
        return { ok: false, status, data: null, fromCache: false, ms: Date.now() - started, error: `http_${status}`, businessOk: false };
      }
      if (status === 401) {
        this.markKeyInvalid();
        return { ok: false, status, data: null, fromCache: false, ms: Date.now() - started, error: 'unauthorized_401', businessOk: false };
      }
      if (status === 400 || status === 404 || status === 405) {
        return { ok: false, status, data: null, fromCache: false, ms: Date.now() - started, error: `http_${status}_no_retry`, businessOk: false };
      }
      if (status !== 200) {
        return { ok: false, status, data: null, fromCache: false, ms: Date.now() - started, error: `http_${status}`, businessOk: false };
      }

      let data;
      try { data = JSON.parse(bodyText); } catch (e) {
        return { ok: false, status, data: null, fromCache: false, ms: Date.now() - started, error: 'bad_json', businessOk: false };
      }
      // 业务判定
      let businessOk;
      if (isLsr) businessOk = data && data.success !== false;
      else businessOk = data && String(data.code) === '0';

      // 业务层 429（上游以 HTTP 200 + code"429" 限流）：按 429 规则有限重试
      if (!businessOk && !isLsr && String(data && data.code) === '429') {
        if (retries429 < 2) {
          retries429++;
          const ra = parseInt(res.headers.get('retry-after') || '3', 10);
          const wait = Math.min(Math.max(ra, 1), 30) * 1000;
          warn(`[coinglass] business-429 on ${path}, retry ${retries429}/2 in ${wait}ms`);
          await sleep(wait);
          continue;
        }
        return { ok: false, status, data, fromCache: false, ms: Date.now() - started, error: 'business_rate_limited', businessOk: false };
      }

      if (useEtag && businessOk) {
        const etag = res.headers.get('etag');
        if (etag) this.etagCache.set(path, { etag, body: data, ts: Date.now() });
      }
      return {
        ok: businessOk, status, data, fromCache: false,
        etag: res.headers.get('etag'), ms: Date.now() - started,
        error: businessOk ? null : `business_fail(code=${data && data.code},success=${data && data.success})`,
        businessOk
      };
    }
  }
}

module.exports = { CoinglassClient, maskKey };
