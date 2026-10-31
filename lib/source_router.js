'use strict';
// ============================================================
// lib/source_router.js — 两个 Coinglass 源的职责分离与选源（2026-10-31）
//
// 背景：系统里有两个独立的 Coinglass 上游，之前没有明确的“谁负责什么”：
//   fast = vip2.coinglass.site（w1-board 自有 key，rpm 自适应 3~10，5min 级）
//   full = api.alphanode.work（cglass-pro 自有 key，约 1/min，Pro 全量端点）
// 两者 key/base 已分离，但消费端仍可能拿错粒度。本模块把“选源规则”显式化：
//   - 同类型数据优先用更快/更省的源（实时爆仓、LSR、费率、OI、价格）
//   - 需要更全数据时用 full 源（清算墙/热力图/最大痛点/鲸鱼仓位）
//   - primary 过期或缺失时回退 secondary，并在 /api/sources 里说明原因
// 只读本地库，不发外部请求；采集仍由 collectors / cglass-pro 各自负责。
// ============================================================

const ROUTES = {
  price:                 { zh: '现价',       primary: 'fast', secondary: 'full', note: 'Gate 60s + Coinglass 5min 加权；同类型取更快源' },
  lsr:                   { zh: '多空比',     primary: 'fast', secondary: 'full', note: 'lsr_signals 一次批量覆盖 BTC/ETH 等主流币' },
  funding:               { zh: '资金费率',   primary: 'fast', secondary: 'full', note: 'futures_markets 5min 快照' },
  oi:                    { zh: '持仓量',     primary: 'fast', secondary: 'full', note: 'futures_markets 5min 快照' },
  liquidation_realtime:  { zh: '实时爆仓',   primary: 'fast', secondary: 'full', note: 'vip2 聚合 coin-list：1 次调用覆盖 8 所' },
  liquidation_walls:     { zh: '清算墙',     primary: 'full', secondary: 'fast', note: 'alphanode 全量 liq_agg_map / max_pain' },
  liquidation_heatmap:   { zh: '清算热力图', primary: 'full', secondary: 'fast', note: 'alphanode 全量 heatmap' },
  max_pain:              { zh: '最大痛点',   primary: 'full', secondary: 'fast', note: 'alphanode liq_max_pain' },
  whale_positions:       { zh: '鲸鱼仓位',   primary: 'full', secondary: 'fast', note: 'alphanode Hyperliquid 仓位分布' },
  etf:                   { zh: 'ETF 流入',   primary: 'fast', secondary: 'full', note: 'coinglass ETF 序列' },
  fear_greed:            { zh: '恐慌贪婪',   primary: 'fast', secondary: 'full', note: '上游日更' }
};

const FAST_THRESH_SEC = 900;    // fast：5min 采集，15min 内算新鲜
const FULL_THRESH_SEC = 1800;   // full：各 Pro 端点轮转，30min 内算新鲜

const PROVIDERS = {
  fast: { id: 'fast', name: 'coinglass-vip2', role: '实时/高频', cadence: '5min', quota: '自适应 3~10 rpm' },
  full: { id: 'full', name: 'alphanode-pro', role: '全量/深度', cadence: '轮转 ~1/min', quota: '约 1 rpm' }
};

function ageOf(db, kind, source) {
  const now = Math.floor(Date.now() / 1000);
  const maxTs = (table, where) => {
    try {
      const sql = `SELECT MAX(ts) m FROM ${table}` + (where ? ` WHERE ${where}` : '');
      const r = db.prepare(sql).get();
      return r && r.m != null ? Number(r.m) : null;
    } catch (e) { return null; }
  };
  let ts = null;
  if (source === 'fast') {
    if (kind === 'price') ts = maxTs('prices');
    else if (kind === 'lsr') ts = maxTs('lsr_signals');
    else if (kind === 'funding' || kind === 'oi') ts = maxTs('futures_markets');
    else if (kind === 'liquidation_realtime') ts = maxTs('liquidation', "exchange='AGG'") || maxTs('liquidation');
    else if (kind === 'etf') ts = maxTs('etf_archive');
    else if (kind === 'fear_greed') ts = maxTs('fear_greed');
    else ts = maxTs('futures_markets');
  } else {
    if (kind === 'liquidation_walls') ts = maxTs('cgpro_snapshots', "endpoint IN ('liq_agg_map','liq_map','liq_max_pain')");
    else if (kind === 'liquidation_heatmap') ts = maxTs('cgpro_snapshots', "endpoint IN ('liq_agg_heatmap_model1','liq_heatmap_model1')");
    else if (kind === 'max_pain') ts = maxTs('cgpro_snapshots', "endpoint='liq_max_pain'");
    else if (kind === 'whale_positions') ts = maxTs('cgpro_snapshots', "endpoint IN ('hl_posdist_bytag','hl_ls_bytag')");
    else ts = maxTs('cgpro_snapshots');
  }
  if (ts == null) return null;
  const sec = String(Math.floor(ts)).length > 10 ? Math.floor(ts / 1000) : ts;
  return Math.max(0, now - sec);
}

function choose(db, kind) {
  const r = ROUTES[kind];
  if (!r) return { kind, error: 'unknown_kind' };
  const pa = ageOf(db, kind, r.primary);
  const sa = ageOf(db, kind, r.secondary);
  const pTh = r.primary === 'fast' ? FAST_THRESH_SEC : FULL_THRESH_SEC;
  const sTh = r.secondary === 'fast' ? FAST_THRESH_SEC : FULL_THRESH_SEC;
  const primaryFresh = pa != null && pa <= pTh;
  const secondaryFresh = sa != null && sa <= sTh;
  const chosen = primaryFresh ? r.primary : (secondaryFresh ? r.secondary : r.primary);
  const age = chosen === r.primary ? pa : sa;
  const th = chosen === 'fast' ? FAST_THRESH_SEC : FULL_THRESH_SEC;
  return {
    kind, zh: r.zh, note: r.note,
    primary: r.primary, secondary: r.secondary,
    chosen,
    chosen_name: PROVIDERS[chosen] ? PROVIDERS[chosen].name : chosen,
    age_sec: age,
    threshold_sec: th,
    stale: age == null || age > th,
    fallback_used: chosen !== r.primary,
    primary_age_sec: pa,
    secondary_age_sec: sa,
    reason: primaryFresh ? 'primary_fresh' : (secondaryFresh ? 'primary_stale_secondary_fresh' : 'both_stale_use_primary')
  };
}

function status(db) {
  const routes = Object.keys(ROUTES).map(k => choose(db, k));
  return {
    ok: true,
    as_of: Math.floor(Date.now() / 1000),
    providers: PROVIDERS,
    routes,
    summary: {
      total: routes.length,
      stale: routes.filter(r => r.stale).length,
      fallback: routes.filter(r => r.fallback_used).length
    }
  };
}

module.exports = { ROUTES, PROVIDERS, FAST_THRESH_SEC, FULL_THRESH_SEC, ageOf, choose, status };
