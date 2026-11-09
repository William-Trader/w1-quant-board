'use strict';
const assert = require('assert');
const f = require('../lib/freshness');
const sr = require('../lib/source_router');
// 单一事实来源：业务选源与体检脚本不得再各自硬编码
assert.strictEqual(sr.FAST_THRESH_SEC, f.FAST_THRESH_SEC);
assert.strictEqual(sr.FULL_THRESH_SEC, f.FULL_THRESH_SEC);
assert(f.FAST_THRESH_SEC > 0 && f.FULL_THRESH_SEC > f.FAST_THRESH_SEC);
// 未知路由必须显式报错，不能静默兜底
assert.strictEqual(sr.choose({}, 'no_such_kind').error, 'unknown_kind');
// 契约字段完整性
const s = sr.status({ prepare: () => ({ get: () => ({ m: null }) }) });
assert.strictEqual(s.ok, true);
assert.strictEqual(s.routes.length, Object.keys(sr.ROUTES).length);
console.log('freshness/source_router contract tests passed');
