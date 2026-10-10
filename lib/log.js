'use strict';
// 统一日志器（工程级）：分级输出 + 环境变量开关，替代散落的 console.*
// 级别：error(0) warn(1) info(2) debug(3) trace(4)
// 环境变量 LOG_LEVEL 控制全局最低输出级别（默认 info）
// LOG_SILENT=1 时只保留 error；某模块可用 LOG_TAG 过滤
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const NAMES = { 0: 'ERROR', 1: 'WARN', 2: 'INFO', 3: 'DEBUG', 4: 'TRACE' };

function envLevel() {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (LEVELS[raw] !== undefined) return LEVELS[raw];
  if (process.env.LOG_SILENT === '1') return 1; // 静默只留 error
  return 2; // 默认 info
}

function enabled(level) {
  return LEVELS[level] !== undefined && LEVELS[level] <= envLevel();
}

function fmt(level, tag, args) {
  const ts = new Date().toISOString();
  const parts = args.map(a => (typeof a === 'object' && a !== null ? safeStringify(a) : String(a)));
  return `${ts} [${NAMES[LEVELS[level]]}]${tag ? ' [' + tag + ']' : ''} ${parts.join(' ')}`;
}

function safeStringify(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}

const out = (level) => (...args) => {
  if (!enabled(level)) return;
  const tag = typeof args[0] === 'string' && /^\[[a-zA-Z0-9_-]+\]$/.test(args[0]) ? args.shift() : null;
  const line = fmt(level, tag ? tag.slice(1, -1) : null, args);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

module.exports = {
  error: out('error'),
  warn: out('warn'),
  info: out('info'),
  debug: out('debug'),
  trace: out('trace'),
  LEVELS,
  envLevel,
  enabled,
  // 供采集器保留原 console 命名习惯的别名
  log: out('info'),
  silent() { return !enabled('info'); },
};
