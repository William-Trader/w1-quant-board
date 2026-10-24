'use strict';
// Coinglass 云端自我修复 + 自我优化（2026-10-25）
// - key 冷却中时直连 /api/gateway/account 探活；若账号正常则清除 401 冷却（续费后自恢复）
// - 汇总最近 30 分钟 cg_/lsr 源健康，输出失败源供日志/告警消费
// - 不修改采集逻辑，只读探活 + 清除冷却标记
const { loadEnv } = require('../lib/env');
const { openDb, kvGet, kvSet } = require('../lib/db');
const { CoinglassClient } = require('../lib/coinglass');

(async () => {
  const env = loadEnv();
  const db = openDb(env);
  const cg = new CoinglassClient(env, db);
  const out = { ts: new Date().toISOString(), base: cg.base.replace(/^https:\/\//, ''), rpm: cg.rpm, key_cooling: false, account_ok: null, cleared: false, sources_fail: [] };

  const until = Number(kvGet(db, 'cg_key_invalid_until', 0) || 0);
  out.key_cooling = Date.now() < until;

  if (out.key_cooling) {
    try {
      const url = cg.base + '/api/gateway/account';
      const res = await fetch(url, { method: 'GET', headers: { 'X-API-Key': cg.key, 'Accept': 'application/json' }, signal: AbortSignal.timeout(12000) });
      const j = await res.json().catch(() => null);
      out.account_ok = res.ok && j && String(j.code) === '0';
      if (out.account_ok) {
        kvSet(db, 'cg_key_invalid_until', 0);
        out.cleared = true;
        console.log('[selfheal] key 冷却已清除（账号探活正常）');
      } else {
        console.log('[selfheal] key 冷却保持（账号探活失败 http ' + res.status + '）');
      }
    } catch (e) {
      out.account_ok = false;
      console.log('[selfheal] 账号探活异常: ' + e.message);
    }
  } else {
    out.account_ok = true;
  }

  const since = Math.floor(Date.now() / 1000) - 1800;
  const rows = db.prepare("SELECT source, COUNT(*) n, SUM(ok) ok FROM source_health WHERE ts>=? AND (source LIKE 'cg_%' OR source LIKE 'lsr%') GROUP BY source").all(since);
  out.sources_fail = rows.filter(r => r.n - r.ok > 0).map(r => ({ source: r.source, fail: r.n - r.ok, total: r.n }));
  if (out.sources_fail.length) {
    console.log('[selfheal] 近30分钟失败源: ' + out.sources_fail.map(x => x.source + '(' + x.fail + '/' + x.total + ')').join(', '));
  } else {
    console.log('[selfheal] 近30分钟 cg/lsr 源健康正常');
  }
  console.log(JSON.stringify(out));
  db.close();
})().catch(e => { console.error('[selfheal] ' + e.message); process.exit(1); });
