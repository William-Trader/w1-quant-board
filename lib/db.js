// SQLite 单文件库 data/w1.db，WAL 模式
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prices (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL, change_24h REAL, high_24h REAL, low_24h REAL, volume REAL,
  source TEXT DEFAULT 'gate',
  PRIMARY KEY (symbol, ts)
);
CREATE TABLE IF NOT EXISTS futures_markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lsr_rankings (
  mode TEXT NOT NULL,
  ts INTEGER NOT NULL,
  etag TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (mode, ts)
);
CREATE TABLE IF NOT EXISTS funding_arb (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consensus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS liquidation (
  exchange TEXT NOT NULL,
  ts INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (exchange, ts)
);
CREATE TABLE IF NOT EXISTS fear_greed (
  ts INTEGER PRIMARY KEY,
  value INTEGER NOT NULL,
  classification TEXT
);
CREATE TABLE IF NOT EXISTS openclue_archive (
  ts INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verdict_daily (
  date TEXT PRIMARY KEY,
  posture_json TEXT,
  verdict_json TEXT,
  stances_json TEXT,
  ai_text TEXT,
  ai_text_en TEXT,
  ai_source TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS source_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  ok INTEGER NOT NULL,
  ms INTEGER,
  detail TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  expires_at INTEGER,
  permanent INTEGER DEFAULT 0,
  is_owner INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'user',
  user_id INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT,
  source TEXT,
  source_label TEXT,
  url TEXT,
  ts INTEGER,
  sentiment TEXT DEFAULT 'neutral',
  influence INTEGER DEFAULT 1,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_news_ts ON news(ts);
CREATE INDEX IF NOT EXISTS idx_news_source ON news(source);
CREATE TABLE IF NOT EXISTS signal_track (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry REAL NOT NULL,
  stop REAL NOT NULL,
  target1 REAL NOT NULL,
  target2 REAL NOT NULL,
  rr REAL NOT NULL,
  pos_pct REAL NOT NULL,
  msg TEXT,
  status TEXT DEFAULT 'OPEN',
  pushed_at INTEGER NOT NULL,
  resolved_at INTEGER,
  pnl_pct REAL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_signal_track_status ON signal_track(status);
CREATE INDEX IF NOT EXISTS idx_signal_track_symbol ON signal_track(symbol);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  nickname TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_health_ts ON source_health(ts);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_futures_ts ON futures_markets(ts);
CREATE INDEX IF NOT EXISTS idx_liquidation_ts ON liquidation(ts);
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS funding_history (
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  funding_rate REAL,
  PRIMARY KEY (ts, symbol)
);
CREATE INDEX IF NOT EXISTS idx_funding_history_sym_ts ON funding_history(symbol, ts);
CREATE TABLE IF NOT EXISTS lsr_history (
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  ratio REAL, trader_ratio REAL, whale_ratio REAL,
  delta_2m REAL, delta_4h REAL, trader_delta_4h REAL, whale_delta_4h REAL,
  long_notional REAL, short_notional REAL,
  PRIMARY KEY (ts, symbol)
);
CREATE INDEX IF NOT EXISTS idx_lsr_history_sym_ts ON lsr_history(symbol, ts);
`;

function openDb(env) {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dbFile = env.SMOKE === '1' ? path.join(dir, 'w1-smoke.db') : path.join(dir, 'w1.db');
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  // 会员体系迁移：旧库补列（幂等）
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('expires_at')) db.exec('ALTER TABLE users ADD COLUMN expires_at INTEGER');
  if (!cols.includes('permanent')) db.exec('ALTER TABLE users ADD COLUMN permanent INTEGER DEFAULT 0');
  if (!cols.includes('is_owner')) db.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0');
  if (!cols.includes('nickname')) db.exec('ALTER TABLE users ADD COLUMN nickname TEXT');
  // 会话与旧健康记录定期清理由 cron/启动时做
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  // messages 表迁移（幂等）：旧库补 nickname 列
  const mcols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (mcols.length && !mcols.includes('nickname')) db.exec('ALTER TABLE messages ADD COLUMN nickname TEXT');
  // 版本化迁移（幂等，按需升级）
  runMigrations(db);
  return db;
}

function kvGet(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function kvSet(db, key, value) {
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------------- 版本化迁移（幂等）----------------
// MIGRATIONS 数组：每项 { v: 版本号, up: (db) => void }
// 已应用的版本记录在 schema_version 表，只执行未应用过的更高版本
const MIGRATIONS = [
  // v1: 初始基线（无操作，标记起始版本）
  { v: 1, up: () => {} },
  // v2: signal_track 补充字段（strategy/regime/exit_reason 已在生产库手工加过，这里幂等补齐）
  {
    v: 2,
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(signal_track)').all().map(c => c.name);
      if (!cols.includes('strategy')) db.exec('ALTER TABLE signal_track ADD COLUMN strategy TEXT');
      if (!cols.includes('strategy_id')) db.exec('ALTER TABLE signal_track ADD COLUMN strategy_id TEXT');
      if (!cols.includes('regime')) db.exec('ALTER TABLE signal_track ADD COLUMN regime TEXT');
      if (!cols.includes('exit_reason')) db.exec('ALTER TABLE signal_track ADD COLUMN exit_reason TEXT');
    }
  },
  // v4: signal_track 结算对齐回测出场结构（t1_hit: 是否已部分落袋→保本）
  {
    v: 4,
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(signal_track)').all().map(c => c.name);
      if (!cols.includes('t1_hit')) db.exec('ALTER TABLE signal_track ADD COLUMN t1_hit INTEGER DEFAULT 0');
    }
  },
  // v3: funding_history 轻量费率历史表（FR 回测数据基建，保留 90 天）
  {
    v: 3,
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS funding_history (
        ts INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        funding_rate REAL,
        PRIMARY KEY (ts, symbol)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_funding_history_sym_ts ON funding_history(symbol, ts)');
    }
  },
  // v4: lsr_history 轻量多空比历史表（FR 回测数据基建，保留 90 天）
  {
    v: 4,
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS lsr_history (
        ts INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        ratio REAL, trader_ratio REAL, whale_ratio REAL,
        delta_2m REAL, delta_4h REAL, trader_delta_4h REAL, whale_delta_4h REAL,
        long_notional REAL, short_notional REAL,
        PRIMARY KEY (ts, symbol)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_lsr_history_sym_ts ON lsr_history(symbol, ts)');
    }
  }
];

function runMigrations(db) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
  if (!has) db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.v)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?,?)').run(m.v, Date.now());
    })();
    console.log(`[db] 迁移 v${m.v} 已应用`);
  }
}

module.exports = { openDb, kvGet, kvSet, runMigrations, MIGRATIONS };
