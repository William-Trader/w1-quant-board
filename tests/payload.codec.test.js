'use strict';
// Payload codec + DB 透明解压层测试
const assert = require('assert');
const Database = require('better-sqlite3');
const { pack, unpack, parse, isGzip } = require('../lib/payload_codec');
const { wrapPayloadDb } = require('../lib/db');

const obj = { a: 1, b: '中文', arr: [1, 2, 3], nested: { x: true } };
const buf = pack(obj);
assert(isGzip(buf), 'pack 应产生 gzip BLOB');
assert.deepStrictEqual(parse(buf), obj, 'parse 应还原对象');
assert.strictEqual(unpack('{"x":1}'), '{"x":1}', 'TEXT 原样返回');
assert.strictEqual(unpack(buf), JSON.stringify(obj), 'unpack 返回 JSON 文本');
assert.strictEqual(parse('not-json', 'F'), 'F', '解析失败走 fallback');
assert.strictEqual(parse(null, 'F'), 'F', 'null 走 fallback');

const db = wrapPayloadDb(new Database(':memory:'));
db.exec('CREATE TABLE t(ts INTEGER, payload TEXT)');
db.prepare('INSERT INTO t(ts,payload) VALUES(?,?)').run(1, pack(obj));
db.prepare('INSERT INTO t(ts,payload) VALUES(?,?)').run(2, JSON.stringify({ plain: true }));
const rows = db.prepare('SELECT ts,payload FROM t ORDER BY ts').all();
assert.deepStrictEqual(JSON.parse(rows[0].payload), obj, 'BLOB 行应透明解压');
assert.deepStrictEqual(JSON.parse(rows[1].payload), { plain: true }, 'TEXT 行不受影响');
const one = db.prepare('SELECT payload FROM t WHERE ts=1').get();
assert.deepStrictEqual(JSON.parse(one.payload), obj, 'get 应透明解压');
db.close();
console.log('payload codec tests passed');
