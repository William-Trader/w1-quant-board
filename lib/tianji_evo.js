'use strict';
// ═══════════════════════════════════════════════════════════
// TIANJI 在线进化引擎 v4.0 (2026-08-31 William老板指令 · 机构级)
// V1 教训：单权重梯度在线学习被单笔噪声带偏（全量47笔42.6% -13.59U，比基线差）
// V2 方案：专家池 + Hedge 在线混合（学术标准：在线凸优化/预测专家混合）
// V3 回测结论：等权先验+η0.5 → 45笔42.2% PF0.95，比静态基线差 → 进化未验证，不能启用
// V4 机构级修正（2026-08-31）：
//   - 默认先验 = 当前CFG（e_current 概率 1.0）→ 实盘行为与已回测验证的 CFG 完全一致
//   - 学习门控 EVO_MIN_N=30：五维完整期结算 <30 笔不更新专家概率（防早期噪声带偏）
//   - n≥30 后按 Hedge 规则更新（做对的专家加码，做错的降权），状态存 kv: tianji:evo
//   - 每次启用进化前必须离线回测验证（scripts/tianji_backtest.js --evo）确认优于静态基线
// ═══════════════════════════════════════════════════════════
const { kvGet, kvSet } = require('./db');

const EVO_KEY = 'tianji:evo';
const DIMS = ['news', 'tech', 'fund', 'con', 'qibao'];

// 专家池：8 组可解释权重假设（总和≈4.1，与 CFG 同量纲）
const EXPERTS = [
  { id: 'e_current', name: '当前实盘', w: { news: 0.2, tech: 1.2, fund: 0.8, con: 0.3, qibao: 1.6 } },
  { id: 'e_tech',    name: '技术主导', w: { news: 0.2, tech: 1.6, fund: 0.6, con: 0.2, qibao: 1.4 } },
  { id: 'e_qib',     name: '清算主导', w: { news: 0.1, tech: 1.0, fund: 0.6, con: 0.2, qibao: 2.0 } },
  { id: 'e_balance', name: '均衡',     w: { news: 0.5, tech: 1.0, fund: 1.0, con: 0.5, qibao: 1.0 } },
  { id: 'e_conserv', name: '保守',     w: { news: 0.2, tech: 0.8, fund: 0.8, con: 0.3, qibao: 1.2 } },
  { id: 'e_fund',    name: '资金主导', w: { news: 0.2, tech: 0.8, fund: 1.4, con: 0.3, qibao: 1.4 } },
  { id: 'e_news',    name: '消息增强', w: { news: 0.8, tech: 1.0, fund: 0.8, con: 0.5, qibao: 1.2 } },
  { id: 'e_equal',   name: '五维等权', w: { news: 0.82, tech: 0.82, fund: 0.82, con: 0.82, qibao: 0.82 } },
];
// V4：默认先验 = 当前CFG（e_current 概率 1.0，其余 0）→ 未学习时权重与 CFG 完全一致
// Hedge 学习率（η=0.3：单笔损失最多调整 ~26% 概率质量，抗噪声）
const ETA = 0.3;
const P_INIT = 0;                                  // 非当前专家的初始概率
const P_CUR_INIT = 1.0;                            // e_current 初始概率
const EVO_MIN_N = 30;                              // 最小学习样本：五维完整期结算 <30 笔不更新

function loadEvo(db) {
  let evo = kvGet(db, EVO_KEY, null);
  if (!evo || typeof evo !== 'object' || !evo.probs) {
    evo = {
      probs: EXPERTS.reduce((a, e) => { a[e.id] = (e.id === 'e_current' ? P_CUR_INIT : P_INIT); return a; }, {}),
      n: 0, eta: ETA, minN: EVO_MIN_N, updatedAt: null, history: [], promotions: [],
      // 每专家累计表现（诊断用）
      perf: EXPERTS.reduce((a, e) => { a[e.id] = { trades: 0, correct: 0, pnl: 0 }; return a; }, {})
    };
  }
  for (const e of EXPERTS) if (evo.probs[e.id] == null) evo.probs[e.id] = (e.id === 'e_current' ? P_CUR_INIT : P_INIT);
  for (const e of EXPERTS) if (!evo.perf || !evo.perf[e.id]) { evo.perf = evo.perf || {}; evo.perf[e.id] = { trades: 0, correct: 0, pnl: 0 }; }
  return evo;
}

// 当前混合权重 = Σ p_i × w_i（软混合，全专家参与）
function getEvoWeights(db) {
  const evo = loadEvo(db);
  const out = {};
  // V4 门控：学习样本不足 → 直接用当前CFG权重（e_current），保证实盘行为与已验证 CFG 一致
  if (!evo.n || evo.n < EVO_MIN_N) {
    const cur = EXPERTS.find(e => e.id === 'e_current');
    for (const d of DIMS) out[d] = cur.w[d];
    return out;
  }
  for (const d of DIMS) {
    out[d] = EXPERTS.reduce((a, e) => a + (evo.probs[e.id] || 0) * e.w[d], 0);
    out[d] = +out[d].toFixed(4);
  }
  return out;
}

// 每笔结算后 Hedge 更新
// dims: {news,tech,fund,con,qibao} 该笔各维度得分；pnlPct: 结算盈亏%；meta: {direction,status,reason,symbol}
function updateEvo(db, dims, pnlPct, meta) {
  try {
    const evo = loadEvo(db);
    const dir = (meta && meta.direction) || 'long';
    const pnlSign = pnlPct >= 0 ? 1 : -1;
    const mag = Math.min(Math.abs(pnlPct) / 5, 2.0); // 幅度权重 5% 封顶

    // 无维度数据不计数（避免污染学习样本）
    let touchedAny = false;
    for (const d of DIMS) if (Math.abs(Number(dims[d]) || 0) > 0.05) { touchedAny = true; break; }
    if (!touchedAny) return evo;

    evo.n++;  // V4：结算样本计数（用于门控判断）

    // 影子战绩：每笔结算都记录每个专家（固定权重）的假设表现（无论是否学习期）
    for (const e of EXPERTS) {
      const total = DIMS.reduce((a, d) => a + (Number(dims[d]) || 0) * e.w[d], 0);
      const supportDir = total >= 0 ? 'long' : 'short';
      const correct = supportDir === dir ? (pnlSign >= 0) : (pnlSign < 0);
      evo.perf[e.id].trades++;
      if (correct) evo.perf[e.id].correct++;
      evo.perf[e.id].pnl += Number(pnlPct) || 0;
    }

    // 晋升检查：任一专家影子样本≥30 且显著优于当前 → 提升先验（机构级进化准入）
    try { checkPromotion(evo); } catch (e) {}

    if (evo.n < EVO_MIN_N) { evo.updatedAt = new Date().toISOString(); kvSet(db, EVO_KEY, evo); return evo; }  // 门控期：只影子跟踪，不更新权重

    // 正式学习期：Hedge 更新
    // 每个专家在该笔的损失：专家打分方向 vs 实际结果
    // loss ∈ [0,1]：方向错=1（满损），方向对但幅度小=0.2~0.5（部分损失），对且大幅=0
    const losses = {};
    for (const e of EXPERTS) {
      const total = DIMS.reduce((a, d) => a + (Number(dims[d]) || 0) * e.w[d], 0);
      const supportDir = total >= 0 ? 'long' : 'short';
      const correct = supportDir === dir ? (pnlSign >= 0) : (pnlSign < 0);
      let loss;
      if (correct && Math.abs(total) >= 0.5) loss = 0.1 * (1 - mag) + 0.2;      // 对且强 → 小损失
      else if (correct) loss = 0.35 * (1 - mag) + 0.2;                           // 对但弱 → 中损失
      else if (!correct && Math.abs(total) >= 0.5) loss = 0.5 + 0.5 * mag;       // 错且强 → 大损失
      else loss = 0.4 + 0.4 * mag;                                               // 错但弱 → 中大损失
      losses[e.id] = Math.max(0.05, Math.min(1, loss)); // clamp 防专家死亡
    }

    // Hedge 乘法更新 + 归一化
    let sum = 0;
    for (const e of EXPERTS) {
      evo.probs[e.id] *= Math.exp(-evo.eta * losses[e.id]);
      sum += evo.probs[e.id];
    }
    if (sum > 0) for (const e of EXPERTS) evo.probs[e.id] /= sum;

    // 防极端：任何专家概率 clamp [0.02, 0.6] 后重归一
    for (const e of EXPERTS) evo.probs[e.id] = Math.max(0.02, Math.min(0.6, evo.probs[e.id]));
    sum = EXPERTS.reduce((a, e) => a + evo.probs[e.id], 0);
    for (const e of EXPERTS) evo.probs[e.id] = +(evo.probs[e.id] / sum).toFixed(4);

    evo.updatedAt = new Date().toISOString();
    evo.history = (evo.history || []).slice(-99);
    evo.history.push({
      ts: evo.updatedAt, pnlPct: +Number(pnlPct).toFixed(2), dims: Object.assign({}, dims),
      meta: meta || null, probs: Object.assign({}, evo.probs)
    });
    kvSet(db, EVO_KEY, evo);
    return evo;
  } catch (e) {
    return null; // 进化失败不影响主流程
  }
}

// 晋升检查：影子样本≥30 且显著跑赢当前CFG的专家 → 提升其先验（机构级准入）
// 显著标准：影子胜率 ≥ 当前胜率 + 5pp 且 影子累计盈亏 > 当前（保守准入，宁缺毋滥）
function checkPromotion(evo) {
  const cur = evo.perf['e_current'] || { trades: 0, correct: 0, pnl: 0 };
  if (cur.trades < 30) return;  // 当前CFG自身样本不足，不比较
  const curWR = cur.correct / cur.trades;
  for (const e of EXPERTS) {
    if (e.id === 'e_current') continue;
    const p = evo.perf[e.id] || { trades: 0, correct: 0, pnl: 0 };
    if (p.trades < 30) continue;  // 候选影子样本不足
    const pWR = p.correct / p.trades;
    if (pWR >= curWR + 0.05 && p.pnl > cur.pnl) {
      const oldP = evo.probs[e.id] || 0;
      if (oldP < 0.5) {
        const boost = 0.5 - oldP;
        evo.probs[e.id] = 0.5;
        let total = 0;
        for (const x of EXPERTS) { if (x.id !== e.id) { evo.probs[x.id] = (evo.probs[x.id] || 0) * (1 - boost); total += evo.probs[x.id]; } }
        evo.promotions = evo.promotions || [];
        evo.promotions.push({ ts: new Date().toISOString(), expert: e.id, name: e.name, curWR: +(curWR * 100).toFixed(1), newWR: +(pWR * 100).toFixed(1), curPnl: +cur.pnl.toFixed(2), newPnl: +p.pnl.toFixed(2) });
        evo.promotions = evo.promotions.slice(-20);
      }
    }
  }
}

function evoStatus(db) {
  const evo = loadEvo(db);
  const mix = getEvoWeights(db);
  const top = Object.entries(evo.probs).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    enabled: true, n: evo.n || 0, eta: evo.eta || ETA, minN: evo.minN || EVO_MIN_N, updatedAt: evo.updatedAt,
    mixedWeights: mix,
    experts: EXPERTS.map(e => ({
      id: e.id, name: e.name, prob: evo.probs[e.id] || 0,
      perf: evo.perf[e.id] || { trades: 0, correct: 0, pnl: 0 }
    })),
    top: top.map(([id, p]) => ({ id, name: EXPERTS.find(e => e.id === id).name, prob: p })),
    history: (evo.history || []).slice(-10)
  };
}

module.exports = { updateEvo, getEvoWeights, evoStatus, loadEvo, EXPERTS, DIMS };
