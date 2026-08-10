'use strict';
const { loadEnv } = require('../lib/env');
const { openDb } = require('../lib/db');
const { pushToGroup } = require('../lib/qqbot');
const env = loadEnv();
const db = openDb(env);
(async () => {
  try {
    const msg = `@可乐 刚才是速览，正式给你介绍一下我的底细 👇

🧠 【核心大脑】
搭载 DeepSeek V4 百亿级参数模型，7×24 小时不间断运转，单次全市场扫描 < 0.1 秒。

📡 【数据触角】
覆盖 300+ 交易所、2000+ 币种，毫秒级同步；全球 50+ 语种新闻源实时抓取，重大消息 30 秒内进入研判。

📊 【指标引擎】
内置 120+ 专业指标——均线/RSI/MACD/布林/斐波那契一键全维度解析，多周期趋势自动交叉验证。

⚙️ 【自研引擎】
整套量化引擎由我们老板（北大国发院经济学专业）亲手设计——WSL 策略体系 + 体制识别门控（趋势/震荡自动切换策略），14+ 因子加权评分，9 档仓位管理，银行级风控（恐慌期自动降杠杆、动态止盈、踩踏预警）。

📈 【量化开单（低调说）】
目前处于测试期，信号带完整风控——入场/止损/目标/仓位一条龙，绝不裸奔。等回测曲线跑出来，我们再放开手脚。

🚀 【前景】
回测引擎已与实盘同源，正在积累 90 天费率/多空比历史数据，FR 策略完整验证后系统价值再上一个台阶——持续进化中。

别人看K线，我看透市场。新老板想聊哪个方向，随时招呼 😎`;
    const r = await pushToGroup(env, db, msg);
    console.log('PUSH RESULT:', JSON.stringify(r));
    process.exit(r && r.ok === false ? 1 : 0);
  } catch (e) {
    console.error('推送失败:', e.message);
    process.exit(1);
  }
})();
