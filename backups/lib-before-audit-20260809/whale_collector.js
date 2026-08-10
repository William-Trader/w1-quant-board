// 链上巨鲸交易采集器 — 定时抓取 BTC 大额交易
// 2026-08-09: mempool.space 国内不可达(全部超时)
//   改用 blockchain.info(unconfirmed-transactions, 100笔) 优先 + blockstream.info 兜底
const https = require('https');

function httpGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const text = data.trim();
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// blockchain.info: 未确认交易列表(100笔, 字段 hash/out[], 价值需对 out 求和)
async function fetchFromBlockchainInfo(minValueBtc = 1) {
  const d = await httpGetJson('https://blockchain.info/unconfirmed-transactions?format=json');
  const txs = d.txs || [];
  return txs
    .map(tx => ({
      txid: tx.hash,
      value_sat: tx.out.reduce((s, o) => s + (o.value || 0), 0)
    }))
    .filter(tx => tx.value_sat >= minValueBtc * 1e8)
    .sort((a, b) => b.value_sat - a.value_sat)
    .slice(0, 20)
    .map(tx => ({
      txid: tx.txid,
      value_btc: (tx.value_sat / 1e8).toFixed(4),
      value_usd: 0,
      fee_sats: null,
      vsize: null,
      ts: Math.floor(Date.now() / 1000)
    }));
}

// blockstream.info: 内存池费率最高25笔(兜底, 数据少但格式简单)
async function fetchFromBlockstream(minValueBtc = 1) {
  const txs = await httpGetJson('https://blockstream.info/api/mempool/recent');
  return txs
    .filter(tx => tx.value >= minValueBtc * 1e8)
    .sort((a, b) => b.value - a.value)
    .slice(0, 20)
    .map(tx => ({
      txid: tx.txid,
      value_btc: (tx.value / 1e8).toFixed(4),
      value_usd: 0,
      fee_sats: tx.fee,
      vsize: tx.vsize,
      ts: Math.floor(Date.now() / 1000)
    }));
}

async function fetchMempoolTxs(minValueBtc = 1) {
  // 双源: blockchain.info 优先, 失败自动切 blockstream
  try {
    const r = await fetchFromBlockchainInfo(minValueBtc);
    if (r.length) return r;
  } catch (e) { /* 切下一源 */ }
  return fetchFromBlockstream(minValueBtc);
}

// 获取最新区块信息（blockstream 需先经 block-height 拿哈希，再查区块）
async function fetchBlockTxs(minValueBtc = 1) {
  const height = parseInt(await httpGetJson('https://blockstream.info/api/blocks/tip/height'));
  const hash = await httpGetJson('https://blockstream.info/api/block-height/' + height);
  const block = await httpGetJson('https://blockstream.info/api/block/' + hash);
  return {
    height: block.height,
    hash: block.id,
    timestamp: block.timestamp,
    tx_count: block.tx_count,
    size: block.size,
    weight: block.weight
  };
}

module.exports = { fetchMempoolTxs, fetchBlockTxs };
