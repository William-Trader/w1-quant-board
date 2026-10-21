# W1 Quant Board · Crypto 市场监测与交易辅助

> **定位**：面向交易者与社群运营者的 crypto 市场监测终端。  
> **不做的事**：不内置交易策略、不执行实盘下单、不承诺收益、不构成投资建议。  
> 历史策略与运行记录已移除；仅保留研究/回测框架用于数据分析。

---

## 1. 这是什么

W1 把分散的 crypto 市场数据整理成一套可读、可查、可告警的监测系统：

- **交易者**：看市场体制、仓位压力、清算结构、资金费率、新闻冲击、跨资产联动，辅助自己做决策。
- **社群运营者**：按模块和会员权限组合产品，接入 QQ / Telegram / Discord 等通知渠道，做实时提示与内容运营。
- **研究者**：用保留的回测/研究框架做因子、体制、事件研究，不依赖任何“实盘策略”。

数据主要来自 **Coinglass**，辅以 Gate/OKX 行情、新闻 RSS、ETF、宏观与链上公开数据。系统只做数据加工与展示，不替用户下单。

---

## 2. 功能矩阵

| 模块 | 提供什么 | 实现方式 |
|---|---|---|
| 总览 Overview | 市场判断、关键价位、情绪与仓位摘要 | 本地 SQLite 聚合 + 规则/AI 摘要；所有卡片带数据时间与新鲜度 |
| 8 币立场 | BTC/ETH/SOL 等主流币的多空立场 | 资金费率、OI、LSR、清算、价格结构多因子合成 |
| 情绪 Sentiment | 恐慌贪婪指数、历史分位、情绪趋势 | FGI 日更 + 8.5 年历史序列 |
| 资金流 Flows | 稳定币供应、ETF 流入、资金面变化 | Coinglass/ETF 数据 + 稳定币供应采集 |
| 全球资产 Global | 美股、商品、加密等跨资产行情 | OKX 代币化标的 + 全球指数；67 个标的、5 分钟级 |
| 市场分析 Market | 宏观、结构、体制与关键事件 | 规则引擎 + 宏观日历 + 研究模块 |
| 链上数据 On-chain | BTC 链上价格、市值、交易数、活跃地址 | 公开链上接口 + 本地缓存 |
| 清算数据 Liquidation | 8 所清算、清算墙、最大痛点 | Coinglass 多所清算 + CoinGlass Pro 快照 |
| 筹码分布 Chip | 持仓成本/筹码结构 | 本地聚合 + 图表 |
| 多空 LSR | 散户/大户多空比、极值 | Coinglass LSR + 历史分位 |
| 费率套利 Funding | 跨所资金费率与套利差 | Coinglass funding + 本地序列 |
| 消息面 News | 8 个来源的实时新闻与情绪 | RSS/接口采集 + 去重 + 情绪标签 |
| 监测 Monitor | 统一告警、SLO、评分卡 | 告警状态机 + 数据源 SLO + 前瞻结果评分 |
| 研究 Research | 体制实验室、仓位压力、新闻冲击、跨资产、逐日回放、市场风险 | 独立研究模块，会员可见；详见第 5 节 |

---

## 3. 数据源与更新节奏

| 数据 | 来源 | 频率 | 说明 |
|---|---|---|---|
| 合约行情/OI/费率 | Coinglass | 5 分钟 | 50 个主流币，写入本地快照 |
| LSR 多空比 | Coinglass | 5 分钟 | 散户/大户，保留历史序列 |
| 清算 | Coinglass（8 所） | 30 分钟 | Binance/OKX/Bybit/Bitget/HTX/Gate/MEXC/KuCoin |
| 恐慌贪婪 | alternative.me / Coinglass | 3 小时采样 | 上游日更，历史可回溯到 2018 |
| 新闻 | 金十/深潮/律动/链智库/华尔街见闻/CoinTelegraph/Decrypt/Cryptonews | 实时轮询 | 去重、来源标记、情绪标签 |
| ETF | Coinglass | 2 小时 | BTC ETF 流入序列 |
| 宏观/全球资产 | FRED / 公开接口 / OKX | 日更或 5 分钟 | 利率、指数、商品、代币化股票 |
| 链上 | 公开接口 | 小时级 | 价格、市值、交易数、活跃地址 |

**新鲜度纪律**：接口返回 `data_ts`/`age_sec`/`stale`，页面顶栏与 `/api/health/sources` 可直接看到数据是否过期；过期数据不会伪装成实时。

---

## 4. 告警与 Bot 通知工程

### 4.1 告警中心

- 统一 `alerts` 表：`open → ack / silenced → resolved`，记录确认人、静默截止、恢复时间、重复次数。
- 严重级别 P0/P1/P2；同一 `dedup_key` 只保留一条活动告警。
- 评分卡：每条带币种告警记录 15m/1h/4h/24h 远期收益、MFE/MAE、命中率。
- SLO：每源成功率、p95 延迟、错误预算燃烧率；`/metrics` 输出 Prometheus 文本。

### 4.2 通知适配器

系统内置一套**与具体软件解耦**的通知工程层（`lib/notify/`）：

| 渠道 | 适配方式 | 配置 |
|---|---|---|
| Telegram | Bot API `sendMessage` | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |
| Discord | Webhook `content` | `DISCORD_WEBHOOK_URL` |
| Slack | Incoming Webhook `text` | `SLACK_WEBHOOK_URL` |
| 通用 Webhook | POST JSON `{text, meta}` | `GENERIC_WEBHOOK_URL` |
| QQ 群 | 复用现有 `pushToGroup` | 现有 QQ 配置 |

- 配置文件：`config/notify.json`（参考 `config/notify.example.json`）。
- 默认 **dry-run**：只生成 payload，不发真实请求；设置 `NOTIFY_LIVE=1` 且配置齐全才真实发送。
- 统一超时 10s、错误返回、按渠道独立配置；不要求也不执行实际连接测试。
- 管理员接口：`GET /api/notify/channels`、`POST /api/notify/send`（默认 dry-run）。

### 4.3 面向社群运营

- 会员/审批制：公开页、会员页、后台三层。
- 可按模块组合产品：行情监测、清算/LSR、新闻、研究、告警。
- 通知渠道可插拔：同一套告警可接 QQ 群、Telegram 频道、Discord 社区或自有 Webhook。

---

## 5. 研究与回测框架

保留但不对外提供实盘策略。研究页签包含：

| 模块 | 数据 | 用途 |
|---|---|---|
| 体制实验室 | BTC 1h，2017→2026（约 5.9 万根） | 趋势/震荡/高波动分类；未来 24h 统计；通用策略范式对比 |
| 仓位压力 | 约 7.5 个月费率/OI/LSR + 8 所清算 | 0–100 压力分、被套方向、费率 z 与未来 4h 收益验证 |
| 新闻冲击 | 30 天约 18.6 万条新闻 × BTC 5m | 来源/情绪命中率、1h/4h 冲击 |
| 跨资产 | 67 个标的、约 2 个月 5m | 风险偏好、广度、BTC 相关性、轮动 |
| 逐日回放 | 5m K线 + 新闻 + 因子快照 | 回看某日行情与事件，不含策略信号 |
| 市场风险 | BTC 日线 | 回撤、VaR95/CVaR95、年化波动、Sharpe |

**回测框架**：`lib/backtest.js`、`lib/backtest_wsl.js`、`lib/indicators.js` 与相关脚本保留，用于研究；不包含上线策略，也不产生交易指令。

**样本限制**：另类数据（费率/LSR/清算/跨资产）只有 2–7.5 个月，不能冒充长周期结论；所有页面都标注数据窗口。

---

## 6. 会员与权限

- 注册后需管理员审批；会员状态、到期时间、额度在 `users` 表。
- 前端 `TABS` 用 `pub:false` 控制会员栏目；后端对应接口用 `requireVip`。
- 后台 `requireAdmin`；owner 可管理用户与公告。
- 会话使用 httpOnly cookie，7 天有效；不在前端暴露密钥。

---

## 7. 技术架构

```
浏览器 SPA (public/index.html + app.js + app.css)
        │  /api/*
        ▼
Express server.js (:3300, 仅监听 127.0.0.1)
        │
        ├── 采集层 lib/collectors.js + node-cron
        │     Coinglass / Gate / 新闻 / 宏观 / ETF / 链上
        ├── 存储层 SQLite WAL (data/w1.db)
        │     历史 payload gzip 压缩 + 保留期清理
        ├── 分析层 lib/verdict.js / research/*
        ├── 告警层 lib/alerts.js + health_guard + skyeye + market_watch
        ├── 通知层 lib/notify/ (Telegram/Discord/Slack/Webhook/QQ)
        └── 输出层 REST API + /metrics + QQ/社群推送
```

- **单进程 + SQLite**：部署简单，适合个人/小团队；重任务不得阻塞 API。
- **WAL + 定期 checkpoint**：读写并发；历史 payload 压缩降低体积。
- **静态资源**：`app.css`/`app.js` 带内容哈希；改完必须更新 `index.html` 的 `?v=`。
- **公网入口**：nginx 反代到 `127.0.0.1:3300`，HTTPS 由证书管理。

---

## 8. 主要 API

| 接口 | 权限 | 内容 |
|---|---|---|
| `/api/version`、`/healthz` | 公开 | 版本/健康 |
| `/api/overview`、`/api/coins`、`/api/fear-greed` | 公开 | 总览/币种/情绪 |
| `/api/health/sources`、`/api/data-quality` | 公开 | 数据新鲜度/质量 |
| `/api/liquidation`、`/api/lsr`、`/api/funding`、`/api/news` | 会员 | 清算/LSR/费率/新闻 |
| `/api/alerts`、`/api/alerts/scorecard`、`/api/slo` | 会员 | 告警/评分卡/SLO |
| `/api/research/*` | 会员 | 体制/仓位/新闻/跨资产/回放/风险 |
| `/api/notify/channels`、`/api/notify/send` | 管理员 | 通知渠道与 dry-run 发送 |
| `/metrics` | 公开 | Prometheus 指标 |
| `/api/okx/*`、`/api/signal/*`、`/api/strategy/*`、`/api/unified/*` | — | **410 Gone：实盘策略层已移除** |

---

## 9. 部署

```bash
npm install
cp .env.example .env       # 填入 Coinglass/QQ 等密钥，chmod 600
npm start                  # :3300
npm test                   # 语法 + 纯函数 + 告警 + 研究测试
```

- 生产：PM2 `w1-board` + nginx 反代；服务器仅监听 `127.0.0.1:3300`。
- 密钥只放 `.env`（600），不入库、不回显。
- 数据备份：每日 `.backup` 到 `/home/ubuntu/backups/db/`；研究/回测产物写 `/tmp`。

---

## 10. 数据保留与性能

- `data/w1.db`：WAL；历史 JSON payload 超过保留窗口后压缩为 gzip BLOB，读取时透明解压。
- 保留期：行情快照/清算/费率等按表配置；访问日志 90 天；SLO 日汇总 30 天。
- `/api/data-quality`：每表行数、最新时间、压缩行占比、DB 可回收页。
- 重计算模块带 2–10 分钟缓存；首屏慢先看服务端耗时，不先改前端。

---

## 11. 限制与合规

- 依赖第三方数据源，上游限流/超时会导致短时缺口；页面会标记 stale。
- 研究结论受样本窗口限制，不构成收益承诺。
- 本项目**不提供交易建议、不代客理财、不执行下单**。
- 历史策略与运行记录已删除；保留的回测/研究代码仅用于分析。
- 使用前请自行确认当地法律与数据源条款。

## 12. License

PolyForm Noncommercial 1.0.0。仅限非商业研究使用；商业授权请联系仓库所有者。
