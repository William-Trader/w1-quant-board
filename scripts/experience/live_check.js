const Database = require('/home/ubuntu/w1-board/node_modules/better-sqlite3');
const db = new Database('/home/ubuntu/w1-board/data/w1.db');
const eng = require('/home/ubuntu/w1-board/lib/experience_engine.js');
const st = eng.liveStatus(db, 'BTC');
console.log('=== 大方向引擎最新判断（数据已更新至 22:00） ===');
console.log('标签:', st.judge.label, '| 综合分:', st.judge.score, '| 建议仓位:', st.judge.pos + '%');
console.log('理由:', st.judge.reasons.join('; '));
if (st.order) console.log('挂单计划:', st.order.direction, '@', st.order.entry, '→ 目标', st.order.target1, '| 止损', st.order.stop, '| 仓位', st.order.pos_pct+'%', '| RR', st.order.rr);
console.log('当前持仓:', st.open ? 'id='+st.open.id+' '+st.open.symbol+' '+st.open.direction+' @'+st.open.entry : '无');
