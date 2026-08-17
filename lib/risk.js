// lib/risk.js — 风控层：冷却/日限/日亏熔断/事件风控/策略熔断（从 engine.js 拆出）
// 2026-08-10 修复：策略熔断阈值从「pnl% 之和 ≤ -2.5」改为「R 之和 ≤ -5R」（与注释一致）
'use strict';
const { debug, warn, info } = require('./log');
const { kvGet, kvSet } = require('./db');
const { eventRiskAdjustment } = require('./event_risk');
// ---------------- 风控层 ----------------
function riskCheck(db, sym, dir, stratId, regime) {
  const now = Date.now();
  // 冷却
  const cd = kvGet(db, `signal:cooldown:${sym}:${dir}`, 0);
  if (cd && now - cd < 4 * 3600 * 1000) return { ok: false, why: '冷却中' };
  // 日限
  const today = new Date().toISOString().slice(0, 10);
  const daily = Number(kvGet(db, `signal:daily:${today}`, 0) || 0);
  if (daily >= 8) return { ok: false, why: '日限已满' };
  // 日亏熔断（live 单价格跌幅累计 ≥3%）
  const dl = Number(kvGet(db, `signal:dayloss:${today}`, 0) || 0);
  if (dl >= 3) return { ok: false, why: '日亏熔断' };
  // 事件风控
  try {
    const er = eventRiskAdjustment(db);
    if (er.risk === 'high') return { ok: false, why: '事件高风险禁单' };
  } catch (e) { debug('[risk] err:', e.message); }
  return { ok: true, daily, dl };
}
function strategyCircuit(db, stratId, riskPct) {
  // 滚动 20 笔累计亏损 ≤ -5R → 熔断暂停（R = pnl% / 单笔风险%）
  const rp = Number(riskPct) > 0 ? Number(riskPct) : 2; // 每笔风险%（默认 2%）
  const rows = db.prepare("SELECT pnl_pct FROM signal_track WHERE strategy=? AND status IN ('WIN','LOSS') ORDER BY id DESC LIMIT 20").all(stratId);
  if (rows.length >= 20) {
    const sumR = rows.reduce((a, r) => a + (Number(r.pnl_pct || 0) / rp), 0); // R 单位
    if (sumR <= -5) return { tripped: true, sumR: +sumR.toFixed(2), rp };
  }
  return { tripped: false };
}


module.exports = { riskCheck, strategyCircuit };
