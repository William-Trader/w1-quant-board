# W1 告警处置 Runbook（自动修复智能体专用）

原则：只做可逆、低风险动作；宁可上报，不猜、不删、不改配置。

## 1. 先跑自愈引擎
```
cd /home/ubuntu/w1-board && flock -n /tmp/alert_autofix_agent.lock node scripts/alert_autofix.js
```
输出字段：`api_ok`、`stale`（断供表）、`repairs`（已做动作）、`swept`（收敛条数）、`open_alerts`。
`open_alerts=0` 且无 `failed` → 结束，回复 NO_REPLY。

## 2. 按告警类型处置

| 告警 | 含义 | 允许动作 |
|---|---|---|
| `health`（某表断供） | 采集失败或上游限流 | 先跑自愈引擎对应采集；仍失败则重跑一次该 JOBS 任务；持续 >2h 才重启 w1-board |
| `PM2服务离线` | 进程挂了 | `pm2 restart <name> --update-env`，只限 w1-board / btc-oracle / search-server |
| `w1-board API 无响应` | 站点进程假死 | 先 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3300/healthz`；非 200 才重启 w1-board |
| `磁盘占用 >85%` | 空间不足 | 只清 `/tmp` 下 >7 天日志与 `/home/ubuntu/w1-board/logs/*.log.*`；禁止删 DB/备份 |
| `skyeye:*` | 行情事件播报（一次性） | 不需要修复；超过 24h 仍 open 可置 resolved，备注 auto-swept |
| `market_watch:*` / `alt_radar` | 监测播报（一次性） | 同上；不需要重启任何服务 |
| `源健康 ok=0` 连续 | 上游/代理问题 | 检查 mihomo 代理 `systemctl is-active mihomo-proxy`；不要改代理配置 |

## 3. 明确禁止
- 禁止 `VACUUM`、删库、删 `data/*.db`、删 `backups/`。
- 禁止修改 `.env`、crontab、nginx、pm2 启动参数。
- 禁止重启整机、禁止 `pm2 delete`。
- 禁止把 P1 告警直接静默超过 1h 来“消除”告警；只能 resolved 并写明原因。

## 4. 结束条件
- 修复成功：简短记录动作 + 重跑第 1 步确认，回复 NO_REPLY。
- 仍失败：只回复一行 `需人工: <表名/进程> <原因>`。
