const ec = require('./lib/eco_calendar');
(async () => {
  try {
    const rows = await ec.fetchTE();
    console.log("TE 未来事件条数:", rows.length);
    rows.slice(0, 25).forEach(r => {
      console.log(`  ${r.date} ${r.time} | [${r.impact}] ${r.country||'--'} | ${r.title_zh || r.title}`);
    });
    // 统计
    const hi = rows.filter(r=>r.impact==='high').length;
    const med = rows.filter(r=>r.impact==='medium').length;
    console.log(`\n高重要:${hi} 中重要:${med} 低:${rows.length-hi-med}`);
  } catch(e) {
    console.error("FAIL:", e.message);
  }
})();
