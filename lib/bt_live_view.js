// 实盘战绩面板 ← 全量历史回测结果（2026-08-31 William老板指令）
// 把 data/tianji_bt_latest.json（回测报告）转换为 /api/live/stats 前端兼容结构（kpi/trades/equityCurve）
const LEV = 50; // 回测杠杆口径与实盘一致

function rrOf(t) {
  const en = Number(t.entry || 0), st = Number(t.stop || 0), t1 = Number(t.t1 || 0);
  if (!en || !st || !t1) return null;
  const risk = Math.abs(en - st), rew = Math.abs(t1 - en);
  if (!risk) return null;
  return +(rew / risk).toFixed(2);
}

function buildBtLiveView(rep) {
  const sm = rep.summary || {};
  const mt = rep.metrics || {};
  const trades = (rep.trades || []).map((t, i) => {
    const posPct = Number(t.posPct || 0);
    const notional = Number(t.notional || 0);
    const posEquity = notional > 0 ? +(notional / LEV).toFixed(2) : posPct > 0 ? +(posPct * 1000 / 100).toFixed(2) : null;
    return {
      id: i + 1, seq: i + 1, symbol: t.sym, direction: t.dir,
      entry: t.entry, stop: t.stop, target1: t.t1, target2: t.t2,
      rr: rrOf(t), strategy: 'TIANJI·回测',
      status: t.status === 'WIN' ? 'WIN' : 'LOSS',
      pnl_pct: t.pnlPct != null ? +Number(t.pnlPct).toFixed(4) : null,
      pnl_usd: t.pnlUsd != null ? +Number(t.pnlUsd).toFixed(2) : null,
      leverage: LEV, t1_hit: !!t.t1Hit,
      notional_usd: notional > 0 ? notional : null,
      orig_stop: null, stop_moved: !!t.stopMoved,
      pos_equity: posEquity, pos_pct: posPct,
      risk_pct: posPct, risk_usd: null,
      opened: t.entryTs != null ? Number(t.entryTs) : null,
      resolved: t.ts != null ? Number(t.ts) : null,
      live_pnl: null
    };
  });
  const settled = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS');
  const wins = settled.filter(t => t.status === 'WIN');
  const losses = settled.filter(t => t.status === 'LOSS');
  const total = settled.length;
  const winRate = total ? wins.length / total * 100 : null;
  const gWin = (rep.trades || []).filter(t => Number(t.pnlUsd || 0) > 0).reduce((a, t) => a + Number(t.pnlUsd), 0);
  const gLoss = Math.abs((rep.trades || []).filter(t => Number(t.pnlUsd || 0) < 0).reduce((a, t) => a + Number(t.pnlUsd), 0));
  const rVals = settled.map(t => Number(t.pnl_pct || 0));
  const avgWin = wins.length ? rVals.filter(v => v > 0).reduce((a, b) => a + b, 0) / wins.length : null;
  const avgLoss = losses.length ? Math.abs(rVals.filter(v => v < 0).reduce((a, b) => a + b, 0) / losses.length) : null;
  const cagr = mt.cagr != null ? Number(mt.cagr) : null;
  const kpi = {
    curEquity: mt.finalEq != null ? +Number(mt.finalEq).toFixed(2) : 1000,
    totalPnlUsd: sm.gross != null ? +Number(sm.gross).toFixed(2) : 0,
    totalPnlPct: mt.grossPct != null ? +Number(mt.grossPct).toFixed(2) : null,
    initEquity: 1000,
    open: 0, total, partialCount: trades.filter(t => t.t1_hit).length,
    winRate: winRate != null ? +winRate.toFixed(1) : null,
    profitFactor: sm.pf != null ? +Number(sm.pf).toFixed(2) : null,
    avgR: null,
    annRet: cagr != null ? +cagr.toFixed(2) : null,
    annVol: mt.annVol != null ? +Number(mt.annVol).toFixed(2) : null,
    sharpe: mt.sharpe != null ? +Number(mt.sharpe).toFixed(2) : null,
    sortino: mt.sortino != null ? +Number(mt.sortino).toFixed(2) : null,
    calmar: mt.calmar != null ? +Number(mt.calmar).toFixed(2) : null,
    maxDrawdownPct: mt.maxDdPct != null ? +Number(mt.maxDdPct).toFixed(2) : null,
    maxDDDurDays: mt.maxDdDurDays != null ? +Number(mt.maxDdDurDays).toFixed(1) : null,
    projAnnRet: cagr != null ? +cagr.toFixed(2) : null,
    projMonthRet: cagr != null ? +(((1 + cagr / 100) ** (1 / 12) - 1) * 100).toFixed(2) : null,
    expVal: mt.expectancy != null ? +Number(mt.expectancy).toFixed(2) : null,
    payoffRatio: sm.payoff != null ? +Number(sm.payoff).toFixed(2) : null,
    grossRatio: gLoss > 0 ? +(gWin / gLoss).toFixed(2) : null,
    avgHoldHours: mt.avgHoldH != null ? +Number(mt.avgHoldH).toFixed(1) : null,
    cvar95: null,
    best: rVals.length ? +Math.max(...rVals).toFixed(2) : null,
    worst: rVals.length ? +Math.min(...rVals).toFixed(2) : null,
    strategyBreakdown: {
      'TIANJI·回测': {
        total, wins: wins.length, losses: losses.length,
        pnlLev: settled.reduce((a, t) => a + (Number(t.pnl_pct || 0) * Number(t.leverage || LEV)), 0)
      }
    }
  };
  const equityCurve = (rep.equity || []).map(p => ({
    ts: Math.floor(Number(p.ts || 0) / 1000),
    label: String(p.t || ''),
    y: +Number(p.equity || 1000).toFixed(2),
    pnl: +Number((p.equity || 1000) - 1000).toFixed(2),
    open: Number(p.positions || 0)
  }));
  return { kpi, trades, equityCurve };
}

module.exports = { buildBtLiveView, buildBtReasoning };

// 开单逻辑研判区 ← 全量历史回测结果（2026-08-31 William老板指令）
// 与 /api/live/stats 同源：读 data/tianji_bt_latest.json，转成 /api/live/reasoning 前端兼容结构
function buildBtReasoning(rep) {
  const list = (rep.trades || []).map((t, i) => {
    const dims = {
      news: t.news != null ? +Number(t.news).toFixed(2) : 0,
      tech: t.tech != null ? +Number(t.tech).toFixed(2) : 0,
      fund: t.fund != null ? +Number(t.fund).toFixed(2) : 0,
      con: t.con != null ? +Number(t.con).toFixed(2) : 0,
      qibao: t.qib != null ? +Number(t.qib).toFixed(2) : 0
    };
    const reasoning = {
      dims,
      score: t.score != null ? +Number(t.score).toFixed(2) : null,
      aiVerdict: t.ai === 'agree' ? 'agree' : (t.ai === 'veto' ? 'veto' : (t.ai === 'hold' ? 'hold' : null)),
      activeDims: t.activeDims != null ? Number(t.activeDims) : null,
      settleReason: t.reason || null,
      holdH: t.holdH != null ? +Number(t.holdH).toFixed(1) : null,
      t1Hit: !!t.t1Hit,
      stopMoved: !!t.stopMoved
    };
    const selfReview = [
      '回测单 · ' + (t.reason || '已结算'),
      '持仓 ' + (t.holdH != null ? Number(t.holdH).toFixed(0) + 'h' : '—'),
      (t.activeDims != null ? t.activeDims + '维共振' : ''),
      (t.t1Hit ? 'T1已落袋' : '')
    ].filter(Boolean).join(' · ');
    return {
      id: i + 1, symbol: t.sym, direction: t.dir,
      entry: t.entry, stop: t.stop, target1: t.t1, target2: t.t2,
      pos_pct: t.posPct, status: t.status === 'WIN' ? 'WIN' : 'LOSS',
      pnl_pct: t.pnlPct != null ? +Number(t.pnlPct).toFixed(2) : null,
      pnl_usd: t.pnlUsd != null ? +Number(t.pnlUsd).toFixed(2) : null,
      reason: t.reason || null,
      pushed_at: t.entryTs != null ? Number(t.entryTs) : null,
      resolved_at: t.ts != null ? Number(t.ts) : null,
      reasoning, self_review: selfReview
    };
  });
  return { count: list.length, list };
}
