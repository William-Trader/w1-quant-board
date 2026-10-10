'use strict';
const { info, error: logError } = require('./lib/log');
// ========== process guard for Node 24 ==========
// 全局异常守卫：统一走 logger，避免裸 console；记录完整 stack 便于排查。
// 注意：unhandledRejection 只记录（业务可恢复）；uncaughtException 记录后由 pm2 重启兜底。
process.on('unhandledRejection', (reason, promise) => {
  logError('[guard] unhandledRejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  logError('[guard] uncaughtException:', err && err.message, '\n' + (err && err.stack));
});

// William 量化看板 W1 — Express 127.0.0.1:3300，nginx 80→3300 反代，pm2 进程名 w1-board
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { loadEnv } = require('./lib/env');
const { openDb } = require('./lib/db');
const { CoinglassClient } = require('./lib/coinglass');
const { registerAuthRoutes } = require('./lib/auth');
const { registerRoutes } = require('./lib/routes');
const { registerQQ } = require('./lib/qqbot');
const collectors = require('./lib/collectors');
const { startCollector: startNewsCollector } = require('./lib/news');

const env = loadEnv();
const SMOKE = env.SMOKE === '1';
const db = openDb(env);
const cg = new CoinglassClient(env, db);
const ctx = { env, db, cg, SMOKE };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// 原始 body 采集（QQ Ed25519 验签需要 raw body）
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(cookieParser());

// ---- 访问统计中间件（页面浏览人数/趋势）----
try { require('./lib/daily_analysis').ensureTable(db); } catch (e) {}
try { db.exec('CREATE TABLE IF NOT EXISTS lsr_signals (ts INTEGER PRIMARY KEY, payload TEXT)'); } catch (e) {}
db.exec(`CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ip TEXT, ua TEXT, path TEXT
)`);
app.use((req, res, next) => {
  try {
    const isPage = req.path === '/' || req.path.endsWith('.html') || (!req.path.startsWith('/api/') && !req.path.startsWith('/qq/'));
    if (isPage && req.method === 'GET') {
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 45);
      const ua = String(req.headers['user-agent'] || '').slice(0, 120);
      const p = req.path.slice(0, 60);
      db.prepare('INSERT INTO access_log(ts, ip, ua, path) VALUES(?,?,?,?)').run(Date.now(), ip, ua, p);
      // 只保留 90 天，防膨胀
      if (Math.random() < 0.02) db.prepare('DELETE FROM access_log WHERE ts < ?').run(Date.now() - 90 * 86400 * 1000);
    }
  } catch (e) { /* 统计失败不影响主流程 */ }
  next();
});

// 静态单页
// index.html 不缓存（防改版后浏览器仍拿旧文件）；静态资源 5 分钟缓存
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m', index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// 认证 + 业务路由 + QQ
const auth = registerAuthRoutes(app, db, env);
registerRoutes(app, ctx, auth);
registerQQ(app, ctx);

app.get('/healthz', (req, res) => res.json({ ok: true, name: 'william-quant-board-w1' }));

// SPA 兜底（非 /api、非 /qq 路径回 index.html）
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/qq/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found' }));

// 采集：SMOKE 模式跳过 cron 注册与外部请求，改用假数据
if (SMOKE) {
  collectors.seedSmoke(ctx);
} else {
  collectors.startCron(ctx);
  startNewsCollector(ctx);
  collectors.prune(ctx);
}

const PORT = Number(env.PORT || 3300);
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    info(`[w1-board] William 量化看板 W1 v${require('./package.json').version} listening on 127.0.0.1:${PORT} (smoke=${SMOKE}, cg=${cg.maskedKey()})`);
  });
  collectors.prune(ctx);
}

module.exports = { app, ctx };
