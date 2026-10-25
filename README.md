# W1 Quant Board · Crypto Market Monitoring & Trading Assistance

**中文** ｜ **English**

> **定位 / Positioning**：面向交易者与社群运营者的 crypto 市场监测终端。  
> **A crypto market-monitoring terminal for traders and community operators.**
>
> **不做的事 / Not doing**：不内置交易策略、不执行实盘下单、不承诺收益、不构成投资建议。  
> **No built-in trading strategy, no live order execution, no return promise, not investment advice.**

历史实盘策略与运行记录已移除；保留研究/回测框架用于数据分析。  
The live strategy layer and its run history have been removed; the research/backtest framework is retained for analysis.

---

# 中文

## 1. 这是什么

W1 把分散的 crypto 市场数据整理成一套可读、可查、可告警的监测系统：

- **交易者**：看市场体制、仓位压力、清算结构、资金费率、新闻冲击、跨资产联动，辅助自己做决策。
- **社群运营者**：按模块和会员权限组合产品，接入 QQ / Telegram / Discord 等通知渠道，做实时提示与内容运营。
- **研究者**：用保留的回测/研究框架做因子、体制、事件研究，不依赖任何“实盘策略”。

数据主要来自 **Coinglass**，辅以 Gate/OKX 行情、新闻 RSS、ETF、宏观与链上公开数据。系统只做数据加工与展示，不替用户下单。

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

## 6. 会员与权限

- 注册后需管理员审批；会员状态、到期时间、额度在 `users` 表。
- 前端 `TABS` 用 `pub:false` 控制会员栏目；后端对应接口用 `requireVip`。
- 后台 `requireAdmin`；owner 可管理用户与公告。
- 会话使用 httpOnly cookie，7 天有效；不在前端暴露密钥。

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

## 10. 数据保留与性能

- `data/w1.db`：WAL；历史 JSON payload 超过保留窗口后压缩为 gzip BLOB，读取时透明解压。
- 保留期：行情快照/清算/费率等按表配置；访问日志 90 天；SLO 日汇总 30 天。
- `/api/data-quality`：每表行数、最新时间、压缩行占比、DB 可回收页。
- 重计算模块带 2–10 分钟缓存；首屏慢先看服务端耗时，不先改前端。

## 11. 限制与合规

- 依赖第三方数据源，上游限流/超时会导致短时缺口；页面会标记 stale。
- 研究结论受样本窗口限制，不构成收益承诺。
- 本项目**不提供交易建议、不代客理财、不执行下单**。
- 历史策略与运行记录已删除；保留的回测/研究代码仅用于分析。
- 使用前请自行确认当地法律与数据源条款。

## 12. License

PolyForm Noncommercial 1.0.0。仅限非商业研究使用；商业授权请联系仓库所有者。

---

# English

## 1. What It Is

W1 turns fragmented crypto market data into a readable, searchable and alertable monitoring system:

- **For traders**: market regime, positioning stress, liquidation structure, funding, news impact and cross-asset context — decision support, not signals.
- **For community operators**: compose products from modules and membership tiers; deliver real-time alerts to QQ, Telegram, Discord or custom webhooks.
- **For researchers**: keep the research/backtest framework for factor, regime and event studies without any live strategy layer.

Primary data comes from **Coinglass**, supplemented by Gate/OKX quotes, news RSS, ETF, macro and on-chain public data. The system processes and displays data; it never places orders.

## 2. Feature Matrix

| Module | What it provides | Implementation |
|---|---|---|
| Overview | Market view, key levels, sentiment and positioning summary | Local SQLite aggregation + rules/AI summary; every card carries data timestamp and freshness |
| 8-Coin Stances | Long/short stance for BTC/ETH/SOL and other majors | Funding, OI, LSR, liquidation and price-structure composite |
| Sentiment | Fear & Greed, historical percentile, trend | Daily FGI + 8.5-year history |
| Flows | Stablecoin supply, ETF flows, capital conditions | Coinglass/ETF data + stablecoin supply collection |
| Global Assets | US equities, commodities and crypto | OKX tokenized instruments + global indices; 67 symbols at 5-minute cadence |
| Market Analysis | Macro, structure, regime and key events | Rule engine + macro calendar + research modules |
| On-Chain | BTC price, market cap, transactions, active addresses | Public on-chain APIs + local cache |
| Liquidation | 8-venue liquidations, liquidation walls, max pain | Coinglass multi-venue data + CoinGlass Pro snapshots |
| Chip Distribution | Cost basis / chip structure | Local aggregation + charts |
| LSR | Retail/whale long-short ratio and extremes | Coinglass LSR + historical percentile |
| Funding | Cross-venue funding and arbitrage spread | Coinglass funding + local series |
| News | Real-time news and sentiment from 8 sources | RSS/API collection + dedup + sentiment tags |
| Monitor | Unified alerts, SLO, scorecards | Alert state machine + source SLO + forward-outcome scoring |
| Research | Regime lab, positioning stress, news impact, cross-asset, daily replay, market risk | Independent research modules; members only; see Section 5 |

## 3. Data Sources & Cadence

| Data | Source | Frequency | Notes |
|---|---|---|---|
| Futures/OI/Funding | Coinglass | 5 min | 50 majors, stored as local snapshots |
| LSR | Coinglass | 5 min | Retail/whale, historical series retained |
| Liquidation | Coinglass (8 venues) | 30 min | Binance/OKX/Bybit/Bitget/HTX/Gate/MEXC/KuCoin |
| Fear & Greed | alternative.me / Coinglass | 3-hour sampling | Upstream daily; history back to 2018 |
| News | Jin10/Odaily/BlockBeats/ChainThink/WallstreetCN/CoinTelegraph/Decrypt/Cryptonews | Real-time polling | Dedup, source labels, sentiment |
| ETF | Coinglass | 2 h | BTC ETF flow series |
| Macro/Global | FRED / public APIs / OKX | Daily or 5 min | Rates, indices, commodities, tokenized equities |
| On-chain | Public APIs | Hourly | Price, market cap, transactions, active addresses |

**Freshness discipline**: APIs expose `data_ts`/`age_sec`/`stale`; the top bar and `/api/health/sources` show whether data is stale. Stale data is never presented as real-time.

## 4. Alerts & Bot Notification Engineering

### 4.1 Alert Center

- Unified `alerts` table: `open → ack / silenced → resolved`, with acknowledger, silence deadline, resolution time and repeat count.
- Severity P0/P1/P2; one active alert per `dedup_key`.
- Scorecards: 15m/1h/4h/24h forward return, MFE/MAE and hit rate for symbol-bearing alerts.
- SLO: per-source success rate, p95 latency and error-budget burn; `/metrics` exposes Prometheus text.

### 4.2 Notification Adapters

A software-agnostic notification layer (`lib/notify/`):

| Channel | Adapter | Configuration |
|---|---|---|
| Telegram | Bot API `sendMessage` | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |
| Discord | Webhook `content` | `DISCORD_WEBHOOK_URL` |
| Slack | Incoming Webhook `text` | `SLACK_WEBHOOK_URL` |
| Generic Webhook | POST JSON `{text, meta}` | `GENERIC_WEBHOOK_URL` |
| QQ Group | Existing `pushToGroup` | Existing QQ config |

- Config: `config/notify.json` (see `config/notify.example.json`).
- **Dry-run by default**: payloads are generated but no request is sent. Set `NOTIFY_LIVE=1` and provide credentials for live delivery.
- 10-second timeout, per-channel errors, independent configuration. Actual connectivity tests are not required or performed.
- Admin APIs: `GET /api/notify/channels`, `POST /api/notify/send` (dry-run by default).

### 4.3 For Community Operators

- Approval-based membership: public, member and admin layers.
- Compose products by module: market monitoring, liquidation/LSR, news, research, alerts.
- Pluggable delivery: the same alert can go to QQ, Telegram, Discord or a custom webhook.

## 5. Research & Backtest Framework

Retained for analysis; no live strategy is exposed. The Research tab includes:

| Module | Data | Purpose |
|---|---|---|
| Regime Lab | BTC 1h, 2017→2026 (~59k bars) | Trend/range/high-vol classification; 24h forward stats; generic strategy comparison |
| Positioning Stress | ~7.5 months funding/OI/LSR + 8-venue liquidation | 0–100 stress score, trapped side, funding-z vs forward 4h validation |
| News Impact | ~186k news items over 30 days × BTC 5m | Source/sentiment hit rate, 1h/4h impact |
| Cross-Asset | 67 symbols, ~2 months of 5m data | Risk appetite, breadth, BTC correlation, rotation |
| Daily Replay | 5m candles + news + factor snapshots | Replay a day's market and events; no strategy signals |
| Market Risk | BTC daily | Drawdown, VaR95/CVaR95, annualized volatility, Sharpe |

**Backtest framework**: `lib/backtest.js`, `lib/backtest_wsl.js`, `lib/indicators.js` and related scripts are retained for research; they contain no deployed strategy and produce no trading instructions.

**Sample limits**: alternative data (funding/LSR/liquidation/cross-asset) covers only 2–7.5 months; it cannot be presented as long-horizon evidence. Every page states its data window.

## 6. Membership & Permissions

- Registration requires admin approval; status, expiry and quota live in `users`.
- Frontend `TABS` uses `pub:false` for member tabs; backend uses `requireVip`.
- Admin routes use `requireAdmin`; owner can manage users and announcements.
- Sessions use httpOnly cookies for 7 days; secrets are never exposed to the frontend.

## 7. Architecture

```
Browser SPA (public/index.html + app.js + app.css)
        │  /api/*
        ▼
Express server.js (:3300, bound to 127.0.0.1 only)
        │
        ├── Collectors lib/collectors.js + node-cron
        │     Coinglass / Gate / news / macro / ETF / on-chain
        ├── Storage SQLite WAL (data/w1.db)
        │     gzip-compressed historical payloads + retention cleanup
        ├── Analysis lib/verdict.js / research/*
        ├── Alerts lib/alerts.js + health_guard + skyeye + market_watch
        ├── Notifications lib/notify/ (Telegram/Discord/Slack/Webhook/QQ)
        └── Output REST API + /metrics + QQ/community push
```

- **Single process + SQLite**: simple deployment for individuals/small teams; heavy jobs must not block the API.
- **WAL + periodic checkpoint**: concurrent reads/writes; payload compression reduces size.
- **Static assets**: `app.css`/`app.js` are content-hashed; update `index.html`'s `?v=` after changes.
- **Public entry**: nginx reverse proxy to `127.0.0.1:3300`; TLS managed by certificates.

## 8. Main APIs

| Endpoint | Access | Content |
|---|---|---|
| `/api/version`, `/healthz` | Public | Version/health |
| `/api/overview`, `/api/coins`, `/api/fear-greed` | Public | Overview/coins/sentiment |
| `/api/health/sources`, `/api/data-quality` | Public | Data freshness/quality |
| `/api/liquidation`, `/api/lsr`, `/api/funding`, `/api/news` | Member | Liquidation/LSR/funding/news |
| `/api/alerts`, `/api/alerts/scorecard`, `/api/slo` | Member | Alerts/scorecards/SLO |
| `/api/research/*` | Member | Regime/positioning/news/cross-asset/replay/risk |
| `/api/notify/channels`, `/api/notify/send` | Admin | Notification channels and dry-run send |
| `/metrics` | Public | Prometheus metrics |
| `/api/okx/*`, `/api/signal/*`, `/api/strategy/*`, `/api/unified/*` | — | **410 Gone: live strategy layer removed** |

## 9. Deployment

```bash
npm install
cp .env.example .env       # Coinglass/QQ credentials, chmod 600
npm start                  # :3300
npm test                   # syntax + pure functions + alerts + research
```

- Production: PM2 `w1-board` + nginx reverse proxy; bind to `127.0.0.1:3300`.
- Secrets stay in `.env` (600), never in the repo or logs.
- Backups: daily `.backup` to `/home/ubuntu/backups/db/`; research/backtest artifacts go to `/tmp`.

## 10. Retention & Performance

- `data/w1.db`: WAL; historical JSON payloads are gzip-compressed after the retention window and transparently decompressed on read.
- Retention: per-table windows for snapshots/liquidations/funding; access logs 90 days; SLO daily rollups 30 days.
- `/api/data-quality`: per-table rows, latest timestamp, compressed-row ratio and reclaimable pages.
- Heavy modules cache for 2–10 minutes; investigate server-side latency before changing the frontend.

## 11. Limitations & Compliance

- Third-party data sources may rate-limit or time out; pages mark stale data.
- Research results are bounded by sample windows and are not return promises.
- This project **does not provide trading advice, does not manage money, and does not place orders**.
- Historical strategies and run history have been removed; retained backtest/research code is for analysis only.
- Verify local laws and data-source terms before use.

## 12. License

PolyForm Noncommercial 1.0.0. Non-commercial research use only; contact the repository owner for commercial licensing.

---

## 更新日志 / Changelog

### 2026-10-25

- **Coinglass 断连治理 + 自动修复**：新增自适应限流（429 自动降档、连续成功自动回升）、每端点熔断退避、401 冷却自愈、超时 8s→12s；新增 `scripts/cg_selfheal.js`（crontab 每 5 分钟）做 key 冷却探活自愈与源健康汇总。
  **Coinglass reliability & self-heal**: adaptive rate limit (auto-throttle on 429, auto-recover on success), per-endpoint circuit breaker, 401 cooldown self-heal, 8s→12s timeout; added `scripts/cg_selfheal.js` (cron every 5 min) for key-cooldown probe/self-heal and source-health summary.
- **Coinglass 新网关**：切换至 `https://vip2.coinglass.site`；LSR 专业版字段扩展至 48 项、排行榜翻页、共识信号恢复、`code=40300` 业务判定、`CG_RPM` 自适应。
  **New Coinglass gateway**: switched to `https://vip2.coinglass.site`; LSR v4 fields (48), ranking pagination, consensus signals restored, `code=40300` handling, adaptive `CG_RPM`.
- **今日决策台增强**：新增 AI 解读（会员）、评分构成、相比昨日变化、事件倒计时/禁交易窗口、自选行动板、亚欧美股盘高低点、风险预算、数据可信度。
  **Today dashboard enhancements**: AI interpretation (member), score breakdown, day-over-day delta, event countdown/blackout, watchlist action board, session high/low, risk budget, data trust.
- **单币技术分析 + 观点演化**：市场地图合并 8 币立场，点击进入单币技术分析；新增观点演化页。
  **Coin technical analysis + view evolution**: market map merges 8-coin stances with click-through coin analysis; added view-evolution page.
- **情报页面卡片流**：消息面改为摘要 + 主题卡片流，事件日历按日期分组，跨资产增加领涨领跌卡片；修复资金流页面卡片嵌套与成交额单位。
  **Intel card flow**: news redesigned to digest + topic card grid, events grouped by date, cross-asset top/bottom cards; fixed Flows card nesting and volume unit.
- **自愈触发机制强化**：清算 watchdog 每小时→每 15 分钟、阈值 40→35min；断供告警阈值 90→60min；清算采集 cron 补 `.catch`；`scripts/health_check.js` 新增死手开关（外部 cron 检测清算表超 50min 且无采集尝试 → 自动 `pm2 restart` 恢复调度，冷却 30min）。
  **Self-heal trigger hardening**: liquidation watchdog hourly→15min, threshold 40→35min; outage-alert threshold 90→60min; liquidation cron added `.catch`; `scripts/health_check.js` dead-man switch (external cron: liquidation stale >50min with no collection attempts → auto `pm2 restart`, 30min cooldown).
- **node-cron 根修 + 死手开关泛化**：将 `*/30`、`0 */2`、`0 */3` 等步进式 cron 改为显式枚举（`0,30 * * * *`、`0 0,2,4,...`、`0 0,3,6,...`），规避 node-cron 3.0.3 慢节奏任务静默死亡的已知问题；死手开关增加 `prices` 60s 心跳守卫（区分「进程存活但 */30 调度死亡」vs「进程/上游故障」），只在心跳新鲜但清算断供时自动 `pm2 restart`。
  **node-cron root fix + dead-man generalization**: step-value crons (`*/30`, `0 */2`, `0 */3`) → explicit enumeration (`0,30 * * * *`, `0 0,2,4,...`, `0 0,3,6,...`) to dodge node-cron 3.0.3's silent stall on slow-cadence tasks; dead-man switch gains a `prices` 60s heartbeat guard (distinguishes "process alive but */30 scheduler dead" from "process/upstream failure"), auto `pm2 restart` only when heartbeat is fresh but liquidation is stale.

### 2026-10-21

- **任务型导航 v9**：主导航从 16 个入口重组为 7 个任务型 Tab（今日 / 市场 / 衍生品 / 情报 / 研究 / 监测 / 我的），新增二级 subnav；新增今日决策台、市场地图、事件日历、跨资产、自选/我的；会员入口保留锁定状态，requireVip 与锁卡逻辑不变。
  **Task-oriented navigation v9**: regrouped 16 entries into 7 task tabs (Today / Market / Derivatives / Intel / Research / Monitor / My) with a secondary subnav; added Today, Market Map, Events, Cross-Asset and Watchlist panels. Member entry points stay visible with lock badges; requireVip and lock-card behavior are unchanged.
- **实盘策略层移除**：/api/signal/*、/api/okx/*、/api/strategy/*、/api/unified/* 统一返回 410；清空 signal_track / equity_history 等运行历史；保留研究/回测框架；风险舱改为 BTC 市场风险。
  **Live strategy layer removed**: strategy/signal/OKX/unified APIs now return 410; strategy run history was cleared; research/backtest frameworks are retained; the risk panel now uses BTC market risk.
- **Bot 通知工程化**：新增 Telegram / Discord / Slack / Webhook / QQ 适配器；配置模板 config/notify.example.json；默认 dry-run，设置 NOTIFY_LIVE=1 才真实发送；新增管理员接口 /api/notify/channels 与 /api/notify/send。
  **Notification engineering**: added Telegram / Discord / Slack / Webhook / QQ adapters; config template config/notify.example.json; dry-run by default, live sending only when NOTIFY_LIVE=1; admin APIs /api/notify/channels and /api/notify/send.
- **README 重写并双语化**：聚焦市场监测、Coinglass 数据、Bot 通知、交易辅助与社群产品化；补充实现方式、数据窗口、限制与合规说明。
  **README rewritten and bilingualized**: focused on market monitoring, Coinglass data, bot notifications, trading assistance and community productization; added implementation notes, data windows, limitations and compliance.
- **监测 v7**：统一告警状态机（open/ack/silenced/resolved）、SLO 与错误预算、/metrics、自适应阈值、告警评分卡、跨源基差/冻结行情检测。
  **Monitoring v7**: unified alert state machine (open/ack/silenced/resolved), SLO and error budgets, /metrics, adaptive thresholds, alert scorecards, cross-source basis and frozen-feed checks.
- **研究 Hub v8**：体制实验室、仓位压力、新闻冲击、跨资产、逐日回放、市场风险；明确样本窗口与限制。
  **Research Hub v8**: regime lab, positioning stress, news impact, cross-asset, daily replay and market risk; explicit sample windows and limitations.
- **数据核心 v6**：历史 JSON 载荷 gzip 压缩，w1.db 从约 4.1GB 降至约 1.9GB；新增 /api/data-quality；大于 1KB 的 JSON 响应启用 gzip；新增载荷编解码与数据质量测试。
  **Data core v6**: gzip-compressed historical JSON payloads reduced w1.db from about 4.1GB to about 1.9GB; added /api/data-quality; gzip for JSON responses over 1KB; added payload codec and data-quality tests.
- **前端样式修复**：恢复被研究页样式覆盖的完整 app.css，重新计算资源哈希；新增桌面/移动端响应式样式。
  **Frontend style fix**: restored the full app.css that had been overwritten by research-panel styles; recomputed asset hashes; added responsive desktop/mobile styles.

### 2026-10-12

- 前端拆分为 index.html + app.css + app.js，加入内容哈希缓存失效；新增公开 /api/health/sources 数据源红绿灯；站点统一 301 到 HTTPS 域名。
  Frontend split into index.html + app.css + app.js with content-hash cache busting; added public /api/health/sources; site standardized on HTTPS via 301.

### 2026-10-01

- 补齐数据保留策略与 Coinglass 限流/429 冷却，修复长期无清理导致的库膨胀。
  Added retention policies and Coinglass rate-limit/429 cooldown; fixed long-term database growth caused by missing cleanup.
