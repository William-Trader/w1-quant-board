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
    .map(tx => {
      const outs = tx.out || [];
      const inputs = tx.inputs || [];
      const totalSat = outs.reduce((s, o) => s + (o.value || 0), 0);
      // 聚合输入地址（发送方）与输出地址（接收方，取金额最大的一两个）
      const inAddrs = [...new Set(inputs.map(i => (i.prev_out && i.prev_out.addr) || null).filter(Boolean))];
      const outAddrs = outs.map(o => o.addr || null).filter(Boolean);
      // 大额接收方：value/1e8 >= 0.1 BTC 的输出地址
      const whaleOuts = outs.filter(o => (o.value||0) >= 0.1*1e8).map(o => ({ addr:o.addr, value_btc:+(o.value/1e8).toFixed(4) }))
        .sort((a,b)=>b.value_btc-a.value_btc).slice(0,3);
      return {
        txid: tx.hash,
        value_sat: totalSat,
        from_addrs: inAddrs.slice(0,3),
        to_addrs: whaleOuts,
        fee_sats: tx.fee || null,
        size: tx.size || null
      };
    })
    .filter(tx => tx.value_sat >= minValueBtc * 1e8)
    .sort((a, b) => b.value_sat - a.value_sat)
    .slice(0, 20)
    .map(tx => ({
      txid: tx.txid,
      value_btc: (tx.value_sat / 1e8).toFixed(4),
      value_usd: 0,
      fee_sats: tx.fee_sats != null ? tx.fee_sats : null,
      size: tx.size != null ? tx.size : null,
      vsize: null,
      from_addrs: tx.from_addrs || [],
      to_addrs: tx.to_addrs || [],
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
