'use strict';
const { warn } = require('../log');
// ============================================================
// 机构级全球资产仪表盘分析 v1.0（2026-08-14）
//  - 输入：asset_prices 最新快照（Yahoo 采集）+ 加密衍生品（本地库）
//  - 输出：风险偏好 / 美元流动性 / 通胀预期 / 利率曲线 / 跨资产联动
//  - 视角：全球宏观对冲基金（桥水/文艺复兴式因子框架）
// ============================================================
const { assetOf } = require('../marketdata/universe');

/** 最新资产行情快照（按 symbol 索引；数据库 snake_case → 统一 camelCase） */
function latestAssets(db) {
  const rows = db.prepare(`
    SELECT p.* FROM asset_prices p
    JOIN (SELECT symbol, MAX(ts) mts FROM asset_prices GROUP BY symbol) q
      ON p.symbol=q.symbol AND p.ts=q.mts`).all();
  const map = {};
  for (const r of rows) {
    map[r.symbol] = {
      ...r,
      changePct: r.change_pct != null ? r.change_pct : r.changePct,
      prevClose: r.prev_close != null ? r.prev_close : r.prevClose
    };
  }
  return map;
}

/** 收益率曲线利差（bp）：10Y-2Y / 10Y-3M；缺少 2Y 时用 5Y 代替 */
function yieldCurve(map) {
  const tnx = map['^TNX'], fvx = map['^FVX'], irx = map['^IRX'];
  if (!tnx || !fvx || !irx) return null;
  return {
    y3m: irx.price, y5y: fvx.price, y10y: tnx.price,
    s10_5: +(tnx.price - fvx.price).toFixed(2),   // 10Y-5Y
    s10_3m: +(tnx.price - irx.price).toFixed(2),  // 10Y-3M（衰退预警经典指标）
    inverted: tnx.price < irx.price               // 倒挂
  };
}

/** 风险偏好评分（-100 极度避险 ~ +100 极度风险偏好；OKX 代理：UVXY=VIX方向、SPY=标普） */
function riskAppetite(map, fg) {
  const uvxy = map['UVXY-USDT-SWAP']; // VIX 2x ETF：涨=恐慌升，跌=恐慌降
  const spy = map['SPY-USDT-SWAP'];
  let score = 0, parts = [];
  if (uvxy && uvxy.changePct != null) {
    const c = uvxy.changePct;
    score += c > 5 ? -25 : c > 2 ? -12 : c > 0 ? -4 : c > -2 ? 4 : c > -5 ? 10 : 20;
    parts.push(`VIX代理 ${c > 0 ? '+' : ''}${c.toFixed(2)}%（${c > 5 ? '恐慌升温' : c > 2 ? '偏避险' : c > -2 ? '平稳' : c > -5 ? '回落' : '恐慌快速消退'}）`);
  }
  if (spy && spy.changePct != null) {
    const c = spy.changePct;
    score += c > 1 ? 15 : c > 0 ? 8 : c > -1 ? 0 : c > -2 ? -8 : -15;
    parts.push(`标普 ${c > 0 ? '+' : ''}${c.toFixed(2)}%`);
  }
  if (fg && fg.value != null) {
    score += (fg.value - 50) * 0.4; // FGI 50 为中性，±20
    parts.push(`加密FGI ${fg.value}（${fg.classification || ''}）`);
  }
  score = Math.max(-100, Math.min(100, Math.round(score)));
  const state = score >= 40 ? 'risk_on' : score >= 10 ? 'leaning_on' : score > -10 ? 'neutral' : score > -40 ? 'leaning_off' : 'risk_off';
  return { score, state, parts };
}

/** 通胀预期代理：油价 + 铜金比（铜/金 = 经济周期领先；OKX 符号） */
function inflationProxy(map) {
  const cl = map['CL-USDT-SWAP'], xau = map['XAU-USDT-SWAP'], xcu = map['XCU-USDT-SWAP'];
  const out = { oil: null, copperGold: null, note: '' };
  if (cl && cl.price != null) out.oil = { price: cl.price, chg: cl.changePct };
  if (xcu && xau && xau.price > 0) {
    const cg = xcu.price / xau.price;
    out.copperGold = +cg.toFixed(4);
    out.note = cg > 0.002 ? '铜金比偏高·再通胀交易活跃' : cg < 0.0013 ? '铜金比偏低·经济预期走弱' : '铜金比中性';
  }
  return out;
}

/** 美元强弱（OKX 无 DXY 永续，暂缺；FRED 配 key 后可补） */
function dollar(map) {
  return null;
}

/** 跨资产相关性（近 90 日日线，OKX 数据源；按需计算） */
async function correlationMatrix(symbols = ['BTC-USDT-SWAP', 'QQQ-USDT-SWAP', 'SPY-USDT-SWAP', 'XAU-USDT-SWAP', 'CL-USDT-SWAP']) {
  const okx = require('../marketdata/okx_market');
  const out = {};
  try {
    for (const s of symbols) {
      const kl = await okx.candles(s, '1D', 90);
      out[s] = kl.map(x => x.c);
      await new Promise(r => setTimeout(r, 250));
    }
    // 对齐最短序列
    const n = Math.min(...Object.values(out).map(a => a.length));
    const aligned = {};
    for (const s of symbols) aligned[s] = out[s].slice(-n);
    const corr = {};
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const a = aligned[symbols[i]], b = aligned[symbols[j]];
        const retA = [], retB = [];
        for (let k = 1; k < n; k++) { retA.push(a[k] / a[k - 1] - 1); retB.push(b[k] / b[k - 1] - 1); }
        corr[`${symbols[i]}|${symbols[j]}`] = +pearson(retA, retB).toFixed(2);
      }
    }
    return { n, corr };
  } catch (e) {
    warn('[asset_board] 相关性计算失败:', e.message);
    return null;
  }
}

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const u = x[i] - mx, v = y[i] - my; num += u * v; dx += u * u; dy += v * v; }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** 构建完整仪表盘（同步部分） */
function buildBoard(db) {
  const map = latestAssets(db);
  const fgRow = db.prepare('SELECT value,classification FROM fear_greed ORDER BY ts DESC LIMIT 1').get() || null;
  const curve = yieldCurve(map);
  const risk = riskAppetite(map, fgRow);
  const infl = inflationProxy(map);
  const dxy = dollar(map);
  const groups = {};
  for (const s of Object.keys(map)) {
    const def = assetOf(s);
    if (!def) continue;
    (groups[def.grp] = groups[def.grp] || []).push({
      symbol: s, zh: def.zh, price: map[s].price, chg: map[s].changePct,
      currency: map[s].currency, ts: map[s].ts
    });
  }
  // 市场宽度 + 涨跌榜（做单速览）
  const all = Object.values(map).filter(r => r.changePct != null);
  const breadth = { up: 0, down: 0, flat: 0 };
  for (const r of all) {
    if (r.changePct > 0.1) breadth.up++;
    else if (r.changePct < -0.1) breadth.down++;
    else breadth.flat++;
  }
  const movers = [...all].sort((a, b) => b.changePct - a.changePct);
  const ts = Object.values(map).reduce((m, r) => Math.max(m, r.ts || 0), 0);
  return {
    ts,
    updatedAt: ts ? new Date(ts * 1000).toISOString() : null,
    riskAppetite: risk,
    yieldCurve: curve,
    inflation: infl,
    dollar: dxy,
    breadth,
    topGainers: movers.slice(0, 5).map(r => ({ symbol: r.symbol, zh: (assetOf(r.symbol) || {}).zh || r.symbol, chg: r.changePct, price: r.price })),
    topLosers: movers.slice(-5).reverse().map(r => ({ symbol: r.symbol, zh: (assetOf(r.symbol) || {}).zh || r.symbol, chg: r.changePct, price: r.price })),
    groups
  };
}

module.exports = { buildBoard, latestAssets, correlationMatrix, yieldCurve, riskAppetite };
