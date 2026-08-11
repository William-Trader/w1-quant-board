'use strict';
// ============================================================
// 严谨结算引擎 v1（2026-08-11 · William 老板审计指令）
// 修复原盲测三大作弊：
//   1. 盈亏对称：盈利/亏损都不封顶，按真实路径结算
//   2. 真实持仓模拟：盘中止损/止盈/爆仓/14天超时（逐根1H bar 检查）
//   3. 手续费+滑点：双边 0.05% taker + 0.02% 滑点，按名义本金扣
// 用法: settleTrade(entry, dir, stop, t1, t2, bars, leverage, posPct, equity)
//   返回 { status, exitPx, pnlUsd, pnlPct, rr, barsHeld, reason }
// ============================================================
const FEE = 0.0005, SLIP = 0.0002;

function settleTrade(opts) {
  const { entry, dir, stop, t1, t2, bars, leverage, posPct, equity } = opts;
  const margin = equity * posPct / 100;                 // 保证金 = 权益 × 仓位%
  const notional = margin * leverage;                   // 名义本金
  const liqDist = entry / leverage;                     // 100x → 1% 反向即爆仓
  const feeCost = notional * (2 * FEE + SLIP);          // 双边手续费 + 滑点
  let exitPx = null, status = 'TIME', reason = '14天超时';
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const isLong = dir === 'long';
    const liqPx = isLong ? entry - liqDist : entry + liqDist;
    // 保守顺序：先爆仓 → 再止损 → 再止盈（同一根bar内利空优先）
    if (isLong) {
      if (b.l <= liqPx) { status = 'LIQ'; reason = '爆仓'; exitPx = liqPx; break; }
      if (b.l <= stop) { status = 'SL'; reason = '止损'; exitPx = stop; break; }
      if (b.h >= t2) { status = 'TP2'; reason = '止盈2.5R'; exitPx = t2; break; }
      if (b.h >= t1) { status = 'TP1'; reason = '止盈1.5R'; exitPx = t1; break; }
    } else {
      if (b.h >= liqPx) { status = 'LIQ'; reason = '爆仓'; exitPx = liqPx; break; }
      if (b.h >= stop) { status = 'SL'; reason = '止损'; exitPx = stop; break; }
      if (b.l <= t2) { status = 'TP2'; reason = '止盈2.5R'; exitPx = t2; break; }
      if (b.l <= t1) { status = 'TP1'; reason = '止盈1.5R'; exitPx = t1; break; }
    }
  }
  if (exitPx === null) { exitPx = bars.length ? bars[bars.length - 1].c : entry; status = 'TIME'; reason = '14天超时'; }
  const movePct = (exitPx - entry) / entry * 100 * (dir === 'long' ? 1 : -1);
  let pnlUsd = notional * movePct / 100 - feeCost;
  if (status === 'LIQ') pnlUsd = -margin;               // 爆仓 = 保证金亏完
  if (pnlUsd <= -margin && status !== 'LIQ') { pnlUsd = -margin; status = 'LIQ'; reason = '爆仓(亏穿保证金)'; }
  const riskDist = Math.abs(entry - stop);
  const rr = riskDist > 0 ? (exitPx - entry) * (dir === 'long' ? 1 : -1) / riskDist : 0;
  return {
    status, reason, exitPx: Math.round(exitPx * 100) / 100,
    pnlUsd: Math.round(pnlUsd), pnlPct: Math.round(pnlUsd / equity * 10000) / 100,
    rr: Math.round(rr * 100) / 100, barsHeld: bars.length
  };
}

module.exports = { settleTrade, FEE, SLIP };
