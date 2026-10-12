// 知名机构/鲸鱼地址标签库 + 巨鲸转账历史（本地缓存，来源 blockchain.watch 开源数据集，MIT）
// 一次性内嵌，避免运行时依赖外网
const fs = require('fs');
const path = require('path');

let _labelMap = null;
let _entities = null;
let _whaleTransfers = null;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const obj = {};
    header.forEach((h, i) => obj[h.trim()] = (cols[i] || '').trim());
    return obj;
  });
}

// 加载地址标签库：address -> { entity, label, chain }
function loadLabels() {
  if (_labelMap) return _labelMap;
  _labelMap = {};
  _entities = {};
  try {
    const p = path.join(__dirname, 'whale-data', 'exchange-wallets.csv');
    if (fs.existsSync(p)) {
      const rows = parseCsv(fs.readFileSync(p, 'utf8'));
      for (const r of rows) {
        if (!r.address) continue;
        const key = r.address.toLowerCase();
        _labelMap[key] = { entity: r.entity || r.label || '机构', label: r.label || '', chain: r.chain || '' };
        const ent = r.entity || '机构';
        if (!_entities[ent]) _entities[ent] = [];
        _entities[ent].push(key);
      }
    }
  } catch (e) { /* 忽略 */ }
  return _labelMap;
}

// 加载巨鲸转账历史（本地缓存）
function loadWhaleTransfers() {
  if (_whaleTransfers) return _whaleTransfers;
  _whaleTransfers = [];
  try {
    const p = path.join(__dirname, 'whale-data', 'whale-transfers.csv');
    if (fs.existsSync(p)) {
      const rows = parseCsv(fs.readFileSync(p, 'utf8'));
      _whaleTransfers = rows.map(r => ({
        amount_usd: parseFloat(r.amount_usd) || 0,
        token: r.token || '',
        chain: r.chain || '',
        from: r.from || '',
        to: r.to || '',
        entity: r.entity || '',
        time: r.time || '',
        tx_hash: r.tx_hash || ''
      })).filter(r => r.amount_usd > 0);
    }
  } catch (e) { /* 忽略 */ }
  return _whaleTransfers;
}

// 查地址标签
function labelOf(addr) {
  if (!addr) return null;
  const map = loadLabels();
  return map[String(addr).toLowerCase()] || null;
}

// 统计：各机构近期转账（按金额 TOP + 笔数）
function entityActivity(limit = 12) {
  const transfers = loadWhaleTransfers();
  const agg = {};
  for (const t of transfers) {
    const ent = t.entity || t.chain || '未知';
    if (!agg[ent]) agg[ent] = { entity: ent, count: 0, total_usd: 0, max_usd: 0, last_time: '' };
    agg[ent].count++;
    agg[ent].total_usd += t.amount_usd;
    if (t.amount_usd > agg[ent].max_usd) agg[ent].max_usd = t.amount_usd;
    if (t.time > agg[ent].last_time) agg[ent].last_time = t.time;
  }
  return Object.values(agg)
    .sort((a, b) => b.total_usd - a.total_usd)
    .slice(0, limit);
}

// 最近巨鲸转账（按时间倒序）
function recentWhaleTransfers(limit = 20) {
  const transfers = loadWhaleTransfers();
  return transfers
    .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
    .slice(0, limit);
}

module.exports = { loadLabels, loadWhaleTransfers, labelOf, entityActivity, recentWhaleTransfers };
