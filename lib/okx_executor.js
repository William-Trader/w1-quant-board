'use strict';
// ============================================================
// OKX 实盘执行器（2026-08-11 · William 老板指令）
// 基于 OKX 官方 Agent Trade Kit CLI（okx-trade-cli）
//   - 未配置 API key 时：所有接口返回 disconnected，前端展示占位
//   - 配置后：市价开仓 + 附加 TP/SL（OCO 触发单，交易所侧兜底止损）
// 设计：金额自适应 —— 风险 = 账户实时余额 × 4.25% × 仓位倍数
//       仓位倍数默认 1.0（1:1 严格跟随策略），可调大/调小
// ============================================================
const { execFile } = require('child_process');
const { warn, info } = require('./log');

const OKX_CLI = process.env.OKX_CLI || 'okx';
// 默认走 live 实盘（config.toml 有 live/demo 双 profile，OKX_PROFILE 可切换）
const PROFILE = process.env.OKX_PROFILE || 'live';
const USE_DEMO = String(process.env.OKX_DEMO || '0') === '1';
const RISK_PCT = 4.25; // 与 dir_prod 锁定参数一致
// 冻结资金持仓保护名单 —— 已封存（William老板 2026-08-25 指令）
// 冻结资金仓已清空，保护名单不再生效；框架保留，将来如需恢复保护，往 Set 里加合约名即可
const PROTECTED_INSTS = new Set([]);
function isProtected(instId) { return PROTECTED_INSTS.has(String(instId || '').toUpperCase()); }

let _configured = null;
function configured() {
  if (_configured !== null) return _configured;
  const fs = require('fs');
  const os = require('os');
  const p = require('path').join(os.homedir(), '.okx', 'config.toml');
  try { _configured = fs.existsSync(p) && fs.statSync(p).size > 50; }
  catch (e) { _configured = false; }
  return _configured;
}

function runCli(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const fullArgs = [];
    if (PROFILE) fullArgs.push('--profile', PROFILE);
    if (USE_DEMO) fullArgs.push('--demo');
    fullArgs.push('--json');
    fullArgs.push(...args);
    execFile(OKX_CLI, fullArgs, { timeout: timeoutMs, env: process.env }, (err, stdout, stderr) => {
      if (err) {
        // 优先解析 stdout JSON（OKX 错误码在 stdout，如 sCode/sMsg）
        let msg = err.message || 'CLI 调用失败';
        try {
          const d = JSON.parse(stdout);
          const first = Array.isArray(d) ? d[0] : d;
          if (first && (first.sMsg || first.sCode)) msg = first.sMsg + (first.sCode ? ' (code ' + first.sCode + ')' : '');
        } catch (e) {}
        // 退路：过滤 stderr 噪音行
        if (/^Command failed|^Error:/.test(msg)) {
          const noise = /Update available|Run: npm|node --trace|EnvHttpProxyAgent|UNDICI-EHPA|^\(Use `/;
          const lines = String(stderr || '').split('\n').map(x => x.trim()).filter(x => x && !noise.test(x));
          if (lines.length) msg = lines.join(' | ');
        }
        return resolve({ ok: false, error: msg });
      }
      try { resolve({ ok: true, data: JSON.parse(stdout) }); }
      catch (e) { resolve({ ok: true, data: stdout.trim() }); }
    });
  });
}

/* ---------- 仓位倍数（kv 存储，默认 1.0 = 1:1 跟随策略） ---------- */
function getPosMult(db) {
  try {
    const r = db.prepare("SELECT value FROM kv WHERE key='okx:pos_mult'").get();
    const v = r ? Number(r.value) : 1.0;
    return isFinite(v) && v > 0 ? v : 1.0;
  } catch { return 1.0; }
}
function setPosMult(db, mult) {
  const v = Math.min(10, Math.max(0.1, Number(mult) || 1.0));
  try {
    db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES('okx:pos_mult',?)")
      .run(String(v));
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, mult: v };
}

/* ---------- 通用设置（kv 存储） ---------- */
function getSetting(db, key, def) {
  try {
    const r = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    const v = r ? Number(r.value) : def;
    return isFinite(v) ? v : def;
  } catch { return def; }
}
function setSetting(db, key, v) {
  try { db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run(key, String(v)); }
  catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}
// 单笔风险%（默认 4.25，与 dir_prod 锁定参数一致）
function getRiskPct(db) { return getSetting(db, 'okx:risk_pct', RISK_PCT); }
function setRiskPct(db, v) { return setSetting(db, 'okx:risk_pct', Math.min(20, Math.max(0.1, Number(v) || RISK_PCT))); }
// 固定金额模式（0=关闭；>0 时每单按 固定金额×倍数 计算名义仓位）
function getFixAmount(db) { return getSetting(db, 'okx:fix_amount', 0); }
function setFixAmount(db, v) { return setSetting(db, 'okx:fix_amount', Math.max(0, Number(v) || 0)); }
// 硬性止损%（开单止损距离上限；策略止损更宽时收窄到该距离，防单笔超亏）
function getHardStop(db) { return getSetting(db, 'okx:hard_stop_pct', 2.5); }
function setHardStop(db, v) { return setSetting(db, 'okx:hard_stop_pct', Math.min(20, Math.max(0, Number(v) || 0))); } // 0=关闭硬止损（完全按策略止损 2026-08-22）
// 杠杆（默认 50）
function getLevSetting(db) { return getSetting(db, 'okx:leverage', 50); }
function setLevSetting(db, v) { return setSetting(db, 'okx:leverage', Math.min(125, Math.max(1, Number(v) || 50))); }
// 智能跟单比例（默认 1.0 = 1:1 复制策略仓位）
function getFollowRatio(db) { return getSetting(db, 'okx:follow_ratio', 1.0); }
function setFollowRatio(db, v) { return setSetting(db, 'okx:follow_ratio', Math.min(5, Math.max(0, Number(v) || 0))); }
// 最大整体杠杆（全账户名义/权益上限，防多信号叠加超杠杆；默认 30x）
function getMaxLev(db) { return getSetting(db, 'okx:max_total_lev', 30); }
// 回撤熔断（2026-08-22 方案B）：基于 OKX 真实权益峰值（kv okx:equity_peak），回撤越大整体杠杆越低
function getDdScale(db, equity) {
  const peak = Number(getSetting(db, 'okx:equity_peak', 0) || 0);
  if (!(equity > 0)) return 1;
  if (equity > peak) { setSetting(db, 'okx:equity_peak', String(equity)); return 1; }
  if (peak <= 0) return 1;
  const dd = (peak - equity) / peak * 100;
  if (dd >= 12) return 0.2;   // ≥12% 接近暂停
  if (dd >= 7) return 0.5;
  if (dd >= 3) return 0.7;
  return 1;
}
function getDdLevOn(db) { return Number(getSetting(db, 'okx:dd_lev', 1) || 1) === 1; }
function setMaxLev(db, v) { return setSetting(db, 'okx:max_total_lev', Math.min(100, Math.max(1, Number(v) || 30))); }
// 系统跟单仓的保证金占用合计（仅 signal_track OPEN+followed 的仓；冻结资金仓/保护仓完全忽略）
// 2026-08-25 加推浮盈闸：现有跟单持仓（signal_track OPEN & followed）总浮盈，亏损期禁止加推
// 2026-08-25 连胜+空仓解锁加推：返回实盘跟单持仓数量（0 = 空仓；null = 查询失败）
async function getFollowPosCount(db) {
  try {
    const pos = await runCli(['swap', 'positions']);
    if (!pos.ok) return null;
    const arr = Array.isArray(pos.data) ? pos.data : (pos.data.data || []);
    const followInsts = new Set();
    try {
      const rows = db.prepare("SELECT DISTINCT symbol FROM signal_track WHERE status='OPEN' AND okx_meta LIKE '%followed%'").all();
      for (const r of rows) {
        const sym = String(r.symbol || '').toUpperCase();
        followInsts.add(sym.includes('-') ? sym : sym + '-USDT-SWAP');
      }
    } catch (e) {}
    let n = 0;
    for (const p of arr) {
      if (Number(p.pos) !== 0 && followInsts.has(String(p.instId).toUpperCase())) n++;
    }
    return n;
  } catch (e) { return null; }
}

async function getFollowUpl(db) {
  try {
    const pos = await runCli(['swap', 'positions']);
    if (!pos.ok) return null;
    const arr = Array.isArray(pos.data) ? pos.data : (pos.data.data || []);
    const followInsts = new Set();
    try {
      const rows = db.prepare("SELECT DISTINCT symbol FROM signal_track WHERE status='OPEN' AND okx_meta LIKE '%followed%'").all();
      for (const r of rows) {
        const sym = String(r.symbol || '').toUpperCase();
        followInsts.add(sym.includes('-') ? sym : sym + '-USDT-SWAP');
      }
    } catch (e) {}
    let upl = 0;
    for (const p of arr) {
      if (Number(p.pos) !== 0 && followInsts.has(String(p.instId).toUpperCase())) {
        upl += Number(p.upl) || 0;
      }
    }
    return upl;
  } catch (e) { return null; }
}

// 2026-08-25 实盘对账巡视（William老板指令）：信号层一直追踪，实盘层巡视确认平
// 对每个 OPEN & followed 信号单：
//   实盘有仓 + 挂单齐全 → 全自动（autoOk）
//   实盘有仓 + 挂单缺失 → verifyAndRepairTpsl 自动补挂 + 监控群告警
//   实盘无仓 → 外部/手动已平 → 查实际成交盈亏，自动确认结算 DB（WIN/LOSS + 实际 pnl）
async function reconcileFollowedPositions(db, env) {
  const out = { scanned: 0, autoOk: 0, repaired: 0, notified: 0, errors: [] };
  let rows = [];
  try {
    rows = db.prepare("SELECT * FROM signal_track WHERE strategy='TIANJI' AND status='OPEN' AND okx_meta LIKE '%followed%'").all();
  } catch (e) { return out; }
  if (!rows.length) return out;
  const pos = await runCli(['swap', 'positions']);
  if (!pos.ok) {
    // 2026-08-29 老板暂停实盘（API 已删除）：查询失败 ≠ 外部平仓，跳过本轮对账，不误标 externalClosed、不误报
    out.errors.push('OKX 查询失败，跳过对账: ' + (pos.error || ''));
    warn('[okx] 实盘对账跳过: OKX CLI 查询失败（API 已暂停），不误判外部平仓');
    return out;
  }
  const posArr = pos.ok && (Array.isArray(pos.data) ? pos.data : ((pos.data || {}).data || []));
  const livePos = new Map();
  for (const p of (posArr || [])) {
    if (Number(p.pos) !== 0) livePos.set(String(p.instId).toUpperCase(), p);
  }
  for (const o of rows) {
    out.scanned++;
    const instId = String(o.symbol).indexOf('-') >= 0 ? o.symbol : o.symbol + '-USDT-SWAP';
    const key = instId.toUpperCase();
    const p = livePos.get(key);
    if (p) {
      // 实盘有仓：先检测部分平仓（外部减仓后挂单数量超持仓，属异常态，告警不自动结算）
      const m = (() => { try { return JSON.parse(o.okx_meta || '{}'); } catch (e) { return {}; } })();
      const sigSz = Number(m.sz) || 0;
      const liveSz = Math.abs(Number(p.pos)) || 0;
      if (sigSz > 0 && liveSz < sigSz * 0.9) {
        out.errors.push(instId + ': 外部部分平仓 ' + sigSz + '→' + liveSz + '张');
        warn(`[okx] 实盘对账 ${instId}: 外部部分平仓 ${sigSz}→${liveSz} 张，挂单数量未同步，需人工确认`);
        // 节流：同币 1h 内只推送一次监控群
        let lastAlert = 0;
        try {
          const row = db.prepare("SELECT value FROM kv WHERE key=?").get('okx:partial_alert:' + instId);
          if (row) lastAlert = Number(row.value) || 0;
        } catch (e) {}
        if (env && env.db && Date.now() - lastAlert > 3600 * 1000) {
          try {
            db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run('okx:partial_alert:' + instId, String(Date.now()));
            const { pushToGroup } = require('./qqbot');
            await pushToGroup(env, env.db, `⚠️【W1 实盘对账】${o.symbol} 实盘部分平仓 ${sigSz}→${liveSz} 张（外部操作），信号单保持 OPEN，按预设止盈止损跟踪，挂单数量待老板确认`, 'monitor');
          } catch (e) { warn('[okx] 部分平仓告警推送失败:', e.message); }
        }
        continue;
      }
      // 实盘有仓：核对挂单齐全（TP1/TP2/SL），缺失自动补挂
      try {
        const v = await verifyAndRepairTpsl(instId, o.direction === 'long' ? 'long' : 'short', liveSz || sigSz, o.t1_hit ? 0 : (Number(o.target1) || 0), Number(o.target2) || 0, Number(o.stop) || 0, m.lotSz);
        if (v && v.repaired > 0) {
          out.repaired += v.repaired;
          warn(`[okx] 实盘对账 ${instId}: 挂单缺失自动补挂 ${v.repaired} 项`);
          if (env && env.db) {
            try {
              const { pushToGroup } = require('./qqbot');
              await pushToGroup(env, env.db, `⚠️【W1 实盘对账】${instId} 挂单缺失，已自动补挂 ${v.repaired} 项${v.errors.length ? '，失败: ' + v.errors.join(';') : ''}`, 'monitor');
            } catch (e) { warn('[okx] 对账告警推送失败:', e.message); }
          }
        } else if (v && !v.missing.length) {
          out.autoOk++;
        }
      } catch (e) { out.errors.push(instId + ': ' + e.message); }
    } else {
      // 实盘无仓 → 外部/手动已平（William老板 2026-08-25 指令修正）：
      // 信号战绩必须按预设止盈止损（T1/T2/SL）独立记录，实盘操作不改写信号记录
      // 这里只做：清残留条件单 + 标记 externalClosed（界面提示"实盘已平，信号按预设跟踪中"）+ 监控群提示
      try {
        const ca = await cancelAlgosByInst(instId);
        if (ca && ca.canceled > 0) info(`[okx] 实盘对账 ${instId}: 外部平仓后清理残留条件单 ${ca.canceled} 个`);
      } catch (e) { warn('[okx] 对账清理条件单异常:', e.message); }
      try {
        const m = (() => { try { return JSON.parse(o.okx_meta || '{}'); } catch (e) { return {}; } })();
        const meta = JSON.stringify(Object.assign({}, m, { externalClosed: true, closedTs: Date.now() }));
        db.prepare("UPDATE signal_track SET okx_meta=? WHERE id=?").run(meta, o.id);
      } catch (e) { warn('[okx] 对账标记异常:', e.message); }
      out.notified++;
      info(`[okx] 实盘对账 ${o.symbol} id=${o.id}: 实盘已无持仓（外部平仓），信号战绩按预设止盈止损继续跟踪，不清算`);
      // 节流：同币 1h 内只推送一次
      let lastAlert = 0;
      try {
        const row = db.prepare("SELECT value FROM kv WHERE key=?").get('okx:ext_close_alert:' + instId);
        if (row) lastAlert = Number(row.value) || 0;
      } catch (e) {}
      if (env && env.db && Date.now() - lastAlert > 3600 * 1000) {
        try {
          db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run('okx:ext_close_alert:' + instId, String(Date.now()));
          const { pushToGroup } = require('./qqbot');
          await pushToGroup(env, env.db, `🔔【W1 实盘对账】${o.symbol} 实盘已无持仓（外部平仓），信号单保持 OPEN，按预设止盈止损（T1 ${Number(o.target1)||'-'} / T2 ${Number(o.target2)||'-'} / SL ${Number(o.stop)||'-'}）继续跟踪结算`, 'monitor');
        } catch (e) { warn('[okx] 对账推送失败:', e.message); }
      }
    }
  }
  return out;
}

async function getFollowMargin(db) {
  try {
    const pos = await runCli(['swap', 'positions']);
    if (!pos.ok) return 0;
    const arr = Array.isArray(pos.data) ? pos.data : (pos.data.data || []);
    const followInsts = new Set();
    try {
      const rows = db.prepare("SELECT DISTINCT symbol FROM signal_track WHERE status='OPEN' AND okx_meta LIKE '%followed%'").all();
      for (const r of rows) {
        const sym = String(r.symbol || '').toUpperCase();
        followInsts.add(sym.includes('-') ? sym : sym + '-USDT-SWAP');
      }
    } catch (e) {}
    return arr.filter(p => Number(p.pos) !== 0 && followInsts.has(String(p.instId).toUpperCase()))
      .reduce((s, p) => s + (Number(p.imr) || 0), 0);
  } catch (e) { return 0; }
}

// 查询当前总名义仓位（跨所有合约）
async function totalNotional(db) {
  const pos = await runCli(['swap', 'positions']);
  if (!pos.ok) return null;
  try {
    const arr = Array.isArray(pos.data) ? pos.data : (pos.data.data || []);
    // 排除两类仓：①冻结资金仓（保护名单，用户自管）②系统跟单中仓（signal_track followed & OPEN）
    // 已有仓不影响新单额度计算（William老板 2026-08-24 指令）
    const followInsts = new Set();
    try {
      const rows = db.prepare("SELECT DISTINCT symbol FROM signal_track WHERE status='OPEN' AND okx_meta LIKE '%followed%'").all();
      for (const r of rows) {
        const sym = String(r.symbol || '').toUpperCase();
        followInsts.add(sym.includes('-') ? sym : sym + '-USDT-SWAP');
      }
    } catch (e) {}
    return arr.filter(p => Number(p.pos) !== 0 && !isProtected(p.instId) && !followInsts.has(String(p.instId).toUpperCase()))
      .reduce((s, p) => s + (Number(p.notionalUsd) || 0), 0);
  } catch (e) { return null; }
}

/* ---------- 智能跟单：把 SmartSignal（TIANJI）信号按比例复制到 OKX 实盘 ----------
 * sig: { symbol, direction, entry, stop, target1, notional, pos_pct, leverage }
 * 目标名义 = 策略建议名义 × 跟单比例（无建议名义时 = 当前权益 × 建议仓位% × 比例）
 * 张数 = 目标名义 / (价格 × 面值)，止损受硬性止损兜底
 */
async function followSignal(db, sig, ratio = null, env = null) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const r = ratio != null ? ratio : getFollowRatio(db);
  if (!(r > 0)) return { ok: false, error: '跟单比例未开启（0 = 关闭）' };
  // 信号时效：超过 2 小时拒绝（价格已变化，止损/目标失真）
  const MAX_AGE = 2 * 3600 * 1000;
  if (sig.ts && Date.now() - Number(sig.ts) > MAX_AGE) {
    const ageMin = Math.round((Date.now() - Number(sig.ts)) / 60000);
    return { ok: false, error: '信号已过期（' + ageMin + ' 分钟前）——超过 2 小时不跟单，请用「一键智能开单」重新生成新信号' };
  }
  const st = await accountStatus(db);
  if (!st.connected || !st.balance) return { ok: false, error: '账户状态不可用' };
  const equity = st.balance.availEq != null ? st.balance.availEq : st.balance.totalEq; // 只用可用资金（冻结资金完全忽略）
  const totalEq = equity + (await getFollowMargin(db));                                  // 熔断基线=可用+系统跟单仓保证金（开仓冻结不误判，冻结仓不计）
  if (equity < 50) return { ok: false, error: '可用资金不足 50u（当前 ' + equity.toFixed(2) + 'u）', meta: { equity } };
  // 总仓位风控：当前总名义 + 本单名义 ≤ 可用资金 × 最大整体杠杆（防多信号叠加超杠杆）
  const symbol = String(sig.symbol || '').toUpperCase();
  const instId = symbol.includes('-') ? symbol : symbol + '-USDT-SWAP';
  const entry = Number(sig.entry), stop = Number(sig.stop), t1 = Number(sig.target1 || 0);
  if (!entry || !stop) return { ok: false, error: '信号价格不完整' };
  const lev = sig.leverage || getLevSetting(db);
  // 反手预处理 + 防重复（方案A·2026-08-26）：同向拒绝，反向先平再开
  const fdir = sig.direction === 'long' ? 'long' : 'short';
  try {
    const ps0 = await runCli(['swap', 'positions'], 15000);
    if (ps0.ok) {
      const parr0 = Array.isArray(ps0.data) ? ps0.data : ((ps0.data || {}).data || []);
      const same0 = parr0.find(p => p.instId === instId && p.posSide === fdir && Number(p.pos) !== 0);
      if (same0) return { ok: false, error: '已有同向持仓（' + same0.pos + ' 张），跳过重复开单', meta: { pos: same0.pos } };
    } else { warn('[okx] 跟单持仓检查失败（继续开单）:', ps0.error || ''); }
  } catch (e) { warn('[okx] 跟单持仓检查异常:', e.message); }
  // 手动仓保护（2026-08-26 William老板指令）：检测到手动单 → 不反向操作 + 跟单信号群提示
  try {
    if (getManualProtect(db)) {
      const prot = await manualConflictCheck(db, instId, fdir, env);
      if (prot.conflict) return { ok: false, error: prot.error, meta: prot };
    }
  } catch (e) { warn('[okx] 手动仓保护检查异常:', e.message); }
  const flip0 = await flipPrep(db, instId, fdir, env);
  if (flip0.error) return { ok: false, error: '反手预处理失败: ' + flip0.error, meta: flip0 };
  // 先设置杠杆档位（place --lever 不生效，必须显式设置）
  const lr0 = await ensureLeverage(instId, lev);
  if (!lr0.ok) warn('[okx] 跟单设置杠杆失败: ' + (lr0.error || ''));
  let targetNotional = (Number(sig.notional) || (equity * (Number(sig.pos_pct) || 3) / 100)) * r;
  // 实盘风险封顶（2026-08-25 William老板修复）：按实盘权益重算单笔风险≤risk_pct，
  // 防止策略模拟净值(1000u复利)≠实盘权益时跟单名义翻倍；封顶后仍受下方总杠杆闸约束
  const stopDistPct = entry > 0 ? Math.abs(entry - stop) / entry * 100 : 0;
  if (stopDistPct > 0) {
    const riskCap = equity * (getRiskPct(db) / 100) * (getPosMult(db) || 1) / (stopDistPct / 100);
    if (isFinite(riskCap) && targetNotional > riskCap) {
      warn(`[okx] 跟单名义 $${Math.round(targetNotional)} > 实盘风险上限 $${Math.round(riskCap)}（权益$${equity.toFixed(0)}×风险${getRiskPct(db)}%÷止损${stopDistPct.toFixed(2)}%），已封顶`);
      targetNotional = riskCap;
    }
  }
  let maxLev = getMaxLev(db);
  // 回撤熔断（2026-08-22）：动态整体杠杆 = 基础上限 × 回撤缩放
  try { if (getDdLevOn(db)) { const sc = getDdScale(db, totalEq); maxLev = Math.max(1, Math.round(maxLev * sc * 10) / 10); } } catch (e) {}
  const curNotional = await totalNotional(db);
  if (curNotional != null && (curNotional + targetNotional) > equity * maxLev) {
    return { ok: false, error: '总仓位超限：当前名义 $' + Math.round(curNotional) + ' + 本单 $' + Math.round(targetNotional) + ' > 可用 ' + equity.toFixed(0) + 'u × ' + maxLev + 'x（最大整体杠杆），已拒绝开单——请平仓或调低设置', meta: { curNotional, targetNotional, maxLev, equity } };
  }
  // 精确 USDT 名义下单（quote_ccy：sz=USDT 金额，OKX 自动换算小数张数，无需取整）
  const args = ['swap', 'place', '--instId', instId,
    '--side', sig.direction === 'long' ? 'buy' : 'sell',
    '--ordType', 'market', '--sz', targetNotional.toFixed(2), '--tgtCcy', 'quote_ccy',
    '--posSide', sig.direction === 'long' ? 'long' : 'short',
    '--tdMode', 'cross', '--lever', String(lev)];
  const res = await runCli(args, 30000);
  // 合约 lot size（BNB/XAU=1.0，其余 0.01）——60/40 挂单必须按 lot 取整
  let lotSz = 0.01;
  try {
    const inst = await runCli(['market', 'instruments', '--instType', 'SWAP', '--instId', instId]);
    const arr = Array.isArray(inst.data) ? inst.data : ((inst.data || {}).data || []);
    const it = arr.find(x => (x.instId || '') === instId) || arr[0];
    lotSz = Number(it.lotSz) > 0 ? Number(it.lotSz) : 0.01;
  } catch (e) { warn('[okx] lotSz 查询失败，默认 0.01:', e.message); }
  // 开仓后查实际持仓张数（小数），用于挂 TP/SL
  let sz = 1;
  if (res.ok) {
    try {
      const ps = await runCli(['swap', 'positions']);
      const parr = Array.isArray(ps.data) ? ps.data : ((ps.data || {}).data || []);
      const mine = parr.find(x => x.instId === instId && x.posSide === (sig.direction === 'long' ? 'long' : 'short') && Number(x.pos) !== 0);
      if (mine) sz = Number(mine.pos);
    } catch (e) {}
  }
  // 挂 TP/SL：严格复制信号风控（信号原止损/目标，不套硬性止损）
  let tpsl = null;
  if (res.ok) {
    tpsl = await attachTPSL(instId, sig.direction === 'long' ? 'long' : 'short', sz, t1, stop, Number(sig.target2 || 0) || null, lotSz);
    if (!tpsl.ok) warn('[okx] 跟单挂 TP/SL 失败: ' + (tpsl.error || ''));
    // 2026-08-25 防复发：挂单后核对交易所实际算法单，缺失自动补挂+告警
    try {
      const v = await verifyAndRepairTpsl(instId, sig.direction === 'long' ? 'long' : 'short', sz, t1, Number(sig.target2 || 0) || null, stop, lotSz);
      if (v && (v.missing.length || v.repaired > 0 || v.errors.length)) {
        warn(`[okx] TP/SL核对: 缺失[${v.missing.map(m => m.kind).join(',')}] 补挂${v.repaired} 失败[${v.errors.join(';')}]`);
        if (env && env.db) {
          try {
            const { pushToGroup } = require('./qqbot');
            await pushToGroup(env, env.db, `⚠️【W1 挂单自检】${instId} 开单后条件单缺失: ${v.missing.map(m => m.kind).join(',') || '无'}，已自动补挂 ${v.repaired} 项${v.errors.length ? '，失败: ' + v.errors.join(';') : ''}`, 'monitor');
          } catch (e) { warn('[okx] 挂单告警推送失败:', e.message); }
        }
      }
    } catch (e) { warn('[okx] 挂单核对异常:', e.message); }
  }
  return {
    ok: res.ok, error: res.error, data: res.data, tpsl,
    meta: { equity, ratio: r, targetNotional: +targetNotional.toFixed(2), notional_actual: +targetNotional.toFixed(2), sz, lotSz, instId, stopUsed: stop, lev }
  };
}

/* ---------- 仓位计算（按金额智能计算开单张数） ----------
 * 返回: { stopDistPct, effStopPct, stopUsed, riskUsd, notional, sz, ctVal }
 * 固定金额模式：notional = fixAmount × mult（金额即名义）
 * 风险百分比模式：notional = equity × riskPct% × mult / effStopPct%
 * 硬性止损：effStopPct = min(策略止损距离, 硬性止损%)，止损价相应收窄
 */
async function calcSize(db, { equity, entry, stop, dir, riskPct = null, mult = null, fixAmount = null, instId = 'BTC-USDT-SWAP' }) {
  const m = mult != null ? mult : getPosMult(db);
  const hardStop = getHardStop(db);
  const fixAmt = fixAmount != null ? fixAmount : getFixAmount(db);
  const stopDistPct = Math.abs(entry - stop) / entry * 100;
  const effStopPct = hardStop > 0 ? Math.min(stopDistPct, hardStop) : stopDistPct; // 2026-08-22 去掉硬止损：hardStop<=0 完全按策略止损
  const stopUsed = dir === 'long' ? entry * (1 - effStopPct / 100) : entry * (1 + effStopPct / 100);
  let riskUsd = null, notional = null;
  if (fixAmt > 0) {
    notional = fixAmt * m;
    riskUsd = notional * effStopPct / 100;
  } else {
    const effRisk = riskPct != null ? riskPct : getRiskPct(db);
    riskUsd = equity * effRisk / 100 * m;
    notional = riskUsd / (effStopPct / 100);
  }
  const inst = await runCli(['market', 'instruments', '--instType', 'SWAP', '--instId', instId]);
  let sz = null, ctVal = 0.01;
  try {
    const arr = Array.isArray(inst.data) ? inst.data : (inst.data.data || []);
    const it = arr.find(x => (x.instId || '') === instId) || arr[0];
    ctVal = Number(it.ctVal) || 0.01;
    sz = Math.max(1, Math.floor(notional / (entry * ctVal)));
  } catch (e) { return { ok: false, error: '合约面值查询失败: ' + e.message }; }
  return { ok: true, stopDistPct: +stopDistPct.toFixed(2), effStopPct: +effStopPct.toFixed(2), stopUsed, riskUsd: riskUsd != null ? +riskUsd.toFixed(2) : null, notional: +notional.toFixed(0), notional_actual: +(sz * entry * ctVal).toFixed(2), sz, ctVal };
}

/* ---------- 账户状态（余额/持仓） ---------- */
// 设置合约杠杆档位（cross；OKX 的 place --lever 参数不生效，必须显式调用）
async function ensureLeverage(instId, lev) {
  const v = Math.max(1, Math.min(125, Number(lev) || 50));
  return runCli(['swap', 'leverage', '--instId', instId, '--lever', String(v), '--mgnMode', 'cross'], 15000);
}
// 价格精度格式化（OKX tick size：高价 1 位小数，低价多位数）
function pxFmt(v) {
  v = Number(v);
  if (!isFinite(v) || v <= 0) return null;
  if (v >= 1000) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(5);
  return v.toFixed(8);
}
// 挂止盈止损（完全复刻虚拟 60/40 方案：TP1 平 60% + TP2 平 40% + SL 全仓，三个独立条件单）
async function attachTPSL(instId, posSide, sz, tp, sl, t2, lotSz) {
  const side = posSide === 'long' ? 'sell' : 'buy';
  // 按合约实际 lot size 取整（BTC/ETH 0.01，但 BNB/XAU 是 1.0！）：60% 向下取整，40% = 剩余
  const lot = Number(lotSz) > 0 ? Number(lotSz) : 0.01;
  const sz60 = (Math.floor(Number(sz) * 0.6 / lot) * lot).toFixed(6);
  const sz40 = (Number(sz) - Number(sz60)).toFixed(6);
  const tp1 = pxFmt(tp), tp2 = pxFmt(t2), slStr = pxFmt(sl);
  const results = [];
  const base = ['--instId', instId, '--side', side, '--posSide', posSide, '--tdMode', 'cross', '--reduceOnly'];
  // 单A：目标1 → 平 60%
  if (tp1) results.push(await runCli(['swap', 'algo', 'place', ...base, '--sz', sz60, '--tpTriggerPx', tp1, '--tpOrdPx=-1'], 20000));
  // 单B：目标2 → 平 40%（若信号有 T2 且不等于 T1）
  if (tp2 && tp2 !== tp1) results.push(await runCli(['swap', 'algo', 'place', ...base, '--sz', sz40, '--tpTriggerPx', tp2, '--tpOrdPx=-1'], 20000));
  // 单C：止损 → 全仓
  if (slStr) results.push(await runCli(['swap', 'algo', 'place', ...base, '--sz', String(sz), '--slTriggerPx', slStr, '--slOrdPx=-1'], 20000));
  const failed = results.filter(r => !r.ok);
  return { ok: failed.length === 0, results, errors: failed.map(r => r.error) };
}
// 挂单止损（保本/移动止损同步用，sz=剩余仓位）
async function attachSL(instId, posSide, sz, sl, lotSz) {
  const side = posSide === 'long' ? 'sell' : 'buy';
  const slStr = pxFmt(sl);
  if (!slStr) return { ok: false, error: '无效止损价' };
  const lot = Number(lotSz) > 0 ? Number(lotSz) : 0.01;
  const szLot = (Math.floor(Number(sz) / lot) * lot).toFixed(6);
  return runCli(['swap', 'algo', 'place', '--instId', instId, '--side', side, '--sz', szLot, '--posSide', posSide, '--tdMode', 'cross', '--reduceOnly', '--slTriggerPx', slStr, '--slOrdPx=-1'], 20000);
}
// 2026-08-25 防复发：核对交易所算法单 TP1/TP2/SL 是否齐全，缺失自动补挂（兜底 attachTPSL 漏挂）
async function verifyAndRepairTpsl(instId, posSide, sz, tp1, tp2, sl, lotSz) {
  const out = { missing: [], repaired: 0, errors: [] };
  const a = await runCli(['swap', 'algo', 'orders', '--instId', instId]);
  const arr = Array.isArray(a.data) ? a.data : ((a.data || {}).data || []);
  const live = arr.filter(o => (o.state === 'live' || o.state === 'effective') && o.posSide === posSide);
  // 精度对齐修复(2026-08-26): DB存原始价(90.5456) vs OKX已舍入价(90.55) 直接比较永远不匹配 → 每轮对账误判缺失重复补挂(84单事故)
  // 统一用 pxFmt 舍入后字符串比较，彻底消除精度错位
  const hasTp = (px) => live.some(o => Number(o.tpTriggerPx || 0) > 0 && pxFmt(Number(o.tpTriggerPx)) === pxFmt(px));
  const hasSl = (px) => live.some(o => Number(o.slTriggerPx || 0) > 0 && pxFmt(Number(o.slTriggerPx)) === pxFmt(px));
  if (tp1 && !hasTp(tp1)) out.missing.push({ kind: 'TP1', px: tp1 });
  if (tp2 && !hasTp(tp2)) out.missing.push({ kind: 'TP2', px: tp2 });
  if (!hasSl(sl)) out.missing.push({ kind: 'SL', px: sl });
  if (!out.missing.length) return out;
  const lot = Number(lotSz) > 0 ? Number(lotSz) : 0.01;
  const sz60 = (Math.floor(Number(sz) * 0.6 / lot) * lot).toFixed(6);
  const sz40 = (Number(sz) - Number(sz60)).toFixed(6);
  const side = posSide === 'long' ? 'sell' : 'buy';
  for (const m of out.missing) {
    const msz = m.kind === 'TP1' ? sz60 : m.kind === 'TP2' ? sz40 : String(sz);
    const r = m.kind === 'SL'
      ? await attachSL(instId, posSide, msz, m.px, lotSz)
      : await runCli(['swap', 'algo', 'place', '--instId', instId, '--side', side, '--posSide', posSide,
          '--tdMode', 'cross', '--reduceOnly', '--sz', msz, '--tpTriggerPx', pxFmt(m.px), '--tpOrdPx=-1'], 20000);
    if (r && r.ok) out.repaired++;
    else out.errors.push(m.kind + ': ' + ((r && r.error) || '挂单失败'));
  }
  return out;
}

// 取消算法单（keepTP=true 时只取消 SL 类，保留 TP 类——保本/移动止损同步用；false 全取消——结算清理用）
async function cancelAlgosByInst(instId, keepTP = true) {
  let n = 0;
  try {
    const a = await runCli(['swap', 'algo', 'orders', '--instId', instId]);
    const arr = Array.isArray(a.data) ? a.data : ((a.data || {}).data || []);
    for (const o of arr) {
      if (o.state === 'live' || o.state === 'effective') {
        const isTP = o.tpTriggerPx || o.tpOrdPx;
        if (keepTP && isTP) continue;   // 保留止盈单（40% 继续搏 T2）
        await runCli(['swap', 'algo', 'cancel', '--instId', instId, '--algoId', o.algoId]);
        n++;
      }
    }
  } catch (e) {}
  return n;
}
async function accountStatus(db) {
  if (!configured()) {
    return {
      ok: true, connected: false,
      note: 'OKX API 未配置（~/.okx/config.toml 不存在），请先运行 okx config init',
      balance: null, positions: [], profile: PROFILE, demo: USE_DEMO
    };
  }
  const bal = await runCli(['account', 'balance']);
  const pos = await runCli(['swap', 'positions']);
  let balance = null, positions = [];
  if (bal.ok && bal.data) {
    try {
      // 顶层数组：每项含 details[]（各币种 eq/eqUsd/availBal/frozenBal）
      // 账户权益口径：只用「能动用的」（availEq/availBal 合计），冻结/质押不计入
      const rows = Array.isArray(bal.data) ? bal.data : (bal.data.data || []);
      let availTotal = 0, eqTotal = 0;
      const details = [];
      for (const r of rows) {
        const ds = r.details || [];
        for (const d of ds) {
          const availEq = Number(d.availEq) || Number(d.availBal) || 0;
          const eqUsd = Number(d.eqUsd) || Number(d.eq) || 0;
          if (eqUsd > 0 || availEq > 0) {
            eqTotal += eqUsd;
            availTotal += availEq;
            details.push({ ccy: d.ccy, eq: d.eq, eqUsd: eqUsd, availEq: availEq, availBal: d.availBal, frozenBal: d.frozenBal });
          }
        }
      }
      // 兼容旧格式（直接顶层 eq）
      if (!eqTotal && rows.length) eqTotal = rows.reduce((s, r) => s + (Number(r.eq) || 0), 0);
      if (!availTotal && rows.length) availTotal = rows.reduce((s, r) => s + (Number(r.availEq) || Number(r.availBal) || 0), 0);
      balance = { totalEq: +eqTotal.toFixed(2), availEq: +availTotal.toFixed(2), rows: details.slice(0, 20) };
    } catch (e) { balance = null; }
  }
  if (pos.ok && pos.data) {
    try {
      positions = (Array.isArray(pos.data) ? pos.data : (pos.data.data || []))
        .filter(p => Number(p.pos) !== 0)
        .map(p => ({
          instId: p.instId, pos: p.pos, posSide: p.posSide,
          avgPx: p.avgPx, upl: p.upl, uplRatio: p.uplRatio,
          lever: p.lever, mgnMode: p.mgnMode, posTime: p.uTime,
          imr: p.imr
        }));
    } catch (e) { positions = []; }
  }
  return { ok: true, connected: true, balance, positions, profile: PROFILE, demo: USE_DEMO, ts: Date.now() };
}

/* ---------- 开仓（市价 + TP/SL 附加单） ----------
 * 参数: { dir, entry, stop, target1, leverage, mult }
 * mult: 仓位倍数（默认 1.0 = 策略 1:1）→ 名义 = 策略名义 × mult
 * 数量: 账户余额 × 4.25% × mult / 止损距离 → 名义 → OKX 张数 */
async function openPosition(db, { dir, entry, stop, target1, leverage = null, mult = null, riskPct = null }) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const st = await accountStatus(db);
  if (!st.connected || !st.balance) return { ok: false, error: '账户状态不可用' };
  const equity = st.balance.availEq != null ? st.balance.availEq : st.balance.totalEq; // 只用可用资金（冻结资金完全忽略）
  const totalEq = equity + (await getFollowMargin(db));                                  // 熔断基线=可用+系统跟单仓保证金
  if (equity < 50) return { ok: false, error: '可用资金不足 50u（当前 ' + equity.toFixed(2) + 'u）——请先从资金账户划转到交易账户', meta: { equity } };
  const lev = leverage != null ? leverage : getLevSetting(db);
  // 反手预处理 + 防重复（方案A·2026-08-26）：同向拒绝，反向先平再开
  const ps = await runCli(['swap', 'positions'], 15000);
  if (ps.ok) {
    const parr = Array.isArray(ps.data) ? ps.data : ((ps.data || {}).data || []);
    const dup = parr.find(p => p.instId === 'BTC-USDT-SWAP' && p.posSide === (dir === 'long' ? 'long' : 'short') && Number(p.pos) !== 0);
    if (dup) return { ok: false, error: '已有同向持仓（' + dup.pos + ' 张），跳过重复开单', meta: { pos: dup.pos } };
  } else {
    warn('[okx] 开单前持仓查询失败（继续开单）:', ps.error || '');
  }
  const flip = await flipPrep(db, 'BTC-USDT-SWAP', dir === 'long' ? 'long' : 'short');
  if (flip.error) return { ok: false, error: '反手预处理失败: ' + flip.error, meta: flip };
  const size = await calcSize(db, { equity, entry, stop, dir, riskPct, mult });
  if (!size.ok) return size;
  const sz = size.sz, stopUsed = size.stopUsed;
  // 先设置杠杆档位（place --lever 不生效，必须显式设置）
  const lr = await ensureLeverage('BTC-USDT-SWAP', lev);
  if (!lr.ok) warn('[okx] 设置杠杆失败: ' + (lr.error || ''));

  const args = ['swap', 'place',
    '--instId', 'BTC-USDT-SWAP',
    '--side', dir === 'long' ? 'buy' : 'sell',
    '--ordType', 'market',
    '--sz', String(sz),
    '--posSide', dir === 'long' ? 'long' : 'short',
    '--tdMode', 'cross',
    '--lever', String(lev)
  ];
  const r = await runCli(args, 30000);
  // 开仓后单独挂 TP/SL（市价单不能带 TP/SL）
  let tpsl = null;
  if (r.ok) {
    tpsl = await attachTPSL('BTC-USDT-SWAP', dir === 'long' ? 'long' : 'short', sz, target1, stopUsed);
    if (!tpsl.ok) warn('[okx] 挂 TP/SL 失败: ' + (tpsl.error || ''));
  }
  return {
    ok: r.ok, error: r.error, data: r.data, tpsl,
    meta: { equity, riskUsd: size.riskUsd, notional: size.notional, notional_actual: size.notional_actual, sz, stopDistPct: size.stopDistPct, effStopPct: size.effStopPct, stopUsed, mult: size.mult || mult || getPosMult(db), riskPct: riskPct || getRiskPct(db), lev }
  };
}

/* ---------- 条件单（OKX 端止损，吊灯/保本同步） ---------- */
async function getAlgoStop(db, instId = 'BTC-USDT-SWAP') {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const r = await runCli(['swap', 'algo', 'orders', '--instId', instId, '--ordType', 'conditional']);
  if (!r.ok) return { ok: false, error: r.error || '查询失败' };
  const arr = Array.isArray(r.data) ? r.data : ((r.data || {}).data || []);
  const algo = arr.find(a => a.slTriggerPx && Number(a.slTriggerPx) > 0);
  if (!algo) return { ok: false, error: '未找到止损条件单' };
  return { ok: true, algoId: algo.algoId, slTriggerPx: Number(algo.slTriggerPx), sz: algo.sz };
}
// 修改 OKX 止损条件单触发价（只向有利方向，调用方判断）
async function amendStop(db, instId, algoId, newSlPx, inst = 'BTC-USDT-SWAP') {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const px = Math.round(newSlPx);
  return runCli(['swap', 'algo', 'amend', '--instId', inst, '--algoId', algoId,
    '--newSlTriggerPx', String(px), '--newSlOrdPx', String(Math.round(px * 0.998))], 20000);
}

/* ---------- 历史平仓记录（OKX 真实成交） ---------- */
async function getHistory(limit = 100, db = null) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  // 交割统计起点：okx:hist_since（2026-08-21 起，旧跟单交割不计入；未设置=全部）
  let since = 0;
  try { if (db) { const row = db.prepare("SELECT value FROM kv WHERE key='okx:hist_since'").get(); if (row) since = Number(row.value) || 0; } } catch (e) {}
  const r = await runCli(['swap', 'orders', '--history'], 30000);
  if (!r.ok) return { ok: false, error: r.error || 'history 查询失败' };
  const arr = Array.isArray(r.data) ? r.data : ((r.data || {}).data || []);
  const closes = arr.filter(o => String(o.reduceOnly) === 'true' && o.state === 'filled')
    .filter(o => !since || (Number(o.fillTime || o.uTime || o.cTime) || 0) >= since)
    .map(o => ({
      instId: o.instId,
      symbol: String(o.instId || '').replace('-USDT-SWAP', ''),
      side: o.side, posSide: o.posSide, ordType: o.ordType,
      sz: Number(o.fillSz != null ? o.fillSz : o.sz) || 0,
      px: Number(o.avgPx || o.fillPx) || 0,
      fee: Number(o.fee) || 0,
      pnl: Number(o.pnl) || 0,
      ts: Number(o.fillTime || o.uTime || o.cTime) || 0,
      lever: Number(o.lever) || 0
    }))
    .filter(x => x.ts > 0)
    .sort((a, b) => b.ts - a.ts);
  const totalPnl = closes.reduce((s2, x) => s2 + x.pnl, 0);
  // 真实交割统计（按 OKX 实际本金口径，与虚拟 signal_track 完全独立）
  const wins = closes.filter(x => x.pnl > 0);
  const losses = closes.filter(x => x.pnl < 0);
  const grossWin = wins.reduce((s2, x) => s2 + x.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s2, x) => s2 + x.pnl, 0));
  let equity = null;
  try {
    const st = db ? await accountStatus(db) : null;
    if (st.connected && st.balance) equity = (Number(st.balance.availEq) != null && Number(st.balance.availEq) > 0) ? Number(st.balance.availEq) : (Number(st.balance.totalEq) || null); // 本金=可用资金（冻结不计）
  } catch (e) {}
  const stats = {
    count: closes.length,
    totalPnl: +totalPnl.toFixed(4),
    wins: wins.length,
    losses: losses.length,
    winRate: closes.length ? +((wins.length / closes.length) * 100).toFixed(1) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? null : null),
    avgPnl: closes.length ? +(totalPnl / closes.length).toFixed(4) : null,
    best: closes.length ? +Math.max(...closes.map(x => x.pnl)).toFixed(4) : null,
    worst: closes.length ? +Math.min(...closes.map(x => x.pnl)).toFixed(4) : null,
    fees: +(closes.reduce((s2, x) => s2 + Math.abs(x.fee), 0)).toFixed(4),
    equity: equity != null ? +equity.toFixed(2) : null,
    roi: (equity && equity > 0) ? +((totalPnl / equity) * 100).toFixed(2) : null
  };
  return { ok: true, count: closes.length, totalPnl: +totalPnl.toFixed(4), stats, list: closes.slice(0, limit) };
}


/* ---------- 反手预处理（方案A·2026-08-26）：开新仓前若存在同品种反方向持仓 → 先市价平旧仓+清条件单 ---------- */
async function flipPrep(db, instId, dir, env = null) {
  const opp = dir === 'long' ? 'short' : 'long';
  const out = { flipped: false, closed: [], algoCanceled: 0, error: null };
  try {
    const ps = await runCli(['swap', 'positions'], 15000);
    if (!ps.ok) { out.error = ps.error || '持仓查询失败'; return out; }
    const parr = Array.isArray(ps.data) ? ps.data : ((ps.data || {}).data || []);
    const oppPos = parr.find(p => p.instId === instId && p.posSide === opp && Number(p.pos) !== 0);
    if (!oppPos) return out; // 无反方向持仓，无需反手
    // 市价平旧仓（含保护名单检查）
    const c = await closePosition(instId, opp);
    const noPos = !c.ok && /51121|51120|无持仓|没有持仓|no position|position.*not exist/i.test(c.error || '');
    if (!c.ok && !noPos) { out.error = '平旧仓失败: ' + (c.error || ''); return out; }
    out.closed.push({ posSide: opp, pos: oppPos.pos, ok: c.ok || noPos, error: c.error });
    // 清残留条件单（全清：旧仓已平，TP/SL 无意义）
    out.algoCanceled = await cancelAlgosByInst(instId, false);
    out.flipped = true;
    info(`[okx] 反手预处理: ${instId} 平掉旧${opp}仓 ${oppPos.pos}张（新方向 ${dir}），清条件单 ${out.algoCanceled} 个`);
    if (env && env.db) {
      try {
        const { pushToGroup } = require('./qqbot');
        await pushToGroup(env, env.db, `🔄【W1 反手】${instId} 检测到旧${opp === 'long' ? '多' : '空'}仓，已先市价平仓 ${oppPos.pos} 张，再开新${dir === 'long' ? '多' : '空'}单`, 'monitor');
      } catch (e) { warn('[okx] 反手推送失败:', e.message); }
    }
  } catch (e) { out.error = e.message; }
  return out;
}

/* ---------- 单仓平仓 ---------- */
async function closePosition(instId = 'BTC-USDT-SWAP', posSide = null) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  if (isProtected(instId)) return { ok: false, error: '该合约为冻结资金持仓（保护名单），系统禁止平仓', protected: true };
  const args = ['swap', 'close', '--instId', instId, '--mgnMode', 'cross'];
  if (posSide) args.push('--posSide', posSide);
  return runCli(args);
}

/* ---------- 一键平仓（全部持仓） ---------- */
async function closeAllPositions(db) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const st = await accountStatus(db);
  if (!st.connected) return { ok: false, error: '账户状态不可用' };
  const posList = (st.positions || []).filter(p => !isProtected(p.instId)); // 跳过冻结资金持仓
  const skipped = (st.positions || []).filter(p => isProtected(p.instId)).map(p => p.instId);
  if (!posList.length) return { ok: true, closed: 0, note: '无持仓', skipped };
  const results = [];
  for (const p of posList) {
    const r = await closePosition(p.instId, p.posSide);
    results.push({ instId: p.instId, ok: r.ok, error: r.error });
  }
  return { ok: results.every(r => r.ok), closed: results.filter(r => r.ok).length, results, skipped };
}

/* ---------- 强制止损（市价平仓离场） ---------- */
async function forceStop(db, instId = 'BTC-USDT-SWAP') {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const r = await closePosition(instId);
  return { ok: r.ok, error: r.error, data: r.data, instId, action: 'force_stop_market_close' };
}

function setAutoOn(db, on) {
  db.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run('okx:auto', on ? '1' : '0');
}

/* 手动仓保护（2026-08-26 William老板指令）：
 * 检测到手动单（非系统跟单所开）→ 不自动反手/不反向开单，跟单信号群推送提示
 * kv: okx:manual_protect 默认 1 = 开启 */
function getManualProtect(db) { return Number(getSetting(db, 'okx:manual_protect', 1) || 1) === 1; }
function setManualProtect(db, v) { return setSetting(db, 'okx:manual_protect', v ? '1' : '0'); }

/* 手动单冲突检测：返回 { conflict, manual, error }
 * 持仓存在且非系统跟单仓（signal_track TIANJI OPEN followed）→ 判定手动单 */
async function manualConflictCheck(db, instId, dir, env = null) {
  const out = { conflict: false, manual: null, error: '' };
  try {
    const ps = await runCli(['swap', 'positions'], 15000);
    if (!ps.ok) return out;
    const parr = Array.isArray(ps.data) ? ps.data : ((ps.data || {}).data || []);
    const up = String(instId).toUpperCase();
    const mine = parr.find(p => String(p.instId || '').toUpperCase() === up && Number(p.pos) !== 0);
    if (!mine) return out;
    // 系统跟单仓判定：signal_track 有该 instId 的 OPEN+followed 记录
    let isSystem = false;
    try {
      const r = db.prepare("SELECT COUNT(*) c FROM signal_track WHERE strategy='TIANJI' AND status='OPEN' AND okx_meta LIKE ? AND okx_meta LIKE '%followed%'")
        .get('%' + up + '%');
      isSystem = r && r.c > 0;
    } catch (e) {}
    if (isSystem) return out; // 系统仓走正常反手/对账逻辑
    const side = String(mine.posSide || '').toLowerCase();
    const posDir = side === 'long' ? 'long' : 'short';
    out.manual = { pos: mine.pos, avgPx: mine.avgPx, posSide: side };
    if (posDir === dir) {
      out.conflict = true;
      out.error = '已有手动同向持仓（' + mine.pos + ' 张），跳过重复开单';
    } else {
      out.conflict = true;
      out.error = '手动仓保护：检测到手动' + (posDir === 'long' ? '多' : '空') + '单（' + mine.pos + ' 张），已拒绝自动反手，请手动处理';
      if (env && env.db) {
        try {
          const { pushToGroup } = require('./qqbot');
          await pushToGroup(env, env.db,
            '🛡️【手动仓保护】' + instId + ' 检测到手动' + (posDir === 'long' ? '多' : '空') + '单（' + mine.pos + ' 张，均价 ' + (mine.avgPx || '-') + '），SmartSignal 拟开' + (dir === 'long' ? '多' : '空') + '单 → 已跳过自动反手/开仓，请确认如何处理',
            'signal');
        } catch (e) { warn('[okx] 手动仓保护推送失败:', e.message); }
      }
    }
  } catch (e) { out.error = '手动仓保护检查异常: ' + e.message; }
  return out;
}
function getAutoOn(db) {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get('okx:auto');
  return !!(row && row.value === '1');
}

/* ---------- 结算清理：市价平掉指定合约仓位 + 取消其 algo 单（超时/回撤保护/方向翻转用） ---------- */
async function closeAndClean(instId) {
  if (isProtected(instId)) return { closed: [], algoCanceled: 0, skippedAlgo: false, protected: true, note: '冻结资金持仓，跳过' };
  const out = { closed: [], algoCanceled: 0, skippedAlgo: false };
  let allClosed = true;
  try {
    const ps = await runCli(['swap', 'positions']);
    const parr = Array.isArray(ps.data) ? ps.data : ((ps.data || {}).data || []);
    const mine = parr.filter(p => p.instId === instId && Number(p.pos) !== 0);
    for (const p of mine) {
      const r = await closePosition(instId, p.posSide);
      // 无持仓类错误视为已平仓成功（目标达成），其余失败保留 algo 止损保护
      const noPos = !r.ok && /51121|51120|无持仓|没有持仓|no position|position.*not exist/i.test(r.error || '');
      out.closed.push({ posSide: p.posSide, ok: r.ok || noPos, error: r.error });
      if (!r.ok && !noPos) allClosed = false;
    }
  } catch (e) { allClosed = false; out.err = e.message; }
  if (allClosed) {
    try {
      const a = await runCli(['swap', 'algo', 'orders', '--instId', instId]);
      const arr = Array.isArray(a.data) ? a.data : ((a.data || {}).data || []);
      for (const o of arr) {
        if (o.state === 'live' || o.state === 'effective') {
          await runCli(['swap', 'algo', 'cancel', '--instId', instId, '--algoId', o.algoId]);
          out.algoCanceled++;
        }
      }
    } catch (e) {}
  } else {
    out.skippedAlgo = true; // 平仓未全部成功 → 保留交易所侧止损，仓位不裸露
  }
  return out;
}

module.exports = { accountStatus, openPosition, openPositionLimit, closePosition, closeAllPositions, forceStop, getHistory, getPosMult, setPosMult, setAutoOn, getAutoOn, getManualProtect, setManualProtect, manualConflictCheck, configured, RISK_PCT, getAlgoStop, amendStop, calcSize, getRiskPct, setRiskPct, getFixAmount, setFixAmount, getHardStop, setHardStop, getLevSetting, setLevSetting, getFollowRatio, setFollowRatio, followSignal, ensureLeverage, attachTPSL, attachSL, cancelAlgosByInst, verifyAndRepairTpsl, getMaxLev, setMaxLev, getDdScale, getDdLevOn, totalNotional, getFollowMargin, getFollowUpl, getFollowPosCount, reconcileFollowedPositions, closeAndClean, flipPrep };

/* ---------- 限价入场（最优限价 + 成交轮询 + 市价兜底） ----------
 * 与 openPosition 同尺寸逻辑，但：
 *   - 挂限价单（limitPx 由策略给出：触发位/盘口最优价）
 *   - 轮询成交状态（默认 40s，每 4s 一次）
 *   - 未成交 → 撤单 + 市价兜底（防错过信号）
 *   - 撤单与市价之间竞态：若限价已成交则不再开市价（防双开）
 */
async function openPositionLimit(db, { dir, entry, stop, target1, leverage = null, mult = null, riskPct = null, limitPx = null, pollMs = 40000, pollEvery = 4000, fallback = true }) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const st = await accountStatus(db);
  if (!st.connected || !st.balance) return { ok: false, error: '账户状态不可用' };
  const equity = st.balance.availEq != null ? st.balance.availEq : st.balance.totalEq; // 只用可用资金（冻结资金完全忽略）
  const totalEq = equity + (await getFollowMargin(db));                                  // 熔断基线=可用+系统跟单仓保证金
  if (equity < 50) return { ok: false, error: '可用资金不足 50u（当前 ' + equity.toFixed(2) + 'u）', meta: { equity } };
  // 反手预处理 + 防重复（方案A·2026-08-26）：同向拒绝，反向先平再开
  const ps = await runCli(['swap', 'positions'], 15000);
  if (ps.ok) {
    const parr = Array.isArray(ps.data) ? ps.data : ((ps.data || {}).data || []);
    const dup = parr.find(p => p.instId === 'BTC-USDT-SWAP' && p.posSide === dir && Number(p.pos) !== 0);
    if (dup) return { ok: false, error: '已有同向持仓（' + dup.pos + ' 张），跳过重复开单', meta: { pos: dup.pos } };
  } else {
    warn('[okx] 限价开单前持仓查询失败（继续开单）:', ps.error || '');
  }
  const flip = await flipPrep(db, 'BTC-USDT-SWAP', dir);
  if (flip.error) return { ok: false, error: '反手预处理失败: ' + flip.error, meta: flip };
  const lev = Math.min(leverage != null ? leverage : getLevSetting(db), Math.floor(100 / (Math.abs(entry - stop) / entry * 100 * 1.3) * 10) / 10);
  const size = await calcSize(db, { equity, entry, stop, dir, riskPct, mult });
  if (!size.ok) return size;
  const sz = size.sz, stopUsed = size.stopUsed;
  // 先设置杠杆档位（place --lever 不生效，必须显式设置）
  const lr = await ensureLeverage('BTC-USDT-SWAP', lev);
  if (!lr.ok) warn('[okx] 设置杠杆失败: ' + (lr.error || ''));
  // 限价钳制：OKX 要求 多单 SL<限价<TP，空单 TP<限价<SL。越界则回退到信号价
  let px = limitPx != null ? Math.round(limitPx) : Math.round(entry);
  const t1v = Math.round(target1), slv = Math.round(stopUsed);
  if (dir === 'long') { if (!(px > slv && px < t1v)) px = Math.round(entry); }
  else { if (!(px < slv && px > t1v)) px = Math.round(entry); }
  if (px === Math.round(entry) && limitPx != null && Math.round(limitPx) !== Math.round(entry)) {
    // 仍可能越界（entry 本身在 SL/TP 外）→ 强制收敛
    if (dir === 'long') px = Math.min(Math.max(Math.round(entry), slv + 1), t1v - 1);
    else px = Math.max(Math.min(Math.round(entry), slv - 1), t1v + 1);
    if (px <= 0) px = Math.round(entry);
  }
  const side = dir === 'long' ? 'buy' : 'sell';
  const baseArgs = ['swap', 'place', '--instId', 'BTC-USDT-SWAP', '--side', side, '--sz', String(sz),
    '--posSide', dir, '--tdMode', 'cross', '--lever', String(lev)];
  const meta = { equity, riskUsd: size.riskUsd, notional: size.notional, notional_actual: size.notional_actual, sz, stopDistPct: size.stopDistPct, effStopPct: size.effStopPct, stopUsed, mult: mult || getPosMult(db), riskPct: riskPct || getRiskPct(db), lev, limitPx: px };
  // 成交后挂 TP/SL（市价单不能带 TP/SL）
  const attachAfter = async () => {
    const at = await attachTPSL('BTC-USDT-SWAP', dir, sz, target1, stopUsed);
    if (!at.ok) warn('[okx] 限价开单挂 TP/SL 失败: ' + (at.error || ''));
    return at;
  };

  // 1) 挂限价
  const r = await runCli([...baseArgs, '--ordType', 'limit', '--px', String(px)], 30000);
  if (!r.ok) return r;
  const ordId = r.data[0].ordId;
  // 2) 轮询成交
  const t0 = Date.now();
  let o = null;
  while (Date.now() - t0 < pollMs) {
    await new Promise(res => setTimeout(res, pollEvery));
    try {
      const st2 = await runCli(['swap', 'orders', '--instId', 'BTC-USDT-SWAP']);
      const arr = Array.isArray(st2.data) ? st2.data : ((st2.data || {}).data || []);
      o = arr.find(x => x.ordId === ordId);
    } catch (e) {}
    if (!o) {
      // 订单从 open orders 消失：查历史确认是否已成交（防已成交却市价兜底 = 双开）
      try {
        const h = await runCli(['swap', 'orders', '--instId', 'BTC-USDT-SWAP', '--history']);
        const harr = Array.isArray(h.data) ? h.data : ((h.data || {}).data || []);
        o = harr.find(x => x.ordId === ordId);
      } catch (e) {}
      if (o && (o.state === 'filled' || o.state === 'partially_filled')) {
        const fillPx = Number(o.avgPx) || Number(o.fillPx) || px;
        const at = await attachAfter();
        return { ok: true, filled: true, ordId, avgPx: fillPx, mode: 'limit', tpsl: at, meta: Object.assign({}, meta, { avgPx: fillPx }) };
      }
      if (!o) o = { state: 'gone' };   // 历史也查不到 → 视为未成交，走撤单+兜底
    }
    if (o.state === 'filled' || o.state === 'partially_filled') {
      const fillPx = Number(o.avgPx) || Number(o.fillPx) || px;
      const at = await attachAfter();
      return { ok: true, filled: true, ordId, avgPx: fillPx, mode: 'limit', tpsl: at, meta: Object.assign({}, meta, { avgPx: fillPx }) };
    }
    if (o.state === 'canceled' || o.state === 'gone') break;
  }
  // 3) 撤单 + 查持仓（防竞态双开）
  try { await runCli(['swap', 'cancel', 'BTC-USDT-SWAP', '--ordId', ordId]); } catch (e) {}
  try {
    const ps = await runCli(['swap', 'positions']);
    const parr = Array.isArray(ps.data) ? ps.data : ((ps.data || {}).data || []);
    const mine = parr.find(x => x.posSide === dir && Number(x.pos) !== 0);
    if (mine) {
      const at = await attachAfter();
      return { ok: true, filled: true, ordId, avgPx: +mine.avgPx, mode: 'limit_race', tpsl: at, meta: Object.assign({}, meta, { avgPx: +mine.avgPx }) };
    }
  } catch (e) {}
  if (!fallback) return { ok: true, filled: false, ordId, mode: 'limit_canceled_no_fallback', meta };
  // 4) 市价兜底
  const rm = await runCli([...baseArgs, '--ordType', 'market'], 30000);
  if (!rm.ok) return rm;
  const at2 = await attachAfter();
  return { ok: true, filled: true, mode: 'market_fallback', ordId: rm.data[0].ordId, avgPx: null, tpsl: at2, meta };
}
