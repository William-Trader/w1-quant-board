'use strict';
// ============================================================
// lib/freshness.js — 数据新鲜度阈值的单一事实来源 (2026-11-10)
// 此前 source_router.js 与 scripts/system_audit.js 各自定义硬编码阈值，
// 导致「业务判定新鲜、体检却报 FAIL」的口径漂移。统一从这里读取，
// 调整阈值只改这一处，避免监控与业务再次分叉。
// ============================================================
const FAST_THRESH_SEC = 900;   // fast 源：5min 采集，15min 内算新鲜
const FULL_THRESH_SEC = 1800;  // full 源：Pro 端点轮转，30min 内算新鲜
module.exports = { FAST_THRESH_SEC, FULL_THRESH_SEC };
