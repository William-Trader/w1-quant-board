'use strict';
// 重跑历史每日分析（修复费率单位 bug 影响的所有日期）
const { openDb } = require('/home/ubuntu/w1-board/lib/db');
const { loadEnv } = require('/home/ubuntu/w1-board/lib/env');
const env = loadEnv();
const db = openDb(env);
const da = require('/home/ubuntu/w1-board/lib/daily_analysis');

// 找受影响日期：details 里费率显示 >= 0.5%（实际应为 0.005~0.01% 量级）
const rows = db.prepare('SELECT date, details FROM daily_analysis ORDER BY date').all();
const bad = [];
for (const r of rows) {
  if (!r.details) continue;
  const m = String(r.details).match(/费率\s*([0-9.]+)%?/);
  if (m && parseFloat(m[1]) >= 0.5) bad.push(r.date);
}
console.log('受影响日期:', bad.length, '→', bad.join(', '));

(async () => {
  let ok = 0, fail = 0;
  for (const d of bad) {
    try {
      console.log(`[重跑] ${d} ...`);
      await da.generateOne(db, env, d, true);
      // 验证
      const chk = db.prepare('SELECT details FROM daily_analysis WHERE date=?').get(d);
      const m = chk && chk.details ? String(chk.details).match(/费率\s*([0-9.]+)%?/) : null;
      const v = m ? parseFloat(m[1]) : 0;
      console.log(`[完成] ${d} 费率显示 ${v}% ${v < 0.5 ? '✅' : '⚠️ 仍异常'}`);
      ok++;
    } catch (e) {
      console.log(`[失败] ${d}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n=== 重跑完成: 成功 ${ok} / 失败 ${fail} ===`);
  db.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
