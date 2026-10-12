const db = require('better-sqlite3')('data/w1.db');
const ec = require('./lib/eco_calendar');
(async () => {
  const ctx = { db };
  const r = await ec.collectEcoCalendar(ctx);
  console.log("collect result:", r);
  const g = ec.getEvents(db);
  console.log("future条数:", g.future.length, "| past条数:", g.past.length);
  console.log("\n=== 未来7天时间表(按天) ===");
  const byDay={};
  g.future.forEach(e=>{const k=e.date||'?'; (byDay[k]=byDay[k]||[]).push(e)});
  Object.keys(byDay).sort().forEach(d=>{
    console.log(`\n${d}:`);
    byDay[d].sort((a,b)=>(a.ts||0)-(b.ts||0)).forEach(e=>{
      console.log(`  ${e.time||'--:--'} [${e.impact}] ${e.country||''} ${e.title_zh||e.title}`);
    });
  });
})();
