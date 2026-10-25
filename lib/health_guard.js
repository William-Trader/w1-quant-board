'use strict';
// lib/health_guard.js — 数据断供统一预警 v1.0（William 老板 2026-08-22 指令）
// 巡检关键数据表新鲜度：某源静默断供超阈值 → 推送市场监测群（QQ_GROUP_MONITOR）
// 与现有 source_health 打点互补：source_health 记录每次采集成败，本模块从「表最新 ts」角度兜底判断「数据是否真的停了」。
const { warn, info } = require('./log');
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const alertsLib = require('./alerts');

// 巡检清单：{ 表名, ts字段(默认 ts), 阈值秒, 中文名 }
// 阈值 = 正常采集间隔 × 3~8（留网络抖动余量，只抓「真停供」不抓「偶发延迟」）
const WATCH = [
  { table: 'prices',            col: 'ts', secs: 300,    zh: '现货价格' },   // 60s 采集
  { table: 'futures_markets',   col: 'ts', secs: 5400,   zh: '合约行情' },   // 30min
  { table: 'fear_greed',        col: 'ts', secs: 108000, zh: '恐慌贪婪指数' }, // 上游日更(每日08:00) → 阈值30h，只抓真断供
  { table: 'liquidation',       col: 'ts', secs: 3600,   zh: '爆仓清算' },   // 30min
  { table: 'lsr_history',       col: 'ts', secs: 900,    zh: '多空比LSR' },  // 5min
  { table: 'funding_arb',       col: 'ts', secs: 5400,   zh: '资金费率套利' }, // 30min
  { table: 'news',              col: 'ts', secs: 14400,  zh: '消息面新闻' },  // 实时 → 断 4h
  // 2026-10-01 退役并移出断供巡检：上游接口已下线、采集已停用，避免长期噪音告警
  // { table: 'consensus',     col: 'ts', secs: 7200,   zh: 'KOL共识' },
  { table: 'market_structure',  col: 'ts', secs: 86400,  zh: '市场结构' },   // 日更
  { table: 'altseason_daily',   col: 'ts', secs: 86400,  zh: '山寨季判断' }, // 日更
  { table: 'klines',             col: 'ts', secs: 900,    zh: 'K线累积' },   // 5min（2026-08-25 加入：本次24h断更根因）
];

// 冷却：同一源告警后 COOLDOWN 秒内不重复推送（防刷屏）
const COOLDOWN = 6 * 3600;
// 全局推送节流：单轮最多推 MAX_PUSH 条，避免首次冷启动时全表空刷屏
const MAX_PUSH = 5;

async function runGuard(ctx) {
  const { db, env } = ctx;
  if (!db) return { checked: 0, pushed: 0, skipped: 0 };
  const now = Math.floor(Date.now() / 1000);
  let checked = 0, pushed = 0, skipped = 0;
  const alerts = [];
  const staleKeys = new Set();

  for (const w of WATCH) {
    checked++;
    let latest = null;
    try {
      // 表可能不存在（尚未建表）→ 跳过，避免误报
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(w.table);
      if (!exists) { skipped++; continue; }
      const row = db.prepare(`SELECT MAX(${w.col}) m FROM ${w.table}`).get();
      latest = row && row.m != null ? Number(row.m) : null;
    } catch (e) {
      warn(`[health_guard] ${w.table} 查询失败: ${e.message}`);
      continue;
    }
    if (latest == null) {
      // 2026-10-01 底座修复：表存在但一行都没有 = 采集从未成功；此前直接 skipped 使这类「静默失效」永不告警。
      const ekey = 'health_guard:last:' + w.table;
      const elast = Number(kvGet(db, ekey, 0) || 0);
      staleKeys.add('health:' + w.table);
      if (now - elast < (w.cooldown || COOLDOWN)) { skipped++; continue; }
      alerts.push(w.zh + '(' + w.table + ') 从未采集到数据（表为空）');
      kvSet(db, ekey, now);
      continue;
    }

    // 统一秒级（ts 可能是毫秒）
    const sec = String(Math.floor(latest)).length > 10 ? Math.floor(latest / 1000) : latest;
    const age = now - sec;

    if (age > w.secs) {
      // 冷却去重
      const key = `health_guard:last:${w.table}`;
      const last = Number(kvGet(db, key, 0) || 0);
      staleKeys.add('health:' + w.table);
      if (now - last < (w.cooldown || COOLDOWN)) { skipped++; continue; } // 2026-10-01 支持单项冷却覆盖
      const ageStr = fmtAge(age);
      alerts.push(`${w.zh}(${w.table}) 已断供 ${ageStr}`);
      kvSet(db, key, now);
    }
  }

  const recIds = [];
  if (alerts.length) {
    const sliced = alerts.slice(0, MAX_PUSH);
    for (const line of sliced) {
      const mm = line.match(/\(([a-z0-9_]+)\)/);
      const table = mm ? mm[1] : null;
      try {
        const rec = alertsLib.record(db, { dedup_key: 'health:' + (table || line.slice(0, 24)), rule: 'health', severity: 'P1', title: line, detail: '数据断供巡检', payload: { table } });
        recIds.push(rec.id);
      } catch (e) {}
    }
    const more = alerts.length > sliced.length ? `\n…等共 ${alerts.length} 项断供` : '';
    const msg = `🔴【W1 数据断供预警】\n${sliced.join('\n')}${more}\n请检查采集服务/上游接口。`;
    try {
      const ok = await pushToGroup(env, db, msg, 'monitor');
      if (ok) { pushed = sliced.length; alertsLib.markNotified(db, recIds); info(`[health_guard] 已推送断供预警 ${sliced.length} 项`); }
    } catch (e) { warn('[health_guard] 推送失败:', e.message); }
  }
  try { alertsLib.resolveMissing(db, 'health', Array.from(staleKeys)); } catch (e) {}
  return { checked, pushed, skipped };
}

function fmtAge(sec) {
  if (sec < 3600) return `${Math.floor(sec / 60)}分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}小时`;
  return `${(sec / 86400).toFixed(1)}天`;
}

module.exports = { runGuard, WATCH };
