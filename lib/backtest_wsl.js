'use strict';
// WSL 策略回测引擎（P0：回测接入主引擎）
// 复用主引擎同一套求值链路：buildCtx + FN + wsl.parse/evaluate + dirFixAst
// 出场逻辑与 runExits 对齐：structure → time_stop → chandelier → stop → target，partial 减半+保本
// 数据源：Gate API 分段拉取（单次 ≤1000 点），支持任意历史窗口
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const wsl = require('./wsl');
const { buildCtx, dirFixAst } = require('./engine');

const STRAT_DIR = path.join(__dirname, '..', 'strategies');
const FEE = 0.0005; // 单边手续费 0.05%

// ---------- 分段拉取 K 线（Gate 单次 ≤1000 点） ----------
async function fetchKL(sym, tf, from, to) {
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym}_USDT&interval=${tf}&from=${from}&to=${to}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`kline ${sym} ${tf} http ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error(`kline ${sym} ${tf} 返回异常: ${JSON.stringify(arr).slice(0, 120)}`);
  return arr.map(c => ({ t: +c[0], o: +c[5], h: +c[3], l: +c[4], c: +c[2], v: +c[6] })).sort((a, b) => a.t - b.t);
}
async function fetchKLRange(sym, tf, days) {
  const to = Math.floor(Date.now() / 1000);
  const secs = tf === '1d' ? 86400 : tf === '4h' ? 14400 : 3600;
  const chunkSecs = 999 * secs; // 每段 <1000 点
  const out = [];
  let cur = to - days * 86400;
  while (cur < to) {
    const end = Math.min(cur + chunkSecs, to);
    try { out.push(...await fetchKL(sym, tf, cur, end)); } catch (e) { console.warn(`[bt] ${sym} ${tf} 分段失败: ${e.message}`); }
    cur = end;
    await new Promise(r => setTimeout(r, 200)); // 限速
  }
  const map = new Map(out.map(b => [b.t, b]));
  return [...map.values()].sort((a, b) => a.t - b.t);
}

// ---------- 策略加载 ----------
function loadStrat(id) {
  const f = id === 'ST' ? 'st_evo.wsl.yaml' : 'funding_reversal.wsl.yaml';
  const st = yaml.load(fs.readFileSync(path.join(STRAT_DIR, f), 'utf8'));
  if (st.meta.id !== id) throw new Error(`策略文件不匹配: 期望 ${id} 实际 ${st.meta.id}`);
  return st;
}

// ---------- 单策略回测 ----------
// 预加载历史因子（funding/lsr），FR 回测用；无 db 时返回空（FR 退化为 0 信号，安全）
function loadFactorHistory(db, sym) {
  const out = { funding: [], lsr: [] };
  if (!db) return out;
  try {
    const fr = db.prepare('SELECT ts, funding_rate FROM funding_history WHERE symbol=? ORDER BY ts').all(sym);
    out.funding = fr.map(r => ({ ts: r.ts, v: r.funding_rate }));
    const lsym = sym + 'USDT';
    const lr = db.prepare(`SELECT ts, ratio, trader_ratio, whale_ratio, delta_2m, delta_4h, trader_delta_4h, whale_delta_4h, long_notional, short_notional
      FROM lsr_history WHERE symbol=? ORDER BY ts`).all(lsym);
    out.lsr = lr.map(r => ({ ts: r.ts, ratio: r.ratio, trader_ratio: r.trader_ratio, whale_ratio: r.whale_ratio,
      delta_2m: r.delta_2m, delta_4h: r.delta_4h, trader_delta_4h: r.trader_delta_4h, whale_delta_4h: r.whale_delta_4h,
      long_notional: r.long_notional, short_notional: r.short_notional }));
  } catch (e) { console.warn(`[bt] 历史因子加载失败: ${e.message}`); }
  return out;
}
function zscoreArrShort(arr) {
  const n = arr.length;
  if (n < 5) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return sd === 0 ? 0 : (arr[n - 1] - m) / sd;
}

async function backtest(sym, stratId, days = 90, opts = {}) {
  const st = loadStrat(stratId);
  const signalTf = st.meta.signal_tf || '1h';
  const ex = st.exit;
  const riskPct = Number(st.risk.risk_pct) || 1;
  const t0 = Date.now();

  console.log(`[bt] ${sym} ${stratId} 回测窗口 ${days} 天（signal_tf=${signalTf}）...`);
  const [kSig, k4h, k1d] = await Promise.all([
    fetchKLRange(sym, signalTf, days),
    fetchKLRange(sym, '4h', days + 10),
    fetchKLRange(sym, '1d', Math.min(days + 60, 400))
  ]);
  console.log(`[bt] 数据: ${signalTf}=${kSig.length}根 4h=${k4h.length}根 1d=${k1d.length}根 (${((Date.now()-t0)/1000).toFixed(1)}s)`);
  if (kSig.length < 150) throw new Error(`${sym} ${signalTf} 数据不足: ${kSig.length}`);

  const stubDb = { prepare: () => ({ get: () => null, all: () => [], run: () => {} }) };
  const hist = loadFactorHistory(opts.db || null, sym);
  const entryAstL = wsl.parse(st.entry.long);
  const entryAstS = wsl.parse(st.entry.short);
  const stopAst = ex.stop ? wsl.parse(ex.stop) : null;
  const targetAst = ex.target ? wsl.parse(ex.target) : null;
  const structureAst = ex.structure ? wsl.parse(ex.structure) : null;
  const chandelierK = Number(ex.chandelier && ex.chandelier.k) || 3;
  const chandelierTf = (ex.chandelier && ex.chandelier.tf) || '1h';
  const timeBars = Number(ex.time_stop && ex.time_stop.bars) || 120;
  const timeMinR = Number(ex.time_stop && ex.time_stop.min_R) || 0;
  const partialAtR = Number(ex.partial && ex.partial.at_R) || 1;
  const partialPct = Number(ex.partial && ex.partial.pct) || 50;

  const trades = [];
  let pos = null; // { dir, entry, stop, entryI, t, partialDone, rAtEntry }
  let eq = 1, peak = 1, maxDD = 0;
  const iStart = Math.max(150, Math.floor(days * 24 * 0.05));

  // 辅助：截至 bar i 的 tf 数据（实盘语义：各 tf 都是"到当前为止"）
  function tfsAt(i) {
    const t = kSig[i].t;
    return {
      [signalTf]: kSig.slice(0, i + 1),
      '4h': k4h.filter(b => b.t <= t),
      '1d': k1d.filter(b => b.t <= t)
    };
  }
  function evalAt(ast, i, side) {
    const tfs = tfsAt(i);
    const t = kSig[i].t;
    // 截至 bar t 的历史因子（与实盘"到当前为止"语义一致）
    let fundingZ = 0, lsrZ = 0, lsrData = {};
    if (hist.funding.length) {
      const fr = hist.funding.filter(h => h.ts <= t).map(h => h.v);
      if (fr.length >= 10) fundingZ = zscoreArrShort(fr);
    }
    if (hist.lsr.length) {
      const rows = hist.lsr.filter(h => h.ts <= t);
      const vals = rows.map(r => r.trader_ratio != null ? r.trader_ratio : r.ratio).filter(v => v != null);
      if (vals.length >= 10) lsrZ = zscoreArrShort(vals);
      if (rows.length) lsrData = rows[rows.length - 1];
    }
    const c = buildCtx(stubDb, sym, tfs, 'OFF', fundingZ, lsrZ, 50, side, lsrData);
    c._tfs = tfs;
    return wsl.evaluate(ast, c, i);
  }

  for (let i = iStart; i < kSig.length; i++) {
    const bar = kSig[i];
    if (!pos) {
      // ---- 入场检查 ----
      const sigL = evalAt(entryAstL, i, 1);
      const sigS = evalAt(entryAstS, i, -1);
      if (sigL === true) pos = { dir: 'long', entry: bar.c, stop: bar.c * 0.98, entryI: i, t: bar.t, partialDone: false };
      else if (sigS === true) pos = { dir: 'short', entry: bar.c, stop: bar.c * 1.02, entryI: i, t: bar.t, partialDone: false };
      if (pos) {
        // 动态止损（对齐 runExits：dirFixAst + sanity）
        if (stopAst) {
          const astS = dirFixAst(wsl.parse(st.exit.stop), pos.dir === 'long');
          const sp = evalAt(astS, i, pos.dir === 'long' ? 1 : -1);
          const px = bar.c;
          if (isFinite(sp) && sp > 0 && ((pos.dir === 'long' && sp < px) || (pos.dir === 'short' && sp > px))) pos.stop = sp;
        }
        const riskDist = Math.abs(pos.entry - pos.stop) || pos.entry * 0.02;
        pos.riskDist = riskDist;
        // 固定目标（FR 用）；ST 无 target 则用 ATR 目标近似
        if (targetAst) {
          const tgt = evalAt(targetAst, i, pos.dir === 'long' ? 1 : -1);
          const tgtValid = isFinite(tgt) && tgt > 0 && ((pos.dir === 'long' && tgt > pos.entry) || (pos.dir === 'short' && tgt < pos.entry));
          if (tgtValid) pos.target = tgt;
        } else {
          const A = evalAt(wsl.parse("atr(14,'" + signalTf + "')"), i, 1);
          pos.target = pos.dir === 'long' ? pos.entry + Math.max(A * 2, riskDist * 1.5) : pos.entry - Math.max(A * 2, riskDist * 1.5);
        }
      }
      continue;
    }

    // ---- 持仓中：出场检查（对齐 runExits 优先级） ----
    const isLong = pos.dir === 'long';
    const R = (bar.c - pos.entry) / pos.entry * (isLong ? 1 : -1) / (pos.riskDist / pos.entry);

    // 1) partial: 浮盈 +1R → 减半 + 保本（标记一次）
    if (ex.partial && R >= partialAtR && !pos.partialDone) {
      pos.partialDone = true;
      if (ex.partial.move_stop === 'breakeven') {
        pos.stop = isLong ? pos.entry * (1 + 0.001) : pos.entry * (1 - 0.001);
      }
      pos.posScale = partialPct / 100; // 减仓后剩余比例
    }

    // 2) structure 全平
    let exit = null, reason = null;
    if (structureAst) {
      const brk = evalAt(structureAst, i, isLong ? 1 : -1);
      const broken = isLong ? brk === true : brk !== true;
      if (broken) { exit = bar.c; reason = '趋势破坏'; }
    }
    // 3) time_stop
    if (!exit && ex.time_stop) {
      const tfH = signalTf === '4h' ? 4 : 1;
      const barsHeld = Math.floor((bar.t - pos.t) / (3600 * 1000 * tfH));
      if (barsHeld >= timeBars && R < timeMinR) { exit = bar.c; reason = '超时'; }
    }
    // 4) chandelier 吊灯追踪
    if (!exit && ex.chandelier) {
      const klx = chandelierTf === '1d' ? k1d : kSig;
      const j = Math.min(i, klx.length - 1);
      const A = (function () { const bars = klx; const out = new Array(bars.length).fill(0); for (let k = 1; k < bars.length; k++) { const tr = Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k-1].c), Math.abs(bars[k].l - bars[k-1].c)); out[k] = k <= 14 ? (out[k-1] * (k-1) + tr) / k : (out[k-1] * 13 + tr) / 14; } return out; })();
      const extreme = isLong
        ? Math.max(...klx.slice(Math.max(0, j - 40), j + 1).map(b => b.h))
        : Math.min(...klx.slice(Math.max(0, j - 40), j + 1).map(b => b.l));
      const trail = isLong ? extreme - chandelierK * A[j] : extreme + chandelierK * A[j];
      if ((isLong && bar.c <= trail) || (!isLong && bar.c >= trail)) { exit = bar.c; reason = '吊灯追踪'; }
    }
    // 5) stop / target（用 bar 高低价判定，止损优先）
    if (!exit) {
      const hitStop = isLong ? bar.l <= pos.stop : bar.h >= pos.stop;
      const hitTgt = pos.target && (isLong ? bar.h >= pos.target : bar.l <= pos.target);
      if (hitStop && hitTgt) { exit = pos.stop; reason = '触及止损(同日双触,保守)'; }
      else if (hitStop) { exit = pos.stop; reason = '触及止损'; }
      else if (hitTgt) { exit = pos.target; reason = '触及目标'; }
    }

    if (exit) {
      // 结算（含手续费）
      const gross = (exit - pos.entry) / pos.entry * (isLong ? 1 : -1);
      const net = gross - 2 * FEE;
      const scale = pos.posScale || 1; // partial 后剩余比例
      const rMultiple = gross / (pos.riskDist / pos.entry);
      const pnlPct = net * 100 * scale;
      eq *= (1 + net * scale);
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, (peak - eq) / peak);
      trades.push({ sym, strat: stratId, dir: pos.dir, entry: pos.entry, exit, stop: pos.stop, reason, r: +rMultiple.toFixed(2), pnl_pct: +pnlPct.toFixed(2), t: pos.t, exitT: bar.t });
      pos = null;
    }
  }
  if (pos) {
    // 未平仓：按最后收盘价结算
    const last = kSig[kSig.length - 1].c;
    const gross = (last - pos.entry) / pos.entry * (pos.dir === 'long' ? 1 : -1);
    const net = gross - 2 * FEE;
    const rMultiple = gross / (pos.riskDist / pos.entry);
    eq *= (1 + net * (pos.posScale || 1));
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
    trades.push({ sym, strat: stratId, dir: pos.dir, entry: pos.entry, exit: last, stop: pos.stop, reason: '未平仓', r: +rMultiple.toFixed(2), pnl_pct: +(net * 100 * (pos.posScale || 1)).toFixed(2), t: pos.t, exitT: last.t });
  }

  // ---- 汇总 ----
  const wins = trades.filter(t => t.pnl_pct > 0);
  const losses = trades.filter(t => t.pnl_pct <= 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b.r, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b.r, 0) / losses.length : 0;
  const profitFactor = losses.length && losses.reduce((a, b) => a + Math.abs(b.r), 0) > 0
    ? wins.reduce((a, b) => a + b.r, 0) / Math.abs(losses.reduce((a, b) => a + b.r, 0)) : (wins.length ? Infinity : 0);
  const totalRet = (eq - 1) * 100;
  const perTrade = (eq ** (1 / Math.max(trades.length, 1)) - 1) * 100;
  const avgHeldBars = trades.length ? trades.reduce((a, b) => a + Math.round((b.exitT - b.t) / 3600), 0) / trades.length : 0;

  const report = {
    sym, strat: stratId, days, signal_tf: signalTf,
    trades: trades.length, win_rate: +winRate.toFixed(3), avg_win_R: +avgWin.toFixed(2), avg_loss_R: +avgLoss.toFixed(2),
    profit_factor: +profitFactor.toFixed(2), total_return_pct: +totalRet.toFixed(2),
    max_drawdown_pct: +(maxDD * 100).toFixed(2), per_trade_pct: +perTrade.toFixed(3),
    avg_hold_hours: +avgHeldBars.toFixed(1), risk_pct: riskPct,
    duration_s: +((Date.now() - t0) / 1000).toFixed(1)
  };
  return { report, trades };
}

module.exports = { backtest, fetchKLRange };
