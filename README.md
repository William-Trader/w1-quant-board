# W1 量化看板 · William Quant Board

专业级加密货币量化分析与给单引擎。技术面 + 资金面 + 消息面三引擎交叉验证，WSL 表达式驱动策略，实盘/回测同引擎。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入真实密钥
npm start              # 启动服务 (:3300)
npm test               # 跑自动化测试（node --test tests/）
npm run smoke           # 信号引擎 smoke test（7 用例）
node scripts/health_check.js      # 系统健康检查（PM2/API/实盘心跳/磁盘，异常推群）
```

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                      server.js (:3300)                  │
│   express + nginx 80→3300 反代 + pm2 (w1-board)          │
├──────────────┬──────────────────────────────────────────┤
│  采集层       │  lib/collectors.js                       │
│  node-cron   │  gate现货60s / coinglass 5min / LSR 5min  │
│              │  KOL共识10min / FGI 30min / 新闻/清算      │
├──────────────┼──────────────────────────────────────────┤
│  分析层       │  lib/verdict.js / market_analyzer.js     │
│              │  daily_analysis.js / macro_alert.js       │
├──────────────┼──────────────────────────────────────────┤
│  决策层       │  lib/engine.js (给单引擎主循环)            │
│              │  scripts/alpha1_live.js ★当前实盘(15m)  │
│              │  ├─ lib/regime.js    体制分类 TREND/RANGE │
│              │  ├─ lib/evalctx.js   WSL 求值上下文+FN    │
│              │  ├─ lib/indicators.js 指标库(纯函数)      │
│              │  ├─ lib/kline.js     K线获取+30min缓存    │
│              │  ├─ lib/risk.js      风控(冷却/熔断/事件)  │
│              │  └─ lib/wsl.js       WSL 表达式解析器     │
│              └─ strategies/*.yaml   策略配置(FR/ST)      │
├──────────────┼──────────────────────────────────────────┤
│  验证层       │  lib/backtest_wsl.js 同引擎回测          │
│              │  tests/*.test.js      31 回归测试         │
│              │  scripts/ci-test.js   CI 守护(cron)       │
├──────────────┼──────────────────────────────────────────┤
│  存储层       │  data/w1.db (SQLite WAL)                │
│              │  schema_version 版本化迁移                │
├──────────────┼──────────────────────────────────────────┤
│  输出层       │  public/index.html 看板 / lib/qqbot.js   │
│              │  QQ 群推送 (pushToGroup)                  │
└──────────────┴──────────────────────────────────────────┘
```

## 核心模块职责

| 模块 | 职责 |
|------|------|
| `lib/engine.js` | 主循环：体制门控 → 策略求值 → 风控 → 推送 → 出场引擎 |
| `lib/wsl.js` | WSL 表达式语言（tokenize/parse/evaluate），策略逻辑可配置化 |
| `lib/evalctx.js` | 求值上下文 + FN 函数库（ema/rsi/atr/highest/ref/cross 等 20+） |
| `lib/backtest_wsl.js` | 回测引擎，复用 buildCtx/FN/dirFixAst，出场与 runExits 对齐 |
| `lib/regime.js` | ADX + 布林带宽 + 波动率分位 → TREND/RANGE/STORM/OFF |
| `lib/risk.js` | 冷却、日限、日亏熔断、事件风控、策略熔断 |
| `lib/indicators.js` | ema/sma/rsi/atr/adx/zscore 纯函数指标库 |

## 策略体系（WSL DSL + YAML）

- **ST 趋势回调追踪**（`strategies/st_evo.wsl.yaml`，TREND 体制专用）
  日线定方向 → 1h 回调入场 → 1R 半仓+保本 → 吊灯追踪 → 趋势破坏离场
- **FR 极端费率反转**（`strategies/funding_reversal.wsl.yaml`，RANGE 体制专用）
  散户仓位极端拥挤 → 均值回归，funding_z30 + RSI 极端 + LSR 确认

策略逻辑全在 YAML，改策略不改代码：

```yaml
entry:
  long: >
    close_1d > ema(50,'1d') and ema(20,'1d') > ema(50,'1d')
    and adx(14,'1d') >= 22
    and abs(close - ema(20,'1h')) <= 0.5 * atr(14,'1h')
```

## 给单链路（一次信号的生命周期）

```
regime 体制分类（15min）
  → run(): WSL 求值入场条件（hits）
  → 风控过滤（冷却/日限/事件/熔断）
  → 写 signal_track + 推送群（paper 期带测试标签）
  → runExits(): 每轮检查出场
      partial(1R减半+保本) → structure(趋势破坏)
      → time_stop → chandelier(吊灯) → stop → target
  → 结算 WIN/LOSS，日亏累计熔断
```

## 测试与 CI

```bash
npm test    # 自动化测试（node --test tests/*.test.js，零依赖）
npm run smoke  # 信号引擎 smoke test（7 用例，纯函数只读）
```

- `tests/signal.smoke.test.js` — 信号引擎核心纯函数（bollinger/trendFilter/stopScale/momentumCheck）
- crontab 每 5 分钟跑健康检查：`node scripts/health_check.js`（4服务/API/实盘心跳/磁盘，异常推群）

## 数据表（data/w1.db）

| 表 | 内容 | 保留策略 |
|----|------|---------|
| prices | gate 现货行情 | 滚动清理 |
| futures_markets | 合约费率/持仓 | 1 天（待扩容 90 天） |
| lsr_rankings / lsr_signals | 多空比 | 滚动清理 |
| liquidation | 爆仓聚合 | 滚动清理 |
| signal_track | 给单记录 | 永久 |
| schema_version | 迁移版本 | 永久 |

## 部署与运维

详见 `README_部署说明.txt`。生产环境：腾讯云 2C4G + pm2 + nginx。

**实盘运行（2026-08 现状）：**
- 当前实盘 = `scripts/alpha1_live.js`（α1 破浪 v3.1，BTC-USDT-SWAP，cron 每 5 分钟）
- 实盘日志：`/tmp/alpha1_live.log`；看板服务：PM2 `w1-board`（:3300）
- 提现规则：可用余额 ≥ 基准×2 时提利润 15%（冻结资金不计入，基准存 `kv.alpha1:wdBase`）
- 日志轮转：`/etc/logrotate.d/w1-logs`（每日 7 份压缩）
- 每日 03:17 数据库备份 → `backups/db/`（保留 7 天）+ 每周 VACUUM

**故障排查：**
1. 服务挂 → `pm2 restart w1-board`；看板 API → `curl 127.0.0.1:3300/api/signal/overview`
2. 实盘不跑 → 查 `/tmp/alpha1_live.log` 末行时间戳（>15min 即异常，health_check 会推群）
3. 数据源报错 → `logs/w1-board.err.log`（odaily 偶发失败属已知噪音）

## 版本历史

- v5.1.0 — 2026-08-12：系统规整（归档88文件/日志轮转/权限收紧）+ 健康检查告警 + smoke test
- v5.0.0 — 算法缺陷修复 + 模块化重构 + 测试/CI + 同引擎回测
