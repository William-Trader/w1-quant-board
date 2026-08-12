#!/usr/bin/env node
'use strict';
// OKX 资金划转（REST + HMAC 签名）：交易账户(18) → 资金账户(6) 提现落袋
// 用法: node scripts/okx_transfer.js <amt> [--dry]
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const DRY = process.argv.includes('--dry');
const AMT = parseFloat(process.argv[2]);
if (!AMT || AMT <= 0) { console.error('用法: node okx_transfer.js <金额USDT> [--dry]'); process.exit(1); }

// 读 config.toml（live profile）
const cfg = fs.readFileSync(process.env.HOME + '/.okx/config.toml', 'utf8');
function getProfile(name) {
  const m = cfg.match(new RegExp('\\[' + name + '\\]\\n([\\s\\S]*?)(?=\\n\\[|$)'));
  if (!m) return null;
  const kv = {};
  for (const line of m[1].split('\n')) {
    const p = line.match(/^\s*([\w]+)\s*=\s*(.+)\s*$/);
    if (p) kv[p[1]] = p[2].replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  }
  return kv;
}
const prof = getProfile('profiles.live') || getProfile('profiles.default');
if (!prof) { console.error('未找到 live 配置'); process.exit(1); }
const SITE_MAP = { global: 'https://www.okx.com', aws: 'https://aws.okx.com', 'aws-ap': 'https://aws-ap.okx.com', 'aws-ny': 'https://aws-ny.okx.com' };
const BASE = (SITE_MAP[prof.site] || 'https://www.okx.com').replace(/\/$/, '');
const PROXY = prof.proxy_url || '';

function sign(method, path, body, ts) {
  const msg = ts + method + path + (body || '');
  return crypto.createHmac('sha256', prof.secret_key).update(msg).digest('base64');
}
const { execFile } = require('child_process');
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const ts = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const url = BASE + path;
    const args = ['-s', '--max-time', '20'];
    if (PROXY) args.push('-x', PROXY);
    args.push('-X', method, '-H', 'OK-ACCESS-KEY: ' + prof.api_key,
      '-H', 'OK-ACCESS-SIGN: ' + sign(method, path, bodyStr, ts),
      '-H', 'OK-ACCESS-TIMESTAMP: ' + ts,
      '-H', 'OK-ACCESS-PASSPHRASE: ' + prof.passphrase,
      '-H', 'Content-Type: application/json');
    if (bodyStr) args.push('-d', bodyStr);
    args.push(url);
    execFile('curl', args, { timeout: 25000 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ code: -1, msg: String(stdout).slice(0, 200) }); }
    });
  });
}

(async () => {
  // 1) 查交易账户余额（校验凭据）
  const bal = await req('GET', '/api/v5/account/balance');
  if (bal.code !== '0') { console.error('凭据/余额查询失败:', bal.code, bal.msg); process.exit(1); }
  const details = (bal.data[0].details || []).find(d => d.ccy === 'USDT');
  const eq = details ? parseFloat(details.eq) : 0;
  const avail = details ? parseFloat(details.availBal) : 0;
  console.log(`交易账户 USDT: 总权益 ${eq.toFixed(2)} · 可用 ${avail.toFixed(2)}`);
  if (AMT > avail) { console.error(`划转金额 ${AMT} 超过可用 ${avail.toFixed(2)}，取消`); process.exit(1); }
  if (DRY) { console.log(`[DRY] 将划转 ${AMT} USDT：交易(18) → 资金(6)`); return; }
  // 2) 划转
  const tr = await req('POST', '/api/v5/asset/transfer', { ccy: 'USDT', amt: String(AMT), from: '18', to: '6', type: '0' });
  if (tr.code === '0') {
    console.log(`✅ 划转成功 ${AMT} USDT → 资金账户 (transId=${tr.data[0].transId})`);
  } else {
    console.error(`❌ 划转失败: ${tr.code} ${tr.msg}`);
    process.exit(1);
  }
})();
