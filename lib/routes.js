// API 路由：全部 JSON，含 data_ts 与 stale 标记；前端只读本地库，永不穿透打上游
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { store, staleOf, ageSec } = require('./store');
const { GLOSSARY } = require('./glossary');
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
  } catch {
    value = { exists: false, bytes: 0, sha256_16: null, is_full_terminal: false };
  }
  fpCache = { ts: now, value };
  return value;
}

function registerRoutes(app, ctx, auth) {
  const { db, env } = ctx;
  const { requireAuth, requireVip, requireAdmin } = auth;
  const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && typeof r.then === 'function') r.catch(e => { console.error('[api]', req.path, e.message); res.status(500).json({ ok: false, error: 'internal', message: e.message }); }); } catch (e) { console.error('[api]', req.path, e.message); res.status(500).json({ ok: false, error: 'internal', message: e.message }); } };

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
    try { const lp = db.prepare("SELECT price FROM prices WHERE symbol=? ORDER BY ts DESC LIMIT 1").get(symbol); st.live_price = lp ? lp.price : null; } catch {}
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
      console.log(`[strategy] 实盘策略切换 → ${target}`);
      res.json({ ok: true, live: target, note: target === 'beta1' ? 'β1 已启用（自动开单恢复）' : 'α1 cron 已启用' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  }));

  app.get('/api/okx/status', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    const st = await okx.accountStatus(db);
    res.json(st);
  }));
  // 实际持仓（快捷）
  app.get('/api/okx/positions', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    const st = await okx.accountStatus();
    res.json({ ok: true, connected: st.connected, positions: st.positions || [] });
  }));
  // 仓位倍数（默认 1.0 = 1:1 跟随策略）
  app.get('/api/okx/status', requireVip, wrap(async (req, res) => {
    const okx = require('./okx_executor');
    try { const st = await okx.accountStatus(db); res.json(Object.assign({ ok: true }, st)); }
    catch (e) { res.json({ ok: false, error: e.message, connected: false }); }
  }));
  app.get('/api/okx/mult', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    res.json({ ok: true, mult: okx.getPosMult(db) });
  }));
  app.post('/api/okx/mult', requireVip, wrap((req, res) => {
    const okx = require('./okx_executor');
    const r = okx.setPosMult(db, Number((req.body || {}).mult));
    res.json(r);
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
  app.post('/api/okx/auto', requireAdmin, wrap((req, res) => {
    const okx = require('./okx_executor');
    const on = !!(req.body || {}).auto;
    okx.setAutoOn(db, on);
    console.log('[okx] 实盘全自动开关 → ' + (on ? 'ON（信号即下单）' : 'OFF（仅虚拟盘）'));
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
    // 时间段：支持 start/end（YYYY-MM-DD），默认全段 2024-01-01 ~ 2026-08-11
    const parseDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s||'')); return m ? Date.UTC(+m[1], +m[2]-1, +m[3]) : null; };
    const reqStart = parseDay(body.start), reqEnd = parseDay(body.end);
    const avgYCache = avgYCacheGlobal;
    const S = reqStart || Date.UTC(2024, 0, 1);
    const E = reqEnd ? reqEnd + 86399999 : Date.UTC(2026, 7, 11, 23, 59);
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
        const p = typeof h.posture_json === 'string' ? JSON.parse(h.posture_json) : h.posture_json;
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
            return { report_date: r.date, headline_zh: p.headline_zh, headline_en: p.headline_en || p.headline_zh };
          });
        } catch (e) { console.warn('[routes] self hero history err:', e.message); return []; }
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

  app.get('/api/market-global', wrap((req, res) => {
    const mg = require('./market_global');
    const cur = mg.getCurrent(db);
    res.json({ ok: true, current: cur, series: mg.getSeries(db, 90), data_ts: cur ? cur.ts : null });
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
        return txs.map(tx => ({ ...tx, value_usd: (Number.isFinite(Number(tx.value_btc)) ? Number(tx.value_btc) : 0 * btcPrice.current_price).toFixed(0) }));
      }
      return txs;
    }).catch(e => { console.error('[whale] fetch error:', e.message); return []; });
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

  app.get('/api/member/consensus', requireVip, wrap((req, res) => {
    const cons = store.latestConsensus(db);
    const arr = Array.isArray(cons && cons.data) ? cons.data : [];
    res.json({
      ok: true, data_ts: cons ? cons.ts : null, stale: staleOf(cons && cons.ts, 1200), age_sec: ageSec(cons && cons.ts),
      coins: arr.map(c => ({
        symbol: c.display_symbol || c.symbol, decision: c.decision, decision_label: c.decision_label,
        color: c.color, confidence: c.confidence, trust_adjusted_bias: c.trust_adjusted_bias,
        price: c.price, snapshot_date: c.snapshot_date, snapshot_age_hours: c.snapshot_age_hours,
        firing_factors_count: c.firing_factors_count,
        top_factors: (c.top_factors || []).slice(0, 5)
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
    } catch {}
    const BASE = 10000;               // 指标战绩真实本金
    const LEVER = 100;                 // 统一引擎 100x
    for (const r of rows) {
      const posPct = Number(r.pos_pct) || 0;
      r.pos_usd_1000 = +(BASE * posPct / 100).toFixed(2);       // 保证金（pos%×本金）
      // 盈亏 = 方向 × pos% × 涨跌幅% × 100（名义=pos%×本金×100x），亏损爆仓截断到保证金
      if (r.pnl_pct != null) {
        let fu = (r.direction === 'long' ? 1 : -1) * posPct * Number(r.pnl_pct) * 100;
        if (fu < 0) fu = Math.max(fu, -(posPct * 100));          // 截断: 3%→-300 / 8%→-800 / 12%→-1200
        r.final_pnl_usd = +fu.toFixed(2);
      } else r.final_pnl_usd = null;
      if (r.status === 'OPEN' && curMap && curMap.has(r.symbol)) {
        const px = Number(curMap.get(r.symbol).current_price);
        const entry = Number(r.entry);
        if (isFinite(px) && px > 0 && isFinite(entry) && entry > 0) {
          const pnl = r.direction === 'long' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
          let fu = (r.direction === 'long' ? 1 : -1) * posPct * pnl * 100;
          if (fu < 0) fu = Math.max(fu, -(posPct * 100));
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
    try { const snaps = signal.futuresSnapshots(db, 1); if (snaps.length) curMap = snaps[snaps.length-1].m; } catch {}
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
    } catch {}
    try {
      const de = require('./dir_prod');
      const an = de.analyze('BTC', Date.now());
      dirEng = { regime: an.regime, score: an.score, tradeable: an.tradeable, plan: an.plan, levels: an.levels, price: an.price };
    } catch {}
    res.json({ ok: true, rows, unified, dir_engine: dirEng });
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
    const traderMap = (() => { const m = new Map(); const r = dbRead.prepare("SELECT payload FROM lsr_rankings WHERE mode='trader' ORDER BY ts DESC LIMIT 1").get(); if (r) { try { for (const c of JSON.parse(r.payload).data || []) m.set(c.symbol, c); } catch {} } return m; })();
    const whaleMap = (() => { const m = new Map(); const r = dbRead.prepare("SELECT payload FROM lsr_rankings WHERE mode='whale' ORDER BY ts DESC LIMIT 1").get(); if (r) { try { for (const c of JSON.parse(r.payload).data || []) m.set(c.symbol, c); } catch {} } return m; })();
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
    try { dbBytes = fs.statSync(dbFile).size; } catch {}
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
    const rv = kvGet(db, 'signal:regime', null) || {}; const r = typeof rv === 'string' ? (() => { try { return JSON.parse(rv); } catch { return {}; } })() : rv;
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
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const today = dayStart.getTime();
    const todayCount = db.prepare('SELECT COUNT(*) n FROM access_log WHERE ts >= ?').get(today);
    const todayIps = db.prepare('SELECT COUNT(DISTINCT ip) n FROM access_log WHERE ts >= ?').get(today);
    const total = db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT ip) ips FROM access_log').get();
    // 14 天每日趋势（含今日）
    const days = [];
    for (let d = 13; d >= 0; d--) {
      const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - d);
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
    const run = (cmd) => { try { return execSync(cmd, { timeout: 5000, shell: '/bin/bash' }).toString().trim(); } catch { return ''; } };
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
    })); } catch { pm2Processes = []; }

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
