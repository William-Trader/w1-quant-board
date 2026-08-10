#!/usr/bin/env node
/**
 * 8/14 窗口到期自动结算 —— 第十场盲测（7/31 谨慎看空 3%×100x）
 * 每天 00:10 触发：8/14 收盘数据到位则结算并自删 cron；否则静默等下次
 */
const fs = require('fs');
const { execSync } = require('child_process');
const DB = '/home/ubuntu/btc-oracle/backtest/hist.db';
const FILES = [
  '/home/ubuntu/w1-board/data/experience_blind.json',
  '/home/ubuntu/w1-board/public/experience.json'
];

function priceAt(dstr) {
  try {
    const sql = `SELECT c FROM klines WHERE symbol='BTCUSDT' AND date(ts/1000,'unixepoch','+8 hours')='${dstr}' ORDER BY ts DESC LIMIT 1`;
    const out = execSync(`sqlite3 "${DB}" "${sql}"`, { timeout: 15000 }).toString().trim();
    return out ? parseFloat(out) : null;
  } catch (e) { return null; }
}

function settle() {
  const p0 = priceAt('2026-07-31');
  const p14 = priceAt('2026-08-14');
  if (!p0 || !p14) { console.log(`[settle] ${new Date().toISOString()} 8/14 收盘未到 (p0=${p0}, p14=${p14})，等待下次`); return false; }
  const chg14 = Math.round((p14 / p0 - 1) * 1000) / 10;   // 百分比，1位小数
  const hit = chg14 < 0;                                   // short_mild: 14日收跌=命中
  const pnl = Math.round(3 * 100 * (-1) * (chg14 / 100) * 100); // 3% × 100x × 空单
  console.log(`[settle] ${new Date().toISOString()} p0=${p0} p14=${p14} chg14=${chg14}% hit=${hit} pnl=${pnl}u`);

  for (const f of FILES) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = d.results.find(x => x.date === '2026-07-31');
    if (!r) { console.log(`[settle] ${f} 找不到 7/31 场次`); continue; }
    r.p14 = Math.round(p14);
    r.chg14 = chg14;
    r.chg30 = null; r.p30 = null;
    r.hit = hit;
    r.status = hit ? '✅ 命中' : '❌ 未中';
    r.pnl = pnl;
    // 重算 summary
    const s = d.summary;
    s.ledger[s.ledger.length-1] = pnl;  // 7/31 现在位于第20场（索引19）
    s.total_pnl = s.ledger.reduce((a, b) => a + b, 0);
    s.pending = 0;
    s.wins = d.results.filter(x => x.hit === true).length;
    s.acc = Math.round(s.wins / Math.max(1, d.results.length - s.pending) * 100);
    delete s.mid; // 实时跟踪块已结算，移除
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
    console.log(`[settle] ${f} 已更新 → 命中 ${s.wins}/${d.results.length} (${s.acc}%) | 账本 ${s.total_pnl>0?'+':''}${s.total_pnl}u`);
  }
  return true;
}

function removeCron() {
  try {
    const cur = execSync('crontab -l', { timeout: 10000 }).toString();
    const next = cur.split('\n').filter(l => !l.includes('settle_1031.js')).join('\n');
    execSync(`crontab - <<'EOF'\n${next}\nEOF`, { timeout: 10000 });
    console.log('[settle] cron 已自删');
  } catch (e) { console.log('[settle] cron 自删失败:', e.message); }
}

if (settle()) removeCron();
