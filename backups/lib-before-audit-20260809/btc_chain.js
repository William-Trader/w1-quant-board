// BTC 链上数据采集器 - 聚合多个免费 API
// 2026-08-09: mempool.space 国内不可达(全部超时), 改用 blockchair(主源)
// 2026-08-09 01:35: blockstream 线路慢(6.5~7s稳定), 弃用; 高度直接取 blockchair best_block_height(单源1.9s)
const https = require('https');

function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const text = d.trim();
        try { resolve(JSON.parse(text)); } catch (e) {
          const n = parseInt(text);
          if (!isNaN(n)) resolve(n);
          else reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchBtcOnchain() {
  // Blockchair - 全量基础链上数据(含高度/算力/难度/交易/费用等, 1.5~2s)
  const bc = await httpGet('https://api.blockchair.com/bitcoin/stats').catch(() => null);
  const data = bc && bc.data ? bc.data : {};

  const price = data.market_price_usd || 0;
  const circ = data.circulation ? data.circulation / 1e8 : 0;
  const mcap = data.market_cap_usd || 0;

  return {
    // 基础数据
    price: price,
    market_cap_usd: mcap,
    circulating_supply: circ,
    block_height: data.best_block_height || 0,

    // 活跃度
    transactions_24h: data.transactions_24h || 0,
    active_addresses_estimated: Math.round((data.transactions_24h || 0) * 0.6), // 估算
    blocks_24h: data.blocks_24h || 0,
    cdd_24h: data.cdd_24h || 0,

    // 算力 & 安全
    difficulty: data.difficulty || 0,
    hashrate_24h: data.hashrate_24h || '0',
    hashrate_exa: data.hashrate_24h ? (parseInt(data.hashrate_24h) / 1e18).toFixed(2) : '0',
    next_difficulty_estimate: data.next_difficulty_estimate || 0,
    next_retarget_time: data.next_retarget_time_estimate || '',

    // 费用 & 价值
    avg_tx_fee_usd: data.average_transaction_fee_usd_24h || 0,
    med_tx_fee_usd: data.median_transaction_fee_usd_24h || 0,
    largest_tx_usd: data.largest_transaction_24h ? data.largest_transaction_24h.value_usd : 0,
    largest_tx_hash: data.largest_transaction_24h ? data.largest_transaction_24h.hash : '',

    // 网络状态
    mempool_txs: data.mempool_transactions || 0,
    mempool_tps: data.mempool_tps || 0,
    hodling_addresses: data.hodling_addresses || 0,
    nodes: data.nodes || 0,
    inflation_usd_24h: data.inflation_usd_24h || 0,

    // 市占率
    dominance: data.market_dominance_percentage || 0,

    ts: Math.floor(Date.now() / 1000)
  };
}

module.exports = { fetchBtcOnchain };
