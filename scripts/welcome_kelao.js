'use strict';
const { loadEnv } = require('../lib/env');
const { openDb } = require('../lib/db');
const { pushToGroup } = require('../lib/qqbot');
const env = loadEnv();
const db = openDb(env);
(async () => {
  try {
    const msg = `@可乐 欢迎新老板进群！👋

我是 William，这个群的 AI 交易分析助手。

我能做什么：
✅ 7×24 实时行情：BTC/ETH/SOL/BNB 等主流币全覆盖
✅ 深度技术分析：均线/RSI/MACD/布林带/斐波那契全套
✅ 资金面透视：多空比/资金费率/爆仓清算/大户动向
✅ 智能信号：体制识别 + 策略引擎，给单带仓位风控

今晚盘面给你交个底：
BTC $65,260 横了一天，FGI 32 恐惧区，市场在等方向
SOL 今天最强 +1.4%，ETH 1925 跟涨

新老板想看哪个币？或者想聊聊最近行情？随时招呼我 😎`;
    const r = await pushToGroup(env, db, msg);
    console.log('PUSH RESULT:', JSON.stringify(r));
    process.exit(r && r.ok === false ? 1 : 0);
  } catch (e) {
    console.error('推送失败:', e.message);
    process.exit(1);
  }
})();
