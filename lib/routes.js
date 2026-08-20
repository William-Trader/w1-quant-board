const { debug, warn, info, error } = require('./log');
// API 路由：全部 JSON，含 data_ts 与 stale 标记；前端只读本地库，永不穿透打上游
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { store, staleOf, ageSec } = require('./store');
const { GLOSSARY } = require('./glossary');
const quizLib = require('./quiz');
const { getCached, collectNews } = require("./news");
const { buildEngineSnapshot, JOBS } = require('./collectors');
const { kvGet } = require('./db');
const { vipOf, findSession, ADMIN_COOKIE, USER_COOKIE } = require('./auth');

const PKG = require('../package.json');
const STARTED = Date.now();

// 通用 TTL 内存缓存：同一 key 在窗口内只执行一次真实计算/外部请求
const ttlCache = new Map();
function withCache(key, ttlMs, fn) {
  const hit = ttlCache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.value);
  return Promise.resolve(fn()).then(v => {
    ttlCache.set(key, { ts: Date.now(), value: v });
    return v;
  });
}

// 指纹只随部署变化，缓存 60s 避免每次 /api/version 都读文件+sha256
let fpCache = null;
function dashboardFingerprint() {
  const now = Date.now();
  if (fpCache && now - fpCache.ts < 60000) return fpCache.value;
  const file = path.join(__dirname, '..', 'public', 'index.html');
  let value;
  try {
    const buf = fs.readFileSync(file);
    const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    value = { exists: true, bytes: buf.length, sha256_16: sha, is_full_terminal: buf.length >= 50000 };
  } catch (e) {
    value = { exists: true, bytes: 0, sha256_16: null, is_full_terminal: false };
  }
  fpCache = { ts: now, value };
  return value;
}

function registerRoutes(app, ctx, auth) {
  const { db, env } = ctx;
  // 幂等加列：orig_stop 保存原始止损（T1保本/移动止损覆盖 stop 前备份），供历史标注
  try { db.prepare("ALTER TABLE signal_track ADD COLUMN orig_stop REAL").run(); } catch (e) {}
  try { db.prepare("ALTER TABLE signal_track ADD COLUMN reasoning_json TEXT").run(); } catch (e) {}
  try { db.prepare("ALTER TABLE signal_track ADD COLUMN self_review TEXT").run(); } catch (e) {}
  const { requireAuth, requireVip, requireAdmin } = auth;
  const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && typeof r.then === 'function') r.catch(e => { error('[api]', req.path, e.message); res.status(500).json({ ok: false, error: 'internal', message: e.message }); }); } catch (e) { error('[api]', req.path, e.message); res.status(500).json({ ok: false, error: 'internal', message: e.message }); } };

  /* ---------------- 公开 ---------------- */
  app.get('/api/version', (req, res) => {
    res.json({
      ok: true,
      name: 'william-quant-board-w1',
      version: PKG.version,
      dashboard_html: dashboardFingerprint(),
      uptime_sec: Math.round((Date.now() - STARTED) / 1000)
    });
  });

  /* ---------------- 统一信号引擎（指标战绩=实盘，v1.0） ---------------- */
  // 状态查询：当前统一引擎判断 + 最新实盘单（未登录仅返回 locked 标记，判断详情会员可见）
  app.get('/api/unified/status', wrap((req, res) => {
    const eng = require('./experience_engine');
    const symbol = String(req.query.symbol || 'BTC').toUpperCase();
    const sess = findSession(db, req.cookies[USER_COOKIE], 'user');
    const authed = !!sess;
    const st = eng.liveStatus(db, symbol);
    // 实时价（w1.db prices 表）
    try { const lp = db.prepare("SELECT price FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT 1").get(symbol); st.live_price = lp ? lp.price : null; } catch (e) { debug('[routes] live_price err:', e.message); }
    if (!authed) { st.locked = true; st.judge = null; st.order = null; st.open = null; }
    else { st.locked = false; }
    res.json(st);
  }));
  // 开单（会员专属）：统一引擎当前判断 → 限价挂单写入 signal_track
  app.post('/api/unified/place', requireVip, wrap((req, res) => {
    const eng = require('./experience_engine');
    const r = eng.placeLiveOrder(db, { symbol: String((req.body || {}).symbol || 'BTC').toUpperCase() });
    res.json(r);
  }));
  // 当前持仓（会员专属）：统一引擎开的 OPEN 单
  app.get('/api/unified/positions', requireVip, wrap((req, res) => {
    const rows = db.prepare("SELECT * FROM signal_track WHERE status='OPEN' ORDER BY id DESC LIMIT 20").all();
    res.json({ ok: true, rows });
  }));

  /* ---------------- OKX 实盘（交易信号选项卡） ---------------- */
  // 账户状态：余额 + 实际持仓（未配置 key 时返回 connected:false 占位）
  // 策略实盘状态：三策略引擎都在运行，但实盘接入唯一（互斥）
  app.get('/api/strategy/status', requireVip, wrap((req, res) => {
    const live = (() => { try { const r = db.prepare("SELECT value FROM kv WHERE key='live_strategy'").get(); return r ? r.value : 'alpha1'; } catch (e) { return 'alpha1'; } })();
    const hasCron = (() => { try { const out = require('child_process').execSync('crontab -l | grep alpha1_live', { shell: '/bin/bash' }); return out.toString().length > 0; } catch (e) { return false; } })();
    const betaAuto = (() => { try { const r = db.prepare("SELECT value FROM kv WHERE key='beta:auto'").get(); return r ? r.value === '1' : false; } catch (e) { return false; } })();
    const strategies = {
      beta1:  { running: betaAuto, live: live === 'beta1',  desc: '方向引擎 · 中低频趋势' },
      alpha1: { running: hasCron,  live: live === 'alpha1', desc: '布林双模 · 中高频' },
      alpha2: { running: false,    live: live === 'alpha2', desc: '激进提现 · 回测研究' }
    };
    res.json({ ok: true, live, strategies });
  }));
  // 切换实盘策略（互斥：切换前自动停旧）
  app.post('/api/strategy/switch', requireAdmin, wrap(async (req, res) => {
    const target = String((req.body || {}).strategy || '');
    if (!['beta1', 'alpha1', 'alpha2'].includes(target)) return res.json({ ok: false, error: '未知策略' });
    if (target === 'alpha2') return res.json({ ok: false, error: 'α2 聚沙暂无实盘模块（回测研究）' });
    const execSync = require('child_process').execSync;
    try {
      try { execSync("crontab -l | grep -v alpha1_live | crontab -", { shell: '/bin/bash', timeout: 10000 }); } catch (e) {}
      db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('beta:auto','0')").run();
      if (target === 'alpha1') {
        execSync("(crontab -l; echo '*/30 * * * * cd /home/ubuntu/w1-board && node scripts/alpha1_live.js >> /tmp/alpha1_live.log 2>&1') | crontab -", { shell: '/bin/bash', timeout: 10000 });
      } else if (target === 'beta1') {
        db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('beta:auto','1')").run();
      }
      db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('live_strategy',?)").run(target);
      info(`[strategy] 实盘策略切换 → ${target}`);
      res.json({ ok: true, live: target, note: target === 'beta1' ? 'β1 已启用（自动开单恢复）' : 'α1 cron 已启用' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

  app.get('/api/okx/status', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    try { const st = await okx.accountStatus(db); res.json(Object.assign({ ok: true }, st)); }
    catch (e) { res.json({ ok: false, error: e.message, connected: false }); }
  }));
  // 实际持仓（快捷）
  app.get('/api/okx/positions', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    const st = await okx.accountStatus();
    res.json({ ok: true, connected: st.connected, positions: st.positions || [] });
  }));
  // 历史仓位：OKX 真实平仓成交记录（reduceOnly 平仓单，含 pnl/fee）
  app.get('/api/okx/history', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    try {
      const r = await okx.getHistory(100, db);
      res.json(r);
    } catch (e) { res.json({ ok: false, error: e.message }); }
  }));
  // 仓位倍数（默认 1.0 = 1:1 跟随策略）
  app.get('/api/okx/mult', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    res.json({ ok: true, mult: okx.getPosMult(db) });
  }));
  app.post('/api/okx/mult', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    const r = okx.setPosMult(db, Number((req.body || {}).mult));
    res.json(r);
  }));
  // 实盘控制全套设置（读）
  app.get('/api/okx/settings', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    res.json({
      ok: true,
      mult: okx.getPosMult(db),
      risk_pct: okx.getRiskPct(db),
      fix_amount: okx.getFixAmount(db),
      hard_stop_pct: okx.getHardStop(db),
      leverage: okx.getLevSetting(db),
      follow_ratio: okx.getFollowRatio(db),
      max_total_lev: okx.getMaxLev(db),
      auto: okx.getAutoOn(db)
    });
  }));
  // 实盘控制全套设置（保存）
  app.post('/api/okx/settings', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    const b = req.body || {};
    let err = null;
    if (b.mult != null) { const r = okx.setPosMult(db, Number(b.mult)); if (!r.ok) err = r.error; }
    if (b.risk_pct != null) { const r = okx.setRiskPct(db, Number(b.risk_pct)); if (!r.ok) err = r.error; }
    if (b.fix_amount != null) { const r = okx.setFixAmount(db, Number(b.fix_amount)); if (!r.ok) err = r.error; }
    if (b.hard_stop_pct != null) { const r = okx.setHardStop(db, Number(b.hard_stop_pct)); if (!r.ok) err = r.error; }
    if (b.leverage != null) { const r = okx.setLevSetting(db, Number(b.leverage)); if (!r.ok) err = r.error; }
    if (b.follow_ratio != null) { const r = okx.setFollowRatio(db, Number(b.follow_ratio)); if (!r.ok) err = r.error; }
    if (b.max_total_lev != null) { const r = okx.setMaxLev(db, Number(b.max_total_lev)); if (!r.ok) err = r.error; }
    if (err) return res.json({ ok: false, error: err });
    info('[okx] 实盘控制设置已保存: ' + JSON.stringify(b));
    res.json({
      ok: true,
      mult: okx.getPosMult(db), risk_pct: okx.getRiskPct(db),
      fix_amount: okx.getFixAmount(db), hard_stop_pct: okx.getHardStop(db),
      leverage: okx.getLevSetting(db), follow_ratio: okx.getFollowRatio(db), max_total_lev: okx.getMaxLev(db)
    });
  }));
  // 智能跟单预览：最新未跟单的 SmartSignal（TIANJI）持仓信号（只读，供界面展示）
  app.get('/api/okx/follow-preview', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    const row = db.prepare("SELECT id, symbol, direction, entry, stop, target1, pos_pct, leverage, notional_usd, pushed_at FROM signal_track WHERE strategy='TIANJI' AND status='OPEN' AND (okx_meta IS NULL OR okx_meta='') ORDER BY id DESC LIMIT 1").get();
    res.json({ ok: true, signal: row || null, follow_ratio: okx.getFollowRatio(db), auto: okx.getAutoOn(db) });
  }));

  // 一键平仓（全部持仓）
  app.post('/api/okx/close-all', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    const r = await okx.closeAllPositions(db);
    res.json(r);
  }));
  // 单仓平仓
  app.post('/api/okx/close', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    const r = await okx.closePosition(String((req.body || {}).instId || 'BTC-USDT-SWAP'));
    res.json(r);
  }));
  // 强制止损（市价平仓离场）
  app.post('/api/okx/force-stop', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    const r = await okx.forceStop(db, String((req.body || {}).instId || 'BTC-USDT-SWAP'));
    res.json(r);
  }));
  // 实盘全自动开关（kv: okx:auto）——管理员才能切换，任何人可读状态
  app.get('/api/okx/auto', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    res.json({ ok: true, auto: okx.getAutoOn(db) });
  }));
  app.post('/api/okx/auto', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    const on = !!(req.body || {}).auto;
    okx.setAutoOn(db, on);
    info('[okx] 实盘全自动开关 → ' + (on ? 'ON（信号即下单）' : 'OFF（仅虚拟盘）'));
    res.json({ ok: true, auto: on });
  }));

  /* ---------------- Tab 权限（用户级 bt_open，后台按用户手动开放） ---------------- */
  // 会员查询：当前用户是否有某 tab 权限（登录后调用，key 仅支持 test2020）
  app.get('/api/tab/open', requireAuth, wrap((req, res) => {
    const key = String(req.query.key || 'test2020');
    const open = key === 'test2020' ? (req.user.bt_open ? true : false) : false;
    res.json({ ok: true, key, open });
  }));

  /* ---------------- 方向引擎云端回测（交易信号界面固定） ----------------
   * 参数: { principal: 本金U, mult: 仓位倍数(默认1), stop_pct: 强制止损率% (可选, 覆盖 stop_atr) }
   * 与 dir_prod 锁定参数同口径，跑 2024-01 ~ 现在 */
  app.post('/api/dir/backtest', requireVip, wrap(async (req, res) => {
    const body = req.body || {};
    const principal = Math.min(1000000, Math.max(100, Number(body.principal) || 10000));
    const mult = Math.min(10, Math.max(0.1, Number(body.mult) || 1));
    const stopPct = body.stop_pct != null ? Math.min(6, Math.max(0.5, Number(body.stop_pct))) : null;
    // 策略选择：beta1（β1 御风 稳健）/ alpha1（α1 破浪 v2 布林双模中高频 + 提现）/ alpha2（α2 聚沙 激进提现版）
    const strat = String(body.strategy || 'beta1');
    const btv = strat === 'alpha1' ? require('../scripts/bt_dual.exp') : strat === 'unnamed' ? require('../scripts/bt_unnamed') : require('../scripts/backtest_v4');
    const cfg = strat === 'alpha1' ? {
      risk_pct: 1.0, range_touch_atr: 0.15, range_rsi_lo: 45, range_rsi_hi: 55, range_stop_atr: 1.5,
      range_timeout: 24, range_trail_atr: 1.0, trend_stop_atr: 1.8, trend_t1_rr: 1.5, trend_trail_atr: 1.8,
      trend_timeout: 48, cooldown: 2, dd_fuse: 10, lev_cap: 50, min_r: 0.3, t1_pct: 60,
      withdrawPct: 0.15, withdrawMult: 2, use15mEntry: 1, return_trades: true
    } : strat === 'alpha2' ? {
      entry_th: 2.5, risk_pct: 7, stop_atr: 2.6, t1_rr: 0.8, t1_pct: 60,
      trail_atr: 2.0, time_bars: 10, min_r: 0.5, lev_cap: 50,
      cooldown: 2, cons_only: 1, compound: 1, dd_fuse: 10, use15m: 1,
      withdrawPct: 1, withdrawMult: 1.5, riskBoostScore: 1.3, riskFloor: 4,
      wdMode: 'excess', wdThresh: 0.02, wdExPct: 0.95, return_trades: true
    } : strat === 'unnamed' ? {
      entry_n: 48, exit_n: 18, atr_add: 0.5, max_add: 3, lev: 1.5, hard_stop: 15, adx_min: 18, return_trades: true
    } : {
      entry_th: 3.0, risk_pct: 4.25, stop_atr: 2.8, t1_rr: 0.8, t1_pct: 60,
      trail_atr: 2.5, time_bars: 10, min_r: 0.5, lev_cap: 50,
      cooldown: 3, cons_only: 1, compound: 1, dd_fuse: 6, use15m: 1, return_trades: true
    };
    const eqCurve = [];
    cfg.curve = eqCurve;
    if (stopPct != null) { // 粗略映射：止损率% → stop_atr（按 ATR 平均 1% 估）
      if (strat === 'alpha1') { cfg.range_stop_atr = stopPct / 2.8; cfg.trend_stop_atr = stopPct / 2.8; }
      else cfg.stop_atr = stopPct / 2.8;
    }
    // 时间段：支持 start/end（YYYY-MM-DD），默认全段 2024-01-01 ~ 今天
    const parseDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s||'')); return m ? Date.UTC(+m[1], +m[2]-1, +m[3]) : null; };
    const reqStart = parseDay(body.start), reqEnd = parseDay(body.end);
    const avgYCache = avgYCacheGlobal;
    const S = reqStart || Date.UTC(2024, 0, 1);
    const td = new Date(); const E = reqEnd ? reqEnd + 86399999 : Date.UTC(td.getUTCFullYear(), td.getUTCMonth(), td.getUTCDate(), 23, 59);
    try {
      const r = strat === 'alpha1' || strat === 'unnamed' ? btv.run(Object.assign({}, cfg, { startTs: S, endTs: E })) : btv.runBacktest(cfg, S, E);
      // 平均年收益：每年重置 1 万固定本金（不滚仓、含当年提现落袋），各年收益率算术平均
      const avgYKey = strat + '|' + S + '|' + E;
      let avgYearly = avgYCache.get(avgYKey);
      if (avgYearly == null) {
        const y0 = new Date(S).getUTCFullYear(), y1 = new Date(E).getUTCFullYear();
        const rets = [];
        for (let y = y0; y <= y1; y++) {
          const yS = y === y0 ? S : Date.UTC(y, 0, 1);
          const yE = y === y1 ? E : Date.UTC(y + 1, 0, 1) - 1;
          const c2 = Object.assign({}, cfg); delete c2.curve; c2.compound = 0;
          const rr = strat === 'alpha1' || strat === 'unnamed' ? btv.run(Object.assign({}, c2, { startTs: yS, endTs: yE })) : btv.runBacktest(c2, yS, yE);
          const wd = rr.withdrawn_total || 0;
          rets.push(((rr.equity - 10000) + wd) / 10000 * 100);
        }
        avgYearly = +(rets.reduce((a, b) => a + b, 0) / rets.length).toFixed(1);
        avgYCache.set(avgYKey, avgYearly);
        if (avgYCache.size > 200) avgYCache.clear();
      }
      const tl = (r.trade_list || []);
      // 按金额与倍数缩放展示（回测以 10000u 为基准 → 名义等比例）
      const scale = principal / 10000 * mult;
      const summary = {
        trades: r.trades, win_rate: r.win_rate, sharpe: r.sharpe,
        total_ret_pct: r.total_ret_pct, cagr_pct: r.cagr_pct, max_dd_pct: r.max_dd_pct,
        profit_factor: r.profit_factor,
        avg_yearly_return_pct: avgYearly,
        equity: Math.round(r.equity * scale),
        pnl_usd: Math.round((r.equity - 10000) * scale),
        principal, mult, stop_pct: stopPct, scale, strategy: strat,
        withdrawn_total: Math.round(r.withdrawn_total * scale), withdrawn_count: r.withdrawn_count,
        start: new Date(S).toISOString().slice(0,10), end: new Date(E).toISOString().slice(0,10),
        equity_curve: eqCurve.map(p => ({ day: p.day, eq: Math.round(p.eq * scale) }))
      };
      // 每月盈亏
      const byMonth = {};
      for (const t of tl) {
        const mk = (t.day || '').slice(0, 7);
        byMonth[mk] = byMonth[mk] || { n: 0, win: 0, pnl_r: 0 };
        byMonth[mk].n++;
        if (t.status === 'WIN') byMonth[mk].win++;
      }
      // 交易明细：按 scale 缩放盈亏/权益，附收益率
      const scaledTrades = tl.slice(0, 100).map((t, idx) => {
        const eqBefore = idx === 0 ? 10000 : (tl[idx - 1].equity_after || 10000);
        const pnlUsd = Math.round((t.pnl_usd || 0) * scale);
        const eqAfter = Math.round((t.equity_after != null ? t.equity_after : 10000) * scale);
        return {
          day: t.day, dir: t.dir, reason: t.reason, r: t.r, status: t.status,
          entryTs: t.entryTs != null ? t.entryTs : null, exitTs: t.exitTs != null ? t.exitTs : null,
          entry: t.entry, exit: t.exit, stop: t.stop,
          leverage: t.leverage, notional: Math.round((t.notional || 0) * scale),
          margin: Math.round((t.margin || 0) * scale), risk_usd: Math.round((t.risk_usd || 0) * scale),
          share: t.share, mode: t.mode || null, regime: t.regime || null,
          pnl_usd: pnlUsd, equity_after: eqAfter,
          ret_pct: eqBefore > 0 ? +((pnlUsd / (eqBefore * scale)) * 100).toFixed(2) : 0
        };
      });
      res.json({ ok: true, summary, months: Object.keys(byMonth).sort().map(mk => ({ month: mk, ...byMonth[mk] })), trades: scaledTrades });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

  app.get('/api/overview', wrap((req, res) => {
    const snap = buildEngineSnapshot(ctx);
    const daily = store.verdictDaily(db, snap.today) || store.verdictHistory(db, 1)[0] || null;
    const ts = Math.max(snap.ts.futures || 0, snap.ts.prices || 0, snap.ts.fear_greed || 0);
    const fut = store.latestFutures(db);
    const futArr = fut && fut.data && fut.data.data ? fut.data.data : [];
    const totalOi = futArr.reduce((s, c) => s + (c.open_interest_usd || 0), 0);
    const avgOiChg = futArr.length ? futArr.reduce((s, c) => s + (c.open_interest_change_percent_24h || 0), 0) / futArr.length : 0;
    const oc = store.latestOpenclue(db);
    const ocd = oc && oc.data;
    const btc = futArr.find(c => c.symbol === 'BTC');
    res.json({
      ok: true, data_ts: ts || null, stale: staleOf(ts, 600), age_sec: ageSec(ts),
      verdict: snap.verdict, posture: snap.posture,
      posture_history: store.verdictHistory(db, 30).map(function(h) {
        let p = null;
        try { p = typeof h.posture_json === 'string' ? JSON.parse(h.posture_json) : h.posture_json; } catch (e) {}
        return { date: h.date, score: p && p.score, state: p && p.state };
      }).filter(function(h) { return h.score != null; }),
      hero_brief: snap.hero_brief,
      hero_brief_source: snap.hero_brief_source || 'openclue',
      hero_brief_history: (function() {
        // 仅自研历史（hero_brief_self 每天一条，不含今天）；彻底摆脱 openclue
        try {
          const rows = db.prepare("SELECT date, payload FROM hero_brief_self WHERE date < date('now','+8 hours') ORDER BY date DESC LIMIT 7").all();
          return rows.map(function(r) {
            const p = JSON.parse(r.payload);
            return { report_date: r.date, headline_zh: p.headline_zh, headline_en: p.headline_en || p.headline_zh, quote_zh: p.quote_zh || '', quote_en: p.quote_en || '', key_levels: p.key_levels || '', stance_pills: p.stance_pills || [], direction: p.direction || '', tone: p.tone || '' };
          });
        } catch (e) { warn('[routes] self hero history err:', e.message); return []; }
      })(),
      ai_daily: daily ? { date: daily.date, ai_text: daily.ai_text, ai_text_en: daily.ai_text_en, ai_source: daily.ai_source } : null,
      official: snap.official ? { verdict: snap.official.verdict, posture: snap.official.posture, market_stance: snap.official.market_stance, exported_at: snap.official.exported_at } : null,
      ts_detail: snap.ts,
      proxies: {
        total_oi_usd: totalOi || null,
        avg_oi_change_24h_pct: Math.round(avgOiChg * 100) / 100,
        btc_dominance: ocd ? ocd.btc_dominance ?? (btc ? btc.open_interest_usd / totalOi * 100 : null) : null,
        dominance_30d: ocd && ocd.btc_dominance_30d_series ? ocd.btc_dominance_30d_series : [],
        note_zh: 'OI 上升 + 市值扩张 ≈ 资金净流入；OI 下降 ≈ 去杠杆/资金离场'
      }
    });
  }));

  app.get('/api/coins', wrap((req, res) => {
    const snap = buildEngineSnapshot(ctx);
    const { rows } = store.latestPrices(db);
    const coins = snap.stances.map(s => {
      const pr = rows.find(r => r.symbol === s.symbol);
      const off = snap.officialStances[s.symbol] || null;
      return {
        symbol: s.symbol, stance: s.stance, confidence: s.confidence,
        headline_zh: s.headline_zh, headline_en: s.headline_en,
        status: s.status,
        price: pr ? pr.price : null, change_24h: pr ? pr.change_24h : (s.inputs ? s.inputs.price_24h : null),
        funding: s.inputs ? s.inputs.funding : null,
        official: off ? { stance: off.stance, confidence: off.confidence } : null,
        diverged: off ? off.stance !== s.stance : null
      };
    });
    const ts = Math.max(snap.ts.futures || 0, snap.ts.prices || 0);
    res.json({ ok: true, data_ts: ts || null, stale: staleOf(ts, 600), age_sec: ageSec(ts), coins });
  }));

  app.get('/api/fear-greed', wrap((req, res) => {
    const series = store.fgSeries(db, 90);
    const cur = store.fgCurrent(db);
    res.json({
      ok: true, data_ts: cur ? cur.ts : null, stale: staleOf(cur && cur.ts, 86400 * 2), age_sec: ageSec(cur && cur.ts),
      current: cur, series: series.map(r => ({ ts: r.ts, value: r.value, classification: r.classification }))
    });
  }));

  app.get('/api/markets', wrap((req, res) => {
    const { ts, rows } = store.latestPrices(db);
    const fut = store.latestFutures(db);
    const futArr = fut && fut.data && fut.data.data ? fut.data.data : [];
    const top = futArr.slice(0, 50).map(c => ({
      symbol: c.symbol, price: c.current_price,
      change_24h: c.price_change_percent_24h,
      funding: typeof c.avg_funding_rate_by_oi === 'number' ? c.avg_funding_rate_by_oi / 100 : null, // % → 小数
      oi_usd: c.open_interest_usd,
      oi_change_24h: c.open_interest_change_percent_24h,
      mcap_usd: c.market_cap_usd
    }));
    const tsAll = Math.max(ts || 0, fut ? fut.ts : 0);
    res.json({
      ok: true, data_ts: tsAll || null, stale: staleOf(tsAll, 600), age_sec: ageSec(tsAll),
      spot: rows.map(r => ({ symbol: r.symbol, price: r.price, change_24h: r.change_24h, high_24h: r.high_24h, low_24h: r.low_24h, volume: r.volume })),
      futures_top: top
    });
  }));

  const williamHandler = wrap((req, res) => {
    const snap = buildEngineSnapshot(ctx);
    res.json({
      ok: true, data_ts: snap.ts.openclue, stale: staleOf(snap.ts.openclue, 7200), age_sec: ageSec(snap.ts.openclue),
      official: snap.official,
      comparison: {
        local_verdict: snap.verdict.verdict, local_posture: snap.posture.state,
        divergence: snap.verdict.divergence,
        official_stances: snap.officialStances
      }
    });
  });
  app.get('/api/william', williamHandler); // William 运算核心
  app.get('/api/openclue', williamHandler); // 兼容旧端

  app.get('/api/glossary', (req, res) => {
    res.json({ ok: true, data_ts: null, stale: false, count: GLOSSARY.length, terms: GLOSSARY });
  });

  /* ============ 每日闯关（每日一题，连续答对3天送3天会员） ============ */
  function quizEnsureTable() {
    db.prepare(`CREATE TABLE IF NOT EXISTS quiz_state (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      answer TEXT,
      correct INTEGER DEFAULT 0,
      streak INTEGER DEFAULT 0,
      rewarded INTEGER DEFAULT 0,
      ts INTEGER,
      PRIMARY KEY (user_id, date)
    )`).run();
  }
  function quizStreakOf(userId) {
    const row = db.prepare("SELECT correct, streak FROM quiz_state WHERE user_id=? ORDER BY date DESC LIMIT 1").get(userId);
    return row && row.correct ? row.streak : 0;
  }

  app.get('/api/quiz/today', requireAuth, wrap((req, res) => {
    quizEnsureTable();
    const t = quizLib.todayQuestion();
    const st = db.prepare("SELECT * FROM quiz_state WHERE user_id=? AND date=?").get(req.user.id, t.date);
    const vip = vipOf(req.user);
    res.json({
      ok: true, date: t.date, qid: t.qid, question: t.question, options: t.options,
      answered: !!st, correct: st ? !!st.correct : null,
      streak: st ? st.streak : quizStreakOf(req.user.id),
      rewarded: st ? !!st.rewarded : false,
      vip: { level: vip.level, label: vip.label, days: vip.days, desc: vip.desc, expired: !!vip.expired, permanent: !!vip.permanent }
    });
  }));

  app.post('/api/quiz/answer', requireAuth, wrap((req, res) => {
    quizEnsureTable();
    const ans = String((req.body || {}).answer || '').toUpperCase();
    if (!['A', 'B', 'C'].includes(ans)) return res.json({ ok: false, error: '无效选项' });
    const t = quizLib.todayQuestion();
    const existed = db.prepare("SELECT * FROM quiz_state WHERE user_id=? AND date=?").get(req.user.id, t.date);
    if (existed) return res.json({ ok: false, error: '今日已作答，明天再来' });
    const correct = ans === t.answer ? 1 : 0;
    const yDate = quizLib.beijingDateOffset(Date.now(), 1);
    const y = db.prepare("SELECT correct, streak FROM quiz_state WHERE user_id=? AND date=?").get(req.user.id, yDate);
    const streak = correct ? ((y && y.correct) ? y.streak + 1 : 1) : 0;
    let rewarded = 0;
    if (correct && streak > 0 && streak % 3 === 0) {
      const base = Math.max(Date.now(), Number(req.user.expires_at) || 0);
      const next = base + 3 * quizLib.DAY_MS;
      db.prepare("UPDATE users SET expires_at=? WHERE id=?").run(next, req.user.id);
      rewarded = 1;
      info(`[quiz] 用户#${req.user.id} 连续答对 ${streak} 天，发放 3 天会员，到期 ${new Date(next).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    }
    db.prepare("INSERT OR REPLACE INTO quiz_state(user_id,date,answer,correct,streak,rewarded,ts) VALUES(?,?,?,?,?,?,?)")
      .run(req.user.id, t.date, ans, correct, streak, rewarded, Date.now());
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const vip = vipOf(u);
    res.json({
      ok: true, correct: !!correct, right_answer: t.answer, explain: t.explain,
      streak, rewarded: !!rewarded,
      vip: { level: vip.level, label: vip.label, days: vip.days, desc: vip.desc, expired: !!vip.expired, permanent: !!vip.permanent }
    });
  }));

  const KB_BASE = '/home/ubuntu/.openclaw/workspace/knowledge-base';
  const KB_SCRIPTS = KB_BASE + '/scripts';
  const KB_DATA = KB_BASE + '/data';
  let kbIdxCache = { ts: 0, idx: null };
  let kbRebuildAt = 0;
  let kbDirSnap = null;
  function kbDirSnapshot() {
    // 目录快照：文件列表 + mtime（新增/修改/删除都会改变快照）
    const parts = [];
    for (const d of ['technical', 'fundamental', 'qibao-judgment', 'engine']) {
      const dir = KB_BASE + '/' + d;
      try {
        for (const fn of fs.readdirSync(dir).sort()) {
          if (fn.endsWith('.md')) parts.push(d + '/' + fn + ':' + fs.statSync(path.join(dir, fn)).mtimeMs);
        }
      } catch (e) {}
    }
    return parts.join('|');
  }
  function kbMaybeRebuild() {
    const now = Date.now();
    if (now - kbRebuildAt < 3000) return;   // 防抖 3s
    let snap = null;
    try { snap = kbDirSnapshot(); } catch (e) { return; }
    if (kbDirSnap === null) { kbDirSnap = snap; return; }   // 首次初始化
    if (snap !== kbDirSnap) {
      try {
        execSync(`cd ${KB_SCRIPTS} && python3 kb_indexer.py build --quiet`, { timeout: 20000 });
        kbRebuildAt = now;
        kbDirSnap = kbDirSnapshot();
      } catch (e) {}
    }
  }
  function kbLoadIndex() {
    const fp = KB_DATA + '/kb_index.json';
    // 目录快照对比：云端龙虾/网页/SSH 写入（含删除）→ 下次请求自动重建索引
    kbMaybeRebuild();
    try {
      const st = fs.statSync(fp).mtimeMs;
      if (!kbIdxCache.idx || st !== kbIdxCache.ts) {
        kbIdxCache = { ts: st, idx: JSON.parse(fs.readFileSync(fp, 'utf8')) };
      }
    } catch (e) { kbIdxCache = { ts: 0, idx: null }; }
    return kbIdxCache.idx;
  }
  const KB_SYN = { "止盈":["止盈位","目标价","TP"], "止损":["SL","stop"], "布林带":["布林","bollinger"], "缩量":["量缩"], "放量":["放量突破"], "震荡":["盘整","横盘","振荡"], "洗盘":["洗筹"], "趋势":["顺势"], "多头":["看多","偏多"], "空头":["看空","偏空"], "仓位":["持仓","开仓"], "杠杆":["杠杆率"], "突破":["上破","下破"], "周末":["周六","周日"], "盈亏比":["R:R"] };
  const KB_ALIAS = { "狗狗币":"DOGE", "大饼":"BTC", "比特币":"BTC", "以太坊":"ETH", "闪迪":"SNDK", "微策略":"MSTR" };
  function kbExpand(words) {
    const out = []; const rev = {};
    for (const k in KB_SYN) for (const v of KB_SYN[k]) rev[v] = k;
    for (const w of words) {
      out.push(w);
      const a = KB_ALIAS[w]; if (a) out.push(a);
      (KB_SYN[w] || []).forEach(x => out.push(x));
      if (rev[w]) out.push(rev[w]);
    }
    return out.filter(Boolean);
  }
  function kbBigram(t) {
    const s = new Set(); t = String(t || '').toLowerCase();
    for (let i = 0; i < t.length - 1; i++) s.add(t.slice(i, i + 2));
    return s;
  }
  function kbTokenize(q) {
    // 长句自然语言 → 从索引词条词典提取 2-6 字子串（自动分词）
    const idx = kbLoadIndex();
    const terms = new Set(Object.keys((idx && idx.inverted) || {}));
    const found = new Set();
    const s = String(q || '');
    for (let L = 6; L >= 2; L--) {
      for (let i = 0; i + L <= s.length; i++) {
        const sub = s.slice(i, i + L);
        if (terms.has(sub)) found.add(sub);
      }
    }
    return [...found];
  }
  function kbSearch(q, topN) {
    const idx = kbLoadIndex();
    if (!idx) return { ok: false, error: 'index missing' };
    let words = String(q || '').split(/\s+/).filter(Boolean).slice(0, 4);
    if (!words.length) return { ok: true, words: '', results: [] };
    // 长句（无空格且超过 6 字）→ 词典切分后检索
    if (words.length === 1 && words[0].length > 6) {
      const toks = kbTokenize(words[0]);
      if (toks.length) words = toks.slice(0, 6);
    }
    const qw = kbExpand(words);
    const qb = new Set(); qw.forEach(w => kbBigram(w).forEach(b => qb.add(b)));
    const scores = {}; const inv = idx.inverted || {};
    qw.forEach(w => { (inv[w] || []).forEach(h => { scores[h.id] = (scores[h.id] || 0) + h.w * 2; }); });
    const blocks = idx.blocks || {};
    if (words.length <= 4) {
      for (const bid in blocks) {
        const b = blocks[bid]; const text = String(b.text || '').toLowerCase();
        let cnt = 0; qw.forEach(w => { if (w && text.includes(String(w).toLowerCase())) cnt++; });
        if (cnt) scores[bid] = (scores[bid] || 0) + cnt;
        const tb = kbBigram(b.text || '');
        if (tb.size && qb.size) {
          let inter = 0; qb.forEach(bk => { if (tb.has(bk)) inter++; });
          const j = inter / (qb.size + tb.size - inter);
          if (j > 0.02) scores[bid] = (scores[bid] || 0) + j * 60;
        }
      }
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, topN || 8);
    return {
      ok: true, words: words.join('+'), ms: 0,
      results: ranked.map(([bid, sc]) => {
        const b = blocks[bid];
        const lines = String(b.text || '').split('\n').map(s => s.trim()).filter(s => s && qw.some(w => w && s.toLowerCase().includes(String(w).toLowerCase()))).slice(0, 3);
        return { id: bid, file: b.file, title: b.title, lines: b.start + '-' + b.end, score: Math.round(sc * 10) / 10, hits: lines };
      })
    };
  }

  app.get('/api/kb/status', requireAuth, (req, res) => {
    const idx = kbLoadIndex();
    let snap = null, sync = null;
    try { snap = JSON.parse(fs.readFileSync(KB_DATA + '/kb_snapshot.json', 'utf8')); } catch (e) {}
    try {
      const lines = fs.readFileSync(KB_DATA + '/sync.log', 'utf8').split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      try { sync = JSON.parse(last); } catch (e) { sync = { raw: last }; }
    } catch (e) {}
    res.json({
      ok: true,
      stats: idx ? idx.stats : null,
      snapshot_ts: snap ? snap.ts : null,
      sync_ts: sync ? sync.ts || sync.raw : null,
      history_count: (() => { try { return fs.readFileSync(KB_DATA + '/kb_history.jsonl', 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } })(),
      audit_count: (() => { try { return fs.readFileSync(KB_DATA + '/kb_audit.jsonl', 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } })()
    });
  });

  app.get('/api/kb/tree', requireAuth, (req, res) => {
    const idx = kbLoadIndex();
    if (!idx) return res.json({ ok: false, error: 'index missing' });
    const files = {};
    for (const bid in idx.blocks) {
      const b = idx.blocks[bid];
      (files[b.file] = files[b.file] || []).push({ id: bid, title: b.title, level: b.level, start: b.start, end: b.end });
    }
    const order = ['technical', 'fundamental', 'qibao-judgment', 'engine'];
    const names = { 'technical': '📈 技术面', 'fundamental': '🌍 基本面', 'qibao-judgment': '👑 7宝判断', 'engine': '⚙️ 引擎说明', 'README.md': '📖 说明' };
    const list = Object.keys(files).sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
    res.json({ ok: true, files: list.map(f => ({ file: f, name: names[f] || f, blocks: files[f].sort((a, b) => a.start - b.start) })) });
  });

  app.get('/api/kb/block', requireAuth, (req, res) => {
    const idx = kbLoadIndex();
    const b = idx && idx.blocks[req.query.id];
    if (!b) return res.json({ ok: false, error: 'block not found' });
    res.json({ ok: true, block: b });
  });

  app.get('/api/kb/search', requireAuth, (req, res) => {
    const t0 = Date.now();
    const r = kbSearch(req.query.q || '', parseInt(req.query.top) || 8);
    r.ms = Date.now() - t0;
    res.json(r);
  });

  app.get('/api/kb/snapshot', requireAuth, (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(KB_DATA + '/kb_snapshot.json', 'utf8'))); }
    catch (e) { res.json({ ok: false, error: String(e) }); }
  });

  app.get('/api/kb/history', requireAuth, (req, res) => {
    try {
      const rows = fs.readFileSync(KB_DATA + '/kb_history.jsonl', 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      res.json({ ok: true, rows });
    } catch (e) { res.json({ ok: false, error: String(e) }); }
  });

  app.get('/api/kb/audit', requireAdmin, (req, res) => {
    try {
      const rows = fs.readFileSync(KB_DATA + '/kb_audit.jsonl', 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse().slice(0, 60);
      res.json({ ok: true, rows });
    } catch (e) { res.json({ ok: false, error: String(e) }); }
  });

  app.get('/api/kb/engine', requireAuth, (req, res) => {
    const sym = String(req.query.sym || 'BTC').toUpperCase().replace(/[^A-Z0-9]/g, '');
    try {
      const out = execSync(`cd ${KB_BASE} && timeout 90 python3 engine/run_engine.py ${sym} --json 2>/dev/null`, { timeout: 95000, maxBuffer: 8 * 1024 * 1024 }).toString().trim();
      const m = out.match(/\{[\s\S]*\}/);
      const data = JSON.parse(m ? m[0] : out);
      // 附带知识注入参考（按信号类型）
      const lbl = (data.position && data.position.label) || '';
      const sc = Math.abs(data.score_adjusted || 0);
      const vol = data.volume_state || '';
      let qw = ['震荡', '布林带', '均值回归', '仓位'];
      if (lbl.includes('多') || (data.score_adjusted || 0) >= 0.3) qw = ['趋势', '突破', '吊灯', '顺势'];
      else if (lbl.includes('空') || (data.score_adjusted || 0) <= -0.3) qw = ['趋势', '突破', '吊灯', '止损'];
      if (vol.includes('缩量')) qw = qw.concat(['缩量', '洗盘']);
      data.kb_inject = kbSearch(qw.join(' '), 4);
      res.json({ ok: true, sym, data, inject_query: qw.join(' ') });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  });

  app.post('/api/kb/sync', requireAdmin, (req, res) => {
    try {
      const out = execSync(`cd ${KB_SCRIPTS} && timeout 120 python3 sync_kb_data.py 2>&1 | tail -2`, { timeout: 125000, maxBuffer: 4 * 1024 * 1024 }).toString().trim();
      res.json({ ok: true, out });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  });

  app.post('/api/kb/verify', requireAdmin, (req, res) => {
    try {
      const out = execSync(`cd ${KB_BASE} && python3 scripts/kb_protect.py check 2>&1`, { timeout: 20000, maxBuffer: 2 * 1024 * 1024 }).toString().trim();
      res.json({ ok: true, out });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  });



  /* ---- W1 系统知识检索（整个 w1 系统可问）---- */
  const GLOSSARY = (() => { try { return require('./glossary').GLOSSARY || []; } catch (e) { return []; } })();
  function kbSplitQuery(q) {
    const parts = String(q || '').split(/[和与,，、;；]/).map(s => s.trim()).filter(s => s.length >= 2);
    return (parts.length >= 2 && parts.length <= 3) ? parts.slice(0, 3) : [String(q || '').trim()];
  }
  function kbW1Know(q, tokens) {
    const parts = [], refs = [];
    const low = q.toLowerCase();
    const hit = (s) => tokens.some(t => t && s.includes(t.toLowerCase())) || low.includes(s.toLowerCase());
    // 1. 概念词典（关键词匹配）
    let g = 0;
    for (const it of GLOSSARY) {
      if (g >= 3) break;
      const keys = [it.en, it.zh].filter(Boolean);
      if (keys.some(k => hit(k) || tokens.some(t => t && (it.en || '').toLowerCase().includes(t.toLowerCase())))) {
        parts.push(`【概念词典】${it.en} / ${it.zh}：${(it.desc_zh || it.desc_en || '').slice(0, 180)}`);
        refs.push({ type: 'w1', source: '概念词典', title: it.zh || it.en, text: it.desc_zh || '' });
        g++;
      }
    }
    // 2. 系统判断（最近 3 天趋势 → 推理用）
    try {
      const vs = db.prepare('SELECT date,verdict_json FROM verdict_daily ORDER BY date DESC LIMIT 3').all();
      if (vs.length) {
        const line = vs.map(v => { try { const j = JSON.parse(v.verdict_json); return `${v.date}:${j.verdict_zh || ''}(${(j.headline_zh || '').slice(0, 70)})`; } catch (e) { return v.date; } }).join('；');
        parts.push(`【系统判断趋势】${line}`);
        const v0 = JSON.parse(vs[0].verdict_json || '{}');
        refs.push({ type: 'w1', source: '系统判断', title: vs[0].date + ' ' + (v0.verdict_zh || ''), text: v0.headline_zh || '' });
      }
    } catch (e) {}
    // 3. 情绪（前后对比）
    try {
      const fs = db.prepare('SELECT value,classification FROM fear_greed ORDER BY ts DESC LIMIT 2').all();
      if (fs.length) { parts.push(`【情绪变化】${fs.map(f => `${f.value}(${f.classification})`).join(' → ')}`); refs.push({ type: 'w1', source: '情绪', title: 'FGI ' + fs[0].value + ' ' + fs[0].classification, text: '' }); }
    } catch (e) {}
    // 3.5 LSR 变化（BTC 4h 方向）
    try {
      const lh = db.prepare("SELECT symbol,ratio,delta_4h FROM lsr_history WHERE symbol='BTCUSDT' ORDER BY ts DESC LIMIT 1").get();
      if (lh) { parts.push(`【LSR变化】BTC ${lh.ratio != null ? Number(lh.ratio).toFixed(2) : '?'}（4h变化 ${lh.delta_4h != null ? Number(lh.delta_4h).toFixed(2) : '?'}）`); }
    } catch (e) {}
    // 4. 多空结构（LSR 前 4）
    try {
      const rows = db.prepare("SELECT payload FROM lsr_rankings WHERE mode='trader' ORDER BY ts DESC LIMIT 1").get();
      if (rows) {
        const d = JSON.parse(rows.payload || '{}');
        const arr = (d.data || d).slice ? (d.data || []) : [];
        const top = arr.filter(r => r && r.symbol).slice(0, 4).map(r => `${r.symbol}=${r.ratio != null ? Number(r.ratio).toFixed(2) : '?'}`);
        if (top.length) { parts.push(`【LSR 多空比】${top.join('，')}`); refs.push({ type: 'w1', source: '多空结构', title: 'LSR ' + top.join(' '), text: '' }); }
      }
    } catch (e) {}
    // 5. KOL 观点（关键词匹配优先）
    try {
      const rows = db.prepare("SELECT author,content,direction,confidence FROM kol_signals ORDER BY ts DESC LIMIT 30").all();
      const pick = rows.filter(r => !tokens.length || tokens.some(t => t && String(r.content || '').includes(t))).slice(0, 3);
      for (const r of pick) {
        parts.push(`【KOL ${r.author || ''}】${String(r.content || '').slice(0, 120)}（${r.direction || ''} ${r.confidence != null ? r.confidence : ''}）`);
        refs.push({ type: 'w1', source: 'KOL观点', title: (r.author || '') + ' ' + String(r.content || '').slice(0, 24), text: '' });
      }
    } catch (e) {}
    // 6. 消息面（新闻匹配）
    try {
      const rows = db.prepare("SELECT title,source_label FROM news ORDER BY ts DESC LIMIT 40").all();
      const pick = rows.filter(r => !tokens.length || tokens.some(t => t && String(r.title || '').includes(t))).slice(0, 3);
      for (const r of pick) { parts.push(`【消息面】${String(r.title || '').slice(0, 100)}（${r.source_label || ''}）`); refs.push({ type: 'w1', source: '消息面', title: String(r.title || '').slice(0, 30), text: '' }); }
    } catch (e) {}
    // 7. 宏观快照（最近）
    try {
      const m = db.prepare('SELECT payload FROM macro_snapshot ORDER BY ts DESC LIMIT 1').get();
      if (m) { const s = String(m.payload || '').slice(0, 500); parts.push(`【宏观快照】${s}`); refs.push({ type: 'w1', source: '宏观', title: s.slice(0, 30), text: '' }); }
    } catch (e) {}
    return { parts, refs };
  }

  /* ---- W1 全文件知识索引（只读：文档 + 代码头注释）---- */
  let w1FilesCache = { ts: 0, files: [] };
  function w1FilesIndex() {
    const now = Date.now();
    if (now - w1FilesCache.ts < 30000) return w1FilesCache.files;
    const files = [];
    const base = '/home/ubuntu/w1-board';
    const skip = new Set(['node_modules', '.git', 'data', 'backups']);
    function walk(dir, depth) {
      if (depth > 3) return;
      let ents = [];
      try { ents = fs.readdirSync(dir); } catch (e) { return; }
      for (const fn of ents) {
        if (skip.has(fn) || fn.endsWith('.bak')) continue;
        const fp = path.join(dir, fn);
        let st = null;
        try { st = fs.statSync(fp); } catch (e) { continue; }
        if (st.isDirectory()) { walk(fp, depth + 1); continue; }
        const rel = fp.replace(base + '/', '');
        try {
          if (fn.endsWith('.md')) {
            files.push({ path: rel, title: fn, text: fs.readFileSync(fp, 'utf8').slice(0, 3000) });
          } else if (fn.endsWith('.js') && !fn.endsWith('.min.js')) {
            const s = fs.readFileSync(fp, 'utf8');
            const m = s.match(/\/\*\*[\s\S]*?\*\//);
            if (m) files.push({ path: rel, title: fn, text: m[0].slice(0, 900) });
          } else if (fn === 'README.md') {
            files.push({ path: rel, title: fn, text: fs.readFileSync(fp, 'utf8').slice(0, 3000) });
          }
        } catch (e) {}
      }
    }
    try { walk(base, 0); } catch (e) {}
    w1FilesCache = { ts: now, files };
    return files;
  }
  function kbW1Files(q, tokens, topN) {
    const files = w1FilesIndex();
    const scored = [];
    for (const f of files) {
      let sc = 0;
      const low = f.text.toLowerCase();
      if (f.title.toLowerCase().includes(String(q).toLowerCase())) sc += 3;
      for (const t of tokens) {
        if (!t) continue;
        const c = low.split(String(t).toLowerCase()).length - 1;
        if (c > 0) sc += Math.min(c, 3);
      }
      if (sc > 0) scored.push({ f, sc });
    }
    scored.sort((a, b) => b.sc - a.sc);
    return scored.slice(0, topN || 5).map(x => ({
      part: `[W1文件] ${x.f.path}\n${x.f.text.slice(0, 1400)}`,
      ref: { type: 'w1file', source: '系统文件', title: x.f.title, text: x.f.text.slice(0, 150), path: x.f.path }
    }));
  }

  /* ---- 多源联网搜索：search-server(Bing) + DuckDuckGo + W1 消息库 ---- */
  async function kbDdg(q, n) {
    try {
      const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      const html = await r.text();
      const out = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && out.length < n) {
        let url = m[1];
        const u = url.match(/uddg=([^&]+)/);
        if (u) { try { url = decodeURIComponent(u[1]); } catch (e) {} }
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        const sn = html.slice(m.index, m.index + 1500).match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        out.push({ title, url, desc: sn ? sn[1].replace(/<[^>]+>/g, '').trim().slice(0, 300) : '' });
      }
      return out;
    } catch (e) { return []; }
  }
  async function kbWebSearchMulti(q, topN) {
    const seen = new Set(), out = [];
    try {
      const r = await fetch('http://127.0.0.1:3334/search?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(12000) });
      const d = await r.json();
      for (const it of (d.results || [])) { if (!seen.has(it.url)) { seen.add(it.url); out.push({ title: it.title, url: it.url, desc: it.desc || '' }); } }
    } catch (e) {}
    const ddg = await kbDdg(q, topN);
    for (const it of ddg) { if (!seen.has(it.url)) { seen.add(it.url); out.push(it); } }
    // W1 消息库补充
    try {
      const rows = db.prepare('SELECT title,source_label FROM news ORDER BY ts DESC LIMIT 20').all();
      for (const r of rows) { const t = String(r.title || ''); if (!seen.has(t)) { seen.add(t); out.push({ title: t, url: '', desc: r.source_label || '' }); } }
    } catch (e) {}
    return out.slice(0, topN);
  }
  /* ---- chat：三模式统一入口 ---- */
  async function kbGather(mode, q, tokens) {
    // 权重：kb 模式 7宝知识库降权(3块) + W1系统 + W1全文件；mix 模式联网加权(8) + 全文件；web 纯联网
    const w = mode === 'kb' ? { kb: 3, w1: true, files: true, web: 0 }
            : mode === 'mix' ? { kb: 3, w1: true, files: true, web: 8 }
            : { kb: 0, w1: false, files: false, web: 8 };
    const subs = kbSplitQuery(q);   // 问题分解：多子句分别检索，增强推理输入
    const ctxParts = [], refs = [], seen = new Set();
    const push = (part, ref) => {
      const key = ref.id || ref.url || ref.path || (ref.source + '|' + ref.title);
      if (seen.has(key)) return;
      seen.add(key);
      ctxParts.push(part);
      refs.push(ref);
    };
    for (let si = 0; si < subs.length; si++) {
      const sub = subs[si], toks = kbTokenize(sub);
      if (w.kb > 0) {
        const sr = kbSearch(sub, w.kb);
        if (sr.ok && sr.results.length) {
          const idx = kbLoadIndex();
          for (const r of sr.results) {
            const b = idx && idx.blocks[r.id];
            push(`[知识库·参考] ${r.title}（${r.file} L${r.lines}）\n${(b && b.text || '').slice(0, 600)}`, { type: 'kb', title: r.title, file: r.file, lines: r.lines, id: r.id });
          }
        }
      }
      if (w.w1) {
        const w1 = kbW1Know(sub, toks);
        w1.parts.forEach((p, i) => push(`[W1系统] ${p}`, w1.refs[i] || { type: 'w1', source: 'W1', title: '' }));
      }
      if (w.files) {
        const wf = kbW1Files(sub, toks, si === 0 ? 5 : 3);
        for (const x of wf) push(x.part, x.ref);
      }
      // 联网只对第一个子问题（控制延迟），其余子问题用本地源
      if (w.web > 0 && si === 0) {
        const results = await kbWebSearchMulti(sub, w.web);
        for (const r of results) {
          push(`[联网] ${r.title}\n${r.url || '(消息库)'}\n${(r.desc || '').slice(0, 250)}`, { type: 'web', title: r.title, url: r.url || '', lines: '' });
        }
      }
    }
    return { ctx: ctxParts.join('\n\n').slice(0, 11000), refs };
  }
  const REASON_CHAIN = '\n铁律：数据只是证据，结论必须来自推理链；禁止只罗列数据；信息不足时明确说明；给出明确倾向，避免模棱两可。';
  const KB_SYS_PROMPT = {
    kb: '你是「威廉 W1 系统」首席量化分析助手。你的职责是推理，不是复述数据。以【W1系统】数据与【W1文件】为主要依据，【知识库】作参考。严格按五步推理链输出（Markdown 标题）：\n## 一、事实提取：列出关键事实与来源\n## 二、多维度分析：技术/资金/情绪/宏观各自含义\n## 三、交叉验证：维度一致还是矛盾？矛盾时说明取舍理由\n## 四、推理结论：方向判断 + 置信度（高/中/低）+ 成立条件\n## 五、风险与反证：判断最可能错在哪？反方逻辑是什么？' + REASON_CHAIN,
    web: '你是联网资讯分析师。基于【联网】搜索结果进行推理：先提取事实，再分析因果与影响，最后给结论与风险。标注来源编号[1][2]。' + REASON_CHAIN,
    mix: '你是「威廉 W1 系统」首席分析助手。以【联网】结果为主、【W1系统】数据与【W1文件】为辅、【知识库】参考，严格按五步推理链输出（事实提取 → 多维分析 → 交叉验证 → 推理结论 → 风险反证），标注来源类型（联网/W1/知识库）。' + REASON_CHAIN
  };

  /* ---- 知识库问答（RAG，登录用户）---- */
  const KB_ASK_CACHE = new Map();
  const KB_ASK_USER = new Map();
  function kbAskLLM(q, ctxText) {
    const ai = require('./ai');
    return ai.chat(env, [
      { role: 'system', content: '你是「7宝知识库」交易知识助手。只基于提供的知识区块回答问题，优先引用区块内容，不编造。结构：先给结论，再分点展开。若知识不足，明确说「知识库中未找到相关内容」。' },
      { role: 'user', content: `问题：${q}\n\n以下为知识库检索到的相关区块（编号[1]起，含来源）：\n${ctxText}` }
    ]);
  }
  app.get('/api/kb/ask', requireAuth, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (!q) return res.json({ ok: false, error: 'empty question' });
    const uid = String((req.user && (req.user.id || req.user.username)) || 'anon');
    const now = Date.now();
    // 限流：每用户 10 次 / 5 分钟
    const hist = (KB_ASK_USER.get(uid) || []).filter(t => now - t < 300000);
    if (hist.length >= 10) return res.json({ ok: false, error: 'rate_limit', msg: '提问太频繁，请 5 分钟后再试' });
    hist.push(now);
    KB_ASK_USER.set(uid, hist);
    // 缓存：相同问题 5 分钟
    const hit = KB_ASK_CACHE.get(q);
    if (hit && now - hit.ts < 300000) return res.json(hit.data);
    const sr = kbSearch(q, 5);
    if (!sr.ok || !sr.results.length) {
      const data = { ok: true, answer: '知识库中未找到与问题相关的内容。试试换个关键词（支持同义词：目标价/盘整/TP 等）。', refs: [], degraded: true };
      KB_ASK_CACHE.set(q, { ts: now, data });
      return res.json(data);
    }
    const idx = kbLoadIndex();
    const ctxText = sr.results.map((r, i) => {
      const b = idx && idx.blocks[r.id];
      return `[${i + 1}] ${r.title}（${r.file} L${r.lines}）\n${(b && b.text || '').slice(0, 1200)}`;
    }).join('\n\n');
    const refs = sr.results.map(r => ({ title: r.title, file: r.file, lines: r.lines, id: r.id }));
    const t0 = Date.now();
    try {
      const llm = await kbAskLLM(q, ctxText);
      const data = { ok: true, answer: llm.text, source: llm.source, refs, ms: Date.now() - t0 };
      KB_ASK_CACHE.set(q, { ts: now, data });
      res.json(data);
    } catch (e) {
      // 降级：LLM 不可用时返回检索摘要（替代方案）
      const data = {
        ok: true, answer: 'AI 生成暂不可用，已降级返回知识库检索结果：\n\n' +
          sr.results.map((r, i) => `[${i + 1}] ${r.title}（${r.file} L${r.lines}）`).join('\n') +
          '\n\n点击下方引用可查看原文。',
        refs, degraded: true, error: String(e.message || e).slice(0, 80)
      };
      KB_ASK_CACHE.set(q, { ts: now, data });
      res.json(data);
    }
  }));

  /* ---- 知识库写入（老板，网页端）---- */
  app.post('/api/kb/write', kbOwnerOrAdmin, wrap(async (req, res) => {
    const { category, title, content } = req.body || {};
    const cats = ['technical', 'fundamental', 'qibao-judgment', 'engine'];
    if (!cats.includes(category)) return res.json({ ok: false, error: 'category 必须是 ' + cats.join('/') });
    const t = String(title || '').trim().slice(0, 100);
    const c = String(content || '').trim();
    if (!t) return res.json({ ok: false, error: '标题不能为空' });
    if (!c || c.length > 5000) return res.json({ ok: false, error: '正文需 1-5000 字符' });
    const slug = t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kb-' + Date.now();
    const rel = `${category}/${slug}.md`;
    const file = `${KB_BASE}/${rel}`;
    if (fs.existsSync(file)) return res.json({ ok: false, error: '同名知识已存在（' + rel + '），请换标题' });
    fs.writeFileSync(file, `# ${t}\n\n> 写入：老板（网页端）· ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n\n${c}\n`, 'utf8');
    try {
      execSync(`cd ${KB_SCRIPTS} && python3 kb_indexer.py build --quiet && python3 kb_audit.py check --actor 老板 >> ../data/sync.log 2>&1`, { timeout: 60000 });
    } catch (e) { /* 索引失败不阻断写入 */ }
    const idx = kbLoadIndex();
    const bid = Object.keys(idx.blocks || {}).find(k => idx.blocks[k].file === rel) || '';
    res.json({ ok: true, block_id: bid, file: rel, note: '已写入并重建索引' });
  }));


  /* ---- 对话式 AI（多轮 + 双模式：本地知识库 / 联网搜索）---- */
  const KB_CHAT_SESS = new Map();   // uid -> [{role,content}...] 最多 20 条
  const KB_CHAT_RL = new Map();     // uid -> {kb:[ts], web:[ts]}
  const KB_CHAT_GLOBAL = [];        // web 全局限流
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS kb_ask_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, mode TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, refs_json TEXT, created_at INTEGER NOT NULL)`);
    // 查询性能索引（大表：news 7.8万 / lsr / 问答历史）
    db.exec(`CREATE INDEX IF NOT EXISTS idx_kbask_uid_ts ON kb_ask_history(user_id, created_at);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_news_ts ON news(ts);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_lsr_mode_ts ON lsr_rankings(mode, ts);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_lsrhist_sym_ts ON lsr_history(symbol, ts);`);
  } catch (e) {}
  /* 写知识权限：两个老板（is_owner）或后台 admin */
  function kbOwnerOrAdmin(req, res, next) {
    const as = findSession(db, req.cookies[ADMIN_COOKIE], 'admin');
    if (as) { req.admin = as; return next(); }
    const us = findSession(db, req.cookies[USER_COOKIE], 'user');
    if (us) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(us.user_id);
      if (u && u.status === 'approved' && u.is_owner) { req.user = u; return next(); }
    }
    return res.status(403).json({ ok: false, error: 'owner_only', message: '仅老板（William / 7宝）可写入知识' });
  }
  /* 每日问答配额：会员每天 10 次（老板/永久不限） */
  function kbDailyQuota(uid) {
    try {
      const d = new Date(Date.now() + 8 * 3600 * 1000);
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime() - 8 * 3600 * 1000;
      const row = db.prepare('SELECT COUNT(*) c FROM kb_ask_history WHERE user_id=? AND created_at>=?').get(uid, start);
      return Math.max(0, 10 - (row ? row.c : 0));
    } catch (e) { return 10; }
  }
  function kbChatSave(uid, mode, q, a, refs) {
    try { db.prepare('INSERT INTO kb_ask_history(user_id,mode,question,answer,refs_json,created_at) VALUES(?,?,?,?,?,?)').run(uid, mode, q, a, JSON.stringify(refs || []), Date.now()); } catch (e) {}
  }
  async function kbWebSearch(q, topN) {
    const r = await fetch('http://127.0.0.1:3334/search?q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    return (d.results || []).slice(0, topN || 6);
  }
  app.post('/api/kb/chat', requireAuth, wrap(async (req, res) => {
    const { mode, question } = req.body || {};
    const m = mode === 'web' ? 'web' : (mode === 'mix' ? 'mix' : 'kb');
    const q = String(question || '').trim().slice(0, 200);
    if (!q) return res.json({ ok: false, error: '问题不能为空' });
    const uid = Number(req.user.id);
    const isOwner = !!req.user.is_owner;
    const remain = kbDailyQuota(uid);
    if (!isOwner && remain <= 0) return res.json({ ok: false, error: 'quota_exhausted', msg: '今日问答次数已用完（10 次/天），明天再来', remaining: 0 });
    if (m === 'web' || m === 'mix') {
      KB_CHAT_GLOBAL.push(Date.now());
      if (KB_CHAT_GLOBAL.length > 500) KB_CHAT_GLOBAL.splice(0, KB_CHAT_GLOBAL.length - 500);
      if (KB_CHAT_GLOBAL.filter(t => Date.now() - t < 300000).length > 30) return res.json({ ok: false, error: 'rate_limit', msg: '联网问答繁忙，请稍后再试' });
    }
    let sess = (KB_CHAT_SESS.get(uid) || []).slice(-24);
    // 跨会话上下文：会话不足时从历史库补最近 3 轮（换设备/重启后仍能续聊）
    if (sess.length < 6) {
      try {
        const hist = db.prepare('SELECT question,answer FROM kb_ask_history WHERE user_id=? ORDER BY id DESC LIMIT 3').all(uid);
        for (const h of hist.reverse()) { sess.push({ role: 'user', content: String(h.question).slice(0, 200) }, { role: 'assistant', content: String(h.answer).slice(0, 400) }); }
      } catch (e) {}
    }
    // 长度控制：上下文总量 ≤6000 字符
    let sessLen = 0; const sessTrim = [];
    for (const m of sess) { sessLen += String(m.content || '').length; if (sessLen > 6000) break; sessTrim.push(m); }
    sess = sessTrim;
    const t0 = Date.now();
    try {
      let answer = '', refs = [], degraded = false;
      const tokens = kbTokenize(q);
      const gathered = await kbGather(m, q, tokens);
      if (!gathered.ctx.trim()) {
        answer = m === 'web' ? '联网搜索未返回结果，试试换个关键词。' : '本地与系统知识均未找到相关内容，试试换个关键词（支持同义词：目标价/盘整/TP 等）。';
      } else {
        const ai = require('./ai');
        const llm = await ai.chat(env, [
          { role: 'system', content: KB_SYS_PROMPT[m] || KB_SYS_PROMPT.kb },
          ...sess,
          { role: 'user', content: `问题：${q}\n\n资料：\n${gathered.ctx}` }
        ]);
        answer = llm.text;
        refs = gathered.refs;
      }
      const data = { ok: true, mode: m, answer, refs, ms: Date.now() - t0, degraded, remaining: isOwner ? -1 : remain - 1 };
      KB_CHAT_SESS.set(uid, sess.concat([{ role: 'user', content: q }, { role: 'assistant', content: answer }]).slice(-30));
      kbChatSave(uid, m, q, answer, refs);
      res.json(data);
    } catch (e) {
      const data = { ok: true, mode: m, answer: 'AI 服务暂不可用，请稍后再试。', refs: [], degraded: true, error: String(e.message || e).slice(0, 80) };
      kbChatSave(uid, m, q, data.answer, []);
      res.json(data);
    }
  }));
  /* 今日剩余问答次数 */
  app.get('/api/kb/quota', requireAuth, (req, res) => {
    res.json({ ok: true, remaining: req.user.is_owner ? -1 : kbDailyQuota(Number(req.user.id)) });
  });
  /* 我的问答历史（仅本人） */
  app.get('/api/kb/chat/history', requireAuth, (req, res) => {
    try {
      const rows = db.prepare('SELECT id,mode,question,answer,refs_json,created_at FROM kb_ask_history WHERE user_id=? ORDER BY id DESC LIMIT 50').all(Number(req.user.id));
      res.json({ ok: true, rows: rows.map(r => ({ id: r.id, mode: r.mode, question: r.question, answer: r.answer, refs: (() => { try { return JSON.parse(r.refs_json || '[]'); } catch (e) { return []; } })(), ts: r.created_at })) });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 120) }); }
  });
  /* 老板：全部用户问答记录 */
  app.get('/api/admin/kb/chat/history', requireAdmin, (req, res) => {
    try {
      const rows = db.prepare('SELECT h.id,h.user_id,u.username,h.mode,h.question,h.answer,h.created_at FROM kb_ask_history h LEFT JOIN users u ON u.id=h.user_id ORDER BY h.id DESC LIMIT 100').all();
      res.json({ ok: true, rows });
    } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 120) }); }
  });


  app.get('/api/market-global', wrap((req, res) => {
    const mg = require('./market_global');
    const cur = mg.getCurrent(db);
    res.json({ ok: true, current: cur, series: mg.getSeries(db, 90), data_ts: cur ? cur.ts : null });
  }));

  /* 全球资产 10 大指标：只读缓存（定时任务 collectMacroIndicators 每 30min 算好存库，前端直接渲染） */
  app.get('/api/macro/indicators', wrap((req, res) => {
    try {
      const row = db.prepare('SELECT payload, ts FROM macro_indicators_cache ORDER BY ts DESC LIMIT 1').get();
      if (!row) return res.json({ ok: true, computing: true, ts: null, composite: null, compositeState: '—', indicators: [] });
      const d = JSON.parse(row.payload);
      d.ok = true;
      d.cache_ts = row.ts;
      d.age_sec = Math.floor(Date.now() / 1000) - row.ts;
      res.json(d);
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

  /* 收益率曲线（FRED DGS 官方：2Y/10Y/30Y + FFR 锚） */
  app.get('/api/macro/curve', wrap((req, res) => {
    try {
      const row = db.prepare('SELECT payload FROM macro_snapshot ORDER BY ts DESC LIMIT 1').get();
      const out = { ok: true, points: [], ts: null };
      if (row) {
        const p = JSON.parse(row.payload);
        out.ts = p.ts || null;
        const map = { DGS2: '2Y', DGS10: '10Y', DGS30: '30Y' };
        for (const [id, label] of Object.entries(map)) {
          const s = (p.series || {})[id];
          if (s && s.observations && s.observations[0]) out.points.push({ label, value: Number(s.observations[0].value) });
        }
        const dff = (p.series || {}).DFF;
        if (dff && dff.observations && dff.observations[0]) out.points.push({ label: 'FFR', value: Number(dff.observations[0].value), ref: true });
      }
      res.json(out);
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

  app.get('/api/altseason', wrap((req, res) => {
    const as = require('./altseason');
    res.json({ ok: true, current: as.getToday(db), history: as.getHistory(db, 180) });
  }));

  app.get('/api/eco-calendar', wrap((req, res) => {
    const ec = require('./eco_calendar');
    const data = ec.getEvents(db);
    if (!data) return res.json({ ok: false });
    res.json({ ok: true, updated_at: data.updated_at, future: data.future, past: data.past });
  }));

  app.get('/api/etf-flows', wrap((req, res) => {
    const oc = store.latestOpenclue(db);
    const ocd = oc && oc.data;
    const series = ocd && Array.isArray(ocd.etf_btc_flow_14d_series) ? ocd.etf_btc_flow_14d_series : [];
    const fut = store.latestFutures(db);
    const futArr = fut && fut.data && fut.data.data ? fut.data.data : [];
    const totalOi = futArr.reduce((s, c) => s + (c.open_interest_usd || 0), 0);
    const avgOiChg = futArr.length ? futArr.reduce((s, c) => s + (c.open_interest_change_percent_24h || 0), 0) / futArr.length : 0;
    res.json({
      ok: true, data_ts: oc ? oc.ts : null, stale: staleOf(oc && oc.ts, 7200), age_sec: ageSec(oc && oc.ts),
      based_on: series.length
        ? 'ETF 14日流来自 William 归档（其自有数据源）；稳定币/OI 变化来自 Coinglass 本地库'
        : 'ETF 直接数据源不可得，返回基于 Coinglass OI 变化与总市值边际变化的近似值',
      etf_btc_flow_14d: series,
      etf_recent3_musd: series.slice(-3).reduce((s, x) => s + (x.value || 0), 0),
      proxies: {
        total_oi_usd: totalOi || null,
        avg_oi_change_24h_pct: Math.round(avgOiChg * 100) / 100,
        btc_dominance: ocd ? ocd.btc_dominance ?? null : null,
        dominance_30d: ocd && ocd.btc_dominance_30d_series ? ocd.btc_dominance_30d_series : [],
        note_zh: 'OI 上升 + 市值扩张 ≈ 资金净流入；OI 下降 ≈ 去杠杆/资金离场（稳定币流的替代观察）'
      }
    });
  }));

  
  /* OI 摘要（纯文本，不依赖 OpenClue） */
  app.get('/api/oi-summary', wrap((req, res) => {
    const fut = store.latestFutures(db);
    const futArr = fut && fut.data && fut.data.data ? fut.data.data : [];
    const totalOi = futArr.reduce((s, c) => s + (c.open_interest_usd || 0), 0);
    const cnt = futArr.length;
    const avgOiChg = cnt ? futArr.reduce((s, c) => s + (c.open_interest_change_percent_24h || 0), 0) / cnt : 0;
    const btc = futArr.find(c => c.symbol === 'BTC');
    const ts = fut ? fut.ts : null;
    res.json({
      ok: true, data_ts: ts,
      total_oi_usd: totalOi || null,
      avg_oi_change_24h_pct: Math.round(avgOiChg * 100) / 100,
      btc_oi_usd: btc ? btc.open_interest_usd : null,
      btc_oi_change_24h: btc ? btc.open_interest_change_percent_24h : null,
      btc_dominance: totalOi && btc ? Math.round(btc.open_interest_usd / totalOi * 1000) / 10 : null,
      coin_count: cnt
    });
  }));

  /* 链上数据与洞察 */
  const { fetchMempoolTxs } = require('./whale_collector');
  const fetchOnchainData = () => {
    const lsrW = store.latestLsr(db, 'whale');
    const whaleData = lsrW && lsrW.data && lsrW.data.data ? lsrW.data.data : [];
    const fut = store.latestFutures(db);
    const futArr = fut && fut.data && fut.data.data ? fut.data.data : [];
    const bigMoves = futArr.map(c => ({
      symbol: c.symbol, price: c.current_price,
      oi_usd: c.open_interest_usd,
      oi_chg_24h: c.open_interest_change_percent_24h,
      oi_chg_usd_24h: c.open_interest_change_usd_24h,
      vol_chg_24h: c.volume_change_percent_24h,
      liq_usd_24h: c.liquidation_usd_24h
    })).sort((a, b) => Math.abs(b.oi_chg_24h||0) - Math.abs(a.oi_chg_24h||0)).slice(0, 20);
    const whales = whaleData.slice(0, 20).map(w => ({
      exchange: w.exchange || w.name || w.symbol || '?',
      symbol: w.symbol || '?',
      long_short_ratio: w.long_short_ratio || w.ratio || null,
      delta: w.delta_24h || w.delta || null
    }));
    // BTC 链上大额交易（外部 API，60s 缓存减少限流）
    const btcWhaleTxsPromise = fetchMempoolTxs(0.5).then(txs => {
      const btcPrice = futArr.find(c => c.symbol === 'BTC');
      if (btcPrice) {
        return txs.map(tx => ({ ...tx, value_usd: ((Number.isFinite(Number(tx.value_btc)) ? Number(tx.value_btc) : 0) * (btcPrice.current_price || 0)).toFixed(0) }));
      }
      return txs;
    }).catch(e => { error('[whale] fetch error:', e.message); return []; });
    return btcWhaleTxsPromise.then(btcWhaleTxs => {
      const ts = Math.max(lsrW ? lsrW.ts : 0, fut ? fut.ts : 0);
      return { ok: true, data_ts: ts, whales, big_moves: bigMoves, btc_whale_txs: btcWhaleTxs };
    });
  };
  app.get('/api/onchain', wrap(async (req, res) => {
    const data = await withCache('onchain', 60000, fetchOnchainData);
    res.json(data);
  }));

  /* BTC 链上指标（120s 缓存） */
  const { fetchBtcOnchain } = require('./btc_chain');
  app.get('/api/btc-onchain', wrap(async (req, res) => {
    const chain = await withCache('btc-onchain', 120000, fetchBtcOnchain).catch(() => null);
    if (!chain) {
      res.json({ ok: false, error: 'fetch_failed' });
      return;
    }
    res.json({ ok: true, data: chain });
  }));

  /* 清算数据（Coinglass coin-list，24h 维度，多所动态） */
  app.get('/api/liquidation', wrap((req, res) => {
    const pick = (l) => {
      if (!l || !l.data || !Array.isArray(l.data.data)) return { ts: l ? l.ts : null, rows: [] };
      const rows = l.data.data
        .map(c => ({
          symbol: c.symbol,
          liq_24h: c.liquidation_usd_24h || 0,
          long_24h: c.long_liquidation_usd_24h || 0,
          short_24h: c.short_liquidation_usd_24h || 0
        }))
        .filter(c => c.liq_24h > 0)
        .sort((a, b) => b.liq_24h - a.liq_24h)
        .slice(0, 50);
      return { ts: l.ts, rows };
    };
    const exRows = db.prepare('SELECT DISTINCT exchange FROM liquidation').all();
    const exchanges = {};
    let ts = 0;
    const bySym = {}; // 全平台聚合：symbol -> {liq,long,short,exch}
    let covered = 0;
    for (const { exchange } of exRows) {
      const e = pick(store.latestLiquidation(db, exchange));
      if (!e.rows.length) continue;
      exchanges[exchange] = e;
      covered++;
      if (e.ts > ts) ts = e.ts;
      for (const r of e.rows) {
        const a = bySym[r.symbol] || (bySym[r.symbol] = { symbol: r.symbol, liq_24h: 0, long_24h: 0, short_24h: 0, exch_count: 0 });
        if (r.liq_24h > 0) a.exch_count++;
        a.liq_24h += r.liq_24h;
        a.long_24h += r.long_24h;
        a.short_24h += r.short_24h;
      }
    }
    const allRows = Object.values(bySym)
      .filter(a => a.liq_24h > 0)
      .sort((a, b) => b.liq_24h - a.liq_24h)
      .slice(0, 50);
    exchanges.ALL = { ts, rows: allRows, covered };
    res.json({
      ok: true, data_ts: ts || null, stale: staleOf(ts, 7200), age_sec: ageSec(ts),
      exchanges
    });
  }));

  /* 情绪扩展指标：资金费率情绪 + 爆仓失衡（数据源：BTC 永续费率 + 全平台 24h 清算） */
  /* 筹码分布（Coinglass Pro：大户持仓 + 清算热力图 + 清算墙 + 足迹 + 爆仓流水，会员可见） */
  app.get('/api/position-distribution', requireVip, wrap((req, res) => {
    const readSnap = (endpoint) => {
      const r = db.prepare('SELECT params, ts, payload FROM cgpro_snapshots WHERE endpoint=? ORDER BY ts DESC LIMIT 1').get(endpoint);
      if (!r) return null;
      try {
        let payload = JSON.parse(r.payload);
        return { ts: r.ts, params: r.params, data: payload.data !== undefined ? payload.data : payload };
      } catch (e) { return null; }
    };

    // 1) 大户持仓分布（多空持仓 + 偏置 + 盈亏地址）
    const posdist = readSnap('hl_posdist_bytag');
    let groups = [];
    let whaleTimeline = [];
    if (posdist && Array.isArray(posdist.data)) {
      const byGroup = {};
      for (const row of posdist.data) byGroup[row.group_name] = row;
      groups = Object.values(byGroup).map(g => ({
        group_name: g.group_name,
        all_address_count: g.all_address_count,
        position_address_count: g.position_address_count,
        long_position_usd: g.long_position_usd,
        short_position_usd: g.short_position_usd,
        position_usd: g.position_usd,
        bias_score: g.bias_score,
        bias_remark: g.bias_remark,
        profit_address_count: g.profit_address_count,
        loss_address_count: g.loss_address_count,
        minimum_amount: g.minimum_amount,
        maximum_amount: g.maximum_amount
      }));
      // 最近 72 个点位的大户外多空持仓走势
      whaleTimeline = posdist.data.slice(-72).map(x => ({
        t: x.time, long: x.long_position_usd, short: x.short_position_usd
      }));
    }

    // 2) BTC 清算墙（跨所聚合）
    const liqmap = readSnap('liq_agg_map');
    let liqwall = null;
    if (liqmap && liqmap.data && Array.isArray(liqmap.data.data)) {
      const instruments = liqmap.data.data.map(it => ({
        ex: it.instrument.exName,
        buckets: Object.entries(it.liqMapV2 || {}).map(([price, arr]) => ({
          price: Number(price), amount: Array.isArray(arr) && arr.length ? Number(arr[0][1] || 0) : 0
        })).filter(b => b.amount > 0).sort((a, b) => a.price - b.price)
      }));
      const allBuckets = {};
      for (const ins of instruments) for (const b of ins.buckets) {
        allBuckets[b.price] = (allBuckets[b.price] || 0) + b.amount;
      }
      const buckets = Object.entries(allBuckets).map(([price, amount]) => ({ price: Number(price), amount })).sort((a, b) => a.price - b.price);
      const lastPrice = Number(liqmap.data.last_price) || (buckets.length ? buckets[Math.floor(buckets.length / 2)].price : 0);
      liqwall = { last_price: lastPrice, buckets, instruments };
    }

    // 3) 清算热力图模型1（价格×时间二维 + K线）
    const heatmap = readSnap('liq_agg_heatmap_model1');
    let heat = null;
    if (heatmap && heatmap.data && heatmap.data.y_axis && heatmap.data.liquidation_leverage_data) {
      const yAxis = heatmap.data.y_axis.map(Number);
      const grid = heatmap.data.liquidation_leverage_data.map(d => ({
        yi: Number(d[0]), xi: Number(d[1]), amount: Number(d[2])
      }));
      const candlesticks = (heatmap.data.price_candlesticks || []).map(c => ({
        t: Number(c[0]), o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]), v: Number(c[5])
      }));
      heat = { y_axis: yAxis, grid, candlesticks, update_time: heatmap.data.update_time, ts: heatmap.ts };
    }

    // 4) 订单足迹（fut_footprint，Binance BTCUSDT 1h）
    const footprint = readSnap('fut_footprint');
    let footprintData = null;
    if (footprint && footprint.data && Array.isArray(footprint.data)) {
      const last = footprint.data[footprint.data.length - 1];
      const rows = (last[1] || []).map(r => ({
        pl: Number(r[0]), ph: Number(r[1]), vol: Number(r[2]),
        buy_vol: Number(r[3]), buy_usd: Number(r[4]), sell_usd: Number(r[5]),
        buy_cnt: Number(r[8] || 0), sell_cnt: Number(r[9] || 0)
      }));
      // 时序 CVD（累计主动买卖差额）
      const cvd = footprint.data.map(tp => {
        const rs = tp[1] || [];
        let buy = 0, sell = 0;
        for (const r of rs) { buy += Number(r[4] || 0); sell += Number(r[5] || 0); }
        return { t: tp[0], buy, sell, delta: buy - sell };
      });
      footprintData = { ts: last[0], rows, cvd, interval: footprint.params };
    }

    // 5) 实时大额爆仓流水（liq_order）
    const orders = readSnap('liq_order');
    let liqOrders = [];
    if (orders && Array.isArray(orders.data)) {
      liqOrders = orders.data
        .filter(o => o.price && o.usd_value)
        .map(o => ({ ex: o.exchange_name, symbol: o.symbol, price: Number(o.price), usd: Number(o.usd_value), side: Number(o.side), time: Number(o.time) }))
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 60);
    }

    // 6) 多标的最大痛点
    const pain = readSnap('liq_max_pain');
    let maxPain = [];
    if (pain && Array.isArray(pain.data)) {
      maxPain = pain.data.map(x => ({
        symbol: x.symbol, price: x.price,
        long_price: x.long_max_pain_liq_price, long_level: x.long_max_pain_liq_level,
        short_price: x.short_max_pain_liq_price, short_level: x.short_max_pain_liq_level
      }));
    }

    const ts = Math.max(
      posdist ? posdist.ts : 0, liqmap ? liqmap.ts : 0, heat ? heat.ts : 0,
      footprint ? footprint.ts : 0, orders ? orders.ts : 0, pain ? pain.ts : 0
    );
    res.json({
      ok: true, data_ts: ts || null, stale: staleOf(ts, 7200), age_sec: ageSec(ts),
      posdist: groups, whaleTimeline, liqwall, heat, footprint: footprintData,
      liqOrders, maxPain
    });
  }));

  app.get('/api/kline', wrap(async (req, res) => {
    // 多尺度 K线：tf=1d|3d|1w|10d|1M（3d/1w/10d/1M 由 1d 合并），symbol 默认 BTC
    const symbol = String(req.query.symbol || 'BTC').toUpperCase();
    const tf = String(req.query.tf || '1d');
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 80));
    const mergeN = tf === '3d' ? 3 : tf === '1w' ? 7 : tf === '10d' ? 10 : tf === '1M' ? 30 : 1;
    try {
      const engine = require('./engine');
      const k = await engine.getKL(symbol, '1d', 400); // [{t,o,h,l,c,v}] 时间正序
      if (!k || !k.length) return res.json({ ok: false, error: 'no kline' });
      const merged = [];
      for (let i = 0; i < k.length; i += mergeN) {
        const seg = k.slice(i, i + mergeN);
        merged.push({ t: seg[0].t, o: seg[0].o, h: Math.max(...seg.map(x => x.h)), l: Math.min(...seg.map(x => x.l)), c: seg[seg.length - 1].c, v: seg.reduce((a, x) => a + x.v, 0) });
      }
      return res.json({ ok: true, symbol, tf, rows: merged.slice(-limit) });
    } catch (e) { return res.json({ ok: false, error: String(e.message || e) }); }
  }));

  app.get('/api/sentiment-extra', wrap((req, res) => {
    const fut = store.latestFutures(db);
    const futArr = (fut && fut.data && fut.data.data) || [];
    const btc = futArr.find(c => c.symbol === 'BTC') || null;
    const funding = btc && typeof btc.avg_funding_rate_by_oi === 'number' ? btc.avg_funding_rate_by_oi / 100 : null; // % → 小数
    const fSent = funding == null ? null : (() => {
      const f = funding * 100;
      if (f >= 0.05) return { emoji: '😍', label: '极度贪婪', tip: '多头拥挤付费、杠杆过热，费率接近熔断区，警惕回调踩踏' };
      if (f >= 0.01) return { emoji: '🙂', label: '偏多', tip: '多头略占优，市场情绪温和偏热' };
      if (f > -0.01) return { emoji: '😐', label: '中性', tip: '多空付费均衡，情绪平淡' };
      if (f > -0.05) return { emoji: '😟', label: '偏空', tip: '空头付费增加，情绪转弱' };
      return { emoji: '😱', label: '极度恐慌', tip: '空头踩踏式付费，超卖区域，常对应反弹窗口' };
    })();
    const exRows = db.prepare('SELECT DISTINCT exchange FROM liquidation').all();
    let long24 = 0, short24 = 0, liqTs = 0, covered = 0;
    for (const { exchange } of exRows) {
      const l = store.latestLiquidation(db, exchange);
      if (!l || !l.data || !Array.isArray(l.data.data)) continue;
      if (l.ts > liqTs) liqTs = l.ts;
      covered++;
      for (const c of l.data.data) {
        long24 += c.long_liquidation_usd_24h || 0;
        short24 += c.short_liquidation_usd_24h || 0;
      }
    }
    const total24 = long24 + short24;
    const imb = total24 > 0 ? (short24 - long24) / total24 : null;
    const lSent = imb == null ? null : (() => {
      if (imb > 0.30) return { emoji: '🚀', label: '逼空', tip: '空头被大幅清算踩踏助推上行，追多需防短期过热' };
      if (imb > 0.05) return { emoji: '🙂', label: '偏多', tip: '空头清算略多，情绪偏多' };
      if (imb > -0.05) return { emoji: '😐', label: '均衡', tip: '多空清算均衡，无显著踩踏' };
      if (imb > -0.30) return { emoji: '😟', label: '偏空', tip: '多头清算略多，情绪承压' };
      return { emoji: '💥', label: '多头踩踏', tip: '多头被大规模清算、恐慌抛售，留意超跌反弹' };
    })();
    const ts = Math.max(fut ? fut.ts : 0, liqTs);
    res.json({
      ok: true, data_ts: ts || null, stale: staleOf(ts, 7200), age_sec: ageSec(ts), covered_exchanges: covered,
      funding: funding == null ? null : { value: funding, pct: +(funding * 100).toFixed(4), sent: fSent },
      liquidation: { total_24h: total24, long_24h: long24, short_24h: short24, imbalance: imb == null ? null : +imb.toFixed(3), sent: lSent }
    });
  }));

  /* BTC 预言机（代理到独立引擎 127.0.0.1:3400，30s 缓存；引擎挂不影响其他功能） */
  app.get('/api/oracle', wrap(async (req, res) => {
    const data = await withCache('oracle', 30000, async () => {
      const r = await fetch('http://127.0.0.1:3400/predict', { signal: AbortSignal.timeout(8000) });
      return r.json();
    }).catch(() => null);
    if (!data || data.ok === false) return res.json({ ok: false, error: 'oracle_unavailable' });
    res.json(data);
  }));

  /* BTC 预言机精度统计（多窗口 acc + 每日趋势 + 因子排行，30s 缓存） */
  app.get('/api/oracle/stats', wrap(async (req, res) => {
    const data = await withCache('oracle-stats', 30000, async () => {
      const r = await fetch('http://127.0.0.1:3400/stats', { signal: AbortSignal.timeout(8000) });
      return r.json();
    }).catch(() => null);
    if (!data || data.ok === false) return res.json({ ok: false, error: 'oracle_unavailable' });
    res.json(data);
  }));

  /* 市场状态分析（120s 缓存） */
  const { fetchMarketAnalysis } = require('./market_analyzer');
  app.get('/api/market-analysis', wrap(async (req, res) => {
    try {
      const data = await withCache('market-analysis', 120000, () => fetchMarketAnalysis(db));
      res.json({ ok: true, data: data });
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
  }));
/* ---------------- 登录专享 ---------------- */
  app.get('/api/member/lsr', requireVip, wrap((req, res) => {
    const t = store.latestLsr(db, 'trader');
    const w = store.latestLsr(db, 'whale');
    const pick = (p) => p && p.data && Array.isArray(p.data.data) ? p.data.data.slice(0, 20) : [];
    const ts = Math.max(t ? t.ts : 0, w ? w.ts : 0);
    res.json({
      ok: true, data_ts: ts || null, stale: staleOf(ts, 600), age_sec: ageSec(ts),
      trader: pick(t), whale: pick(w),
      updated_at: { trader: t && t.data ? t.data.updated_at : null, whale: w && w.data ? w.data.updated_at : null }
    });
  }));

  app.get('/api/member/funding-arb', requireVip, wrap((req, res) => {
    const arb = store.latestFundingArb(db);
    const rows = arb && arb.data && arb.data.data ? arb.data.data : [];
    res.json({
      ok: true, data_ts: arb ? arb.ts : null, stale: staleOf(arb && arb.ts, 600), age_sec: ageSec(arb && arb.ts),
      rows: rows.slice(0, 50), updated_at: arb && arb.data ? arb.data.updated_at : null
    });
  }));

  app.get('/api/member/consensus', wrap((req, res) => {
    const cons = store.latestConsensus(db);
    const arr = Array.isArray(cons && cons.data) ? cons.data : [];
    res.json({
      ok: true, data_ts: cons ? cons.ts : null, stale: staleOf(cons && cons.ts, 1200), age_sec: ageSec(cons && cons.ts),
      coins: arr.map(c => ({
        symbol: c.display_symbol || c.symbol, decision: c.decision, decision_label: c.decision_label,
        color: c.color, confidence: c.confidence, trust_adjusted_bias: c.trust_adjusted_bias,
        price: c.price, snapshot_date: c.snapshot_date, snapshot_age_hours: c.snapshot_age_hours,
        firing_factors_count: c.firing_factors_count,
        equal_weight: c.equal_weight || null,
        firing_factors: (c.firing_factors || []).slice(0, 20),
        top_factors: (c.top_factors || []).slice(0, 20),
        top_aligned_traders: (c.top_aligned_traders || []).slice(0, 10),
        warning: c.warning || null
      }))
    });
  }));

  app.get('/api/member/countdown', requireVip, wrap((req, res) => {
    const snap = buildEngineSnapshot(ctx);
    res.json({
      ok: true, data_ts: Math.max(snap.ts.futures || 0, snap.ts.fear_greed || 0) || null,
      stale: staleOf(snap.ts.futures, 600),
      posture: { state: snap.posture.state, score: snap.posture.score, days_held: snap.posture.days_held, flip_trigger_zh: snap.posture.flip_trigger_zh },
      countdown: snap.countdown
    });
  }));

  /* ---------------- 交易信号系统（给单引擎 v4.0） ---------------- */
  app.get('/api/signal/overview', requireVip, wrap((req, res) => {
    const signal = require('./signal');
    const settings = signal.loadSettings(db);
    // 引擎状态
    const lastHealth = db.prepare("SELECT detail, ts FROM source_health WHERE source='qq_push' ORDER BY ts DESC LIMIT 1").get();
    // 战绩统计
    // 2026-08-11: 战绩统计聚焦方向引擎（DIR/UNIFIED），旧 ST/FR 引擎已退役
    const stats = db.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) wins,
        SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) losses,
        SUM(CASE WHEN status='FLAT' THEN 1 ELSE 0 END) flats,
        SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) opens,
        ROUND(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END),2) avg_pnl
      FROM signal_track WHERE strategy IN ('DIR','UNIFIED')`).get();
    const byStrategy = db.prepare(`
      SELECT strategy, COUNT(*) cnt,
        SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) wins,
        SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) losses
      FROM signal_track WHERE strategy IN ('DIR','UNIFIED') GROUP BY strategy`).all();
    // 今日推送数
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const todayCount = Number(db.prepare("SELECT value FROM kv WHERE key=?").get(`signal:daily:${today}`)?.value || 0);
    const fgi = db.prepare('SELECT value, classification FROM fear_greed ORDER BY ts DESC LIMIT 1').get();
    // 主流品种单（BTC/ETH）独立战绩
    const majorStats = db.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) wins,
        SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) losses,
        SUM(CASE WHEN status='FLAT' THEN 1 ELSE 0 END) flats,
        SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) opens,
        ROUND(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END),2) avg_pnl
      FROM signal_track WHERE symbol IN ('BTC','ETH')`).get() || {};
    // 回测战绩（dir_prod 中低频引擎：训练段+样本外验证，防过拟合双段口径）
    const btStats = (() => {
      try {
        const bt = require('./dir_bt_stats');
        return bt.stats();
      } catch (e) { return null; }
    })();
    res.json({
      ok: true,
      settings,
      enabled: !!settings.enabled,
      stats,
      major_stats: majorStats,
      byStrategy,
      bt_stats: btStats,
      today_count: todayCount,
      fgi: fgi ? { value: fgi.value, classification: fgi.classification } : null,
      last_push: lastHealth ? { detail: lastHealth.detail, ts: lastHealth.ts } : null,
      ts: Math.floor(Date.now() / 1000)
    });
  }));

  app.get('/api/signal/settings', requireAdmin, wrap((req, res) => {
    const signal = require('./signal');
    res.json({ ok: true, settings: signal.loadSettings(db) });
  }));

  app.post('/api/signal/settings', requireAdmin, wrap((req, res) => {
    const signal = require('./signal');
    const patch = req.body || {};
    const saved = signal.saveSettings(db, patch);
    res.json({ ok: true, settings: saved });
  }));

  app.get('/api/signal/history', requireVip, wrap((req, res) => {


    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const major = req.query.major === '1';
    const symFilter = major ? " AND symbol IN ('BTC','ETH')" : '';
    const rows = db.prepare(`
      SELECT id, symbol, direction, entry, stop, target1, target2, rr, pos_pct, status,
             pnl_pct, reason, strategy, pushed_at, resolved_at
      FROM signal_track WHERE 1=1${symFilter} ORDER BY id DESC LIMIT ?`).all(limit);
    // 实时浮盈：按指标战绩真实本金 10000U 计算（10000u × 仓位% × 涨跌幅，与回测口径一致）
    const signal = require('./signal');
    let curMap = null;
    try {
      const snaps = signal.futuresSnapshots(db, 1);
      if (snaps.length) curMap = snaps[snaps.length - 1].m;
    } catch (e) { debug('[routes] snapshot err:', e.message); }
    const BASE = 10000;               // 指标战绩真实本金
    for (const r of rows) {
      const posPct = Number(r.pos_pct) || 0;
      const lev = Number(r.leverage) || 100;   // 每行实际杠杆（默认 100 兼容旧数据）
      r.pos_usd_1000 = +(BASE * posPct / 100).toFixed(2);       // 保证金（pos%×本金）
      // 盈亏 = 方向 × pos% × 涨跌幅% × 杠杆（名义=pos%×本金×lev），亏损爆仓截断到保证金
      if (r.pnl_pct != null) {
        let fu = (r.direction === 'long' ? 1 : -1) * posPct * Number(r.pnl_pct) * lev;
        if (fu < 0) fu = Math.max(fu, -(posPct * lev));          // 截断: 3%→-300 / 8%→-800 / 12%→-1200
        r.final_pnl_usd = +fu.toFixed(2);
      } else r.final_pnl_usd = null;
      if (r.status === 'OPEN' && curMap && curMap.has(r.symbol)) {
        const px = Number(curMap.get(r.symbol).current_price);
        const entry = Number(r.entry);
        if (isFinite(px) && px > 0 && isFinite(entry) && entry > 0) {
          const pnl = r.direction === 'long' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
          let fu = (r.direction === 'long' ? 1 : -1) * posPct * pnl * lev;
          if (fu < 0) fu = Math.max(fu, -(posPct * lev));
          r.live = { price: px, pnl_pct: +pnl.toFixed(2), pnl_usd: +fu.toFixed(2) };
        }
      }
    }
    res.json({ ok: true, rows });
  }));
  // 会员仓位后台：统一引擎 OPEN 单 + 10000u 实际开仓标注 + 实时浮盈 + 引擎判断
  app.get('/api/signal/positions', requireVip, wrap((req, res) => {
    const rows = db.prepare("SELECT * FROM signal_track WHERE status='OPEN' ORDER BY id DESC LIMIT 20").all();
    const signal = require('./signal');
    let curMap = null;
    try { const snaps = signal.futuresSnapshots(db, 1); if (snaps.length) curMap = snaps[snaps.length-1].m; } catch (e) { debug('[routes] curMap err:', e.message); }
    const BASE = 10000;               // 指标战绩真实本金（会员跟单基准）
    const LEVER_DEFAULT = 100;         // 旧单默认杠杆
    for (const r of rows) {
      const posPct = Number(r.pos_pct) || 0;
      // 实际开仓（10000u 当 N 倍用）：优先读建单时存的真实字段，旧单按 pos% 推算
      const lev = Number(r.leverage) || LEVER_DEFAULT;
      const marginUsd = Number(r.margin_usd) || +(BASE * posPct / 100).toFixed(2);
      const notionalUsd = Number(r.notional_usd) || +(marginUsd * lev).toFixed(2);
      const liqPx = Number(r.liq_price) || null;
      r.margin_usd = +marginUsd.toFixed(2);          // 实际保证金（u）
      r.notional_usd = +notionalUsd.toFixed(2);      // 名义仓位（u）
      r.leverage = lev;                               // 实际杠杆
      r.liq_price = liqPx;                            // 爆仓价
      r.notional_multiple = +(notionalUsd / BASE).toFixed(1); // 10000u 当几倍用
      // 实时浮盈（按 10000u 本金 × 仓位% × 涨跌幅 × 杠杆口径，与回测一致）
      if (r.pnl_pct != null) {
        let fu = (r.direction === 'long' ? 1 : -1) * posPct * Number(r.pnl_pct) * lev;
        if (fu < 0) fu = Math.max(fu, -(marginUsd));   // 亏损截断到保证金
        r.final_pnl_usd = +fu.toFixed(2);
      } else r.final_pnl_usd = null;
      if (curMap && curMap.has(r.symbol)) {
        const px = Number(curMap.get(r.symbol).current_price);
        const entry = Number(r.entry);
        if (isFinite(px) && px>0 && isFinite(entry) && entry>0) {
          const pnl = r.direction==='long' ? (px-entry)/entry*100 : (entry-px)/entry*100;
          let fu = (r.direction === 'long' ? 1 : -1) * posPct * pnl * lev;
          if (fu < 0) fu = Math.max(fu, -(marginUsd));
          r.live = { price: px, pnl_pct: +pnl.toFixed(2), pnl_usd: +fu.toFixed(2) };
        }
      }
    }
    // 统一引擎当前判断 + 新方向引擎（公开状态）
    let unified = null, dirEng = null;
    try {
      const eng = require('./experience_engine');
      const st = eng.liveStatus(db, 'BTC');
      unified = { judge: st.judge, order: st.order, ts: st.ts };
    } catch (e) { debug('[routes] unified err:', e.message); }
    try {
      const de = require('./dir_prod');
      const an = de.analyze('BTC', Date.now());
      dirEng = { regime: an.regime, score: an.score, tradeable: an.tradeable, plan: an.plan, levels: an.levels, price: an.price };
    } catch (e) { debug('[routes] dir_prod err:', e.message); }
    res.json({ ok: true, rows, unified, dir_engine: dirEng });
  }));

  /* ---------------- 开单逻辑可视化（/api/live/reasoning） ---------------- */
  app.get('/api/live/reasoning', requireVip, wrap((req, res) => {
    const rows = db.prepare("SELECT id, symbol, direction, entry, stop, target1, target2, pos_pct, status, pnl_pct, reason, pushed_at, resolved_at, reasoning_json, self_review FROM signal_track WHERE strategy IN ('TIANJI','LIVE','UNIFIED','DIR','ALPHA1') ORDER BY pushed_at DESC LIMIT 30").all();
    const list = rows.map(r => {
      let rz = null; try { rz = JSON.parse(r.reasoning_json || 'null'); } catch (e) {}
      return {
        id: r.id, symbol: r.symbol, direction: r.direction,
        entry: r.entry, stop: r.stop, target1: r.target1, target2: r.target2,
        pos_pct: r.pos_pct, status: r.status,
        pnl_pct: r.pnl_pct != null ? Number(r.pnl_pct) : null,
        reason: r.reason || null,
        pushed_at: r.pushed_at || null, resolved_at: r.resolved_at || null,
        reasoning: rz, self_review: r.self_review || null
      };
    });
    res.json({ ok: true, count: list.length, list });
  }));

  /* ---------------- 实盘战绩面板（/api/live/stats） ----------------
   * 前端 PANELS.live 数据源：kpi 13项指标 + trades 明细 + equityCurve 净值曲线
   * 数据口径：signal_track 实盘单（TIANJI/LIVE/UNIFIED/DIR/ALPHA1 全策略）
   * 净值：1000u 复利 + 持仓浮盈（equity.js calcEquity）
   */
  app.get('/api/live/stats', requireVip, wrap(async (req, res) => {
    const equity = require('./equity');
    const signal = require('./signal');
    // 全量实盘单
    const rows = db.prepare("SELECT * FROM signal_track WHERE strategy IN ('TIANJI','LIVE','UNIFIED','DIR','ALPHA1') ORDER BY id DESC LIMIT 500").all();
    // 当前价映射（用于 OPEN 单浮盈）
    let curMap = null;
    try { const snaps = signal.futuresSnapshots(db, 1); if (snaps.length) curMap = snaps[snaps.length - 1].m; } catch (e) { debug('[live/stats] curMap err:', e.message); }
    const pxOf = (sym) => { if (curMap && curMap.has(sym)) return Number(curMap.get(sym).current_price); return null; };

    // 当前净值（提前供仓位权益计算）
    const cur = (() => { try { const c = equity.calcEquity(db); return c; } catch (e) { return { equity: 1000, pnl: 0, openCount: 0 }; } })();

    // 复利贡献映射：按时间序累计净值，每单贡献 = 当时净值 × 价格% × 杠杆 × 仓位%
    // （与净值 1000u 复利口径一致：Σ贡献 = 总盈亏；OPEN 单用最新净值×浮盈）
    const contribMap = new Map();
    let eqWalk = 1000;
    {
      const srt = rows.filter(r => r.status === 'WIN' || r.status === 'LOSS')
        .sort((a, b) => (Number(a.pushed_at) || 0) - (Number(b.pushed_at) || 0));
      for (const r of srt) {
        const pp = Number(r.pnl_pct || 0);
        const cf = eqWalk * pp / 100 * (Number(r.leverage || 50)) * (Number(r.pos_pct || 0)) / 100;
        contribMap.set(r.id, cf);
        eqWalk *= (1 + pp / 100 * (Number(r.leverage || 50)) * (Number(r.pos_pct || 0)) / 100);
      }
    }

    // 单子序号：按开单时间升序（初始单=1）
    const seqById = {};
    rows.slice().sort((a, b) => (a.pushed_at || a.id) - (b.pushed_at || b.id)).forEach((r, i) => { seqById[r.id] = i + 1; });

    // 组装 trades（对齐前端字段：id/symbol/direction/entry/stop/target1/target2/rr/strategy/status/pnl_pct/live_pnl/risk_pct/leverage/t1_hit/opened）
    const trades = rows.map(r => {
      const lev = Number(r.leverage || 50);
      const posPct = Number(r.pos_pct || 0);
      // 仓位实际权益：优先 margin_usd，其次 名义价值/杠杆，最后 当前净值×占比
      let posEquity = null;
      if (r.margin_usd != null) posEquity = Number(r.margin_usd);
      else if (r.notional_usd != null && lev) posEquity = Number(r.notional_usd) / lev;
      else if (posPct > 0) posEquity = (cur.equity || 1000) * posPct / 100;
      const t = {
        id: r.id, seq: seqById[r.id] || r.id, symbol: r.symbol, direction: r.direction,
        entry: r.entry, stop: r.stop, target1: r.target1, target2: r.target2, rr: r.rr,
        strategy: r.strategy || '—', status: r.status,
        pnl_pct: r.pnl_pct != null ? Number(r.pnl_pct) : null,
        risk_pct: r.risk_usd != null && cur && cur.equity ? +(Number(r.risk_usd) / cur.equity * 100).toFixed(2) : +(posPct).toFixed(2),
        risk_usd: r.risk_usd != null ? Number(r.risk_usd) : null,
        leverage: lev, t1_hit: !!r.t1_hit,
        notional_usd: r.notional_usd != null ? Number(r.notional_usd) : null,
        orig_stop: r.orig_stop != null ? Number(r.orig_stop) : null,
        stop_moved: !!(r.t1_hit || (r.orig_stop != null && Math.abs(Number(r.orig_stop) - Number(r.stop || 0)) > 0.0001)),
        pnl_usd: contribMap.has(r.id) ? +contribMap.get(r.id).toFixed(2) : null,
        pos_equity: posEquity != null ? +posEquity.toFixed(2) : null,
        pos_pct: posPct,
        opened: r.pushed_at || r.resolved_at || null,
        resolved: r.resolved_at != null ? Number(r.resolved_at) : null
      };
      // OPEN 单实时浮盈（裸价格%，前端乘杠杆）
      if (r.status === 'OPEN') {
        const px = pxOf(r.symbol), entry = Number(r.entry);
        if (px && entry) {
          const floatPct = r.direction === 'long' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
          t.live_pnl = +floatPct.toFixed(4);
          t.pnl_usd = +(eqWalk * floatPct / 100 * (Number(r.leverage || 50)) * (Number(r.pos_pct || 0)) / 100).toFixed(2);
        }
      }
      return t;
    });

    // 净值曲线（equity.js 已有 15min 快照）
    let equityCurve = [];
    try { equityCurve = equity.curve(db, 500); } catch (e) { debug('[live/stats] curve err:', e.message); }

    // KPI 统计（基于已结算单 WIN/LOSS，加 OPEN 浮盈）
    const settled = rows.filter(r => r.status === 'WIN' || r.status === 'LOSS');
    const wins = settled.filter(r => r.status === 'WIN');
    const losses = settled.filter(r => r.status === 'LOSS');
    const openRows = rows.filter(r => r.status === 'OPEN');
    const total = settled.length;
    const winRate = total > 0 ? (wins.length / total * 100) : null;

    // 每笔已实现收益（pnl_pct = 价格涨跌幅%，展示为 R 口径；止损距离≈1% 时 1% 价格≈1R）
    const rVals = settled.map(r => (Number(r.pnl_pct || 0)));
    const grossWin = rVals.filter(v => v > 0).reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(rVals.filter(v => v < 0).reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : null);
    const avgR = rVals.length ? (rVals.reduce((a, b) => a + b, 0) / rVals.length) : null;
    const best = rVals.length ? Math.max(...rVals) : null;
    const worst = rVals.length ? Math.min(...rVals) : null;
    const expVal = avgR; // 期望值 = 平均 R
    // 风险回报比（平均盈利单 R / 平均亏损单 R）
    const winVals = rVals.filter(v => v > 0), lossVals = rVals.filter(v => v < 0);
    const avgWin = winVals.length ? winVals.reduce((a, b) => a + b, 0) / winVals.length : null;
    const avgLoss = lossVals.length ? Math.abs(lossVals.reduce((a, b) => a + b, 0) / lossVals.length) : null;
    const payoffRatio = (avgWin != null && avgLoss) ? avgWin / avgLoss : null;
    // 总盈亏比（按金额口径：名义×pnl%）
    const gWinUsd = settled.filter(r => Number(r.pnl_pct || 0) > 0).reduce((s, r) => s + Number(r.pnl_pct || 0) / 100 * Number(r.notional_usd || 0), 0);
    const gLossUsd = Math.abs(settled.filter(r => Number(r.pnl_pct || 0) < 0).reduce((s, r) => s + Number(r.pnl_pct || 0) / 100 * Number(r.notional_usd || 0), 0));
    const grossRatioUsd = gLossUsd > 0 ? gWinUsd / gLossUsd : null;
    // 平均持仓时间（小时）
    const holds = settled.map(r => (Number(r.resolved_at || 0) - Number(r.pushed_at || 0)) / 3600000).filter(h => isFinite(h) && h >= 0 && h < 720); // <30天，过滤缺失时间戳污染
    const avgHoldHours = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null;

    // 简化波动/回撤/夏普（基于净值曲线 pnl 序列）
    let sharpe = null, sortino = null, calmar = null, maxDrawdownPct = null, maxDDDurDays = null, annVol = null, annRet = null, cvar95 = null;
    const pnlSeries = equityCurve.map(p => p.pnl).filter(v => v != null);
    if (pnlSeries.length >= 3) {
      const rets = [];
      for (let i = 1; i < pnlSeries.length; i++) rets.push(pnlSeries[i] - pnlSeries[i - 1]);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
      annVol = sd ? +(sd * Math.sqrt(96 * 365) / 1000 * 100).toFixed(2) : null; // 15min→年化（√(96×365)）
      annRet = mean ? +(mean * 96 * 365 / 1000 * 100).toFixed(2) : null;
      sharpe = sd ? +(mean / sd * Math.sqrt(96 * 365)).toFixed(2) : null;
      // 下行偏差
      const downs = rets.filter(r => r < 0);
      const downSd = downs.length ? Math.sqrt(downs.reduce((a, b) => a + b * b, 0) / rets.length) : 0;
      sortino = downSd ? +(mean / downSd * Math.sqrt(96 * 365)).toFixed(2) : null;
      // CVaR 95%：最差5%收益均值
      const sorted = [...rets].sort((a, b) => a - b);
      const tail = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05)));
      cvar95 = tail.length ? +(tail.reduce((a, b) => a + b, 0) / tail.length).toFixed(4) : null;
      // 最大回撤
      let peak = -Infinity, mdd = 0, ddStart = 0, ddEnd = 0;
      let curDDStart = 0;
      for (let i = 0; i < pnlSeries.length; i++) {
        if (pnlSeries[i] > peak) { peak = pnlSeries[i]; curDDStart = i; }
        const dd = peak - pnlSeries[i];
        if (dd > mdd) { mdd = dd; ddStart = curDDStart; ddEnd = i; }
      }
      maxDrawdownPct = +(mdd / 1000 * 100).toFixed(2);
      maxDDDurDays = mdd > 0 ? +((ddEnd - ddStart) / 96).toFixed(1) : null; // 回撤起点→谷底天数
      calmar = (annRet && maxDrawdownPct) ? +(annRet / maxDrawdownPct).toFixed(2) : null;
    }

    // 策略分布
    const strategyBreakdown = {};
    for (const r of rows) {
      const name = r.strategy || 'OTHER';
      if (!strategyBreakdown[name]) strategyBreakdown[name] = { total: 0, wins: 0, losses: 0, pnlLev: 0 };
      strategyBreakdown[name].total++;
      if (r.status === 'WIN') strategyBreakdown[name].wins++;
      if (r.status === 'LOSS') strategyBreakdown[name].losses++;
      if (r.status !== 'OPEN' && r.pnl_pct != null) strategyBreakdown[name].pnlLev += Number(r.pnl_pct);
    }

    // 净值头卡（策略模拟净值 + 实盘真实权益双轨）
    const totalPnlUsd = cur.pnl;
    const initEquity = 1000;
    const curEquity = cur.equity;

    const totalPnlPct = +(totalPnlUsd / initEquity * 100).toFixed(2);
    const partialCount = rows.filter(r => r.t1_hit).length;

    const kpi = {
      curEquity, totalPnlUsd: +totalPnlUsd.toFixed(2), totalPnlPct, initEquity,
      open: cur.openCount, total: settled.length, partialCount,
      winRate: winRate != null ? +winRate.toFixed(1) : null,
      profitFactor: profitFactor != null ? +profitFactor.toFixed(2) : null,
      avgR: avgR != null ? +avgR.toFixed(2) : null,
      annRet, annVol, sharpe, sortino, calmar,
      maxDrawdownPct, maxDDDurDays, expVal: expVal != null ? +expVal.toFixed(2) : null,
      payoffRatio: payoffRatio != null ? +payoffRatio.toFixed(2) : null,
      grossRatio: grossRatioUsd != null ? +grossRatioUsd.toFixed(2) : null,

      avgHoldHours: avgHoldHours != null ? +avgHoldHours.toFixed(1) : null,
      cvar95, best: best != null ? +best.toFixed(2) : null, worst: worst != null ? +worst.toFixed(2) : null,
      strategyBreakdown
    };

    // v3: 追加最新实时净值点（消除 15min 快照 vs 实时浮盈的曲线错位）
    // 仅在最后一个持久化快照点与当前时间差 >60s 时追加，且值有差异，避免重复堆积
    if (equityCurve.length) {
      const lastPt = equityCurve[equityCurve.length - 1];
      const nowSec = Math.floor(Date.now() / 1000);
      const gapSec = nowSec - (lastPt.ts || 0);
      if (gapSec > 60 && Math.abs(lastPt.y - cur.equity) >= 0.01) {
        equityCurve.push({ ts: nowSec, label: equity.fmtTs(nowSec), y: +cur.equity.toFixed(2), pnl: +cur.pnl.toFixed(2), open: cur.openCount, live: true });
      }
    }

    res.json({ ok: true, kpi, trades, equityCurve, ts: Math.floor(Date.now() / 1000) });
  }));



  app.get('/api/signal/ai', requireVip, wrap(async (req, res) => {
    const adv = require('./ai_advisor');
    const force = req.query.force === '1';
    const r = await adv.getAdvisory(ctx, force);
    res.json(r);
  }));



  app.post('/api/signal/backtest', requireAdmin, wrap(async (req, res) => {
    const bt = require('./backtest');
    if (!ctx.env.db) ctx.env.db = ctx.db; // backtest 引擎需要从 env 访问 db（kv 缓存）
    const opts = Object.assign({ mode: 'okx', days: 30, bar: '1H', symbols: [] }, req.body || {});
    opts.days = Math.min(Math.max(Number(opts.days) || 30, 1), 30);
    if (Array.isArray(opts.symbols)) opts.symbols = opts.symbols.slice(0, 10);
    const r = await bt.runBacktest(ctx, opts);
    res.json(r);
  }));

  app.get('/api/signal/scan', requireAdmin, wrap((req, res) => {
    const signal = require('./signal');
    const dbRead = db;
    const snaps = signal.futuresSnapshots(dbRead, 30);
    const cur = snaps[snaps.length - 1];
    if (!cur) return res.json({ ok: false, error: 'no_futures_data' });
    const settings = signal.loadSettings(dbRead);
    const traderMap = (() => { const m = new Map(); const r = dbRead.prepare("SELECT payload FROM lsr_rankings WHERE mode='trader' ORDER BY ts DESC LIMIT 1").get(); if (r) { try { for (const c of JSON.parse(r.payload).data || []) m.set(c.symbol, c); } catch (e) { debug('[routes] traderMap err:', e.message); } } return m; })();
    const whaleMap = (() => { const m = new Map(); const r = dbRead.prepare("SELECT payload FROM lsr_rankings WHERE mode='whale' ORDER BY ts DESC LIMIT 1").get(); if (r) { try { for (const c of JSON.parse(r.payload).data || []) m.set(c.symbol, c); } catch (e) { debug('[routes] whaleMap err:', e.message); } } return m; })();
    const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
    const coins = [];
    for (const coin of cur.m.values()) {
      try {
        const r = signal.scanCoin({ db: dbRead }, coin, coin.symbol, snaps, prev ? prev.m : null, settings, traderMap, whaleMap);
        coins.push({
          symbol: coin.symbol, price: Number(coin.current_price),
          trend: r.trend, pct: r.pct !== null ? Number(r.pct.toFixed(2)) : null,
          strategy: r.hit ? r.hit.strategy : null,
          direction: r.hit ? r.hit.direction : null,
          factors: r.hit ? r.hit.factors : (r.near ? ['未共振'] : null),
          rr: r.hit ? r.hit.plan.rr : null,
          score: r.hit ? (r.hit.cloud ? r.hit.cloud.score.toFixed(2) : r.hit.score) : null,
          near: r.near || null, skipNote: r.skipNote || null
        });
      } catch (e) { coins.push({ symbol: coin.symbol, error: e.message }); }
    }
    res.json({ ok: true, ts: cur.ts, coins, settings });
  }));

  app.post('/api/signal/trigger', requireAdmin, wrap(async (req, res) => {
    const signal = require('./signal');
    const { symbol, direction, strategy } = req.body || {};
    // 新引擎已接管推送；scan 仅作实时视图（dry-run 不推送、不记冷却）
    const result = await signal.checkAll({ ...ctx, pushFn: async () => false }, { force: true });
    res.json({ ok: true, ...result });
  }));

  /* ---------------- 后台健康 + 手动触发 ---------------- */
  /* ---------- 消息面 API ---------- */
  app.get("/api/news", wrap((req, res) => {
    const cached = getCached();
    res.json({
      ok: true,
      ts: cached.ts,
      items: cached.items,
      count: cached.items.length
    });
  }));
  app.post("/api/news/refresh", auth.requireAdmin, wrap(async (req, res) => {
    const items = await collectNews();
    res.json({ ok: true, items: items.length });
  }));
  app.get('/api/admin/health', requireAdmin, wrap((req, res) => {
    const health = db.prepare(`
      SELECT h.* FROM source_health h
      JOIN (SELECT source, MAX(ts) mts FROM source_health GROUP BY source) q
        ON h.source=q.source AND h.ts=q.mts
      ORDER BY h.ts DESC LIMIT 40`).all();
    const recent = db.prepare('SELECT * FROM source_health ORDER BY id DESC LIMIT 30').all();
    const dbFile = path.join(__dirname, '..', 'data', env.SMOKE === '1' ? 'w1-smoke.db' : 'w1.db');
    let dbBytes = 0;
    try { dbBytes = fs.statSync(dbFile).size; } catch (e) { debug('[routes] dbBytes err:', e.message); }
    const counts = {};
    for (const t of ['prices', 'futures_markets', 'lsr_rankings', 'funding_arb', 'consensus', 'fear_greed', 'openclue_archive', 'verdict_daily', 'users', 'source_health']) {
      counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    }
    res.json({
      ok: true,
      uptime_sec: Math.round((Date.now() - STARTED) / 1000),
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      db_bytes: dbBytes,
      table_counts: counts,
      cg_key: { masked: ctx.cg.maskedKey(), cooldown_until: kvGet(db, 'cg_key_invalid_until', 0) || 0, cooling: ctx.cg.isKeyCoolingDown() },
      ai_keys: { a: !!env.DEEPSEEK_KEY_A, b: !!env.DEEPSEEK_KEY_B, model: env.DEEPSEEK_MODEL },
      qq: { appid: env.QQ_APPID, group_openid_set: !!(env.QQ_GROUP_OPENID || '').trim() },
      latest_by_source: health.map(h => ({ source: h.source, ok: !!h.ok, ms: h.ms, ts: h.ts, detail: h.detail })),
      recent
    });
  }));

  app.post('/api/admin/trigger/:job', requireAdmin, wrap(async (req, res) => {
    const job = JOBS[req.params.job];
    if (!job) return res.status(404).json({ ok: false, error: 'unknown_job', jobs: Object.keys(JOBS) });
    const t0 = Date.now();
    const ok = await job(ctx);
    res.json({ ok: true, job: req.params.job, success: ok, ms: Date.now() - t0 });
  }));

  // 系统监控（服务器 CPU / 内存 / 磁盘 / 进程）
  app.get('/api/signal/regime', requireAdmin, wrap((req, res) => {
    // 当前市场体制（总开关状态）
    const rv = kvGet(db, 'signal:regime', null) || {}; const r = typeof rv === 'string' ? (() => { try { return JSON.parse(rv); } catch (e) { return {}; } })() : rv;
    res.json({ ok: true, regime: r });
  }));

  app.get('/api/signal/strategies', requireAdmin, wrap((req, res) => {
    // 策略档案：状态(paper/live/paused) + 战绩摘要 + 出场方式分布
    const engine = require('./engine');
    const strats = engine.loadStrategies(db);
    const list = strats.map(s => {
      const rows = db.prepare("SELECT status, pnl_pct, exit_reason FROM signal_track WHERE strategy=? ORDER BY id DESC LIMIT 30").all(s.meta.id);
      const settled = rows.filter(r => r.status === 'WIN' || r.status === 'LOSS');
      const wins = settled.filter(r => r.status === 'WIN').length;
      const sumPnl = settled.reduce((a, r) => a + Number(r.pnl_pct || 0), 0);
      const reasons = {};
      for (const r of rows) if (r.exit_reason) reasons[r.exit_reason] = (reasons[r.exit_reason] || 0) + 1;
      return {
        id: s.meta.id, name: s.meta.name, regime: s.meta.regime, tf: s.meta.signal_tf,
        status: s.state.status, paper_since: s.state.paper_since,
        trades: settled.length, win_rate: settled.length ? Math.round(wins / settled.length * 100) : 0,
        pnl_sum: +sumPnl.toFixed(2), exits: reasons
      };
    });
    res.json({ ok: true, strategies: list });
  }));

  app.get('/api/signal/exits-stats', requireAdmin, wrap((req, res) => {
    // 出场方式分布（time_stop 占比应 < 30%）
    const rows = db.prepare("SELECT exit_reason, COUNT(*) n FROM signal_track WHERE status IN ('WIN','LOSS','FLAT') AND exit_reason != '' GROUP BY exit_reason ORDER BY n DESC").all();
    const total = rows.reduce((a, r) => a + r.n, 0);
    const timeStop = rows.find(r => r.exit_reason === '超时');
    res.json({ ok: true, total, rows, time_stop_pct: total ? Math.round((timeStop ? timeStop.n : 0) / total * 100) : 0 });
  }));

  app.get('/api/daily-analysis', wrap((req, res) => {
    // William 每日分析（最近 30 天）
    const da = require('./daily_analysis');
    da.ensureTable(db);
    const rows = da.list(db, 30).map(r => ({ date: r.date, sentiment: r.sentiment, label: r.label, color: r.color, summary: r.summary, conclusion: r.conclusion || '', details: r.details, btc: r.btc, eth: r.eth }));
    res.json({ ok: true, rows });
  }));

  app.post('/api/daily-analysis/generate', requireAdmin, wrap(async (req, res) => {
    // 预生成历史（默认 7 天）或生成指定日期
    const da = require('./daily_analysis');
    da.ensureTable(db);
    const { days, date } = req.body || {};
    let result;
    if (date) result = await da.generateOne(db, ctx.env, date, true);
    else result = await da.generateRange(db, ctx.env, Math.min(Math.max(Number(days) || 7, 1), 30));
    res.json({ ok: true, result });
  }));

  app.get('/api/admin/access', requireAdmin, wrap((req, res) => {
    // 访问统计：总览 + 14天趋势 + 24h 时段分布 + 最近访问
    const now = Date.now();
    const d0 = new Date(Date.now() + 8 * 3600 * 1000);
    const today = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate())).getTime() - 8 * 3600 * 1000;
    const todayCount = db.prepare('SELECT COUNT(*) n FROM access_log WHERE ts >= ?').get(today);
    const todayIps = db.prepare('SELECT COUNT(DISTINCT ip) n FROM access_log WHERE ts >= ?').get(today);
    const total = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT ip) ips FROM access_log').get();
    // 14 天每日趋势（含今日）
    const days = [];
    for (let d = 13; d >= 0; d--) {
      const s = new Date(today - d * 86400 * 1000);
      const e = s.getTime() + 86400 * 1000;
      const r = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT ip) ips FROM access_log WHERE ts >= ? AND ts < ?').get(s.getTime(), e);
      days.push({ date: s.toISOString().slice(5, 10), count: r.n, ips: r.ips });
    }
    // 近 24h 时段分布（按小时）
    const hours = [];
    for (let h = 23; h >= 0; h--) {
      const s = now - h * 3600 * 1000;
      const e = s + 3600 * 1000;
      const r = db.prepare('SELECT COUNT(*) n FROM access_log WHERE ts >= ? AND ts < ?').get(s, e);
      const hh = new Date(s).getHours();
      hours.push({ hour: String(hh).padStart(2, '0') + ':00', count: r.n });
    }
    const recent = db.prepare('SELECT ts, ip, ua, path FROM access_log ORDER BY id DESC LIMIT 20').all();
    res.json({ ok: true, today_count: todayCount.n, today_ips: todayIps.n, total_count: total.n, total_ips: total.ips, days, hours, recent });
  }));

  app.get('/api/admin/system-stats', requireAdmin, wrap((req, res) => {
    const run = (cmd) => { try { return execSync(cmd, { timeout: 5000, shell: '/bin/bash' }).toString().trim(); } catch (e) { debug('[routes] exec:', e.message); return ''; } };
    const load = run("cat /proc/loadavg").split(/\s+/).slice(0,3).map(Number);
    const mem = run("free -b | grep ^Mem").split(/\s+/);
    const disk = run("df -B1 / | tail -1").split(/\s+/);
    const pm2 = run("pm2 jlist 2>/dev/null || echo '[]'");
    const top = run("ps -eo user,pid,%cpu,%mem,args --sort=-%cpu | head -7 | tail -6");
    const uptime = run("cat /proc/uptime | cut -d. -f1");
    const os = run("uname -sr");

    let pm2Processes = [];
    try { pm2Processes = JSON.parse(pm2).map(p => ({
      name: p.name, pid: p.pid, status: p.status === 'online' ? 'running' : p.status,
      cpu: (p.monit && p.monit.cpu) || 0,
      mem_bytes: (p.monit && p.monit.memory) || 0,
      uptime_ms: p.pm_uptime || 0
    })); } catch (e) { debug('[routes] pm2 list:', e.message); pm2Processes = []; }

    const topLines = top.split('\n').filter(Boolean).map(l => {
      const m = l.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!m) return null;
      const args = (m[5] || '').trim();
      const comm = args.split(/\s+/)[0].split('/').pop() || m[1];
      return { user: m[1], pid: m[2], comm: comm.slice(0, 20), cpu_pct: m[3], mem_pct: m[4], cmd: args.slice(0, 80) };
    }).filter(Boolean);

    const cpus = require('os').cpus().length;
    res.json({
      ok: true, ts: Math.floor(Date.now() / 1000),
      host: run("hostname"),
      os: os || 'unknown',
      uptime_sec: Number(uptime) || 0,
      cpu: { cores: cpus, load_1m: load[0], load_5m: load[1], load_15m: load[2] },
      memory: {
        total_bytes: Number(mem[1]) || 0,
        used_bytes: Number(mem[2]) || 0,
        free_bytes: Number(mem[3]) || 0,
        used_pct: mem[1] ? Math.round(Number(mem[2]) / Number(mem[1]) * 1000) / 10 : 0
      },
      disk: {
        total_bytes: Number(disk[1]) || 0,
        used_bytes: Number(disk[2]) || 0,
        free_bytes: Number(disk[3]) || 0,
        used_pct: disk[1] ? Math.round(Number(disk[2]) / Number(disk[1]) * 1000) / 10 : 0
      },
      pm2: pm2Processes,
      top_cpu: topLines
    });
  }));

  /* ========== User Profile ========== */
  app.get('/api/user/profile', auth.requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM user_profiles WHERE user_id=?').get(req.user.id);
    res.json({ ok: true, profile: row ? { nickname: row.nickname, title: row.title, avatar_url: row.avatar_url, bio: row.bio } : {} });
  });
  app.post('/api/user/profile', auth.requireAuth, (req, res) => {
    const { nickname, title, avatar_url, bio } = req.body || {};
    db.prepare('INSERT OR REPLACE INTO user_profiles(user_id,nickname,title,avatar_url,bio,updated_at) VALUES(?,?,?,?,?,?)')
      .run(req.user.id, nickname||'', title||'', avatar_url||'', bio||'', Date.now());
    // 同步更新 users.nickname（留言显示名用）
    if (typeof nickname === 'string') {
      const nick = nickname.trim();
      if (!nick || /^[A-Za-z0-9_\-一-龥]{2,24}$/.test(nick)) {
        db.prepare('UPDATE users SET nickname=? WHERE id=?').run(nick || null, req.user.id);
      }
    }
    res.json({ ok: true });
  });

  /* ========== Messages 留言板 ========== */
  // 留言列表（公开可看，登录才能发）
  app.get('/api/messages', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const rows = db.prepare(`
      SELECT m.id, m.user_id, m.username, m.nickname AS msg_nickname, m.content, m.created_at,
             u.is_owner AS is_owner, u.permanent AS permanent, u.expires_at AS expires_at,
             u.nickname AS user_nickname
      FROM messages m LEFT JOIN users u ON u.id = m.user_id
      ORDER BY m.created_at DESC LIMIT ?`).all(limit);
    // 用 vipOf 动态计算会员等级；昵称：留言快照优先，空则回退当前用户昵称（老留言也能显示新昵称）
    const messages = rows.map(m => ({
      id: m.id, user_id: m.user_id, username: m.username, nickname: m.msg_nickname || m.user_nickname || null, content: m.content, created_at: m.created_at,
      vip: vipOf({ is_owner: m.is_owner, permanent: m.permanent, expires_at: m.expires_at })
    }));
    res.json({ ok: true, count: messages.length, messages });
  });

  // 发言（需登录，每人每天最多 5 条）
  app.post('/api/messages', auth.requireAuth, (req, res) => {
    const content = String((req.body && req.body.content) || '').trim();
    if (!content) return res.status(400).json({ ok: false, error: 'empty', message: '内容不能为空' });
    if (content.length > 500) return res.status(400).json({ ok: false, error: 'too_long', message: '单条留言最多 500 字' });
    // 每日 5 条限制（Asia/Shanghai 自然日：用东八区当天 00:00 的时间戳）
    const tzOffsetMs = 8 * 3600 * 1000; // UTC+8
    const nowUtc = Date.now();
    const dayStartUtc8 = Math.floor((nowUtc + tzOffsetMs) / 86400000) * 86400000 - tzOffsetMs;
    const todayCount = db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id=? AND created_at >= ?').get(req.user.id, dayStartUtc8).c;
    if (todayCount >= 5) {
      return res.status(429).json({ ok: false, error: 'daily_limit', message: '今日留言已达 5 条上限，明天再来吧' });
    }
    const info = db.prepare('INSERT INTO messages(user_id,username,nickname,content,created_at) VALUES(?,?,?,?,?)')
      .run(req.user.id, req.user.username, req.user.nickname || null, content, Date.now());
    res.json({ ok: true, id: info.lastInsertRowid, today_count: todayCount + 1 });
  });

  // 删除自己的留言
  app.delete('/api/messages/:id', auth.requireAuth, (req, res) => {
    const id = parseInt(req.params.id) || 0;
    // 管理员（admin cookie）或留言本人可删；老板(is_owner)始终可删
    const adminSess = findSession(db, req.cookies[ADMIN_COOKIE], 'admin');
    const isAdmin = !!adminSess || !!req.user.is_owner;
    const info = isAdmin
      ? db.prepare('DELETE FROM messages WHERE id=?').run(id)
      : db.prepare('DELETE FROM messages WHERE id=? AND user_id=?').run(id, req.user.id);
    res.json({ ok: info.changes > 0, error: info.changes ? null : 'not_found' });
  });

  // ============ 七宝因子（7宝BTC 教学体系量化评分 · 2026-08-10） ============
  // 7 因子：洗盘/出货 · 清算墙 · 爆仓动能 · MM Gamma · 吸筹/派发 · 多空拥挤 · 趋势体制
  // 数据全部来自本地库（futures_markets），无外部依赖；qibao7.js 教学来源见文件头注释
  app.get('/api/qibao', wrap(async (req, res) => {
    try {
      const qibao = require('./qibao7');
      const symbol = String(req.query.symbol || req.query.s || 'BTC').toUpperCase().replace(/USDT$/, '');
      const r = await qibao.qibaoReportAsync(db, symbol);   // 双通道：加密走 W1，非加密走 Yahoo
      res.json(r);
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));
  app.get('/api/qibao/list', wrap((req, res) => {
    try {
      const qibao = require('./qibao7');
      const snaps = qibao.listReport(db);
      res.json(snaps);
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

}

const avgYCacheGlobal = new Map();
module.exports = { registerRoutes, dashboardFingerprint };
