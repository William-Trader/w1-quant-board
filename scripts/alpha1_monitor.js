#!/usr/bin/env node
// α1 实盘开单/平仓独立监控 → QQ 私聊主动推送 (2026-08-12)
// 用法: node scripts/alpha1_monitor.js [--test]
// cron: * * * * * cd /home/ubuntu/w1-board && node scripts/alpha1_monitor.js >> /tmp/alpha1_monitor.log 2>&1
const { loadEnv } = require('../lib/env');
const { getAccessToken } = require('../lib/qqbot');
const Database = require('better-sqlite3');

const env = loadEnv();
const wdb = new Database('/home/ubuntu/w1-board/data/w1.db');
const USER_OPENID = (env.QQ_C2C_OPENID || '').trim();
const STRAT = 'ALPHA1';
const KV_KEY = 'alpha1:notified_id';

async function sendC2C(content) {
  if (!USER_OPENID) { console.log('[monitor] QQ_C2C_OPENID 未配置，跳过推送'); return 0; }
  const token = await getAccessToken(env);
  const r = await fetch(`https://api.sgroup.qq.com/v2/users/${USER_OPENID}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, msg_type: 0 })
  });
  return r.status;
}

function fmtNum(x) { return x == null ? '-' : Number(x).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }

function buildOpenMsg(r) {
  const dir = r.direction === 'long' ? '📈 做多 LONG' : '📉 做空 SHORT';
  const mode = (r.reason || '?').split(':')[0];
  const ts = new Date(r.pushed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const stopPct = r.entry ? Math.abs(r.entry - r.stop) / r.entry * 100 : null;
  const rr = (r.entry && r.stop) ? Math.abs(r.target1 - r.entry) / Math.max(Math.abs(r.entry - r.stop), 0.01) : null;
  const lines = [
    `🟢【α1 实盘开单】${ts}`,
    `──────────────`,
    `${dir}（${mode} 模式）`,
    `🌐 体制：${r.regime || '-'}`,
    `💵 入场：${fmtNum(r.entry)}`,
    `🛑 止损：${fmtNum(r.stop)}${stopPct ? `（${stopPct.toFixed(2)}%）` : ''}`,
    `🎯 止盈：${fmtNum(r.target1)}${rr ? `（${rr.toFixed(2)}R）` : ''}`,
    `⚙️ 杠杆：${r.leverage != null ? r.leverage + 'x' : '-'}`,
    `📦 名义：$${fmtNum(r.notional_usd)}`,
    `⚠️ 风险：$${fmtNum(r.risk_usd)}`,
    `──────────────`,
    `⏱ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 独立监控推送`
  ];
  return lines.join('\n');
}

function buildCloseMsg(r) {
  const dir = r.direction === 'long' ? '多单' : '空单';
  const res = r.status === 'WIN' ? '✅ 止盈平仓' : '❌ 止损平仓';
  const ts = new Date(r.resolved_at || r.pushed_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const lines = [
    `${res}【α1 实盘】${ts}`,
    `──────────────`,
    `📌 ${dir} | 原因：${r.exit_reason || r.reason || '-'}`,
    `💵 入场：${fmtNum(r.entry)}`,
    `🏁 离场：${fmtNum(r.exit_reason === 'stop' ? r.stop : r.target1)}`,
    `💰 盈亏：${r.pnl_pct != null ? r.pnl_pct.toFixed(2) + '%' : '-'}`,
    `──────────────`,
    `⏱ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 独立监控推送`
  ];
  return lines.join('\n');
}

async function main() {
  const isTest = process.argv.includes('--test');
  if (isTest) {
    const st = await sendC2C('🔔【监控通道测试】α1 开单私聊通知已就绪 ✅\n后续实盘开单/平仓将在此推送。');
    console.log(`[monitor] 测试推送 HTTP ${st}`);
    return;
  }

  // 上次已通知的最大 id
  let lastId = 0;
  try { const kv = wdb.prepare("SELECT value FROM kv WHERE key=?").get(KV_KEY); lastId = kv ? Number(kv.value) : 0; } catch (e) {}

  const rows = wdb.prepare("SELECT * FROM signal_track WHERE strategy=? AND id>? ORDER BY id ASC").all(STRAT, lastId);
  if (!rows.length) { wdb.close(); return; }

  for (const r of rows) {
    const msg = r.status === 'OPEN' ? buildOpenMsg(r) : buildCloseMsg(r);
    let st = 0;
    try { st = await sendC2C(msg); } catch (e) { console.error('[monitor] 推送异常:', e.message); }
    console.log(`[monitor] #${r.id} ${r.status} ${r.direction} 推送 HTTP ${st}`);
    if (st >= 200 && st < 300) {
      wdb.prepare("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)").run(KV_KEY, String(r.id));
    } else {
      console.error(`[monitor] #${r.id} 推送失败 HTTP ${st}，下次重试`); break;
    }
  }
  wdb.close();
}

main().catch(e => { console.error('[monitor] 异常:', e.message); process.exit(1); });
