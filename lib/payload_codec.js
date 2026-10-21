'use strict';
// Payload codec — 历史 JSON 载荷压缩（gzip BLOB），读取端透明解压。
// 设计：新写入保持 TEXT（外部只读最新行的消费者不受影响）；超过保留窗口的历史行
// 由 scripts/compress_history.js 压缩为 BLOB。openDb() 在读取时自动解压任何
// gzip 头的 Buffer 列，因此业务代码无需改动。
const zlib = require('zlib');

function isGzip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function pack(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 6 });
}

function unpack(value) {
  if (value == null) return value;
  if (Buffer.isBuffer(value)) {
    if (isGzip(value)) {
      try { return zlib.gunzipSync(value).toString('utf8'); }
      catch (e) { return value.toString('utf8'); }
    }
    return value.toString('utf8');
  }
  return value;
}

function parse(value, fallback = null) {
  if (value == null) return fallback;
  try { return JSON.parse(unpack(value)); }
  catch (e) { return fallback; }
}

// 解码一行中所有 gzip 列（payload / *_json 等）
function decodeRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (Buffer.isBuffer(v) && isGzip(v)) {
      try { row[key] = zlib.gunzipSync(v).toString('utf8'); } catch (e) { /* 保留原值 */ }
    }
  }
  return row;
}

module.exports = { pack, unpack, parse, isGzip, decodeRow, GZIP_MAGIC: 0x1f8b };
