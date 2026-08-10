'use strict';
// ============================================================
// 七宝因子引擎 qibao7.js（2026-08-10）
// 基于多因子量化框架构建的 7 因子评分：
//   ① 主力资金行为分析（建仓/整理/拉升）
//   ② 清算分布·支撑阻力（强平集中方向）
//   ③ 爆仓推动论（空头爆仓=被动买单推涨）
//   ④ 波动率体制（高波动放大 / 低波动抑制）
//   ⑤ 市商吸筹/派发（OI × 价格方向）
//   ⑥ 散户拥挤反向（LSR 极端 + 费率过热）
//   ⑦ 趋势体制（趋势破坏=震荡不反做）
// 每个因子 score ∈ [-1, +1]（正=偏多，负=偏空），权重加权 → 综合分 [-100, +100]
// 数据全部来自本地 w1.db（futures_markets），不依赖外部 API
// ============================================================
const { futuresSnapshots, priceSeries, trendFilter } = require('./signal');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const PROXY = process.env.HTTP_PROXY || process.env.http_proxy || 'http://127.0.0.1:7890';

/* ============ 全市场通用：Yahoo Finance 数据源（非加密标的） ============ */
const YAHOO_MAP = {
  XAU:'GC=F', GOLD:'GC=F', XAG:'SI=F', SILVER:'SI=F',
  OIL:'CL=F', WTI:'CL=F', BRENT:'BZ=F', CL:'CL=F', NG:'NG=F',
  SPX:'^GSPC', SP500:'^GSPC', NASDAQ:'^IXIC', IXIC:'^IXIC', DJI:'^DJI', DOW:'^DJI',
  HSI:'^HSI', HANG:'^HSI', N225:'^N225', DAX:'^GDAXI', VIX:'^VIX',
  USDJPY:'USDJPY=X', EURUSD:'EURUSD=X', GBPUSD:'GBPUSD=X', USDCNY:'USDCNY=X',
  US10Y:'^TNX', TNX:'^TNX', US2Y:'^IRX', IRX:'^IRX'
};
function toYahooSymbol(sym) {
  if (YAHOO_MAP[sym]) return YAHOO_MAP[sym];
  if (sym.includes('=') || sym.startsWith('^')) return sym;   // 已带后缀（EURUSD=X / ^GSPC）
  if (sym.endsWith('.US') || sym.endsWith('.us')) {           // 美股显式后缀（SNDK.US → SNDK）
    const b = sym.replace(/\.US$/i, '');
    return /^[A-Z]{1,5}$/.test(b) ? b : null;
  }
  if (/^[A-Z]{1,5}$/.test(sym)) return sym;                   // 美股代码（SNDK/NVDA/TSLA…）
  return null;
}
async function fetchYahooSeries(symbol, range = '6mo') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const { stdout } = await execFileP('curl', ['-s', '-m', '20', '--proxy', PROXY,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    '-H', 'Accept: application/json', url]);
  const d = JSON.parse(stdout);
  const r = d.chart && d.chart.result && d.chart.result[0];
  if (!r) throw new Error('Yahoo 无数据');
  const q = r.indicators.quote[0], ts = r.timestamp || [];
  const closes = [], vols = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close[i], v = q.volume ? q.volume[i] : 0;
    if (c != null && isFinite(c) && c > 0) { closes.push(c); vols.push(v || 0); }
  }
  if (!closes.length) throw new Error('Yahoo 无有效K线');
  return { meta: r.meta, closes, vols };
}
function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  if (g + l === 0) return 50;
  return 100 - 100 / (1 + g / l);
}
function obvSlope(closes, vols) {
  if (!closes || !vols || closes.length < 30 || vols.length < 30) return 0;
  const obvs = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obvs.push(obvs[i - 1] + vols[i]);
    else if (closes[i] < closes[i - 1]) obvs.push(obvs[i - 1] - vols[i]);
    else obvs.push(obvs[i - 1]);
  }
  const now = obvs[obvs.length - 1], ago = obvs[obvs.length - 21];
  return ago ? (now - ago) / Math.abs(ago) : 0;
}
function volRatio(vols, n = 20) {
  if (!vols || vols.length < n + 1) return 1;
  const last = vols[vols.length - 1], avg = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n;
  if (!avg) return 1;
  const r = last / avg;
  return Math.max(0.3, Math.min(3, r));   // 截断 0.3~3，防期货/衍生品 volume 异常值
}

/* ---------- 因子1：量能结构（缩量整理 vs 放量派发） ---------- */
function factorWashout(c) {
  const volChg = Number(c.volume_change_percent_24h || 0); // 量能24h变化%
  const chg24 = Number(c.price_change_percent_24h || 0);   // 价格24h变化%
  let score, state, tip;
  if (chg24 < -0.3) {
    if (volChg < 0)      { score = 0.8; state = '缩量整理';     tip = '缩量阴跌=主力整理，关键支撑未破可持有'; }
    else if (volChg > 40){ score = -0.9; state = '出货';    tip = '放量下跌=资金派发，避免盲目抄底'; }
    else                 { score = 0.2; state = '疑似整理'; tip = '下跌但量能温和，观察支撑承接'; }
  } else if (chg24 > 0.3) {
    if (volChg > 30)     { score = 0.6; state = '拉升';     tip = '放量上涨=拉升启动，回踩可跟'; }
    else                 { score = 0.1; state = '缓涨';     tip = '缩量上涨动能弱，谨防诱多'; }
  } else {
    if (Math.abs(volChg) < 20) { score = 0.3; state = '横盘吸筹'; tip = '低位缩量横盘=主力吸筹，别割肉'; }
    else                        { score = -0.2; state = '横盘异动'; tip = '横盘放量=变盘前兆，等方向'; }
  }
  return { score, state, tip, detail: `量能24h ${volChg >= 0 ? '+' : ''}${volChg.toFixed(0)}% / 价格 ${chg24 >= 0 ? '+' : ''}${chg24.toFixed(2)}%` };
}

/* ---------- 因子2：强平分布方向（哪边支撑/阻力更厚） ---------- */
function factorLiqWall(c) {
  const long24 = Number(c.long_liquidation_usd_24h || 0);
  const short24 = Number(c.short_liquidation_usd_24h || 0);
  const total = long24 + short24;
  if (total < 1e5) return { score: 0, state: '清算稀疏', tip: '24h清算量小，暂无急跌操作机会' };
  const longPct = long24 / total;
  let score, state, tip;
  if (longPct > 0.6)      { score = 0.7; state = '下方强平集中'; tip = '多头爆仓集中在下方=下探后存在技术性反弹'; }
  else if (longPct < 0.4) { score = -0.7; state = '上方强平集中'; tip = '空头爆仓集中在上方=冲高后容易回落'; }
  else                    { score = 0; state = '清算均衡'; tip = '多空清算均衡，等待方向明朗再入场'; }
  return { score, state, tip, detail: `24h多爆${(longPct * 100).toFixed(0)}%/空爆${((1 - longPct) * 100).toFixed(0)}%` };
}

/* ---------- 因子3：短期强平动能（当下强平方向） ---------- */
function factorLiqMomentum(c) {
  const long1h = Number(c.long_liquidation_usd_1h || 0);
  const short1h = Number(c.short_liquidation_usd_1h || 0);
  const total24 = Number(c.liquidation_usd_24h || 0) || 1;
  const total1h = long1h + short1h;
  if (total1h < 1e4) return { score: 0, state: '无明显强平', tip: '近1h清算极少，行情平静' };
  const spike = total1h / total24; // 1h 清算占 24h 比例 = 强平集中度
  let dir = 0;
  if (long1h > short1h * 1.5) dir = -1;       // 多头正在被爆 → 下杀中
  else if (short1h > long1h * 1.5) dir = 1;   // 空头正在被爆 → 上攻中
  const score = dir * Math.min(0.3 + spike * 1.5, 1);
  const state = dir > 0 ? '空头强平集中' : dir < 0 ? '多头强平集中' : '强平均衡';
  const tip = dir > 0 ? '空头强平推动价格上涨，顺势操作' : dir < 0 ? '多头强平砸盘，盲目抄底风险高' : '1h清算均衡';
  return { score, state, tip, detail: `1h清算占24h ${(spike * 100).toFixed(0)}%` };
}

/* ---------- 因子4：波动率体制（高波动放大 / 低波动抑制） ----------
 * 加密无直接 Gamma 数据，用「波动率 + 清算同向反馈」近似：
 *   高波动 + 同向清算放大（跌越多爆越多）= 空Gamma → 别追单，急跌后企稳才有操作空间
 *   低波动 + 清算均衡 = 多Gamma → 波动被抑制，顺势空间小 */
function factorGamma(c, arr) {
  const chg24 = Math.abs(Number(c.price_change_percent_24h || 0));
  const px = arr && arr.length ? arr[arr.length - 1] : 0;
  const vol = arr && arr.length > 3 && px > 0
    ? (Math.max(...arr.slice(-6)) - Math.min(...arr.slice(-6))) / px * 100 : chg24;
  const long24 = Number(c.long_liquidation_usd_24h || 0);
  const short24 = Number(c.short_liquidation_usd_24h || 0);
  const total = long24 + short24;
  const imbalance = total > 1e5 ? Math.abs(long24 - short24) / total : 0;
  const chgSign = Number(c.price_change_percent_24h || 0) > 0 ? 1 : -1;
  // 同向放大：下跌时多头爆仓多（越跌越爆）或上涨时空头爆仓多（越涨越爆）
  const amplifying = (chgSign > 0 && short24 > long24 * 1.3) || (chgSign < 0 && long24 > short24 * 1.3);
  if (vol > 1.5 && amplifying) return { score: -0.5, state: '高波动放大区', tip: '高波动放大状态：涨推涨跌砸跌，追单风险大，等待急跌企稳' };
  if (vol < 0.8 && imbalance < 0.3) return { score: 0.4, state: '低波动稳定区', tip: '低波动抑制状态：波动被压制，顺势空间有限' };
  return { score: 0, state: '波动中性', tip: '波动状态中性，按常规逻辑操作' };
}

/* ---------- 因子5：吸筹/派发（OI × 价格方向，市商成本区判别） ---------- */
function factorAccum(c) {
  const oiChg = Number(c.open_interest_change_percent_24h || 0);
  const chg24 = Number(c.price_change_percent_24h || 0);
  let score, state, tip;
  if (oiChg > 2 && chg24 > 0.3)  { score = 0.7; state = '吸筹拉升'; tip = '增仓上涨=新多进场，趋势健康'; }
  else if (oiChg > 2 && chg24 < -0.3) { score = -0.6; state = '增仓下跌'; tip = '增仓下跌=新空进场，避免盲目抄底'; }
  else if (oiChg < -2 && chg24 > 0.3) { score = -0.4; state = '减仓上涨'; tip = '减仓上涨=空头离场反弹，持续性存疑'; }
  else if (oiChg < -2 && chg24 < -0.3) { score = 0.5; state = '减仓下跌'; tip = '减仓下跌=多头离场，抛压衰竭接近尾声'; }
  else { score = 0.1; state = '持仓平稳'; tip = 'OI变化小，无明确吸筹/派发'; }
  return { score, state, tip, detail: `OI 24h ${oiChg >= 0 ? '+' : ''}${oiChg.toFixed(1)}%` };
}

/* ---------- 因子6：多空拥挤（散户情绪反向指标：LSR极端 + 费率过热） ---------- */
function factorCrowding(c) {
  const lsr = Number(c.long_short_ratio_4h || 0);
  // avg_funding_rate_by_oi 单位已是百分数（如 0.0063 = 0.0063%），勿再乘 100
  const funding = Number(c.avg_funding_rate_by_oi || 0); // %
  let score = 0;
  const parts = [];
  if (lsr > 1.5) { score -= 0.5; parts.push('散户多头拥挤'); }
  else if (lsr < 0.67) { score += 0.5; parts.push('散户空头拥挤'); }
  if (funding > 0.1) { score -= 0.4; parts.push('费率过热(多头付费)'); }
  else if (funding < -0.01) { score += 0.4; parts.push('费率倒挂(空头付费)'); }
  if (!parts.length) return { score: 0, state: '情绪均衡', tip: 'LSR与费率正常，无拥挤反向信号', detail: `LSR4h ${lsr.toFixed(2)} / 费率 ${funding >= 0 ? '+' : ''}${funding.toFixed(4)}%` };
  const state = parts.join('+');
  const tip = score < 0 ? '散户扎堆做多，警惕主力反向收割' : '散户扎堆做空，反弹概率大';
  return { score, state, tip, detail: `LSR4h ${lsr.toFixed(2)} / 费率 ${funding >= 0 ? '+' : ''}${funding.toFixed(4)}%` };
}

/* ---------- 因子7：趋势体制（趋势破坏=震荡不反做） ---------- */
function factorRegime(arr) {
  const trend = trendFilter(arr);
  if (trend === 'long')  return { score: 0.8, state: '多头趋势', tip: '趋势完整，回踩均线/前低可考虑做多' };
  if (trend === 'short') return { score: -0.8, state: '空头趋势', tip: '趋势完整，反弹破位可考虑做空' };
  return { score: 0, state: '震荡整理', tip: '趋势破坏后是震荡不是反转，等待方向明朗再入场' };
}

/* ---------- 全市场通用因子（非加密：Yahoo 日线等价替代） ---------- */
function atrVal(closes, n = 14) {
  if (closes.length < n + 1) return 0;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += Math.abs(closes[i] - closes[i - 1]);
  return s / n;
}
function buildCtx(y) {
  const closes = y.closes, vols = y.vols;
  const last = closes[closes.length - 1];
  const chg1d = closes.length > 1 ? (last - closes[closes.length - 2]) / closes[closes.length - 2] * 100 : 0;
  const chg5d = closes.length > 5 ? (last - closes[closes.length - 6]) / closes[closes.length - 6] * 100 : 0;
  const chg20d = closes.length > 20 ? (last - closes[closes.length - 21]) / closes[closes.length - 21] * 100 : 0;
  const hi20 = Math.max(...closes.slice(-20)), lo20 = Math.min(...closes.slice(-20));
  return { closes, vols, last, chg1d, chg5d, chg20d, hi20, lo20,
    atrPct: atrVal(closes) / last * 100, rsi14: calcRSI(closes, 14),
    volR: volRatio(vols), obv: obvSlope(closes, vols) };
}
function uWashout(ctx) {
  const { chg1d, volR } = ctx;
  if (chg1d < -1.5) {
    if (volR < 0.8) return { score: 0.8, state: '缩量回调', tip: '缩量回调=主力整理，关键支撑未破可持有', detail: `量比 ${volR.toFixed(2)} / 日跌 ${chg1d.toFixed(2)}%` };
    if (volR > 1.6) return { score: -0.9, state: '放量下杀', tip: '放量下跌=资金派发，避免盲目抄底', detail: `量比 ${volR.toFixed(2)} / 日跌 ${chg1d.toFixed(2)}%` };
    return { score: 0.2, state: '下跌量能温和', tip: '下跌但量能温和，观察支撑承接', detail: `量比 ${volR.toFixed(2)}` };
  }
  if (chg1d > 1.5) {
    if (volR > 1.4) return { score: 0.6, state: '放量拉升', tip: '放量上涨=拉升启动，回踩可跟', detail: `量比 ${volR.toFixed(2)} / 日涨 ${chg1d.toFixed(2)}%` };
    return { score: 0.1, state: '缩量上涨', tip: '缩量上涨动能弱，谨防诱多', detail: `量比 ${volR.toFixed(2)}` };
  }
  if (Math.abs(chg1d) <= 1.5 && volR < 1.2) return { score: 0.3, state: '横盘整理', tip: '窄幅缩量=整理蓄势，等突破方向', detail: `量比 ${volR.toFixed(2)}` };
  return { score: -0.2, state: '横盘放量', tip: '横盘放量=变盘前兆，等方向', detail: `量比 ${volR.toFixed(2)}` };
}
function uLiqWall(ctx) {
  const { last, hi20, lo20 } = ctx;
  const range = hi20 - lo20 || 1;
  const pos = (last - lo20) / range;
  if (pos > 0.9) return { score: -0.7, state: '逼近上方压力区', tip: '价格贴近20日高点=上方压力较重，冲高易回落', detail: `20日区间位置 ${(pos * 100).toFixed(0)}%` };
  if (pos < 0.1) return { score: 0.7, state: '贴近下方支撑区', tip: '价格贴近20日低点=下方承接较强，下探有反弹', detail: `20日区间位置 ${(pos * 100).toFixed(0)}%` };
  return { score: 0, state: '区间中段', tip: '价格处于区间中段，等待靠近支撑/阻力再行动', detail: `20日区间位置 ${(pos * 100).toFixed(0)}%` };
}
function uLiqMom(ctx) {
  const { chg5d, volR } = ctx;
  if (chg5d > 12 && volR > 1.3) return { score: -0.6, state: '短线过热冲高', tip: '5日急涨+放量=追高盘拥挤，谨防回踩', detail: `5日 ${chg5d.toFixed(1)}%` };
  if (chg5d < -12 && volR > 1.3) return { score: 0.6, state: '短线超跌恐慌', tip: '5日急跌+放量=恐慌宣泄，超跌反弹概率大', detail: `5日 ${chg5d.toFixed(1)}%` };
  return { score: 0, state: '动能平稳', tip: '5日动能正常，无明显强平', detail: `5日 ${chg5d.toFixed(1)}%` };
}
function uGamma(ctx) {
  const { atrPct, volR } = ctx;
  if (atrPct > 3.5) return { score: -0.5, state: '高波动放大区', tip: '波动率高位，追单风险大，等待回踩/反弹确认', detail: `ATR ${atrPct.toFixed(1)}%` };
  if (atrPct < 1.2 && volR < 1.1) return { score: 0.4, state: '低波动稳定区', tip: '波动率低位，顺势空间有限，等待突破', detail: `ATR ${atrPct.toFixed(1)}%` };
  return { score: 0, state: '波动中性', tip: '波动率正常', detail: `ATR ${atrPct.toFixed(1)}%` };
}
function uAccum(ctx) {
  const { obv, chg5d } = ctx;
  if (obv > 0.05 && chg5d > 0) return { score: 0.7, state: '量能流入(吸筹)', tip: 'OBV上行+价格走强=资金吸筹，趋势健康', detail: `OBV斜率 ${obv > 0 ? '+' : ''}${(obv * 100).toFixed(0)}%` };
  if (obv < -0.05 && chg5d < 0) return { score: -0.6, state: '量能流出(派发)', tip: 'OBV下行+价格走弱=资金派发，避免盲目抄底', detail: `OBV斜率 ${(obv * 100).toFixed(0)}%` };
  if (obv < -0.05) return { score: -0.4, state: '量价背离', tip: '价格涨但量能流出=背离，持续性存疑', detail: `OBV斜率 ${(obv * 100).toFixed(0)}%` };
  return { score: 0.1, state: '量能平稳', tip: 'OBV无明确方向', detail: `OBV斜率 ${(obv * 100).toFixed(0)}%` };
}
function uCrowd(ctx) {
  const { rsi14 } = ctx;
  if (rsi14 > 75) return { score: -0.5, state: '超买拥挤', tip: 'RSI超买=多头拥挤，警惕回落', detail: `RSI14 ${rsi14.toFixed(0)}` };
  if (rsi14 < 25) return { score: 0.5, state: '超卖恐慌', tip: 'RSI超卖=空头拥挤，反弹概率大', detail: `RSI14 ${rsi14.toFixed(0)}` };
  return { score: 0, state: '情绪中性', tip: 'RSI正常区间', detail: `RSI14 ${rsi14.toFixed(0)}` };
}
function uRegime(ctx) {
  const trend = trendFilter(ctx.closes);
  if (trend === 'long') return { score: 0.8, state: '多头趋势', tip: '趋势完整，回踩均线/前低可考虑做多' };
  if (trend === 'short') return { score: -0.8, state: '空头趋势', tip: '趋势完整，反弹破位可考虑做空' };
  return { score: 0, state: '震荡整理', tip: '趋势破坏后是震荡不是反转，等待方向明朗再入场' };
}

/* ---------- 因子注册表 ---------- */
const FACTORS = [
  { key: 'washout', name: '量能结构', emoji: '🧹', w: 1.2, fn: factorWashout },
  { key: 'liqwall', name: '强平分布', emoji: '🎯', w: 1.0, fn: factorLiqWall },
  { key: 'liqmom',  name: '强平动能', emoji: '⚡', w: 0.8, fn: factorLiqMomentum },
  { key: 'gamma',   name: '波动率体制', emoji: '🏦', w: 0.8, fn: factorGamma },
  { key: 'accum',   name: '量能吸筹/派发', emoji: '📊', w: 1.0, fn: factorAccum },
  { key: 'crowd',   name: '多空拥挤', emoji: '👥', w: 0.7, fn: factorCrowding },
  { key: 'regime',  name: '趋势体制', emoji: '🔄', w: 1.0, fn: factorRegime },
];
const UNIVERSAL_FACTORS = [
  { key: 'washout', name: '量能结构', emoji: '🧹', w: 1.2, fn: uWashout },
  { key: 'liqwall', name: '支撑/阻力墙', emoji: '🎯', w: 1.0, fn: uLiqWall },
  { key: 'liqmom',  name: '动量脉冲', emoji: '⚡', w: 0.8, fn: uLiqMom },
  { key: 'gamma',   name: '波动率体制', emoji: '🏦', w: 0.8, fn: uGamma },
  { key: 'accum',   name: '量能吸筹/派发', emoji: '📊', w: 1.0, fn: uAccum },
  { key: 'crowd',   name: '多空拥挤', emoji: '👥', w: 0.7, fn: uCrowd },
  { key: 'regime',  name: '趋势体制', emoji: '🔄', w: 1.0, fn: uRegime },
];

/* ---------- 综合评分 ---------- */
function totalScore(factors) {
  let s = 0, w = 0;
  for (const f of factors) { s += f.score * f.w; w += f.w; }
  return Math.round(s / w * 100);
}
function conclusion(score) {
  if (score >= 35) return { label: '🔴 偏多', note: '多因子共振偏多，回踩关键位接多（企稳确认更佳）' };
  if (score >= 15) return { label: '🟠 中性偏多', note: '多头占优但未共振，轻仓试探，止损跟上' };
  if (score <= -35) return { label: '🔵 偏空', note: '多因子共振偏空，反弹至阻力/压力区附近做空' };
  if (score <= -15) return { label: '🟣 中性偏空', note: '空头占优但未共振，反弹做空，快进快出' };
  return { label: '⚪ 震荡观望', note: '因子互相矛盾/均中性：趋势震荡整理中，不入场，等待方向明朗' };
}
function marketLabel(m) {
  if (m === 'crypto') return '加密';
  if (m === 'EQUITY') return '美股';
  if (m === 'INDEX') return '指数';
  if (m === 'CURRENCY') return '外汇';
  if (m === 'FUTURE') return '商品/期货';
  if (m === 'ETF') return 'ETF';
  return m || '市场';
}

/* ---------- 市场分类：加密集合 / 美股集合 / 商品指数集合 ---------- */
const CRYPTO_SET = new Set(['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','LINK','LTC','BCH','AVAX','NEAR','SUI','AAVE','UNI','TRX','XLM','XMR','ZEC','PEPE','ENA','ONDO','HYPE','TAO','WLD','CRCL','LIT','PAXG','XAUT','ASTER','SKHX','SKHY','SKHYNIX','PUMP','XYZ100','SPCX','FARTCOIN','TST']);
const STOCK_SET = new Set(['SNDK','NVDA','MU','GOOGL','SOXL','TSLA','AAPL','MSFT','AMZN','META','AMD','INTC','PLTR','SMCI','AVGO','QCOM','TXN','WDC','STX']);
const COMMODITY_SET = new Set(['XAU','GOLD','SILVER','XAG','CL','OIL','BZ','BRENTOIL','SP500','SPX','NG','COPPER','WTI']);
function marketOf(sym) {
  const s = String(sym || '').toUpperCase();
  if (s.endsWith('USDT')) return 'crypto';
  if (CRYPTO_SET.has(s)) return 'crypto';
  if (STOCK_SET.has(s) || s.endsWith('.US')) return 'stock';
  if (COMMODITY_SET.has(s)) return 'commodity';
  if (YAHOO_MAP[s]) return 'other';
  if (s.includes('=') || s.startsWith('^')) return 'other';
  if (/^[A-Z]{1,5}$/.test(s)) return 'stock';   // 纯字母代码默认按美股尝试
  return 'unknown';
}

/* ---------- 双通道报告：加密走 W1，非加密走 Yahoo ---------- */
function qibaoReport(db, symbol = 'BTC') {
  const sym = String(symbol || 'BTC').toUpperCase().replace(/USDT$/, '');
  const snaps = futuresSnapshots(db, 30);
  const cur = snaps.length ? snaps[snaps.length - 1] : null;
  const coin = cur && cur.m.get(sym);
  if (!coin) return { ok: false, error: `无 ${sym} 数据`, market: null };
  const arr = priceSeries(snaps, sym);
  const factors = FACTORS.map(f => {
    const r = f.fn(coin, arr);
    return { key: f.key, name: f.name, emoji: f.emoji, w: f.w, score: +r.score.toFixed(2), state: r.state, tip: r.tip, detail: r.detail || '' };
  });
  const score = totalScore(factors);
  const con = conclusion(score);
  return {
    ok: true, symbol: sym, market: 'crypto', market_label: '加密',
    price: Number(coin.current_price || 0), chg24: Number(coin.price_change_percent_24h || 0),
    score, label: con.label, note: con.note, factors, ts: cur ? cur.ts : null
  };
}
async function qibaoReportAsync(db, symbol = 'BTC') {
  let sym = String(symbol || 'BTC').toUpperCase().replace(/USDT$/, '');
  const mkt = marketOf(sym);
  // 1) 加密 → 本地 W1 期货快照
  if (mkt === 'crypto') {
    const crypto = qibaoReport(db, sym);
    if (crypto.ok) return crypto;
  }
  // 2) 非加密（美股/商品/外汇/指数）→ Yahoo Finance 真实日线
  if (mkt === 'stock' && sym.endsWith('.US')) sym = sym.replace(/\.US$/, '');
  const ysym = toYahooSymbol(sym);
  if (!ysym) return { ok: false, error: `无 ${sym} 数据（非加密标的需要美股代码或带后缀，如 NVDA / EURUSD=X / ^GSPC / GC=F）`, market: null };
  try {
    const y = await fetchYahooSeries(ysym, '6mo');
    const ctx = buildCtx(y);
    const factors = UNIVERSAL_FACTORS.map(f => {
      const r = f.fn(ctx);
      return { key: f.key, name: f.name, emoji: f.emoji, w: f.w, score: +r.score.toFixed(2), state: r.state, tip: r.tip, detail: r.detail || '' };
    });
    const score = totalScore(factors);
    const con = conclusion(score);
    const m = y.meta.instrumentType;
    return {
      ok: true, symbol: sym, market: m, market_label: marketLabel(m),
      price: ctx.last, chg24: ctx.chg1d,
      score, label: con.label, note: con.note, factors,
      ts: Math.floor(Date.now() / 1000), yahoo_symbol: ysym
    };
  } catch (e) {
    return { ok: false, error: `Yahoo 取数失败 ${sym}: ${e.message}`, market: 'yahoo' };
  }
}

/* ---------- 多币扫描（8 大币评分一览） ---------- */
const SCAN_SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'LINK'];
function listReport(db) {
  const out = [];
  for (const sym of SCAN_SYMBOLS) {
    try {
      const r = qibaoReport(db, sym);
      if (r.ok) out.push({ symbol: sym, score: r.score, label: r.label, price: r.price, chg24: r.chg24 });
    } catch {}
  }
  return { ok: true, ts: Math.floor(Date.now() / 1000), rows: out };
}

/* ---------- QQ 消息格式化 ---------- */
function qibaoMessage(r) {
  if (!r.ok) return `【W1·七宝因子】${r.error}`;
  const L = [];
  L.push(`【W1·七宝因子】${r.symbol}（${r.market_label}） ${r.price ? '$' + r.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : ''} (${r.chg24 >= 0 ? '+' : ''}${r.chg24.toFixed(2)}%)`);
  L.push(`综合 ${r.score >= 0 ? '+' : ''}${r.score} ｜ ${r.label}`);
  L.push('━━━━━━━━━━');
  for (const f of r.factors) {
    const arrow = f.score > 0.15 ? '▲' : f.score < -0.15 ? '▼' : '◆';
    L.push(`${f.emoji} ${f.name} ${arrow} ${f.state}${f.detail ? '（' + f.detail + '）' : ''}`);
    L.push(`　 ↳ ${f.tip}`);
  }
  L.push('━━━━━━━━━━');
  L.push(`📌 ${r.note}`);
  L.push('⚠️ 仅供研究参考，不构成投资建议');
  return L.join('\n');
}

module.exports = { qibaoReport, qibaoReportAsync, qibaoMessage, listReport, FACTORS, UNIVERSAL_FACTORS, totalScore };
