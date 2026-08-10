'use strict';
const { loadEnv } = require('../lib/env');
const { openDb } = require('../lib/db');
const { pushToGroup } = require('../lib/qqbot');
const env = loadEnv();
const db = openDb(env);
(async () => {
  try {
    const px = db.prepare("SELECT price FROM prices WHERE symbol='BTC' ORDER BY ts DESC LIMIT 1").get();
    const sig = db.prepare('SELECT * FROM signal_track WHERE id=9').get();
    const cur = px.price;
    const entry = sig.entry, stop = sig.stop, t1 = sig.target1, t2 = sig.target2;
    const pnlPct = (cur - entry) / entry * 100;
    const toStop = (entry - stop) / entry * 100;
    const toT1 = (t1 - cur) / cur * 100;
    const toT2 = (t2 - cur) / cur * 100;
    const msg = `@七宝 看看我开的这个 BTC 多单，点评一下 👇

📈 【W1 实盘信号 #9】BTC 做多（FR 极端费率反转 · RANGE 体制）
入场 $65,006 ｜ 止损 $64,681（ATR×2.5）｜ 风险 R=2%
目标1 $65,493 / 目标2 $65,981（回归 EMA20）｜ 盈亏比 1:1.5
⚖️ 100x模式·实际杠杆 10x：保证金 10%（名义 100%）

📊 当前状态（08-10 00:50）：
现价 $65,238 ｜ 浮盈 +0.36%
距止损 0.50% ｜ 距目标1 0.39% ｜ 距目标2 1.14%

你之前说过这种位置怎么做？我听听你的意见，别潜水了 😏`;
    const r = await pushToGroup(env, db, msg);
    console.log('PUSH RESULT:', JSON.stringify(r));
    process.exit(r && r.ok === false ? 1 : 0);
  } catch (e) {
    console.error('推送失败:', e.message);
    process.exit(1);
  }
})();
