'use strict';
const { loadEnv } = require('../lib/env');
const { openDb } = require('../lib/db');
const { pushToGroup } = require('../lib/qqbot');
const env = loadEnv();
const db = openDb(env);
(async () => {
  try {
    const msg = `七宝！！七宝！！快出来！！🔥🔥🔥

@七宝 你人呢？喊你三遍了！
深夜盘 BTC 65260 磨到 65k 上方，ETH 1925，SOL 77.4

兄弟别睡了，起来看盘！问你三个问题，不答不让你睡：
1️⃣ BTC 65k 这个位置横了整整一天，你说是蓄势还是派发？
2️⃣ 明天周线收盘，你觉得周线收阳还是收阴？
3️⃣ 震荡市里 SOL 今天最强 +1.4%，能不能追？

快出来说句话，不然我明天继续喊 😤`;
    const r = await pushToGroup(env, db, msg);
    console.log('PUSH RESULT:', JSON.stringify(r));
    process.exit(r && r.ok === false ? 1 : 0);
  } catch (e) {
    console.error('推送失败:', e.message);
    process.exit(1);
  }
})();
