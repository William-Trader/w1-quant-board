# W1 量化看板 · 部署与运维说明（2026-08-09 更新）

## 服务架构
- **腾讯云**：49.232.251.21（Ubuntu 20.04/22.04 LTS，2C4G，nginx 80→3300）
- **PM2 进程**：
  - `w1-board`（:3300）—— 看板 + 采集 + 给单引擎 + 威廉分析
  - `cloud-lobster`（OpenClaw Gateway :18789）—— QQ 智能体（DeepSeek 对话/联网/服务器命令）
  - `btc-oracle`（:3400）—— BTC 预言机（独立进程）
  - `search-server`（:3334）—— Bing 搜索代理（web_search provider）
- **代理**：mihomo 127.0.0.1:7890（OKX/Deribit/DeepSeek 等外网必需）

## 数据流闭环
采集（gate 现货 60s / coinglass 合约 5min / LSR v2 排行榜+批量信号 5min / KOL 共识 10min / FGI 30min / 新闻 / 清算 / 稳定币）
→ 存储（SQLite w1.db：prices / futures_markets / lsr_rankings / lsr_signals / consensus / fear_greed / news / liquidation / signal_track / daily_analysis / access_log / kv）
→ 分析（verdict 每日判断 / BTC 预言机 / 威廉分析引擎 v8 十因子 / AI 研判 DeepSeek / William 每日分析五维）
→ 决策（给单引擎：体制分类器 regime → WSL 策略 ST/FR → 出场引擎 → 影子期门禁）
→ 输出（W1 看板 21 选项卡 / QQ 双通道：w1-board 主动推送 + OpenClaw 智能体）

## 给单引擎（新架构，2026-08-09）
- **lib/engine.js**：WSL 表达式策略引擎（ST 趋势回调 + FR 费率反转），100x 模式实际杠杆 ≤10x、单笔风险 2%、ATR 同源止损/仓位
- **lib/regime.js**：市场体制分类器（TREND/RANGE/STORM/OFF，15min 更新，滞后防抖）
- **lib/wsl.js**：策略表达式语言（无 eval，递归下降解析，30+ 变量含 LSR 深度字段）
- **lib/qqbot.js**：QQ 官方机器人（RFC8032 ed25519 验签 + 主动推送）；**群消息回复已移交云端 OpenClaw**，w1-board 只推送不抢事件
- 策略文件：`strategies/*.wsl.yaml`（热加载，每次扫描重读）
- 门禁：7 天影子期 paper → 达标 live；20 笔亏 5R 熔断 paused 24h
- 周报：周日 10:00 战绩 + 出场分布；引擎健康告警：连续 3 轮异常 QQ 通知

## QQ 机器人（2026-08-09 重新接入）
- QQ 号 4016629021 · appId 1905262033 · secret 见 .env（勿外泄）
- 双通道：w1-board（主动推送信号/宏观/周报/告警）+ cloud-lobster（智能体对话）
- WebSocket：OpenClaw qqbot 插件自动连接（wss://api.sgroup.qq.com/websocket）

## 环境变量（.env）
- QQ_APPID / QQ_APPSECRET / QQ_TOKEN / QQ_GROUP_OPENID（群推送）
- DEEPSEEK_KEY_A/B + DEEPSEEK_MODEL / DEEPSEEK_MODEL_REASON（reasoner 推理）
- COINGLASS_API_KEY（api.coinglass.site 中转）
- ENGINE_ENABLED=1 / ENGINE_DEFAULT_MODE=paper / ENGINE_MAX_LEVERAGE=10 / ENGINE_PAPER_DAYS=7 / ENGINE_PAPER_PUSH=1
- PROXY_URL=http://127.0.0.1:7890

## 定时任务
- crontab：jin10 5min / 数据库备份 03:17 / VACUUM 周日 03:30
- 引擎内 cron（node-cron）：现货 60s · 合约/LSR/清算 5min · FGI 30min · 每日判断 08:30 · 宏观提醒 08:00/20:00 · 威廉每日分析 08:00 · 给单扫描 5min · 周报周日 10:00

## 运维常用命令
```bash
pm2 list                          # 进程状态
pm2 logs w1-board --lines 50     # 看板日志
pm2 restart w1-board             # 重启看板
pm2 restart cloud-lobster        # 重启 OpenClaw
sqlite3 data/w1.db ".tables"     # 表清单
curl http://127.0.0.1:3300/healthz
```

## 注意
- 全部数据仅供研究，不构成投资建议
- w1-board 改动后必须 pm2 restart 生效
- 配置改动先备份（openclaw.json / .env / lib/*.js 有 .bak 习惯）
