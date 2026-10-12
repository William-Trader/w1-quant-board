const ec = require('./lib/eco_calendar');
(async () => {
  const rows = await ec.fetchTE();
  // 统计 auction/bill 类占比
  const auction = rows.filter(r=>/auction|t-bill|bill auction|note|bond|btf|ktb|jgb/i.test(r.title));
  console.log("拍卖/债券类噪音:",auction.length,"/",rows.length);
  // 高+中重要事件完整清单
  console.log("\n=== 高重要(17) ===");
  rows.filter(r=>r.impact==='high').forEach(r=>console.log(`  ${r.date} ${r.time} | ${r.country} | ${r.title}`));
  console.log("\n=== 中重要(72) 前30 ===");
  rows.filter(r=>r.impact==='medium').slice(0,30).forEach(r=>console.log(`  ${r.date} ${r.time} | ${r.country} | ${r.title}`));
})();
