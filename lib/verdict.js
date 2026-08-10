'use strict';
// 本地智能引擎 — William 运算核心
// posture 计算器 / 8币 stance 引擎 / verdict 合成 / countdown 翻转条件
const MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

/* ---------------- posture 计算器（11 因子） ---------------- */
// 每个因子: {key,label_zh,label_en,score(-1..1),weight,value,detail_zh}
function postureFactors(inp) {
  const f = [];
  const fgi = num(inp.fgi, 50);
  // 升级v6.1：FGI 极端值非线性化——极端恐惧/贪婪时权重增强（市场极端情绪往往预示反转）
  let fgiScore = (fgi - 50) / 25;
  const fgiExtreme = Math.abs(fgi - 50);
  if (fgiExtreme > 20) fgiScore *= 1 + (fgiExtreme - 20) / 30; // >70或<30 时放大最多 2x
  f.push({
    key: 'fgi', label_zh: '恐惧贪婪指数', label_en: 'Fear & Greed',
    score: clamp(fgiScore, -1, 1), weight: 1.5,
    value: fgi, detail_zh: `FGI ${fgi}（${fgi <= 25 ? '极度恐惧' : fgi <= 45 ? '恐惧' : fgi <= 55 ? '中性' : fgi <= 75 ? '贪婪' : '极度贪婪'}）`
  });
  const fgi7 = num(inp.fgi_7d_delta, 0);
  f.push({
    key: 'fgi_momentum', label_zh: '情绪7日动量', label_en: 'FGI 7d momentum',
    score: clamp(fgi7 / 15, -1, 1), weight: 0.75,
    value: fgi7, detail_zh: `7日变化 ${fgi7 >= 0 ? '+' : ''}${Math.round(fgi7)}`
  });
  const dvol = num(inp.dvol, 0); // 8币 24h |涨跌| 均值
  f.push({
    key: 'volatility', label_zh: '24h 波动率', label_en: '24h volatility',
    score: clamp(-(dvol - 4) / 8, -1, 1), weight: 1.0,
    value: dvol, detail_zh: `主流币 24h 平均波动 ${dvol.toFixed(1)}%`
  });
  const funding = num(inp.funding_avg, 0); // 平均资金费率（小数）
  // 升级v6.1：费率分档评分——|费率|<0.01% 视为健康（评分平坦），过热区惩罚陡峭（非线性）
  const fAbs = Math.abs(funding);
  let fundingScore;
  if (fAbs <= 0.0001) fundingScore = 0;                    // 健康区：中性
  else if (fAbs <= 0.0004) fundingScore = -(fAbs - 0.0001) / 0.0003 * 0.5; // 温和：线性至 -0.5
  else fundingScore = -0.5 - (fAbs - 0.0004) / 0.0006 * 0.5; // 过热：加速惩罚至 -1
  fundingScore = funding < 0 ? -fundingScore : fundingScore; // 负费率（空头付费）对称处理
  f.push({
    key: 'funding_heat', label_zh: '资金费率热度', label_en: 'Funding heat',
    score: clamp(fundingScore, -1, 1), weight: 1.0,
    value: funding, detail_zh: `全市场OI加权费率 ${(funding * 100).toFixed(4)}%${funding > 0.0005 ? '（过热）' : funding < -0.0002 ? '（偏空付费）' : ''}`
  });
  const oi = num(inp.oi_change_24h, 0);
  const px = num(inp.price_change_24h, 0);
  let oiScore = 0;
  if (oi > 2 && px > 0) oiScore = 0.7;       // 量增价涨：建设性
  else if (oi > 2 && px < 0) oiScore = -0.4; // 量增价跌：踩踏风险
  else if (oi < -3) oiScore = -0.5;          // 去杠杆
  f.push({
    key: 'oi_change', label_zh: '持仓量变化', label_en: 'OI change',
    score: clamp(oiScore, -1, 1), weight: 0.75,
    value: oi, detail_zh: `OI 24h ${oi >= 0 ? '+' : ''}${oi.toFixed(1)}%`
  });
  const sc = num(inp.stablecoin_mcap_delta_pct, 0); // 稳定币/总市值替代指标
  f.push({
    key: 'stablecoin_flow', label_zh: '资金流替代指标', label_en: 'Flow proxy',
    score: clamp(sc / 2, -1, 1), weight: 1.0,
    value: sc, detail_zh: `总市值边际变化 ${sc >= 0 ? '+' : ''}${sc.toFixed(2)}%（ETF/稳定币替代）`
  });
  const etf = num(inp.etf_recent3_musd, 0);
  f.push({
    key: 'etf_flow', label_zh: 'ETF 近3日流', label_en: 'ETF 3d flow',
    score: clamp(etf / 500, -1, 1), weight: 1.25,
    value: etf, detail_zh: `近3日 ${etf >= 0 ? '+' : ''}${Math.round(etf)}M 美元（${inp.etf_based_on || '近似'}）`
  });
  const trader = num(inp.lsr_trader_skew, 0); // 主流币 trader_ratio 均值 -1
  f.push({
    key: 'lsr_trader', label_zh: '交易者多空比', label_en: 'Trader LSR',
    score: clamp(trader / 0.3, -1, 1), weight: 0.75,
    value: trader, detail_zh: `多空比偏离 ${trader >= 0 ? '+' : ''}${trader.toFixed(2)}`
  });
  const whale = num(inp.lsr_whale_skew, 0);
  f.push({
    key: 'lsr_whale', label_zh: '大户多空比', label_en: 'Whale LSR',
    score: clamp(whale / 0.3, -1, 1), weight: 0.75,
    value: whale, detail_zh: `大户偏离 ${whale >= 0 ? '+' : ''}${whale.toFixed(2)}`
  });
  const cons = num(inp.consensus_bias, 0);
  f.push({
    key: 'consensus', label_zh: 'KOL 共识偏向', label_en: 'KOL consensus',
    score: clamp(cons / 0.2, -1, 1), weight: 0.5,
    value: cons, detail_zh: `共识偏向 ${cons >= 0 ? '+' : ''}${cons.toFixed(3)}`
  });
  const cyc = num(inp.cycle_valuation, 0); // MVRV-Z 等周期估值（0 附近为中性，高=过热）
  f.push({
    key: 'cycle_valuation', label_zh: '周期估值', label_en: 'Cycle valuation',
    score: clamp(-cyc / 4, -1, 1), weight: 0.75,
    value: cyc, detail_zh: `周期估值读数 ${cyc.toFixed(2)}（越高越过热）`
  });
  return f;
}

function computePosture(inp, daysHeld = 0) {
  const factors = postureFactors(inp);
  const wsum = factors.reduce((s, f) => s + f.weight, 0);
  const raw = factors.reduce((s, f) => s + f.weight * f.score, 0) / wsum;
  const score = Math.round(clamp(raw * 5, -5, 5) * 10) / 10;
  const state = score >= 1.5 ? 'aggressive' : score <= -1.5 ? 'defensive' : 'neutral';

  // conviction：因子方向一致度
  const agree = factors.filter(f => (state === 'defensive' ? f.score < -0.05 : state === 'aggressive' ? f.score > 0.05 : Math.abs(f.score) < 0.3)).length;
  const ratio = agree / factors.length;
  const conviction = ratio >= 0.65
    ? { code: 'solid', zh: '信念稳固', en: 'Conviction solid' }
    : ratio >= 0.45
      ? { code: 'mixed', zh: '信念混合', en: 'Conviction mixed' }
      : { code: 'fragile', zh: '信念脆弱', en: 'Conviction fragile' };

  // flip trigger：找最接近把总分推过阈值的因子
  const threshold = state === 'aggressive' ? 1.5 : state === 'defensive' ? -1.5 : (score >= 0 ? 1.5 : -1.5);
  const gap = Math.abs(threshold - score);
  const contrib = factors.map(f => ({ f, room: (1 - Math.abs(f.score)) * f.weight / wsum * 5 }))
    .sort((a, b) => b.room - a.room)[0];
  const targetZh = state === 'defensive' ? '转中性' : state === 'neutral' ? (score >= 0 ? '转积极' : '转防御') : '转中性';
  const flip = {
    zh: `${contrib ? contrib.f.label_zh : '关键因子'}改善（当前${contrib ? contrib.f.detail_zh : ''}）→ ${targetZh}，距阈值约 ${gap.toFixed(1)} 分`,
    en: `${contrib ? contrib.f.label_en : 'Key factor'} improving → ${state === 'neutral' ? 'risk posture shift' : 'neutral'}, ~${gap.toFixed(1)} pts from threshold`
  };

  // 主因（|贡献| 前二）
  const top = factors.slice().sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score)).slice(0, 2);
  const stateZh = state === 'aggressive' ? '积极' : state === 'defensive' ? '防御' : '中性';
  const stateEn = state === 'aggressive' ? 'aggressive' : state === 'defensive' ? 'defensive' : 'neutral';
  return {
    score, state,
    days_held: daysHeld,
    conviction,
    factors,
    reason_zh: `${top.map(f => f.label_zh).join(' + ')}（偏${stateZh}）`,
    reason_en: `${top.map(f => f.label_en).join(' + ')} (${stateEn})`,
    flip_trigger_zh: flip.zh,
    flip_trigger_en: flip.en,
    inputs: {
      fgi: num(inp.fgi, null), dvol: num(inp.dvol, null),
      funding_avg: num(inp.funding_avg, null),
      etf_recent3_musd: num(inp.etf_recent3_musd, null),
      stablecoin_mcap_delta_pct: num(inp.stablecoin_mcap_delta_pct, null)
    },
    report_date: new Date().toISOString().slice(0, 10)
  };
}

/* ---------------- 8币 stance 引擎 ---------------- */
function computeStance(symbol, d) {
  // d: {price_24h, funding, trader_ratio, trader_delta_4h, whale_ratio, whale_delta_4h, consensus_bias}
  const px = num(d.price_24h, 0);
  const funding = num(d.funding, 0);
  const tRatio = d.trader_ratio == null ? null : num(d.trader_ratio);
  const tDelta = num(d.trader_delta_4h, 0);
  const wRatio = d.whale_ratio == null ? null : num(d.whale_ratio);
  const cons = num(d.consensus_bias, 0);
  // 升级v6.1：波动率自适应缩放——高波动市道下同样涨跌幅的信号意义减弱（噪音更大），低波动下增强
  const vol = num(d.vol_24h, 0); // 24h 波动率（%），无数据时 1 表示不缩放
  const volScale = vol > 0 ? (1 / (1 + vol / 12)) : 1; // 波动 12% 时缩放 0.5，4% 时 0.75
  const pxAdj = px * (volScale * 1.3);

  let score = 0, parts = 0;
  score += clamp(pxAdj / 6, -1, 1) * 0.35; parts += 0.35;
  score += clamp(-funding / 0.0008, -1, 1) * 0.15; parts += 0.15;
  if (tRatio != null) { score += clamp((tRatio - 1) / 0.5, -1, 1) * 0.15; parts += 0.15; }
  if (tDelta !== 0) { score += clamp(tDelta / 0.05, -1, 1) * 0.10; parts += 0.10; }
  if (wRatio != null) { score += clamp((wRatio - 1) / 0.5, -1, 1) * 0.15; parts += 0.15; }
  if (cons !== 0) { score += clamp(cons / 0.2, -1, 1) * 0.10; parts += 0.10; }
  score = parts > 0 ? score / parts : 0; // 归一到 -1..1

  const stance = score >= 0.35 ? 'bullish'
    : score >= 0.12 ? 'cautiously_bullish'
    : score > -0.12 ? 'neutral'
    : score > -0.35 ? 'cautiously_bearish' : 'bearish';
  const confidence = Math.round(clamp(0.35 + Math.abs(score) * 0.65, 0, 1) * 100) / 100;

  const stanceZh = { bullish: '看多', cautiously_bullish: '谨慎看多', neutral: '中性', cautiously_bearish: '谨慎看空', bearish: '看空' }[stance];
  const drivers = [];
  if (Math.abs(px) >= 2) drivers.push(`24h ${px >= 0 ? '+' : ''}${px.toFixed(1)}%`);
  if (Math.abs(funding) >= 0.0003) drivers.push(`全市场费率 ${(funding * 100).toFixed(3)}%`);
  if (tRatio != null && Math.abs(tRatio - 1) >= 0.15) drivers.push(`多空比 ${tRatio.toFixed(2)}`);
  if (wRatio != null && Math.abs(wRatio - 1) >= 0.15) drivers.push(`大户 ${wRatio.toFixed(2)}`);
  if (cons !== 0 && Math.abs(cons) >= 0.05) drivers.push(`KOL ${cons > 0 ? '偏多' : '偏空'}`);
  const headline_zh = drivers.length
    ? `${symbol} ${stanceZh}：${drivers.join('，')}。`
    : `${symbol} ${stanceZh}：价格与资金指标均无显著信号，维持观察。`;
  const headline_en = `${symbol} ${stance.replace(/_/g, ' ')}${drivers.length ? ' — ' + drivers.join(', ') : ', no strong signal'}.`;

  const status = Math.abs(score) >= 0.3 ? { code: 'strengthened', reason_zh: '多项指标同向，立场信号明确' }
    : Math.abs(score) < 0.1 ? { code: 'watch', reason_zh: '指标平淡，立场处于观察区' }
    : { code: 'steady', reason_zh: '指标温和同向，立场维持' };
  return { symbol, stance, confidence, score: Math.round(score * 100) / 100, headline_zh, headline_en, status, inputs: d };
}

/* ---------------- verdict 合成 ---------------- */
function synthesizeVerdict(posture, stances, prevDaily, official) {
  const bull = stances.filter(s => s.stance === 'bullish' || s.stance === 'cautiously_bullish').length;
  const bear = stances.filter(s => s.stance === 'bearish' || s.stance === 'cautiously_bearish').length;
  const n = stances.length || 1;

  let verdict;
  // 升级v6.1：引入多空差距强度——差距越大判断越果断；临界（差距≤1）时更倾向谨慎
  const bullBearGap = Math.abs(bull - bear);
  if (posture.state === 'aggressive' && bull >= n / 2) verdict = 'risk_on';
  else if (posture.state === 'defensive' && bear >= n / 2) verdict = 'risk_off';
  else if (posture.state === 'defensive' || bear > bull) verdict = 'cautious';
  else if (bull === bear && bullBearGap <= 1) verdict = 'neutral'; // 多空持平：中性
  else verdict = 'neutral';

  const verdictZh = { risk_on: '进攻', risk_off: '避险', cautious: '谨慎', neutral: '中性' }[verdict];
  const headline_zh = `姿态${posture.state === 'aggressive' ? '积极' : posture.state === 'defensive' ? '防御' : '中性'}（${posture.score}分），8币中 ${bull} 多 / ${bear} 空，整体判断：${verdictZh}。`;
  const headline_en = `Posture ${posture.state} (${posture.score}), ${bull} bullish / ${bear} bearish of ${n} coins. Verdict: ${verdict.replace('_', ' ')}.`;
  const rationale_zh = `姿态评分由 ${posture.reason_zh} 主导（${posture.conviction.zh}）。多空立场分布：看多 ${bull}、看空 ${bear}、中性 ${n - bull - bear}。${posture.flip_trigger_zh}。`;
  const rationale_en = `Score driven by ${posture.reason_en} (${posture.conviction.en}). Stances: ${bull} bullish, ${bear} bearish, ${n - bull - bear} neutral.`;

  const watchItems = [];
  if ((posture.inputs.fgi ?? 50) <= 30) watchItems.push('情绪走出恐惧区（FGI 回升至 45+）');
  if (bear > bull) watchItems.push('追踪币里出现更多同步转多信号');
  if ((posture.inputs.funding_avg ?? 0) > 0.0004) watchItems.push('资金费率降温，过热杠杆出清');
  if (!watchItems.length) watchItems.push('姿态评分向 ±1.5 阈值靠拢的因子变化');
  const watch_zh = watchItems.join('；');

  // whats_new：对比昨日库内数据
  const news = [];
  if (prevDaily) {
    try {
      const prevPosture = JSON.parse(prevDaily.posture_json || '{}');
      const prevStances = JSON.parse(prevDaily.stances_json || '[]');
      if (prevPosture.state && prevPosture.state !== posture.state) {
        news.push(`姿态由「${prevPosture.state}」转为「${posture.state}」`);
      } else if (prevPosture.score != null && Math.abs(prevPosture.score - posture.score) >= 0.8) {
        news.push(`姿态评分 ${prevPosture.score} → ${posture.score}`);
      }
      for (const s of stances) {
        const p = prevStances.find(x => x.symbol === s.symbol);
        if (p && p.stance !== s.stance) news.push(`${s.symbol} 立场 ${p.stance} → ${s.stance}`);
      }
      if (prevPosture.inputs && prevPosture.inputs.fgi != null && posture.inputs.fgi != null) {
        const dfgi = posture.inputs.fgi - prevPosture.inputs.fgi;
        if (Math.abs(dfgi) >= 5) news.push(`FGI ${prevPosture.inputs.fgi} → ${posture.inputs.fgi}（${dfgi > 0 ? '回暖' : '转冷'}）`);
      }
    } catch { /* 忽略昨日数据解析失败 */ }
  }
  const whats_new_zh = news.length ? news.join('；') : '与昨日相比无显著变化，延续既有判断。';

  // 与 William 归档值对照
  let divergence = null;
  if (official && official.verdict) {
    const ov = official.verdict.verdict || official.verdict;
    const ops = official.posture && official.posture.state;
    const map = { risk_on: 1, neutral: 0, cautious: -0.5, risk_off: -1 };
    const offMap = { risk_on: 1, greedy: 1, neutral: 0, cautious: -0.5, risk_off: -1, fearful: -1 };
    const mine = map[verdict] ?? 0;
    const theirs = offMap[ov] ?? 0;
    const diverged = Math.abs(mine - theirs) >= 0.75 || (ops && ops !== posture.state);
    divergence = {
      diverged,
      official_verdict: ov,
      official_posture_state: ops || null,
      note_zh: diverged
        ? `本地引擎（${verdict}/${posture.state}）与 William 归档（${ov}/${ops || '-'}）存在分歧，需人工复核因子权重。`
        : `本地引擎与 William 归档判断一致（${ov}）。`
    };
  }

  return {
    verdict, verdict_zh: verdictZh,
    headline_zh, headline_en,
    rationale_zh, rationale_en,
    watch_zh,
    watch_en: watchItems.length ? 'Watch: ' + watchItems.join('; ') : 'Watch factor drift toward thresholds',
    whats_new_zh,
    whats_new_en: news.length ? news.join('; ') : 'No material change vs yesterday.',
    divergence,
    stance_distribution: { bullish: bull, neutral: n - bull - bear, bearish: bear },
    verdict_days_held: posture.days_held,
    report_date: posture.report_date
  };
}

/* ---------------- countdown 翻转条件 ---------------- */
function computeCountdown(posture, stances, officialConditions) {
  const bull = stances.filter(s => s.stance.includes('bullish')).length;
  const fgi = posture.inputs.fgi ?? 50;
  const funding = posture.inputs.funding_avg ?? 0;
  // 升级v6.1：新增 OI 确认条件（持仓量回升 = 新资金进场）
  const oiChg = num(posture.inputs.oi_change_24h, 0);
  const target = posture.state === 'defensive' ? 'neutral' : posture.state === 'aggressive' ? 'neutral' : (posture.score >= 0 ? 'aggressive' : 'defensive');
  const conditions = [
    {
      key: 'oi', label_zh: '持仓', label_en: 'Open Interest',
      line_zh: '持仓量企稳回升（OI 24h ≥ 0），杠杆资金重新进场', line_en: 'OI stabilizing (24h ≥ 0), leverage returning',
      progress: Math.round(clamp((oiChg + 2) / 4, 0, 1) * 100) / 100,
      today_move: oiChg >= 2 ? 'done' : oiChg >= 0 ? 'closer' : 'none',
      distance_bucket: oiChg >= 2 ? '已达成' : oiChg >= 0 ? '已出现' : '仍在去杠杆'
    },
    {
      key: 'fgi', label_zh: '情绪', label_en: 'Sentiment',
      line_zh: '恐慌情绪真正退潮，走出恐惧区（FGI ≥ 45）', line_en: 'Fear genuinely receding (FGI ≥ 45)',
      progress: Math.round(clamp(fgi / 45, 0, 1) * 100) / 100,
      today_move: fgi >= 45 ? 'done' : fgi >= 35 ? 'closer' : 'none',
      distance_bucket: fgi >= 45 ? '已达成' : fgi >= 35 ? '还差一步' : '距离较远'
    },
    {
      key: 'stance', label_zh: '立场', label_en: 'Stance',
      line_zh: '更多追踪币同步转多（≥4/8），而非个别信号', line_en: 'More tracked coins turning bullish together (≥4/8)',
      progress: Math.round(clamp(bull / 4, 0, 1) * 100) / 100,
      today_move: bull >= 4 ? 'done' : bull >= 2 ? 'closer' : 'none',
      distance_bucket: bull >= 4 ? '已达成' : bull >= 2 ? '已出现' : '未出现'
    },
    {
      key: 'funding', label_zh: '杠杆', label_en: 'Leverage',
      line_zh: '资金费率回到健康区间（|平均费率| < 0.03%）', line_en: 'Funding back to healthy zone (|avg| < 0.03%)',
      progress: Math.round(clamp(1 - Math.abs(funding) / 0.0003, 0, 1) * 100) / 100,
      today_move: Math.abs(funding) < 0.0003 ? 'done' : 'none',
      distance_bucket: Math.abs(funding) < 0.0003 ? '已达成' : Math.abs(funding) < 0.0006 ? '还差一步' : '过热'
    },
    {
      key: 'flows', label_zh: '资金流', label_en: 'Flows',
      line_zh: 'ETF/稳定币资金转为净流入', line_en: 'ETF/stablecoin flows turn net positive',
      progress: Math.round(clamp(((posture.inputs.etf_recent3_musd ?? 0) + 500) / 1000, 0, 1) * 100) / 100,
      today_move: (posture.inputs.etf_recent3_musd ?? 0) > 0 ? 'closer' : 'none',
      distance_bucket: (posture.inputs.etf_recent3_musd ?? 0) > 0 ? '已出现' : '未出现'
    }
  ];
  const done = conditions.filter(c => c.today_move === 'done').length;
  return {
    target_state: target,
    intensity: { score_from: posture.score, score_to: posture.score, trend: 'steady' },
    overall_progress: Math.round(conditions.reduce((s, c) => s + c.progress, 0) / conditions.length * 100) / 100,
    conditions,
    note_zh: `距「${target === 'aggressive' ? '积极' : target === 'defensive' ? '防御' : '中性'}」还差 ${conditions.length - done} 项条件`,
    official: officialConditions || null
  };
}

module.exports = { MAJORS, computePosture, computeStance, synthesizeVerdict, computeCountdown, clamp, num };
