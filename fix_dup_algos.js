/* 清理 SOL 重复条件单：按价位分组，每价位只保留最新1个(algoId最大)，其余cancel */
const { execFileSync } = require('child_process');
const INST = 'SOL-USDT-SWAP';
function cli(args) {
  try { return execFileSync('okx', args, { timeout: 20000, encoding: 'utf8' }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
const out = cli(['swap','algo','orders','--instId',INST]);
const lines = out.split('\n').filter(l => l.includes(INST) && l.includes('conditional'));
const groups = {}; // key: 'SL:101.05' / 'TP:90.55'
for (const l of lines) {
  const m = l.match(/(\d{16,20})\s+SOL-USDT-SWAP\s+conditional\s+(\w+)\s+([\d.]+)\s+([\d.]*)\s+([\d.]*)\s+(\w+)/);
  if (!m) continue;
  const [, algoId, side, sz, tp, sl, state] = m;
  if (state !== 'live' && state !== 'effective') continue;
  const key = tp ? 'TP:' + Number(tp) : 'SL:' + Number(sl);
  if (!groups[key] || Number(algoId) > Number(groups[key].algoId)) groups[key] = { algoId, side, sz, tp, sl };
}
console.log('分组(每价位最新):', Object.entries(groups).map(([k,v])=>k+'→'+v.algoId).join(' | '));
const keep = new Set(Object.values(groups).map(g => g.algoId));
const toCancel = [];
for (const l of lines) {
  const m = l.match(/(\d{16,20})\s+SOL-USDT-SWAP/);
  if (m && !keep.has(m[1])) toCancel.push(m[1]);
}
console.log('待取消:', toCancel.length, '个 | 保留:', keep.size, '个');
let ok = 0, fail = 0;
for (const id of toCancel) {
  const r = cli(['swap','algo','cancel','--instId',INST,'--algoId',id]);
  if (r.includes('algoId') && !r.includes('error')) ok++; else fail++;
}
console.log('取消完成 ok=' + ok + ' fail=' + fail);
