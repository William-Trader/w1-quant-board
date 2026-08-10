'use strict';
// CI 守护脚本：跑回归测试，结果写日志；失败时推送群消息
// 用法: node scripts/ci-test.js [--push]
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, '..', 'logs', 'ci-test.log');
const PUSH = process.argv.includes('--push');

function run() {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    const out = execSync('npm test 2>&1', { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 120000 });
    const pass = (out.match(/ℹ pass (\d+)/) || [])[1] || '?';
    const fail = (out.match(/ℹ fail (\d+)/) || [])[1] || '0';
    const line = `[${ts}] CI PASS ✅ tests=${pass} fail=${fail}`;
    fs.appendFileSync(LOG, line + '\n');
    console.log(line);
    return { ok: true, pass: +pass, fail: +fail };
  } catch (e) {
    const err = (e.stdout || e.message || '').toString();
    const line = `[${ts}] CI FAIL ❌ ${err.split('\n').slice(0, 5).join(' | ')}`;
    fs.appendFileSync(LOG, line + '\n');
    console.error(line);
    return { ok: false, error: err };
  }
}

async function main() {
  const r = run();
  if (!r.ok && PUSH) {
    try {
      const env = require('../lib/env').loadEnv();
      const { openDb } = require('../lib/db');
      const { pushToGroup } = require('../lib/qqbot');
      const db = openDb(env);
      await pushToGroup(env, db, `⚠️ W1 回归测试失败！\n${(r.error || '').split('\n').slice(0, 3).join('\n')}\n请检查最近的算法改动。`);
      console.log('已推送群消息');
    } catch (pe) { console.error('推送失败:', pe.message); }
  }
  process.exit(r.ok ? 0 : 1);
}
main();
