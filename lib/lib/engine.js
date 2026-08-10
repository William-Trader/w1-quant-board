// lib/engine.js — 新给单引擎（WSL 驱动）：体制门控 + 策略求值 + 风控 + 推送 + 出场
// 直接改造版：保留 signal.js 全部旧文件（不注册扫描），新引擎接管推送/战绩链路
'use strict';
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const { kvGet, kvSet } = require('./db');
const { pushToGroup } = require('./qqbot');
const { classify } = require('./regime');
const wsl = require('./wsl');
const ROOT = path.join(__dirname, '..');
const STRAT_DIR = path.join(ROOT, 'strategies');
const WATCH = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'LINK', 'XAU'];


// 拆分子模块（2026-08-09 结构重构：行为零变化）
const { ema, sma, rsi, atr, zscoreArr } = require('./indicators');
const { getKL } = require('./kline');
const { buildCtx, FN } = require('./evalctx');
const { riskCheck, strategyCircuit } = require('./risk');

// ---------------- 策略加载 + 门禁校验 ----------------
function loadStrategies(db) {
  const out = [];
  if (!fs.existsSync(STRAT_DIR)) return out;
  // 前端开关（settings.st/fr.enabled）覆盖 YAML enabled
  let settingsSt = null, settingsFr = null;
  try {
    const s = kvGet(db, 'signal:settings:v4', null) || {};
    settingsSt = s.st ? s.st.enabled !== false : null;
    settingsFr = s.fr ? s.fr.enabled !== false : null;
  } catch {}
  for (const f of fs.readdirSync(STRAT_DIR)) {
    if (!f.endsWith('.wsl.yaml')) continue;
    try {
      const doc = yaml.load(fs.readFileSync(path.join(STRAT_DIR, f), 'utf8'));
      const meta = doc.meta || {};
      // 前端开关覆盖
      if (meta.id === 'ST' && settingsSt !== null) meta.enabled = settingsSt;
      if (meta.id === 'FR' && settingsFr !== null) meta.enabled = settingsFr;
      // schema 校验
      if (!meta.id || !meta.regime) throw new Error('缺少 meta.id / meta.regime');
      if (!doc.entry) throw new Error('缺少 entry 块');
      const entry = {};
      for (const dir of ['long', 'short']) {
        if (doc.entry[dir]) {
          const ast = wsl.parse(doc.entry[dir]); // 语法校验
          entry[dir] = ast;
        }
      }
      const exit = doc.exit || {};
      const exitAst = {};
      for (const k of Object.keys(exit)) {
        if (typeof exit[k] === 'string') exitAst[k] = wsl.parse(exit[k]);
        else exitAst[k] = exit[k];
      }
      // 状态: 首次 = paper（影子期 7 天）
      const stKey = 'signal:strat:' + meta.id;
      let st = JSON.parse(kvGet(db, stKey, 'null') || 'null');
      if (!st) {
        st = { status: 'paper', paper_since: Date.now(), paper_trades: 0, live: false };
        kvSet(db, stKey, JSON.stringify(st));
      }
      out.push({ meta, entry, exit: exitAst, risk: doc.risk || {}, file: f, state: st, key: stKey });
    } catch (e) {
      console.log(`[engine] 策略 ${f} 校验失败: ${e.message}`);
    }
  }
  return out;
}

// 方向修正：把 stop 表达式里的 highest/lowest 按持仓方向对调（纯函数，供测试）

function dirFixAst(ast, isLong) {
  (function dirFix(a) {
    if (!a) return;
    if (a.type === 'call' && (a.name === 'highest' || a.name === 'lowest')) {
      if (isLong && a.name === 'highest') a.name = 'lowest';
      else if (!isLong && a.name === 'lowest') a.name = 'highest';
    }
    if (a.l) dirFix(a.l); if (a.r) dirFix(a.r); if (a.e) dirFix(a.e);
    (a.args || []).forEach(dirFix);
  })(ast);
  return ast;
}


// ---------------- 主循环 ----------------
async function run(ctx) {
  const { db, env } = ctx;
  const mode = env.ENGINE_DEFAULT_MODE || 'paper'; // 首次一律 paper
  const leverageCap = Math.min(Number(env.ENGINE_MAX_LEVERAGE) || 10, 10); // 100x 模式，实际仓位杠杆上限 10x
  const now = Date.now();
  // 健康告警：连续失败 ≥3 轮 → QQ 通知
  try {
    const failN = Number(kvGet(db, 'signal:engine_fail', 0) || 0);
    if (failN >= 3) {
      const lastAlert = Number(kvGet(db, 'signal:engine_alert', 0) || 0);
      if (now - lastAlert > 6 * 3600 * 1000) {
        try { await pushToGroup(env, db, `【W1 告警】给单引擎连续 ${failN} 轮异常，请检查服务器日志`); kvSet(db, 'signal:engine_alert', now); } catch {}
      }
    }
  } catch {}
  // 1. 体制
  let regime;
  try { regime = await classify(ctx, WATCH); } catch (e) { regime = { ok: false, regime: 'OFF' }; }
  const regimeName = regime.regime || 'OFF';
  // 2. 加载策略
  const strats = loadStrategies(db);
  const t0 = Date.now();
  let hits = 0, pushed = 0;
  for (const st of strats) {
    if (st.meta.enabled === false) continue;
    if (st.meta.regime !== 'ANY' && st.meta.regime !== regimeName) continue; // 体制门控
    if (st.state.status === 'paused') {
      if (Date.now() < (st.state.paused_until || 0)) continue;
      st.state.status = 'paper'; st.state.paused_until = 0;
      try { kvSet(db, st.key, JSON.stringify(st.state)); } catch {}
    }
    if (st.state.status !== 'live' && st.state.status !== 'paper') continue;
    if (st.state.status === 'paper' && now - (st.state.paper_since || now) < (Number(env.ENGINE_PAPER_DAYS) || 7) * 86400 * 1000) {
      // 影子期未满: 允许回测/paper 记录，不推送
      if (env.ENGINE_PAPER_PUSH !== '1') continue;
    }
    const symbols = (st.meta.symbols || WATCH).filter(s => s !== 'XAU'); // XAU 无 K线，不给单
    for (const sym of symbols) {
      try {
        const tf = st.meta.signal_tf || '1h';
        const k1h = await getKL(sym, '1h');
        if (!k1h || k1h.length < 100) continue;
        const tfs = { '1h': k1h };
        if (tf === '4h' || st.entry.long || st.entry.short) {
          const k4h = await getKL(sym, '4h', 200);
          if (k4h && k4h.length > 30) tfs['4h'] = k4h;
          const k1d = await getKL(sym, '1d', 300);
          if (k1d && k1d.length > 40) tfs['1d'] = k1d;
        }
        // 策略所需周期数据不足则跳过（防止求值报错）
        if (!tfs[tf] || tfs[tf].length < 50) { console.log(`[engine] ${st.meta.id} ${sym} ${tf} 数据不足跳过`); continue; }
        // funding_z30 / lsr_z30（从 futures_markets 算）
        let fundingZ = 0, lsrZ = 0, lsrData = {};
        try {
          const rows = db.prepare('SELECT payload FROM futures_markets ORDER BY ts DESC LIMIT 30').all();
          const fr = [], lr = [];
          for (const r of rows) {
            try {
              const d = JSON.parse(r.payload).data || [];
              const c = d.find(x => x.symbol === sym);
              if (c) {
                if (c.avg_funding_rate_by_oi != null) fr.push(c.avg_funding_rate_by_oi);
                if (c.long_short_ratio_5m != null) lr.push(c.long_short_ratio_5m);
              }
            } catch {}
          }
          if (fr.length >= 10) fundingZ = zscoreArr(fr);
          if (lr.length >= 10) lsrZ = zscoreArr(lr);
        } catch {}
        // LSR 增强字段：优先 lsr_signals（v2/signals 8大币完整信号），fallback lsr_rankings
        try {
          const sigRow = db.prepare('SELECT payload FROM lsr_signals ORDER BY ts DESC LIMIT 1').get();
          if (sigRow) {
            const arr = JSON.parse(sigRow.payload).data || [];
            const c = arr.find(x => x.symbol === sym || x.symbol === sym + 'USDT');
            if (c) Object.assign(lsrData, c);
          }
          const tr = db.prepare("SELECT payload FROM lsr_rankings WHERE mode='trader' ORDER BY ts DESC LIMIT 1").get();
          const wr = db.prepare("SELECT payload FROM lsr_rankings WHERE mode='whale' ORDER BY ts DESC LIMIT 1").get();
          const merge = (row, mode) => { if (!row) return; try { const arr = JSON.parse(row.payload).data || []; const c = arr.find(x => x.symbol === sym + 'USDT' || x.symbol === sym + '_USDT' || x.symbol === sym); if (c) Object.assign(lsrData, mode === 'trader' ? c : { whale_ratio: c.whale_ratio, whale_delta_2m: c.whale_delta_2m, whale_long_qty: c.whale_long_qty, whale_short_qty: c.whale_short_qty, whale_long_count: c.whale_long_count, whale_short_count: c.whale_short_count }); } catch {} };
          merge(tr, 'trader'); merge(wr, 'whale');
        } catch {}
        let fgi = 50;
        try { const f = db.prepare('SELECT value FROM fear_greed ORDER BY ts DESC LIMIT 1').get(); if (f) fgi = f.value; } catch {}
        const i = k1h.length - 1;
        for (const dir of ['long', 'short']) {
          if (!st.entry[dir]) continue;
          const ctx2 = buildCtx(db, sym, tfs, regimeName, fundingZ, lsrZ, fgi, dir === 'long' ? 1 : -1, lsrData);
          ctx2._tfs = tfs;
          let ok = false;
          try { ok = !!wsl.evaluate(st.entry[dir], ctx2, i); } catch (e) { console.log(`[engine] ${st.meta.id} ${sym} 求值错误: ${e.message}`); }
          if (!ok) continue;
          hits++;
          // 风控
          const rc = riskCheck(db, sym, dir, st.meta.id, regimeName);
          if (!rc.ok) { console.log(`[engine] ${sym}:${dir} 跳过(${rc.why})`); continue; }
          const cb = strategyCircuit(db, st.meta.id);
          if (cb.tripped) {
            console.log(`[engine] 策略 ${st.meta.id} 熔断 → paused（24h 后自动恢复 paper）`);
            try { const k2 = 'signal:strat:' + st.meta.id; const cur = JSON.parse(kvGet(db, k2, '{}') || '{}'); cur.status = 'paused'; cur.paused_until = Date.now() + 24 * 3600 * 1000; kvSet(db, k2, JSON.stringify(cur)); } catch {}
            continue;
          }
          // 仓位: 固定风险
          const px = k1h[i].c;
          // 止损距离 = 2.5×ATR(策略周期)（ST用1h、FR用4h——波动率自适应且与策略级别一致）
          const sigTf = st.meta.signal_tf || '1h';
          const klSig = tfs[sigTf] || k1h;
          const A1v = (atr(klSig, 14)[klSig.length - 1]) || px * 0.008;
          const stopDistPct = Math.min(4, Math.max(0.8, (2.5 * A1v) / px * 100));
          let riskPct = Math.min(Number(st.risk.risk_pct) || 2, 2) / 100; // 每笔风险 2%
          // FGI 恐惧缩放仓位（沿用旧规则）
          if (fgi <= 20) riskPct *= 0.3;
          else if (fgi <= 30) riskPct *= 0.5;
          const posPct = Math.min(0.1, Number((riskPct / (stopDistPct / 100) / leverageCap).toFixed(4))); // 保证金% = 风险/止损%/杠杆，上限 10%
          const live = st.state.status === 'live';
          const pushNow = live || env.ENGINE_PAPER_PUSH === '1'; // 测试期也推送（标注警示）
          // 入库 + 推送
          const msg = buildMsg(st, sym, dir, px, regimeName, posPct, leverageCap, live, mode, stopDistPct);
          let pushOk = false;
          if (pushNow) {
            try { pushOk = await pushToGroup(env, db, msg); } catch (e) { console.warn('[engine] push:', e.message); }
          }
          const stopPx = dir === 'long' ? px * (1 - stopDistPct / 100) : px * (1 + stopDistPct / 100);
          const t1Px = dir === 'long' ? px * (1 + 2 * stopDistPct / 100) : px * (1 - 2 * stopDistPct / 100);
          const t2Px = dir === 'long' ? px * (1 + 4 * stopDistPct / 100) : px * (1 - 4 * stopDistPct / 100);
          const rr = 2;
          db.prepare(`INSERT INTO signal_track (symbol, direction, entry, stop, target1, target2, rr, pos_pct, msg, status, pushed_at, strategy, strategy_id, regime, exit_reason)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(sym, dir, px, stopPx, t1Px, t2Px, rr,
              posPct, msg, live ? 'OPEN' : 'PAPER', Date.now(), st.meta.id, st.meta.id, regimeName, '');
          // 冷却：PAPER 入库即冷却防重复；LIVE 推送失败保留重试（下轮可重推）
          if (!live || pushOk) kvSet(db, `signal:cooldown:${sym}:${dir}`, Date.now());
          if (pushNow && pushOk) { kvSet(db, `signal:daily:${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })}`, rc.daily + 1); pushed++; }
          console.log(`[engine] ${live ? 'LIVE' : 'PAPER'} ${sym}:${dir} [${st.meta.id}] regime=${regimeName} ${msg.split('\n')[0]}`);
        }
      } catch (e) { console.log(`[engine] ${sym} 处理错误: ${e.message}`); }
    }
  }
  console.log(`[engine] regime=${regimeName} 策略=${strats.map(s => s.meta.id).join(',')} hits=${hits} pushed=${pushed} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  kvSet(db, 'signal:engine_fail', '0');
  return { ok: true, regime: regimeName, hits, pushed };
}

function buildMsg(st, sym, dir, px, regime, posPct, lev, live, mode, stopDistPct) {
  const act = dir === 'long' ? '做多' : '做空';
  const fmt = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(4);
  const rp = Math.min(Number(st.risk.risk_pct) || 2, 2);
  const testTag = live ? '' : '⚠️ 测试期信号 · 不想亏钱别跟（策略验证中）';
  const stopPx = dir === 'long' ? px * (1 - (stopDistPct || 2) / 100) : px * (1 + (stopDistPct || 2) / 100);
  return [
    `【W1 给单】${sym} ${act} ${st.meta.name}（${regime}体制）`,
    `入场 $${fmt(px)} ｜ 止损 $${fmt(stopPx)} ｜ 风险 R=${rp}%`,
    `出场计划: 1R 半仓+保本 · 吊灯追踪 3ATR · 趋势破坏全平`,
    `⚖️ 100x模式·实际杠杆 ${lev}x：保证金 ${(posPct * 100).toFixed(2)}%（名义 ${(posPct * 100 * lev).toFixed(0)}%）`,
    testTag,
    `提示：仅供研究，不构成投资建议，盈亏自负`
  ].filter(Boolean).join('\n');
}

// ---------------- 出场引擎 ----------------
async function runExits(ctx) {
  const { db, env } = ctx;
  const opens = db.prepare("SELECT * FROM signal_track WHERE status='OPEN'").all();
  if (!opens.length) return 0;
  const strats = loadStrategies(db);
  const stratMap = new Map(strats.map(s => [s.meta.id, s]));
  let settled = 0;
  for (const o of opens) {
    try {
      const st = stratMap.get(o.strategy_id || o.strategy);
      if (!st || !st.exit) { continue; }
      const sym = o.symbol;
      const kl = await getKL(sym, st.meta.signal_tf || '1h');
      if (!kl || kl.length < 30) continue;
      const px = kl[kl.length - 1].c;
      const i = kl.length - 1;
      const isLong = o.direction === 'long';
      const entry = Number(o.entry);
      const stop = Number(o.stop);
      const riskDist = Math.abs(entry - stop) || entry * 0.02;
      const R = (px - entry) / entry * (isLong ? 1 : -1) / (riskDist / entry);
      const ex = st.exit;
      // 动态止损：exit.stop 表达式（如 FR 的 24h 极值外侧）优先于固定 stop
      let dynStop = null;
      if (ex.stop && typeof ex.stop === 'object') {
        try {
          const k4 = await getKL(sym, '4h', 200);
          const k1d = await getKL(sym, '1d', 300);
          const c2 = buildCtx(db, sym, { '1h': kl, '4h': k4, '1d': k1d }, 'OFF', 0, 0, 50, isLong ? 1 : -1);
          c2._tfs = { '1h': kl, '4h': k4, '1d': k1d };
          // 方向修正: stop 表达式里的 highest/lowest 按持仓方向对调
          // 做多止损应在价格下方(lowest)、做空止损应在价格上方(highest)
          const astStop = dirFixAst(typeof ex.stop === 'string' ? wsl.parse(ex.stop) : ex.stop, isLong);
          const sp = wsl.evaluate(astStop, c2, i);
          // 方向 sanity check: 做多止损必须低于现价、做空止损必须高于现价，否则丢弃
          if (isFinite(sp) && sp > 0 && ((isLong && sp < px) || (!isLong && sp > px))) dynStop = sp;
        } catch {}
      }
      const effStop = dynStop || Number(stop);
      // 1) partial: 浮盈 +1R → 平半仓（pos_pct 减半）+ 止损移至保本
      if (ex.partial && R >= Number(ex.partial.at_R || 1)) {
        const pk = 'signal:partial:' + o.id;
        if (!kvGet(db, pk, 0)) {
          const pct = Number(ex.partial.pct) || 50;
          const half = Number((Number(o.pos_pct) * pct / 100).toFixed(4));
          const be = ex.partial.move_stop === 'breakeven'
            ? (isLong ? entry * (1 + 0.001) : entry * (1 - 0.001)) : stop;
          db.prepare('UPDATE signal_track SET pos_pct=?, stop=? WHERE id=?').run(half, be, o.id);
          kvSet(db, pk, Date.now());
          console.log(`[exits] #${o.id} ${sym} +1R 平半仓（剩余 ${(half * 100).toFixed(2)}%），止损移保本`);
        }
      }
      // 2) chandelier: 吊灯追踪
      // 3) structure: 条件全平
      // 4) time_stop 兜底
      let exit = null, reason = null;
      if (ex.structure) {
        try {
          const k1d = await getKL(sym, '1d', 300);
          const ctx2 = buildCtx(db, sym, { '1h': kl, '1d': k1d }, 'OFF', 0, 0, 50, isLong ? 1 : -1);
          ctx2._tfs = { '1h': kl, '1d': k1d };
          // short 单: 结构破坏条件取反（如多头的 close<ema20 破坏，空头应为 close>=ema20）
          const ev = wsl.evaluate(ex.structure, ctx2, i);
          const brk = isFinite(ev) && (isLong ? ev : !ev); // NaN 时不平仓（保守）
          if (brk) { exit = px; reason = '趋势破坏'; }
        } catch {}
      }
      if (!exit && ex.time_stop) {
        const tfH = (st.meta.signal_tf === '4h' ? 4 : 1);
        const barsHeld = Math.floor((Date.now() - Number(o.pushed_at)) / (3600 * 1000 * tfH));
        const maxBars = (ex.time_stop.bars || 120);
        const minR = ex.time_stop.min_R || 0;
        if (barsHeld >= maxBars && R < minR) { exit = px; reason = '超时'; }
      }
      if (!exit && ex.chandelier) {
        const k = Number(ex.chandelier.k) || 3;
        const tf = ex.chandelier.tf || '1h';
        const klx = tf === '1d' ? await getKL(sym, '1d', 300) : kl;
        const A = atr(klx, 14);
        const j = Math.min(i, klx.length - 1);
        const extreme = isLong
          ? Math.max(...klx.slice(Math.max(0, j - 40), j + 1).map(b => b.h))
          : Math.min(...klx.slice(Math.max(0, j - 40), j + 1).map(b => b.l));
        const trail = isLong ? extreme - k * A[j] : extreme + k * A[j];
        if ((isLong && px <= trail) || (!isLong && px >= trail)) { exit = px; reason = '吊灯追踪'; }
      }
      if (!exit && ((isLong && px <= effStop) || (!isLong && px >= effStop))) { exit = effStop; reason = '触及止损'; }
      if (!exit && ex.target) {
        try {
          const k1d = await getKL(sym, '1d', 300);
          const k4 = await getKL(sym, '4h', 200);
          const ctx2 = buildCtx(db, sym, { '1h': kl, '4h': k4, '1d': k1d }, 'OFF', 0, 0, 50, isLong ? 1 : -1);
          ctx2._tfs = { '1h': kl, '4h': k4, '1d': k1d };
          const tgt = wsl.evaluate(ex.target, ctx2, i);
          // 方向 sanity: 做多目标须高于入场、做空目标须低于入场，否则目标失效
          const tgtValid = isFinite(tgt) && tgt > 0 && ((isLong && tgt > entry) || (!isLong && tgt < entry));
          if (tgtValid && ((isLong && px >= tgt) || (!isLong && px <= tgt))) { exit = px; reason = '触及目标'; }
        } catch {}
      }
      if (exit) {
        const pnl = (exit - entry) / entry * (isLong ? 1 : -1) * 100;
        const status = pnl > 0 ? 'WIN' : 'LOSS';
        db.prepare("UPDATE signal_track SET status=?, resolved_at=?, pnl_pct=?, reason=?, exit_reason=? WHERE id=?")
          .run(status, Date.now(), Number(pnl.toFixed(2)), reason, reason, o.id);
        // 日亏累计
        if (status === 'LOSS') {
          const dk = 'signal:dayloss:' + new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
          kvSet(db, dk, String(Number(kvGet(db, dk, 0) || 0) + Math.abs(pnl)));
        }
        settled++;
      }
    } catch (e) { console.warn(`[exits] ${o.id} 处理错误: ${e.message}`); }
  }
  if (settled) console.log(`[exits] 结算 ${settled} 笔`);
  return settled;
}

function countFail(db) {
  const n = Number(kvGet(db, 'signal:engine_fail', 0) || 0) + 1;
  kvSet(db, 'signal:engine_fail', String(n));
  return n;
}
module.exports = { run, runExits, loadStrategies, buildCtx, FN, getKL, countFail, dirFixAst, ema, sma, rsi, atr };
