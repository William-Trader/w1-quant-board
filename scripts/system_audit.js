#!/usr/bin/env node
'use strict';
// W1 全系统体检（2026-10-31）
// 用法: node scripts/system_audit.js [--json]
// 覆盖：HTTP 关键接口、数据表新鲜度、价格/LSR 精度、磁盘/内存、Coinglass 限流、QQ 群配置。
// 退出码：0=全通过；1=有 FAIL；2=脚本异常。
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { WATCH } = require('../lib/health_guard');

const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', 'w1.db');
const BASE = 'http://127.0.0.1:3300';
const JSON_OUT = process.argv.includes('--json');
const results = [];
function add(area, name, ok, detail) { results.push({ area, name, ok: !!ok, detail: detail == null ? '' : String(detail) }); }
async function get(p, timeout = 8000) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, body, text };
  } catch (e) { return { ok: false, status: 0, ms: Date.now() - t0, error: e.message }; }
}

(async () => {
  const db = new Database(DB, { readonly: true });
  const now = Math.floor(Date.now() / 1000);

  // 1) HTTP 接口
  const ver = await get('/api/version');
  add('HTTP', '/api/version', ver.ok && ver.body && ver.body.ok, ver.status + ' ' + ver.ms + 'ms');
  add('HTTP', 'frontend is_full_terminal', ver.body && ver.body.dashboard_html && ver.body.dashboard_html.is_full_terminal === true,
    ver.body && ver.body.dashboard_html ? JSON.stringify({ index: ver.body.dashboard_html.bytes, total: ver.body.dashboard_html.total_bytes }) : 'no body');
  const hz = await get('/healthz');
  add('HTTP', '/healthz', hz.ok && hz.body && hz.body.ok, hz.status + ' ' + hz.ms + 'ms');
  const perf = await get('/api/perf');
  add('HTTP', '/api/perf', perf.ok && perf.body && perf.body.ok, perf.status + ' ' + perf.ms + 'ms');
  const alt = await get('/api/alt-radar');
  const ab = alt.body || {};
  add('山寨雷达', '/api/alt-radar', alt.ok && ab.ok !== false && Array.isArray(ab.hot) && Array.isArray(ab.anomalies),
    alt.ok ? `universe=${ab.universe || 0} hot=${ab.hot ? ab.hot.length : '?'} anomalies=${ab.anomalies ? ab.anomalies.length : '?'}` : alt.error);
  try {
    const r = db.prepare("SELECT value FROM kv WHERE key='alt_radar:last_scan'").get();
    const last = r ? Number(r.value) : null;
    const age = last ? now - last : null;
    add('山寨雷达', '最近扫描', age != null && age <= 1800, age == null ? 'no scan yet' : `${age}s / 阈值 1800s`);
  } catch (e) { add('山寨雷达', '最近扫描', false, e.message); }
  const src = await get('/api/sources');
  const sb = src.body || {};
  add('源路由', '/api/sources', src.ok && sb.ok === true && Array.isArray(sb.routes), src.ok ? `routes=${sb.routes ? sb.routes.length : '?'} stale=${sb.summary ? sb.summary.stale : '?'}` : src.error);
  const dq = await get('/api/data-quality', 20000);
  const dqb = dq.body || {};
  add('数据', '/api/data-quality', dq.ok && dqb.ok && dqb.quality_score >= 90 && dqb.summary && dqb.summary.stale === 0,
    dq.ok ? `score=${dqb.quality_score} stale=${dqb.summary ? dqb.summary.stale : '?'} ${dq.ms}ms` : dq.error);
  const px = await get('/api/precision/price?symbols=BTC,ETH');
  const pxb = px.body && px.body.symbols ? px.body.symbols : {};
  const pxOk = px.ok && pxb.BTC && pxb.BTC.price != null && pxb.BTC.n >= 2 && pxb.BTC.max_dev_pct <= 0.5 && !pxb.BTC.stale;
  add('精度', '价格多源加权', pxOk, pxOk ? `BTC ${pxb.BTC.price} n=${pxb.BTC.n} dev=${pxb.BTC.max_dev_pct}% conf=${pxb.BTC.confidence}` : JSON.stringify(px.body).slice(0, 200));
  const lsr = await get('/api/precision/lsr?symbol=BTC');
  const lb = lsr.body || {};
  const lsrOk = lsr.ok && lb.notional_lsr != null && lb.cross_check_pct != null && lb.cross_check_pct <= 0.5;
  add('精度', 'LSR 三口径', lsrOk, lsrOk ? `notional=${lb.notional_lsr} account=${lb.account_lsr} whale=${lb.whale_qty_lsr} cross=${lb.cross_check_pct}%` : JSON.stringify(lb).slice(0, 200));
  const today = await get('/api/today', 15000);
  add('HTTP', '/api/today', today.ok && today.body && today.body.ok !== false, today.status + ' ' + today.ms + 'ms');

  // 2) 表新鲜度（复用 health_guard 阈值）
  for (const w of WATCH) {
    try {
      const r = db.prepare(`SELECT MAX(${w.col}) m FROM ${w.table}`).get();
      const raw = r && r.m != null ? Number(r.m) : null;
      if (raw == null) { add('表龄', w.zh, false, '空表'); continue; }
      const sec = String(Math.floor(raw)).length > 10 ? Math.floor(raw / 1000) : raw;
      const age = now - sec;
      add('表龄', w.zh, age <= w.secs, `${age}s / 阈值 ${w.secs}s`);
    } catch (e) { add('表龄', w.zh, false, e.message); }
  }

  // 2b) 两个 CG 源：必须分离 + 各自负责的数据类型新鲜
  try {
    const readEnv = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
    const w1e = readEnv(path.join(ROOT, '.env'));
    const cge = readEnv('/home/ubuntu/cglass-pro/.env');
    const keyOf = (txt, k) => { const m = txt.match(new RegExp('^' + k + '=(.+)$', 'm')); return m ? m[1].replace(/^["']|["']$/g, '').trim() : ''; };
    const k1 = keyOf(w1e, 'COINGLASS_API_KEY');
    const k2 = keyOf(cge, 'CGLASS_PRO_KEY');
    add('源路由', '两个 CG 源 key 已分离', !!k1 && !!k2 && k1 !== k2, k1 && k2 ? (k1 !== k2 ? 'fast/full separate' : 'SAME KEY') : 'missing key');
    const base1 = keyOf(w1e, 'COINGLASS_BASE');
    add('源路由', 'fast 源 base', /vip2\.coinglass\.site/.test(base1), base1 || 'missing');
  } catch (e) { add('源路由', 'CG 源分离检查', false, e.message); }
  try {
    const r = db.prepare("SELECT MAX(ts) m FROM liquidation WHERE exchange='AGG'").get();
    const age = r && r.m != null ? now - Number(r.m) : null;
    add('源路由', 'fast 聚合清算', age != null && age <= 900, age == null ? 'no AGG row' : `${age}s / 阈值 900s`);
  } catch (e) { add('源路由', 'fast 聚合清算', false, e.message); }
  try {
    const r = db.prepare("SELECT MAX(ts) m FROM cgpro_snapshots WHERE endpoint IN ('liq_agg_map','liq_map','liq_max_pain')").get();
    const age = r && r.m != null ? now - Number(r.m) : null;
    add('源路由', 'full 清算墙', age != null && age <= 1800, age == null ? 'no wall row' : `${age}s / 阈值 1800s`);
  } catch (e) { add('源路由', 'full 清算墙', false, e.message); }

  // 3) 资源
  let diskFreeGb = null, diskPct = null;
  try {
    const st = fs.statfsSync('/');
    diskFreeGb = +(st.bavail * st.bsize / 1e9).toFixed(1);
    diskPct = +(((st.blocks - st.bfree) / st.blocks) * 100).toFixed(1);
  } catch (e) {}
  add('资源', '磁盘剩余', diskFreeGb != null && diskFreeGb >= 5, diskFreeGb == null ? 'unknown' : `${diskFreeGb}GB free (${diskPct}% used)`);
  const freeMb = Math.round(os.freemem() / 1048576);
  add('资源', '内存剩余', freeMb >= 300, `${freeMb}MB free`);
  const mem = process.memoryUsage();
  add('资源', '进程 RSS', mem.rss / 1048576 < 800, `${Math.round(mem.rss / 1048576)}MB`);

  // 4) Coinglass 限流与 QQ 配置
  let rpm = null;
  try { const r = db.prepare("SELECT value FROM kv WHERE key='cg:rpm'").get(); rpm = r ? Number(r.value) : null; } catch (e) {}
  add('外部源', 'Coinglass 自适应 rpm', rpm == null || rpm >= 3, String(rpm));
  const envPath = path.join(ROOT, '.env');
  let envText = '';
  try { envText = fs.readFileSync(envPath, 'utf8'); } catch (e) {}
  const has = (k) => new RegExp('^' + k + '=.+', 'm').test(envText);
  add('推送', 'QQ 监测群', has('QQ_GROUP_MONITOR'), has('QQ_GROUP_MONITOR') ? 'configured' : 'missing');
  add('推送', 'QQ 信号群', has('QQ_GROUP_SIGNAL'), has('QQ_GROUP_SIGNAL') ? 'configured' : 'missing');
  add('推送', 'QQ 分析群', has('QQ_GROUP_ANALYSIS'), has('QQ_GROUP_ANALYSIS') ? 'configured' : 'missing');

  db.close();

  const failed = results.filter(r => !r.ok);
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failed.length === 0, as_of: now, results }, null, 2));
  } else {
    const areas = [...new Set(results.map(r => r.area))];
    for (const a of areas) {
      console.log(`\n▍${a}`);
      for (const r of results.filter(x => x.area === a)) {
        console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
      }
    }
    console.log(`\n结论：${failed.length ? '❌ ' + failed.length + ' 项失败' : '✅ 全部通过'}（${results.length} 项）`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('AUDIT ERROR', e.stack); process.exit(2); });
