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

const OKX_CLI = process.env.OKX_CLI || 'okx';
// 默认走 live 实盘（config.toml 有 live/demo 双 profile，OKX_PROFILE 可切换）
const PROFILE = process.env.OKX_PROFILE || 'live';
const USE_DEMO = String(process.env.OKX_DEMO || '0') === '1';
const RISK_PCT = 4.25; // 与 dir_prod 锁定参数一致

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
        const msg = (stderr || '').trim().split('\n').pop() || err.message;
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

/* ---------- 账户状态（余额/持仓） ---------- */
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
          lever: p.lever, mgnMode: p.mgnMode, posTime: p.uTime
        }));
    } catch (e) { positions = []; }
  }
  return { ok: true, connected: true, balance, positions, profile: PROFILE, demo: USE_DEMO, ts: Date.now() };
}

/* ---------- 开仓（市价 + TP/SL 附加单） ----------
 * 参数: { dir, entry, stop, target1, leverage, mult }
 * mult: 仓位倍数（默认 1.0 = 策略 1:1）→ 名义 = 策略名义 × mult
 * 数量: 账户余额 × 4.25% × mult / 止损距离 → 名义 → OKX 张数 */
async function openPosition(db, { dir, entry, stop, target1, leverage = 50, mult = null }) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const m = mult != null ? mult : getPosMult(db);
  const st = await accountStatus(db);
  if (!st.connected || !st.balance) return { ok: false, error: '账户状态不可用' };
  const equity = st.balance.availEq != null ? st.balance.availEq : st.balance.totalEq; // 只用可用资金
  if (equity < 50) return { ok: false, error: '可用资金不足 50u（当前 ' + equity.toFixed(2) + 'u）——请先从资金账户划转到交易账户', meta: { equity } };
  const stopDistPct = Math.abs(entry - stop) / entry * 100;
  const riskUsd = equity * RISK_PCT / 100 * m;
  const notional = riskUsd / (stopDistPct / 100);
  const inst = await runCli(['market', 'instruments', '--instType', 'SWAP', '--instId', 'BTC-USDT-SWAP']);
  let sz = null;
  try {
    const arr = Array.isArray(inst.data) ? inst.data : (inst.data.data || []);
    const it = arr.find(x => (x.instId || '').includes('BTC-USDT-SWAP')) || arr[0];
    const ctVal = Number(it.ctVal) || 0.01;
    const contracts = Math.floor(notional / (entry * ctVal));
    sz = Math.max(1, contracts);
  } catch (e) { return { ok: false, error: '合约面值查询失败: ' + e.message }; }

  const args = ['swap', 'place',
    '--instId', 'BTC-USDT-SWAP',
    '--side', dir === 'long' ? 'buy' : 'sell',
    '--ordType', 'market',
    '--sz', String(sz),
    '--posSide', dir === 'long' ? 'long' : 'short',
    '--tdMode', 'cross',
    '--lever', String(leverage),
    '--tpTriggerPx', String(Math.round(target1)),
    '--tpOrdPx', String(Math.round(target1 * 0.999)),
    '--slTriggerPx', String(Math.round(stop)),
    '--slOrdPx', String(Math.round(stop * 0.998))
  ];
  const r = await runCli(args, 30000);
  return {
    ok: r.ok, error: r.error, data: r.data,
    meta: { equity, riskUsd: +riskUsd.toFixed(2), notional: +notional.toFixed(0), sz, stopDistPct: +stopDistPct.toFixed(2), mult: m }
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

/* ---------- 单仓平仓 ---------- */
async function closePosition(instId = 'BTC-USDT-SWAP', posSide = null) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const args = ['swap', 'close', '--instId', instId, '--mgnMode', 'cross'];
  if (posSide) args.push('--posSide', posSide);
  return runCli(args);
}

/* ---------- 一键平仓（全部持仓） ---------- */
async function closeAllPositions(db) {
  if (!configured()) return { ok: false, error: 'OKX 未配置' };
  const st = await accountStatus(db);
  if (!st.connected) return { ok: false, error: '账户状态不可用' };
  const posList = st.positions || [];
  if (!posList.length) return { ok: true, closed: 0, note: '无持仓' };
  const results = [];
  for (const p of posList) {
    const r = await closePosition(p.instId, p.posSide);
    results.push({ instId: p.instId, ok: r.ok, error: r.error });
  }
  return { ok: results.every(r => r.ok), closed: results.filter(r => r.ok).length, results };
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
function getAutoOn(db) {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get('okx:auto');
  return !!(row && row.value === '1');
}
module.exports = { accountStatus, openPosition, closePosition, closeAllPositions, forceStop, getPosMult, setPosMult, setAutoOn, getAutoOn, configured, RISK_PCT, getAlgoStop, amendStop };
