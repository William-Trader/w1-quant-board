
'use strict';
/* ================= W1 Terminal Frontend Core ================= */
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toggleHbHistory(i){
  const d=document.getElementById('hb-detail-'+i);
  const a=document.getElementById('hb-arrow-'+i);
  if(!d)return;
  const open=d.style.display!=='none';
  d.style.display=open?'none':'block';
  if(a)a.textContent=open?'▸':'▾';
}
function openHbCard(i){
  const h=window._hbData&&window._hbData[i];
  if(!h)return;
  const lang=state.lang||'zh';
  const headline=esc(lang==='zh'?h.headline_zh:h.headline_en);
  const quote=esc(lang==='zh'?(h.quote_zh||''):(h.quote_en||''));
  const dirMap={'看涨':['#2e7d5b','🐂'],'偏多':['#57a04a','📈'],'中性':['#d99e2b','⚖️'],'偏空':['#e0703a','📉'],'看跌':['#b83a2e','🐻']};
  const dirC=dirMap[h.direction];
  const dirHtml=dirC?'<span style="display:inline-block;background:'+dirC[0]+';color:#fff;font-size:11px;font-weight:800;border-radius:4px;padding:2px 8px;margin-left:8px;vertical-align:middle">'+dirC[1]+' '+esc(h.direction)+'</span>':'';
  const pills=(h.stance_pills||[]).map(function(p){return '<span class="hb-pill '+esc(p.tone)+'">'+esc(lang==='zh'?p.label_zh:p.label_en)+'</span>';}).join('');
  const kl=h.key_levels?'<div class="hb-card-levels">🎯 '+esc(h.key_levels)+'</div>':'';
  const m=document.getElementById('hb-modal');
  if(!m)return;
  m.querySelector('.hb-card-date').textContent=h.report_date||'';
  m.querySelector('.hb-card-head').innerHTML=headline+dirHtml;
  m.querySelector('.hb-card-pills').innerHTML=pills?'<div class="hb-pills">'+pills+'</div>':'';
  m.querySelector('.hb-card-quote').textContent=quote||'（暂无全文）';
  m.querySelector('.hb-card-levels').innerHTML=kl;
  m.style.display='flex';
}
function closeHbCard(){const m=document.getElementById('hb-modal');if(m)m.style.display='none'}
function toggleHbHistoryList(){
  const box=document.getElementById('hb-history-list');
  const a=document.getElementById('hb-history-list-arrow');
  if(!box)return;
  const open=box.style.display!=='none';
  box.style.display=open?'none':'block';
  if(a)a.style.transform=open?'':'rotate(180deg)';
}
const fmtPct=(v,d=2)=>v==null?'—':(v>0?'+':'')+Number(v).toFixed(d)+'%';
const fmtUsd=v=>{if(v==null)return'—';const n=Number(v);if(n>=1e12)return'$'+(n/1e12).toFixed(2)+'T';if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(1)+'K';return'$'+n.toFixed(2)};
const fmtPrice=v=>v==null?'—':(v>=1000?'$'+Number(v).toLocaleString('en-US',{maximumFractionDigits:1}):v>=1?'$'+Number(v).toFixed(2):'$'+Number(v).toFixed(4));
const fmtTs=ts=>{if(!ts)return'—';const d=new Date(ts*1000);return d.toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})};
const fmtDur=sec=>{if(!sec||sec<0)return'—';const d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60),s=sec%60;return(d?d+'d ':'')+(h?h+'h ':'')+m+'m '+s+'s'};
const barClass=pct=>pct>=85?'red':pct>=70?'orange':pct>=50?'yellow':'green';
const cls=v=>v>0?'up':v<0?'down':'flat';
const stanceZh=s=>({bullish:'看多',cautiously_bullish:'谨慎看多',neutral:'中性',cautiously_bearish:'谨慎看空',bearish:'看空',aggressive:'积极',defensive:'防御',risk_on:'进攻',risk_off:'避险',cautious:'谨慎'}[s]||s);
const stanceEn=s=>({cautiously_bullish:'cautiously bullish',cautiously_bearish:'cautiously bearish',risk_on:'risk on',risk_off:'risk off'}[s]||s);

const state={lang:'zh',user:null,admin:false,tab:'overview',timers:{},cache:{}};
const T=(zh,en)=>state.lang==='zh'?zh:(en||zh);

async function api(path,opts){
  const r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json'}},opts||{}));
  let data=null;try{data=await r.json()}catch(e){}
  if(r.status===401&&data&&data.need_login)return{__needLogin:true,status:401};
  if(r.status===401&&data&&data.need_admin)return{__needAdmin:true,status:401};
  return data||{ok:false,error:'http_'+r.status};
}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),2600)}
function dataTsHtml(ts,stale){return `<span class="data-ts${stale?' stale':''}">数据 ${fmtTs(ts)}</span>${stale?'<span class="stale-tag">STALE</span>':''}`}
function clearTimers(){Object.values(state.timers).forEach(clearTimeout);state.timers={}}
const tabRefresh={overview:120000,coins:300000,sentiment:1800000,flows:300000,markets:60000,liquidation:1800000,'chip-distribution':300000,signals:900000,access:60000,assets:300000,news:60000,lsr:300000,funding:300000,consensus:600000,countdown:60000,messages:60000,monitor:60000,research:120000,today:120000,'market-map':300000,events:300000,'cross-asset':300000,watchlist:300000};
function startTabTimer(id,fn){clearTimeout(state.timers[id+'_t']);state.timers[id+'_t']=setTimeout(()=>{if(state.tab===id)fn();startTabTimer(id,fn)},tabRefresh[id]||120000)}

/* ================= Tab 定义 ================= */

/* ================= 引擎编号体系（统一 X1 格式） =================
 * 回测策略 α1 破浪 / β2 观澜 已除名（回测系统保留后台 · 历史价格数据保留）
 * 生产引擎：γ1 天机(SmartSignal) δ1 方向 ε1 判官 ζ1 预言机 η1 观点
 *           θ1 季节 ι1 威廉分析 κ1 宏观 λ1 KOL μ1 清算技术 ν1 LSR ξ1 筹码
 */
const ENGINES={
  tianji:{id:'γ1',zh:'天机 SmartSignal',en:'TIANJI',color:'#5f9e7a'},
  dir:{id:'δ1',zh:'方向引擎',en:'Direction',color:'#4da6ff'},
  verdict:{id:'ε1',zh:'判官引擎',en:'Verdict',color:'#5f9e7a'},
  oracle:{id:'ζ1',zh:'预言机',en:'Oracle',color:'#7c4dff'},
  hero:{id:'η1',zh:'观点引擎',en:'Hero Brief',color:'#d9a441'},
  altseason:{id:'θ1',zh:'季节引擎',en:'Altseason',color:'#ff8c4d'},
  william:{id:'ι1',zh:'威廉分析',en:'William AI',color:'#d9a441'},
  board:{id:'κ1',zh:'宏观仪表盘',en:'Asset Board',color:'#4da6ff'},
  kol:{id:'λ1',zh:'KOL 抓取',en:'KOL Watch',color:'#7c4dff'},
  qibao:{id:'μ1',zh:'清算技术知识',en:'Qibao',color:'#e0b36a'},
  lsr:{id:'ν1',zh:'LSR 多空',en:'LSR',color:'#5f9e7a'},
  chip:{id:'ξ1',zh:'筹码分布',en:'Chip',color:'#4da6ff'}
};
function engBadge(key){
  const e=ENGINES[key];if(!e)return'';
  return '<span style="display:inline-block;background:'+e.color+';color:#fff;font-size:10px;font-weight:800;border-radius:4px;padding:1px 7px;margin-right:6px;font-family:var(--mono);vertical-align:2px">'+e.id+' '+T(e.zh,e.en)+'</span>';
}

const TABS=[
  {id:'today',zh:'今日',en:'Today',pub:true},
  {id:'overview',zh:'总览',en:'Overview',pub:true},
  {id:'market-map',zh:'市场地图',en:'Market Map',pub:true},
  {id:'coins',zh:'8币立场',en:'Stances',pub:true},
  {id:'sentiment',zh:'情绪',en:'Sentiment',pub:true},
  {id:'flows',zh:'资金流',en:'Flows',pub:true},
  {id:'assets',zh:'全球资产',en:'Global',pub:true},
  {id:'glossary',zh:'概念词典',en:'Glossary',pub:true},
  {id:'market-analysis',zh:'市场分析',en:'Market',pub:false},
  {id:'onchain',zh:'链上数据',en:'On-Chain',pub:false},
  {id:'liquidation',zh:'清算数据',en:'Liquidation',pub:false},
  {id:'chip-distribution',zh:'筹码分布',en:'Chip Distribution',pub:false},
  {id:'lsr',zh:'多空LSR',en:'LSR',pub:false},
  {id:'funding',zh:'费率套利',en:'Funding Arb',pub:false},
  {id:'news',zh:'消息面',en:'News',pub:false},
  {id:'events',zh:'事件日历',en:'Events',pub:false},
  {id:'cross-asset',zh:'跨资产',en:'Cross-Asset',pub:false},
  {id:'monitor',zh:'监测',en:'Monitor',pub:false},
  {id:'research',zh:'研究',en:'Research',pub:false},
  {id:'watchlist',zh:'自选',en:'Watchlist',pub:false},
  {id:'messages',zh:'留言',en:'Messages',pub:true,hide:true},
  {id:'account',zh:'登录/注册',en:'Account',pub:true},
  {id:'admin',zh:'后台',en:'Admin',pub:true,hide:true},
];

const GROUPS=[
  {id:'today',zh:'今日',en:'Today',icon:'☀️',subs:['today']},
  {id:'market',zh:'市场',en:'Market',icon:'📊',subs:['overview','market-map','coins','sentiment','flows','assets','glossary','market-analysis']},
  {id:'derivatives',zh:'衍生品',en:'Derivatives',icon:'⚙️',subs:['funding','lsr','liquidation','chip-distribution']},
  {id:'intel',zh:'情报',en:'Intel',icon:'📰',subs:['news','events','onchain','cross-asset']},
  {id:'research',zh:'研究',en:'Research',icon:'🔬',subs:['research']},
  {id:'monitor',zh:'监测',en:'Monitor',icon:'🛰️',subs:['monitor']},
  {id:'my',zh:'我的',en:'My',icon:'👤',subs:['account','watchlist']},
  {id:'admin',zh:'后台',en:'Admin',icon:'⚙',subs:['admin'],hide:true}
];
function tabMeta(id){ return TABS.find(t=>t.id===id); }
function activeGroup(){ return GROUPS.find(g=>g.subs.includes(state.tab))||GROUPS[0]; }
function renderNav(){
  const active=activeGroup();
  $('#tabnav').innerHTML=GROUPS.filter(g=>{
    if(g.id==='admin') return !!(state.user&&state.user.is_owner);
    if(g.hide) return false;
    return true; // 保留会员入口可见性：锁定组显示 ◆，点击进入锁卡
  }).map(g=>{
    const isActive=g.id===active.id;
    const allLocked=g.subs.every(id=>{const t=tabMeta(id);return t&&!t.pub;});
    return '<div class="tab'+(isActive?' active':'')+(allLocked&&!state.user?' member-tab':'')+'" data-group="'+g.id+'">'+(g.icon||'')+' '+(state.lang==='zh'?g.zh:g.en)+(allLocked&&!state.user?'<span class="lock">◆</span>':'')+'</div>';
  }).join('');
  $$('#tabnav .tab').forEach(el=>el.onclick=()=>{const g=GROUPS.find(x=>x.id===el.dataset.group);if(g)switchTab(g.subs[0])});
  const sub=$('#subnav');
  if(!sub)return;
  if(active.subs.length<2){sub.innerHTML='';sub.style.display='none';return;}
  sub.style.display='';
  sub.innerHTML=active.subs.map(id=>{
    const t=tabMeta(id);if(!t)return '';
    const locked=!t.pub&&!state.user;
    return '<button class="subtab'+(state.tab===id?' active':'')+(locked?' locked':'')+'" data-sub="'+id+'">'+(state.lang==='zh'?t.zh:t.en)+(locked?' ◆':'')+'</button>';
  }).join('');
  $$('#subnav .subtab').forEach(el=>el.onclick=()=>switchTab(el.dataset.sub));
}
function switchTab(id){
  let def=TABS.find(t=>t.id===id);
  if(!def){ const g=GROUPS.find(x=>x.id===id); if(g) return switchTab(g.subs[0]); return; }
  state.tab=id;clearTimers();renderNav();
  const main=$('#main');
  if(def.id==='admin'&&!state.admin){
    main.innerHTML='<div class="lock-card"><div class="lock-icon">🔒</div><div class="lock-title">'+T('仅后台可见','Admin Only')+'</div><div class="lock-desc">'+T('后台仅供管理员使用。','Admin console is admin-only.')+'</div><button class="btn" id="lockAdmin">'+T('进入后台','Enter Admin')+'</button></div>';
    $('#lockAdmin').onclick=()=>switchTab('admin');return;
  }
  const _vip=state.user&&state.user.vip;const _vipLocked=!def.pub&&state.user&&_vip&&_vip.expired;
  if(!def.pub&&(!state.user||_vipLocked)){main.innerHTML=lockCardHtml(def,_vip);bindLockCard();return}
  if(typeof PANELS[id]!=='function'){main.innerHTML='<div class="card">'+T('该模块暂未开放','Module not available')+'</div>';return}
  PANELS[id]();
}

function lockCardHtml(def,vip){
  const expired=vip&&vip.expired;
  return `<div class="lock-card">
    <div class="lock-icon">${expired?'⏳':'◆'}</div>
    <div class="lock-title">${T(expired?'会员已到期':'会员专享 · '+def.zh, expired?'Membership Expired':'Members Only')}</div>
    <div class="lock-desc">${expired
      ? T('您的会员已到期，额度已归零。请联系管理员续费后即可继续访问会员栏目。','Your membership has expired. Please contact admin to renew.')
      : T('本栏目为审批制会员内容。注册账号并通过管理员审批后即可解锁多空榜单、费率套利、KOL 共识、AI 日报与翻转倒计时。','This section is approval-gated. Register and wait for admin approval.')}</div>
    ${expired?'':'<button class="btn" id="lockLogin">'+T('登录','Sign in')+'</button>'}
    ${expired?'':'<button class="btn secondary" id="lockReg">'+T('注册（需管理员审批）','Register (approval required)')+'</button>'}
  </div>`;
}
function bindLockCard(){
  $('#lockLogin').onclick=()=>switchTab('account');
  $('#lockReg').onclick=()=>{switchTab('account');setTimeout(()=>{const f=$('#showReg');if(f)f.click()},50)};
}

;

'use strict';
/* ================= SVG 图表助手 ================= */
function gaugeSVG(score,min,max,opts){ // posture -5..+5 / fgi 0..100
  const o=Object.assign({size:200,label:'',color:'#d9a441'},opts||{});
  const frac=Math.max(0,Math.min(1,(score-min)/(max-min)));
  const cx=100,cy=95,r=78;
  const arc=(a0,a1,rad)=>{const p=a=>[cx+rad*Math.cos(Math.PI*(1-a)),cy-rad*Math.sin(Math.PI*(1-a))];const[x0,y0]=p(a0),[x1,y1]=p(a1);return`M ${x0} ${y0} A ${rad} ${rad} 0 0 1 ${x1} ${y1}`};
  const na=frac; // 0..1 映射半圆
  const nx=cx+r*Math.cos(Math.PI*(1-na)),ny=cy-r*Math.sin(Math.PI*(1-na));
  let ticks='';
  for(let i=0;i<=10;i++){const a=i/10,tx1=cx+(r-8)*Math.cos(Math.PI*(1-a)),ty1=cy-(r-8)*Math.sin(Math.PI*(1-a)),tx2=cx+(r-2)*Math.cos(Math.PI*(1-a)),ty2=cy-(r-2)*Math.sin(Math.PI*(1-a));ticks+=`<line x1="${tx1}" y1="${ty1}" x2="${tx2}" y2="${ty2}" stroke="#3c424d" stroke-width="1.5"/>`}
  const zoneColor=frac<0.33?'#c06a5e':frac<0.66?'#d9a441':'#5f9e7a';
  return `<svg viewBox="0 0 200 115" width="${o.size}" height="${o.size*0.575}">
    <path d="${arc(0,1,r)}" fill="none" stroke="#2a2f38" stroke-width="11" stroke-linecap="round"/>
    <path d="${arc(0,na,r)}" fill="none" stroke="${zoneColor}" stroke-width="11" stroke-linecap="round"/>
    ${ticks}
    <line x1="${cx}" y1="${cy}" x2="${nx*0.92+cx*0.08}" y2="${ny*0.92+cy*0.08}" stroke="#d8d5cd" stroke-width="2" transform="rotate(0 ${cx} ${cy})"/>
    <circle cx="${cx}" cy="${cy}" r="4" fill="#d8d5cd"/>
    <text x="18" y="112" fill="#6d6a62" font-size="9">${min}</text>
    <text x="176" y="112" fill="#6d6a62" font-size="9">${max}</text>
    <text x="100" y="112" fill="#6d6a62" font-size="8.5" text-anchor="middle">${esc(o.label)}</text>
  </svg>`;
}
function candleChartSVG(candles,opts){ // candles:[{t,o,h,l,c}]，opts.yLabel 自定义 y 轴标签
  const o=Object.assign({w:640,h:260,up:'#3aa06e',dn:'#e05a4e',yLabel:v=>fmtPrice(v)},opts||{});
  if(!candles||!candles.length)return'<div class="empty">no data</div>';
  const pad={l:46,r:10,t:14,b:24},W=o.w,H=o.h,iw=W-pad.l-pad.r,ih=H-pad.t-pad.b;
  const n=candles.length;
  const lo=Math.min(...candles.map(c=>c.l)),hi=Math.max(...candles.map(c=>c.h));
  const span=(hi-lo)||1;
  const x=i=>pad.l+iw*(i+0.5)/n;
  const y=v=>pad.t+ih*(1-(v-lo)/span);
  const cw=Math.max(2,iw/n*0.62);
  const ma=p=>{const out=[];for(let i=p-1;i<n;i++){let s=0;for(let j=0;j<p;j++)s+=candles[i-j].c;out.push({x:x(i),y:y(s/p)});}return out;};
  let g='';
  for(let i=0;i<=4;i++){const v=lo+span*i/4,yy=y(v);g+=`<line x1="${pad.l}" y1="${yy}" x2="${W-pad.r}" y2="${yy}" stroke="#31363f" stroke-width="0.5"/><text x="${pad.l-4}" y="${yy+3}" fill="#6d6a62" font-size="8" text-anchor="end">${esc(String(o.yLabel(v)))}</text>`}
  let body='';
  candles.forEach((c,i)=>{
    const up=c.c>=c.o;
    const col=up?o.up:o.dn;
    body+=`<line x1="${x(i)}" y1="${y(c.h)}" x2="${x(i)}" y2="${y(c.l)}" stroke="${col}" stroke-width="1"/>`;
    const yo=y(c.o),yc=y(c.c),bh=Math.max(1,Math.abs(yc-yo));
    body+=`<rect x="${x(i)-cw/2}" y="${Math.min(yo,yc)}" width="${cw}" height="${bh}" fill="${col}" rx="0.5"/>`;
  });
  const ma7=ma(7),ma25=ma(25);
  const line=(pts,col)=>{if(pts.length<2)return'';return'<path d="'+pts.map((p,j)=>(j?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1)).join(' ')+'" fill="none" stroke="'+col+'" stroke-width="1.2" opacity="0.85"/>';};
  // x 轴日期标签（首/中/末）
  const dLabel=c=>String(c.t||'').slice(5).replace('-','/');
  const xl=[candles[0],candles[Math.floor(n/2)],candles[n-1]].map((c,i)=>{
    const ix=i===0?0:i===1?Math.floor(n/2):n-1;
    return `<text x="${x(ix)}" y="${H-7}" fill="#6d6a62" font-size="8" text-anchor="middle">${esc(dLabel(c))}</text>`;
  }).join('');
  const tl=ma(7).length>=2?`<text x="${W-pad.r}" y="${pad.t-3}" fill="#5b8ff9" font-size="8" text-anchor="end">MA7</text>`:'';
  const tl2=ma(25).length>=2?`<text x="${W-pad.r-34}" y="${pad.t-3}" fill="#d9a441" font-size="8" text-anchor="end">MA25</text>`:'';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:${H+20}px">${g}${body}${line(ma7,'#5b8ff9')}${line(ma25,'#d9a441')}${xl}${tl}${tl2}</svg>`;
}
// 姿态评分 → K线（按 N 天合并，hist 需 oldest first）
function candlesFromHist(hist,n){
  const out=[];
  for(let i=0;i<hist.length;i+=n){
    const seg=hist.slice(i,i+n);
    if(!seg.length)continue;
    out.push({t:seg[0].date, o:seg[0].score, h:Math.max(...seg.map(x=>x.score)), l:Math.min(...seg.map(x=>x.score)), c:seg[seg.length-1].score});
  }
  return out;
}
function lineChartSVG(points,opts){ // points:[{x:label,y:value}] 或 [number]
  const o=Object.assign({w:640,h:200,color:'#d9a441',fill:true,yLabel:v=>v,gridN:4,xTickStep:0,xTickFmt:null,stretch:false,smooth:false,smoothTension:1,xCapacity:0},opts||{});
  // 颗粒聚合：xCapacity>0 且点数超容量 → 分段取末值（每点代表更长时间段，颗粒变大）
  const cap=o.xCapacity>0?o.xCapacity:0;
  let src=points.map(p=>typeof p==='number'?{y:p}:p);
  if(cap>0&&src.length>cap){
    const st=src.length/cap;const agg=[];
    for(let k=0;k<cap;k++){const i=Math.min(src.length-1,Math.round((k+1)*st)-1);agg.push(src[i]);}
    src=agg;
  }
  const vals=src.map(p=>p.y);
  if(!vals.length)return'<div class="empty">no data</div>';
  const autoMin=Math.min(...vals),autoMax=Math.max(...vals);
  const min=o.yMin!=null?o.yMin:autoMin,max=o.yMax!=null?o.yMax:autoMax,span=(max-min)||1;
  const pad={l:36,r:10,t:10,b:22};
  const W=o.w,H=o.h,iw=W-pad.l-pad.r,ih=H-pad.t-pad.b;
  // 左起流动：cap>0 时按容量分格（点少→曲线贴左生长，满容量→铺满并聚合变粗）；默认=点数（铺满旧行为）
  const g=(cap>0?cap:vals.length)||1;
  const xAt=i=>pad.l+iw*(vals.length===1?0.5:i/(g-1));
  const xy=(i,v)=>[xAt(i),pad.t+ih*(1-(v-min)/span)];
  // 曲线路径：Catmull-Rom → Bezier，smoothTension 控制弯曲程度（<1 更平缓）
  const mkPath=(closeBottom)=>{let d='';const n=vals.length,t=o.smoothTension;
    for(let i=0;i<n;i++){const p1=xy(i,vals[i]);
      if(i===0){d+='M'+p1[0].toFixed(1)+' '+p1[1].toFixed(1);continue}
      if(!o.smooth||n<3){d+='L'+p1[0].toFixed(1)+' '+p1[1].toFixed(1);continue}
      const p0=xy(Math.max(0,i-1),vals[Math.max(0,i-1)]),p2=xy(Math.min(n-1,i+1),vals[Math.min(n-1,i+1)]),p3=xy(Math.min(n-1,i+2),vals[Math.min(n-1,i+2)]);
      const c1x=p1[0]+(p2[0]-p0[0])/6*t,c1y=p1[1]+(p2[1]-p0[1])/6*t;
      const c2x=p2[0]-(p3[0]-p1[0])/6*t,c2y=p2[1]-(p3[1]-p1[1])/6*t;
      d+='C'+c1x.toFixed(1)+' '+c1y.toFixed(1)+' '+c2x.toFixed(1)+' '+c2y.toFixed(1)+' '+p2[0].toFixed(1)+' '+p2[1].toFixed(1)}
    if(closeBottom){d+=' L '+xy(vals.length-1,min)[0].toFixed(1)+' '+(pad.t+ih)+' L '+xy(0,min)[0].toFixed(1)+' '+(pad.t+ih)+' Z'}
    return d};
  const path=mkPath(false);
  const area=mkPath(true);
  let grid='';
  const N=o.gridN;
  for(let i=0;i<=N;i++){const v=min+span*i/N,y=pad.t+ih*(1-i/N);grid+=`<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="#31363f" stroke-width="0.5"/><text x="${pad.l-5}" y="${y+3}" fill="#6d6a62" font-size="8" text-anchor="end">${esc(o.yLabel(v))}</text>`}
  // 垂直网格线 + 横轴刻度（xTickStep>0 时开启，形成框格）
  if(o.xTickStep>0&&points.length>1){
    for(let i=0;i<points.length;i++){
      if(i%o.xTickStep!==0&&i!==points.length-1)continue;
      const x=xy(i,min)[0];
      grid+=`<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t+ih}" stroke="#31363f" stroke-width="0.5" stroke-dasharray="2,3"/>`;
      if(o.xTickFmt)grid+=`<text x="${x}" y="${H-6}" fill="#6d6a62" font-size="8" text-anchor="middle">${esc(o.xTickFmt(i))}</text>`;
    }
  }
  // 水平阈值参考线（hlines: [{y, color, dash, label}]）
  if(o.hlines){
    for(const hl of o.hlines){
      const hy=pad.t+ih*(1-(hl.y-min)/span);
      grid+=`<line x1="${pad.l}" y1="${hy}" x2="${W-pad.r}" y2="${hy}" stroke="${hl.color||'#6d6a62'}" stroke-width="0.8" stroke-dasharray="${hl.dash||'4,4'}" opacity="0.6"/>`;
      if(hl.label)grid+=`<text x="${W-pad.r-2}" y="${hy-2}" fill="${hl.color||'#6d6a62'}" font-size="7.5" text-anchor="end" opacity="0.8">${esc(hl.label)}</text>`;
    }
  }
  const dot=xy(vals.length-1,vals[vals.length-1]);
  // extras：叠加序列（高点连接虚线 + 标记点），与主图同坐标系
  let extrasHtml='';
  if(o.extras&&o.extras.length){
    extrasHtml=o.extras.map(function(ex){
      if(!ex.pts||ex.pts.length<1)return'';
      const n2=vals.length;
      const exPx=function(p){return[xAt(p.i),pad.t+ih*(1-(p.y-min)/span)]};
      const lift=ex.lift!=null?ex.lift:5;
      const dotSrc=ex.dots||ex.pts;
      const dots=ex.noDots?'':dotSrc.map(function(p){const q=exPx(p);return'<circle cx="'+q[0].toFixed(1)+'" cy="'+q[1].toFixed(1)+'" r="'+(ex.dotR||2.4)+'" fill="'+(ex.color||'#e0533d')+'" stroke="#14161a" stroke-width="1"/>'}).join('');
      if(ex.dotsOnly)return dots;
      if(ex.pts.length<2)return dots;
      // Catmull-Rom 平滑虚线
      let d='';const m=ex.pts.length,t=0.6;
      for(let k=0;k<m;k++){
        const p1=exPx(ex.pts[k]);
        if(k===0){d+='M'+p1[0].toFixed(1)+' '+(p1[1]-lift).toFixed(1);continue}
        const p0=exPx(ex.pts[Math.max(0,k-1)]),p2=exPx(ex.pts[Math.min(m-1,k+1)]),p3=exPx(ex.pts[Math.min(m-1,k+2)]);
        const c1x=p1[0]+(p2[0]-p0[0])/6*t,c1y=(p1[1]-lift)+((p2[1]-lift)-(p0[1]-lift))/6*t;
        const c2x=p2[0]-(p3[0]-p1[0])/6*t,c2y=(p2[1]-lift)-((p3[1]-lift)-(p1[1]-lift))/6*t;
        d+='C'+c1x.toFixed(1)+' '+c1y.toFixed(1)+' '+c2x.toFixed(1)+' '+c2y.toFixed(1)+' '+p2[0].toFixed(1)+' '+(p2[1]-lift).toFixed(1);
      }
      return '<path d="'+d+'" fill="none" stroke="'+(ex.color||'#e0533d')+'" stroke-width="1.2" stroke-dasharray="4,3" opacity="0.85"/>'+dots;
    }).join('');
  }
  const svg=`<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="${o.stretch?'min-width:'+W+'px;display:block;':'max-height:'+(H+20)+'px;'}">
    ${grid}
    ${o.fill?`<path d="${area}" fill="${o.color}" opacity="0.12"/>`:''}
    ${extrasHtml}
    <path d="${path}" fill="none" stroke="${o.color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${dot[0]}" cy="${dot[1]}" r="3" fill="${o.color}"/>
    <text x="${dot[0]-4}" y="${dot[1]-7}" fill="${o.color}" font-size="9" text-anchor="end">${esc(String(Math.round(vals[vals.length-1]*100)/100))}</text>
  </svg>`;
  return o.stretch?`<div style="overflow-x:auto;padding-bottom:2px">${svg}</div>`:svg;
}
/* ---- [batch4] 各闪烁区独立逻辑（不共用函数，各自按极端程度/变化速度映射闪烁频率） ---- */
// 通用：把 0~1 强度映射为闪烁周期（秒）。越极端值越接近1，周期越短闪越快。
function __flickDurOf(v){
  v=Math.max(0,Math.min(1,Number(v)||0));
  if(v<0.35) return 0;                 // 平稳/中性，不闪
  if(v>=0.85) return 0.32;
  if(v>=0.70) return 0.48;
  if(v>=0.50) return 0.68;
  return 1.05;
}

/* 清算大额闪烁：主流币白名单 + 绝对金额双门槛。低市值冷门币一律不闪。
   白名单 = 系统监控主流币 + 补充主流大币；金额>=5M 开始闪，>=100M 最快。
   极端双杀（多空都 >=5M）时双双闪烁。 */
var LIQ_FLICK_MAJOR = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','LINK','LTC','BCH','AVAX','DOT','TRX','TON','NEAR','APT','SUI','ARB','OP','UNI','AAVE','XLM','FIL','ICP'];
function __liqFlickDur(usd){
  var v=Number(usd)||0;
  if(v < 5e6) return 0;       // < 500万美元：不闪
  if(v >= 100e6) return 0.45; // >=1亿：最快
  if(v >= 30e6) return 0.6;   // 3000万~1亿
  if(v >= 10e6) return 0.8;   // 1000万~3000万
  return 1.1;                 // 500万~1000万：开始慢闪
}
function liqFlickStyleFor(symbol, usd){
  var s=String(symbol||'').toUpperCase().replace(/1000/,'');  // 归一化 1000PEPE -> PEPE
  if(LIQ_FLICK_MAJOR.indexOf(s)<0) return '';  // 非主流币：不闪
  var dur=__liqFlickDur(usd);
  if(!dur) return '';
  return 'animation:liqFlick '+dur+'s ease-in-out infinite;';
}
// 兼容旧调用（无 symbol）：仅按金额判断（用于汇总卡，汇总卡无低市值问题）
function liqFlickStyle(usd){
  var dur=__liqFlickDur(usd);
  if(!dur) return '';
  return 'animation:liqFlick '+dur+'s ease-in-out infinite;';
}

/* ① ETF 流入条闪烁：按单根柱「净流入/流出额」偏离 14 日均值的幅度算强度，
   但绝对值低于门槛（噪音级小柱子）一律不闪，避免量少却闪得同样凶。 */
var ETF_FLICK_ABS_MIN = 150;   // 绝对值门槛：|净流入/流出| < 150M 不闪（单位：百万美元）
function etfBarFlickDur(value, mean){
  // 绝对值门槛：小柱子不闪
  var absVal = Math.abs(Number(value) || 0);
  if (absVal < ETF_FLICK_ABS_MIN) return 0;
  var diff=Math.abs(Number(value)-Number(mean));
  var base=Math.max(Math.abs(Number(value)), Math.abs(Number(mean)), 1);
  var it=diff/base;
  return __flickDurOf(it);            // 0 或 0.32/0.48/0.68/1.05
}

/* ② 8币立场「强硬方向」徽章闪烁：bullish/bearish 及强倾向档位才闪，按置信度加成。 */
function stanceBadgeFlickStyle(stance, confidence){
  var hard={bullish:1,bearish:1,aggressive:0.9,offensive:0.9,defensive:0.9,risk_on:0.9,risk_off:0.9};
  var mid={cautiously_bullish:0.6,cautiously_bearish:0.6};
  var base=hard[stance]||mid[stance]||0;
  if(!base) return '';
  var conf=Number(confidence)||0;
  // 置信度越高，越极端，闪越快
  var it=Math.min(1, base*(0.65 + 0.35*Math.max(0,Math.min(1,conf))));
  var dur=__flickDurOf(it);
  if(!dur) return '';
  return 'animation:barFlick '+dur+'s ease-in-out infinite;';
}

/* ③ 姿态评分 30 日趋势快速变化闪烁：按最近评分变化幅度(delta)定强度，变化越快闪越快。 */
function postureTrendFlickStyle(delta){
  // delta 约 0~5 分变化，做归一化
  var it=Math.min(1, Number(delta||0)/3);
  var dur=__flickDurOf(it);
  if(!dur) return '';
  return 'animation:barFlick '+dur+'s ease-in-out infinite;';
}

/* ④ FGI 极端/快速变化闪烁：越偏离 50 中枢越极端，闪越快（双向：极度恐惧/极度贪婪都闪）。 */
function fgiFlickStyle(value){
  var v=Number(value);
  if(v==null||isNaN(v)) return '';
  var it=Math.abs(v-50)/50;          // 0(中性) ~ 1(极度恐惧/贪婪)
  var dur=__flickDurOf(it);
  if(!dur) return '';
  return 'animation:edgeFlick '+dur+'s ease-in-out infinite;';
}

/* ⑤ 爆仓较多一方闪烁：多空爆仓占比差越大，占优一方闪越快。 */
function liqSideFlickStyle(longPct, shortPct){
  var diff=Math.abs(Number(longPct)-Number(shortPct))/100; // 0~1
  var dur=__flickDurOf(diff);
  if(!dur) return '';
  return 'animation:barFlick '+dur+'s ease-in-out infinite;';
}

function barChartSVG(items,opts){ // items:[{label,value,color?}]
  const o=Object.assign({w:640,h:220,color:'#d9a441'},opts||{});
  if(!items.length)return'<div class="empty">no data</div>';
  const pad={l:8,r:8,t:14,b:26},W=o.w,H=o.h,iw=W-pad.l-pad.r,ih=H-pad.t-pad.b;
  const maxAbs=Math.max(...items.map(i=>Math.abs(i.value)),1);
  const zeroY=pad.t+ih*(items.some(i=>i.value<0)?maxAbs/(2*maxAbs):1);
  const scale=v=>ih*(Math.abs(v)/(2*maxAbs));
  const bw=Math.min(28,iw/items.length*0.62);
  let bars='',labels='';
  items.forEach((it,i)=>{
    const x=pad.l+iw*(i+0.5)/items.length-bw/2;
    const h=scale(it.value);
    const y=it.value>=0?zeroY-h:zeroY;
    const c=it.color||(it.value>=0?'var(--up)':'var(--down)');
    // [batch4] ETF 流入条闪烁：按每根柱相对 14 日均值的偏离度决定是否闪及频率（独立逻辑，不依赖统一函数）
    const mean=items.reduce(function(s,o){return s+o.value;},0)/items.length;
    const flickDur=etfBarFlickDur(it.value, mean);
    const flickAttr=flickDur>0?(' class="bar-flick" style="--flick-dur:'+flickDur+'s"'):'';
    bars+=`<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(h,1)}" fill="${c}" opacity="0.85" rx="2"${flickAttr}/>
      <text x="${x+bw/2}" y="${it.value>=0?y-4:y+h+11}" fill="${c}" font-size="8.5" text-anchor="middle">${esc(String(it.value))}</text>`;
    labels+=`<text x="${x+bw/2}" y="${H-8}" fill="#6d6a62" font-size="8" text-anchor="middle">${esc(it.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:${H+20}px">
    <line x1="${pad.l}" y1="${zeroY}" x2="${W-pad.r}" y2="${zeroY}" stroke="#3c424d" stroke-width="1"/>
    ${bars}${labels}
  </svg>`;
}

/* ================= PANEL: 总览 ================= */
const PANELS={};

PANELS.overview=async function(){startTabTimer('overview',PANELS.overview);
  // Coinglass Pro 摘要卡（2026-08-22：会员可见，异步填充）
  try {
    api('/api/cgpro/summary').then(function(r){
      if(!r||!r.ok) return;
      const el=$('#cgproCard'); if(!el) return;
      const up=r.heatmap?(r.heatmap.upUsd+'M'):'—', dn=r.heatmap?(r.heatmap.downUsd+'M'):'—';
      const bias=r.heatmap&&r.heatmap.bias==='up'?'上方阻力更强':'下方支撑更强';
      const ord=(r.orders||[]).map(function(o){return '<span style="display:inline-block;background:var(--bg2);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:10px;font-family:var(--mono)">'+esc(o.sym)+' '+(o.side==='long'?'多':'空')+' $'+Math.round(o.usd/1000)+'K</span>';}).join(' ')||'无';
      const mp=r.maxPain?('多痛点 '+r.maxPain.long+' / 空痛点 '+r.maxPain.short):'—';
      const wh=r.whale?('鲸鱼多空比 '+r.whale.ratio+'（多 $'+Math.round(r.whale.longUsd/1e6)+'M / 空 $'+Math.round(r.whale.shortUsd/1e6)+'M）'):'—';
      el.innerHTML='<div class="card-title" style="justify-content:space-between"><span>🔬 Coinglass Pro</span><span class="data-ts">'+T('专业清算增强 · 每5分钟','Pro liquidation · 5min')+'</span></div>'
        +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">'
        +'<div style="background:var(--bg1);border:1px solid var(--line);border-radius:10px;padding:8px 10px"><div style="font-size:10px;color:var(--text3)">🎯 '+T('BTC 清算强度（现价±5%）','Liq strength ±5%')+'</div><div style="font-size:13px;font-weight:700;font-family:var(--mono);margin-top:3px">'+T('上方','Up')+' '+up+' <span style="color:var(--text3)">vs</span> '+T('下方','Down')+' '+dn+'</div><div style="font-size:10px;color:var(--text2);margin-top:2px">'+bias+'</div></div>'
        +'<div style="background:var(--bg1);border:1px solid var(--line);border-radius:10px;padding:8px 10px"><div style="font-size:10px;color:var(--text3)">💥 '+T('大额清算（≥50万美元）','Big liq')+'</div><div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">'+ord+'</div></div>'
        +'<div style="background:var(--bg1);border:1px solid var(--line);border-radius:10px;padding:8px 10px"><div style="font-size:10px;color:var(--text3)">🧭 '+T('最大痛点 / 鲸鱼','Max pain / Whale')+'</div><div style="font-size:11px;font-family:var(--mono);margin-top:3px">'+mp+'</div><div style="font-size:10px;color:var(--text2);margin-top:2px">'+wh+'</div></div>'
        +'</div>';
    }).catch(function(){});
  } catch (e) {}

  // 二级数据速览：宏观体制 + 消息面多空（异步填充，不阻塞主内容）
  (function(){
    try {
      Promise.all([api('/api/macro/dashboard'), api('/api/news')]).then(function(r){
        var md = r[0], nw = r[1];
        var el = $('#ovSecondary'); if (!el) return;
        var regime = (md && md.ok && md.regime) ? esc(md.regime) : '—';
        var conf = (md && md.ok && md.confidence != null) ? md.confidence + '%' : '—';
        var share = (nw && nw.ok && nw.bias_24h && nw.bias_24h.scored) ? nw.bias_24h.bull_share : null;
        var shareTxt = share == null ? '—' : share.toFixed(1) + '%';
        var shareCls = share == null ? '' : share >= 58 ? 'up' : share <= 42 ? 'down' : 'mid';
        el.innerHTML = '<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn secondary" style="font-size:12px;padding:6px 12px" onclick="switchTab(\'assets\')">🌐 '+T('宏观体制','Macro Regime')+'：<b>'+regime+'</b>（'+conf+'）</button><button class="btn secondary" style="font-size:12px;padding:6px 12px" onclick="switchTab(\'news\')">📰 '+T('消息面多头占比','News bull share')+'：<b class="'+shareCls+'">'+shareTxt+'</b></button></div></div>';
      }).catch(function(){});
    } catch (e) {}
  })();

  const main=$('#main');
  main.innerHTML='<div class="card" style="text-align:center;padding:60px 20px;animation:fadeIn .3s">加载中…</div>';
  try{
    const d=await api('/api/overview');
    if(!d.ok){main.innerHTML='<div class="card">'+T('数据不可用','Data unavailable')+'</div>';return}
    var hb=d.hero_brief||null;
    var hbHistory=d.hero_brief_history||[];
    var heroHtml='';
    if(hb){
      var toneCls=hb.tone||'neutral';
      var headline=esc(state.lang==='zh'?hb.headline_zh:hb.headline_en);
      var quote=esc(state.lang==='zh'?hb.quote_zh:hb.quote_en);
      var pills=(hb.stance_pills||[]).map(function(p){return '<span class="hb-pill '+esc(p.tone)+'">'+esc(state.lang==='zh'?p.label_zh:p.label_en)+'</span>';}).join('');
      var hh='';
      if(hbHistory.length){
        window._hbData=hbHistory.slice(0,7);
        var hbItems=window._hbData.map(function(h,hi){var hl=esc((state.lang==='zh'?h.headline_zh:h.headline_en)||'').slice(0,50);
          return '<div class="hb-history-item" onclick="openHbCard('+hi+')"><span class="hb-history-date">'+(h.report_date||'')+'</span><span style="flex:1">'+hl+'</span><span class="hb-history-arrow">▸</span></div>';});
        hh='<div class="hb-history-toggle" onclick="toggleHbHistoryList()"><span>'+T('历史观点','PAST BRIEFS')+'</span><span class="hb-history-arrow" id="hb-history-list-arrow">▾</span></div>'
          +hbItems[0]
          +(hbItems.length>1?'<div id="hb-history-list" style="display:none">'+hbItems.slice(1).join('')+'</div>':'');
      }
      var dirMap={'看涨':['#2e7d5b','🐂'],'偏多':['#57a04a','📈'],'中性':['#d99e2b','⚖️'],'偏空':['#e0703a','📉'],'看跌':['#b83a2e','🐻'],'bullish':['#2e7d5b','🐂'],'bearish':['#b83a2e','🐻'],'cautious':['#d99e2b','⚖️'],'mixed':['#d99e2b','⚖️']};
      var dirC=hb.direction?dirMap[hb.direction]:null;
      var dirHtml=dirC?'<span class="hb-dir" style="display:inline-block;background:'+dirC[0]+';color:#fff;font-size:11px;font-weight:800;border-radius:4px;padding:2px 8px;margin-left:8px">'+dirC[1]+' '+esc(hb.direction)+'</span>':'';
      var klHtml=hb.key_levels?'<div class="hb-levels" style="margin-top:6px;font-size:11px;color:var(--amber);font-family:var(--mono)">🎯 '+esc(hb.key_levels)+'</div>':'';
      heroHtml='<div class="hero-brief">'+engBadge('verdict')+'<div style="color:#d4af37;font-size:12px;font-weight:700;margin-bottom:8px">'+T('今日主要观点：','Daily Key Points:')+'</div><div class="hb-headline">'+headline+dirHtml+'</div><div class="hb-quote">'+quote+'</div>'+klHtml+(pills?'<div class="hb-pills">'+pills+'</div>':'')+(hh?'<div class="hb-history">'+hh+'</div>':'')+'<div class="hb-meta"><span>'+(hb.generated_at?hb.generated_at.slice(0,10):'')+'</span><span>'+T('情绪','Tone')+': '+esc(toneCls)+'</span></div></div>';
    }
    var v=d.verdict||{},p=d.posture||{},hist=d.posture_history||[];
    var score=p&&p.score!=null?Number(p.score):0;
    var pState=p&&p.state?p.state:'neutral';
    var days=p&&p.days_held!=null?p.days_held:0;
    
    // Compute gauge needle angle: -5→-90deg, +5→+90deg
    var angle=Math.max(-90,Math.min(90,score/5*90));
    var zoneColor=score<-1.5?'#c06a5e':score<0?'#c0854e':score<1.5?'#c0854e':'#5f9e7a';
    var stateZh={'defensive':'防御','neutral':'中性','offensive':'进攻','cautious':'谨慎','aggressive':'积极','risk_off':'避险','risk_on':'进攻'}[pState]||pState;
    var stateEn={'defensive':'Defensive','neutral':'Neutral','offensive':'Offensive','cautious':'Cautious','aggressive':'Aggressive','risk_off':'Risk Off','risk_on':'Risk On'}[pState]||pState;
    var stateLabel=T(stateZh,stateEn);
    
    // Gauge SVG with needle animation (via CSS var)
    var gaugeSvg=(function(){
      var cx=110,cy=116,R=80;
      var angOf=function(s){return Math.PI*(1-(s+5)/10);}; // -5→180°, +5→0°
      var pt=function(s,r){var a=angOf(s);return [cx+r*Math.cos(a), cy-r*Math.sin(a)];};
      var arc='M '+pt(-5,R)[0].toFixed(1)+' '+pt(-5,R)[1].toFixed(1)+' A '+R+' '+R+' 0 0 1 '+pt(5,R)[0].toFixed(1)+' '+pt(5,R)[1].toFixed(1);
      // 刻度：每 1 格，主刻度（偶）带标签
      var ticks='';
      for(var i=0;i<=10;i++){
        var s=-5+i;
        var major=(i%2===0);
        var p1=pt(s,major?62:67), p2=pt(s,72);
        ticks+='<line x1="'+p1[0].toFixed(1)+'" y1="'+p1[1].toFixed(1)+'" x2="'+p2[0].toFixed(1)+'" y2="'+p2[1].toFixed(1)+'" stroke="'+(major?'#59616e':'#3a404b')+'" stroke-width="'+(major?1.6:1)+'"/>';
        if(major){
          var pl=pt(s,52);
          ticks+='<text x="'+pl[0].toFixed(1)+'" y="'+(pl[1]+3).toFixed(1)+'" fill="#6d6a62" font-size="8" text-anchor="middle" font-family="var(--mono)">'+(s>0?'+':'')+s+'</text>';
        }
      }
      // 指针（弹性动画）+ 中心轴 + 光晕
      var needle='<g style="transform-box:view-box;transform-origin:'+cx+'px '+(cy-3)+'px;transition:transform 1s cubic-bezier(.34,1.56,.64,1);transform:rotate('+angle+'deg)">'
        +'<line x1="'+cx+'" y1="'+(cy-3)+'" x2="'+cx+'" y2="'+(cy-70)+'" stroke="'+zoneColor+'" stroke-width="3" stroke-linecap="round"/>'
        +'<line x1="'+cx+'" y1="'+(cy-3)+'" x2="'+cx+'" y2="'+(cy-4)+'" stroke="'+zoneColor+'" stroke-width="5" stroke-linecap="round" opacity="0.25"/>'
        +'<line x1="'+cx+'" y1="'+(cy-3)+'" x2="'+cx+'" y2="'+(cy+14)+'" stroke="'+zoneColor+'" stroke-width="3" stroke-linecap="round" opacity="0.4"/>'
        +'</g>';
      return '<svg viewBox="0 0 220 154" style="max-width:250px"><defs>'
        +'<linearGradient id="gGrad" x1="0" y1="0" x2="1" y2="0">'
        +'<stop offset="0%" stop-color="#c06a5e"/><stop offset="26%" stop-color="#c06a5e"/>'
        +'<stop offset="40%" stop-color="#d98b4a"/><stop offset="50%" stop-color="#d9a441"/>'
        +'<stop offset="60%" stop-color="#7fae4a"/><stop offset="74%" stop-color="#5f9e7a"/><stop offset="100%" stop-color="#3aa06e"/>'
        +'</linearGradient>'
        +'<filter id="gShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="#000" flood-opacity="0.5"/></filter>'
        +'</defs>'
        +'<path d="'+arc+'" fill="none" stroke="#20252d" stroke-width="15" stroke-linecap="round"/>'
        +'<path d="'+arc+'" fill="none" stroke="url(#gGrad)" stroke-width="10" stroke-linecap="round"/>'
        +'<path d="'+arc+'" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" opacity="0.14"/>'
        +ticks
        +'<circle cx="'+cx+'" cy="'+(cy-3)+'" r="11" fill="'+zoneColor+'" opacity="0.14"/>'
        +needle
        +'<circle cx="'+cx+'" cy="'+(cy-3)+'" r="5.5" fill="'+zoneColor+'"/>'
        +'<circle cx="'+cx+'" cy="'+(cy-3)+'" r="2.6" fill="var(--bg0)"/>'
        +'<text x="'+cx+'" y="145" fill="#d4af37" font-size="10.5" text-anchor="middle" letter-spacing="2" font-weight="600">姿态评分 · POSTURE SCORE</text>'
        +'</svg>';
    })();
    
    // Factor chips
    var factorHtml='';
    if(p.factors&&p.factors.length){
      factorHtml='<div class="factor-grid">'+p.factors.map(function(f){
        var fv=Number(f.score||0).toFixed(2);
        var cls=fv>0?'pos':fv<0?'neg':'zero';
        return '<div class="factor-item"><span class="fl">'+(state.lang==='zh'?esc(f.label_zh):esc(f.label_en))+'</span><span class="fv '+cls+'">'+(fv>0?'+':'')+fv+'</span></div>';
      }).join('')+'</div>';
    }
    
    // Historical chart (posture scores)
    var chartHtml='<div class="empty" style="text-align:center;padding:30px;color:var(--text3);font-size:12px">'+T('暂无历史数据','No history')+'</div>';
    if(hist.length>=2){
      var pts=hist.slice().reverse(); // oldest first
      // Use the lineChartSVG with enhanced styling
      // 纵坐标固定 -4 ~ +4（姿态评分标准区间）
      var min=-3, max=3;
      chartHtml=lineChartSVG(pts.map(function(h){return{x:h.date,y:Number(h.score.toFixed(1))}}),{
        color:'#d9a441',fill:true,yLabel:function(v){return v.toFixed(1)},
        w:760,h:170,gridN:8,stretch:true,smooth:true,smoothTension:0.6,
        yMin:-3,yMax:3, // 纵坐标固定 -3 ~ +3
        xTickStep:Math.max(1,Math.ceil(pts.length/8)),
        xTickFmt:function(i){return pts[i].date.slice(5)}
      });
      // Add conviction/state dots below chart
      chartHtml+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;justify-content:center">'
        +pts.slice(-7).map(function(h){
          var dotClr=h.state==='defensive'?'#c06a5e':h.state==='neutral'?'#d9a441':h.state==='offensive'?'#5f9e7a':'#6d6a62';
          return '<span style="font-size:9px;color:var(--text3)"><span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:'+dotClr+';margin-right:3px;vertical-align:middle"></span>'+h.date.slice(5)+'</span>';
        }).join('')
        +'</div>';
    }
    
    // Verdict & rationale
    var headline=state.lang==='zh'?(v.headline_zh||''):(v.headline_en||'');
    var rationale=state.lang==='zh'?(p.rationale_zh||v.rationale_zh||''):(p.rationale_en||v.rationale_en||'');
    var whatsnew=state.lang==='zh'?(v.whats_new_zh||''):(v.whats_new_en||'');
    
    // Stance distribution bar
    var sd=v.stance_distribution||{};
    var totalStances=(sd.bullish||0)+(sd.neutral||0)+(sd.bearish||0);
    var stanceBar=totalStances?'<div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin:6px 0">'
      +'<div style="flex:'+(sd.bullish||0)+';background:var(--up);opacity:.7"></div>'
      +'<div style="flex:'+(sd.neutral||0)+';background:var(--yellow);opacity:.7"></div>'
      +'<div style="flex:'+(sd.bearish||0)+';background:var(--down);opacity:.7"></div>'
      +'</div>':'';
    
    // 多尺度切换：30日=姿态趋势（默认），3日K/周K/10日K/月K=BTC 蜡烛图（document 委托，避免 DOM 未就绪）
    window.__pcChartHtml=chartHtml;
    window.__pcHist=(hist||[]).slice().reverse(); // oldest first
    if(!window.__pcBound){
      window.__pcBound=true;
      document.addEventListener('click',function(ev){
        const btn=ev.target.closest && ev.target.closest('.tf-btn');
        if(!btn||!btn.closest('#pcBar'))return;
        Array.prototype.forEach.call(document.querySelectorAll('#pcBar .tf-btn'),b=>b.classList.toggle('on',b===btn));
        const tf=btn.dataset.tf, box=$('#pcBox'), title=$('#pcTitle');
        if(!box)return;
        if(tf==='30d'){ box.innerHTML=window.__pcChartHtml||''; if(title){var _ph=window.__pcHist||[];var _dP=0;if(_ph.length>=3){var _a=_ph[_ph.length-1].score,_b=_ph[_ph.length-4>=0?_ph.length-4:_ph.length-1].score;_dP=Math.abs(_a-_b);}title.textContent=T('姿态评分 30 日趋势','Posture Score 30d Trend');title.style.animation = postureTrendFlickStyle(_dP);} return; }
        const n=tf==='3d'?3:tf==='1w'?7:tf==='10d'?10:30;
        const candles=candlesFromHist(window.__pcHist||[],n);
        if(candles.length<2){ box.innerHTML='<div class="empty">'+T(T('暂无足够历史','Not enough history'),'Not enough history')+'</div>'; if(title)title.textContent=T('姿态评分 '+tf+' K线','Posture '+tf+' K'); return; }
        if(title)title.textContent=T('姿态评分 '+tf+' K线','Posture '+tf+' K');
        box.innerHTML=candleChartSVG(candles,{w:640,h:260,yLabel:v=>Number(v).toFixed(1)});
      });
    }
    main.innerHTML='<div id="ovSecondary"></div>'+heroHtml+'<div class="posture-dashboard">'
      // LEFT: Speedometer
      +'<div class="posture-gauge"><div class="gauge-score-text" style="color:'+zoneColor+'">'+(score>0?'+':'')+score.toFixed(1)+'</div>'
      +'<div class="gauge-state-text" style="color:'+zoneColor+'">'+stateLabel+'</div>'
      +gaugeSvg
      +'<div class="gauge-sub"><span>📅 '+T('已维持','Held')+' '+days+'d</span><span>⚡ '+T('信念','Conviction')+' '+esc(p.conviction&&p.conviction.code?T(p.conviction.zh||p.conviction.code,p.conviction.en||p.conviction.code):'—')+'</span></div>'
      +'</div>'
      // RIGHT: Change curve
      +'<div class="posture-chart"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      +'<div class="chart-title" id="pcTitle" style="margin-bottom:0">'+T('姿态评分 30 日趋势','Posture Score 30d Trend')+'</div>'
      +'<div class="tf-bar" id="pcBar">'
      +'<button class="tf-btn on" data-tf="30d">'+T('30日','30d')+'</button>'
      +'<button class="tf-btn" data-tf="3d">'+T('3日K','3d K')+'</button>'
      +'<button class="tf-btn" data-tf="1w">'+T('周K','1w K')+'</button>'
      +'<button class="tf-btn" data-tf="10d">'+T('10日K','10d K')+'</button>'
      +'<button class="tf-btn" data-tf="1M">'+T('月K','1M K')+'</button>'
      +'</div></div>'
      +'<div class="chart-box" id="pcBox">'+chartHtml+'</div>'
      +stanceBar
      +'<div style="display:flex;gap:6px;flex-wrap:wrap;font-size:10px;color:var(--text3);margin-top:6px"><span>🐂 '+T('看多','Bull')+' '+(sd.bullish||0)+'</span><span>⚪ '+T('中性','Neutral')+' '+(sd.neutral||0)+'</span><span>🐻 '+T('看空','Bear')+' '+(sd.bearish||0)+'</span></div>'
      +'</div>'
      // Full-width factors & rationale
      +'</div>'
      +'<div class="card" style="animation:slideUp .6s ease-out .3s both;margin-top:16px">'
      +'<div class="card-title">🧠 '+T('William 每日分析','William Daily Analysis')
      +'<span style="margin-left:auto" class="data-ts">'+T('宏观+资金+情绪+技术+事件 · 每日 08:00 更新 · DeepSeek','5-dim · daily 08:00 · DeepSeek')+'</span></div>'
      +'<div class="daily-ts">▼ '+T('时间轴（最新在上）','Timeline (newest first)')+' ▼</div>'
      +'<div id="dailyBox" class="empty">'+T('加载中…','Loading…')+'</div>'
      +'</div>';
    // OI 摘要卡已移除（总览精简）

  // William 每日分析（S 型时间轴）
  const loadDaily = async () => {
    const box = $('#dailyBox');
    if (!box) return;
    try {
      const r = await fetch('/api/daily-analysis').then(x => x.json());
      if (!r || !r.ok || !r.rows.length) { box.innerHTML = '<div class="empty">'+T('暂无分析（每日 08:00 自动生成）','No analysis yet')+'</div>'; return; }
      const rows = r.rows; // date DESC，最新在上
      const isMobile = window.innerWidth <= 760;
      const MOBILE_VISIBLE = 15;
      let visibleRows = rows;
      if (isMobile && rows.length > MOBILE_VISIBLE) visibleRows = rows.slice(0, MOBILE_VISIBLE);
      const META = { '看涨': { c: '#2e7d5b', e: '🐂' }, '偏多': { c: '#57a04a', e: '📈' }, '中性': { c: '#d99e2b', e: '⚖️' }, '偏空': { c: '#e0703a', e: '📉' }, '看跌': { c: '#b83a2e', e: '🐻' } };
      const gradColors = rows.map(function (d) { const mm = META[d.label]; return (mm && mm.c) || d.color || '#d99e2b'; }).join(',');
      let html = '<div class="daily-s" style="--sgrad:linear-gradient(180deg,' + gradColors + ')">';
      visibleRows.forEach(function (d, idx) {
        const m = META[d.label] || { c: d.color || '#d9a441', e: '•' };
        const cls = idx % 2 === 0 ? 'odd' : 'even';
        html += '<div class="daily-node ' + cls + '" onclick="showDailyCard(' + idx + ')"><div class="inner">'
          + '<span class="daily-emoji" style="color:' + m.c + '">' + m.e + '</span>'
          + '<span class="daily-dot" style="color:' + m.c + ';background:' + m.c + '"></span>'
          + '<span class="daily-tag" style="background:' + m.c + '">' + esc(d.label) + '</span>'
          + '<span class="daily-date">' + esc(d.date.slice(5)) + '</span>'
          + '<span class="daily-sum">' + esc((d.summary || '').slice(0, 34)) + (d.summary && d.summary.length > 34 ? '…' : '') + '</span>'
          + '<span class="daily-arrow">▶</span>'
          + '</div></div>';
      });
      html += '</div>';
      if (isMobile && rows.length > MOBILE_VISIBLE) {
        html += '<div class="daily-fold" style="text-align:center;margin-top:14px"><button class="tf-btn" onclick="toggleDailyFold()" style="padding:6px 16px;font-size:11px">📅 展开更早 ' + (rows.length - MOBILE_VISIBLE) + ' 天 ▾</button></div>';
      }
      box.innerHTML = html;
      // 浮层小卡数据
      window.__dailyRows = rows;
    } catch (e) { box.innerHTML = '<div class="empty">❌ ' + esc(e.message) + '</div>'; }
  };
  // 浮层小卡（图层之上）

  window.toggleDailyFold = function () {
    const box = $('#dailyBox');
    if (!box) return;
    const rows = window.__dailyRows || [];
    const META = { '看涨': { c: '#2e7d5b', e: '🐂' }, '偏多': { c: '#57a04a', e: '📈' }, '中性': { c: '#d99e2b', e: '⚖️' }, '偏空': { c: '#e0703a', e: '📉' }, '看跌': { c: '#b83a2e', e: '🐻' } };
    const gradColors = rows.map(function (d) { const mm = META[d.label]; return (mm && mm.c) || d.color || '#d99e2b'; }).join(',');
    let html = '<div class="daily-s" style="--sgrad:linear-gradient(180deg,' + gradColors + ')">';
    rows.forEach(function (d, idx) {
      const m = META[d.label] || { c: d.color || '#d9a441', e: '•' };
      const cls = idx % 2 === 0 ? 'odd' : 'even';
      html += '<div class="daily-node ' + cls + '" onclick="showDailyCard(' + idx + ')"><div class="inner">'
        + '<span class="daily-emoji" style="color:' + m.c + '">' + m.e + '</span>'
        + '<span class="daily-dot" style="color:' + m.c + ';background:' + m.c + '"></span>'
        + '<span class="daily-tag" style="background:' + m.c + '">' + esc(d.label) + '</span>'
        + '<span class="daily-date">' + esc(d.date.slice(5)) + '</span>'
        + '<span class="daily-sum">' + esc((d.summary || '').slice(0, 34)) + (d.summary && d.summary.length > 34 ? '…' : '') + '</span>'
        + '<span class="daily-arrow">▶</span>'
        + '</div></div>';
    });
    html += '</div><div class="daily-fold" style="text-align:center;margin-top:14px"><button class="tf-btn" onclick="toggleDailyFold()" style="padding:6px 16px;font-size:11px">📅 收起 ▴</button></div>';
    box.innerHTML = html;
  };
  window.showDailyCard = function (idx) {
    const rows = window.__dailyRows || [];
    const d = rows[idx];
    if (!d) return;
    const m = META2[d.label] || { c: d.color || '#d9a441', e: '•' };
    const det = d.details || {};
    const btcs = d.btc || {}, eths = d.eth || {};
    let ov = document.getElementById('dailyOverlay');
    if (ov) ov.remove();
    ov = document.createElement('div');
    ov.id = 'dailyOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);animation:fadeIn .2s';
    ov.onclick = function () { ov.remove(); };
    const cls = idx % 2 === 0 ? 'odd' : 'even';
    const emojiRow = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">'
      + '<span style="font-size:26px">' + m.e + '</span>'
      + '<span style="font-size:16px;font-weight:800;color:' + m.c + '">' + esc(d.label) + '</span>'
      + '<span style="font-size:12px;color:var(--text3);font-family:var(--mono)">' + esc(d.date) + '</span>'
      + '</div>';
    const concl = d.conclusion ? '<div style="background:rgba(45,108,223,.1);border:1px solid rgba(45,108,223,.3);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px;line-height:1.7"><b style="color:var(--amber)">🧠 William 结论</b><br>' + esc(d.conclusion) + '</div>' : '';
    const dims = [
      [T('🌐 宏观','🌐 Macro'), det.macro], [T('💰 资金','💰 Funds'), det.fund], [T('😀 情绪','😀 Sentiment'), det.sentiment], [T('📈 技术','📈 Technical'), det.tech], [T('📰 事件','📰 Events'), det.events]
    ].filter(x => x[1]).map(x => '<div style="margin-top:7px"><b style="font-size:11px;color:var(--amber)">' + x[0] + '</b><div style="font-size:12px;color:var(--text2);line-height:1.65;margin-top:2px">' + esc(String(x[1]).slice(0, 130)) + (String(x[1]).length > 130 ? '…' : '') + '</div></div>').join('');
    const btcOk=btcs&&btcs.close!=null, ethOk=eths&&eths.close!=null;
    const dataRow = (btcOk||ethOk) ? '<div style="margin-top:9px;font-size:11px;color:var(--text3)">📊 '
      +(btcOk?('BTC $'+fmtPrice(btcs.close)+(btcs.chg_24h!=null?(' ('+(btcs.chg_24h>=0?'+':'')+btcs.chg_24h.toFixed(2)+'%)'):'')):'')
      +((btcOk&&ethOk)?' · ':'')
      +(ethOk?('ETH $'+fmtPrice(eths.close)+(eths.chg_24h!=null?(' ('+(eths.chg_24h>=0?'+':'')+eths.chg_24h.toFixed(2)+'%)'):'')):'')
      +'</div>' : '';
    ov.innerHTML = '<div onclick="event.stopPropagation()" style="background:var(--bg2);border:1px solid var(--line);border-radius:14px;max-width:520px;width:92%;max-height:78vh;overflow:auto;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.55)">'
      + '<div style="display:flex;justify-content:flex-end"><span onclick="document.getElementById(\'dailyOverlay\').remove()" style="cursor:pointer;color:var(--text3);font-size:16px">✕</span></div>'
      + emojiRow + concl + dims + dataRow
      + '<div style="margin-top:10px;font-size:10px;color:var(--text3)">William 每日分析 · DeepSeek 智能体 · 仅供研究</div>'
      + '</div>';
    document.body.appendChild(ov);
  };
  window.META2 = { '看涨': { c: '#2e7d5b', e: '🐂' }, '偏多': { c: '#57a04a', e: '📈' }, '中性': { c: '#d99e2b', e: '⚖️' }, '偏空': { c: '#e0703a', e: '📉' }, '看跌': { c: '#b83a2e', e: '🐻' } };
  loadDaily();
  if (!state.timers['daily']) { state.timers['daily'] = setInterval(() => { if (state.tab === 'overview') loadDaily(); }, 300000); }
  }catch(e){main.innerHTML='<div class="card">'+T('加载异常:','Error:')+' '+esc(e.message)+'</div>';}
};


/* ================= PANEL: 清算数据 ================= */
/* ================= PANEL: 清算数据 ================= */
  try { const _m=document.getElementById('main'); if(_m && !document.getElementById('cgproCard')) { const _c=document.createElement('div'); _c.id='cgproCard'; _c.className='card'; _c.style.marginTop='10px'; _c.innerHTML='<div class="empty">🔬 加载 Pro 数据…</div>'; _m.appendChild(_c); } } catch(e){}

PANELS.liquidation=async function(){startTabTimer('liquidation',PANELS.liquidation);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  try{
    const d=await fetch('/api/liquidation').then(function(r){return r.json()});
    if(!d||!d.ok){main.innerHTML='<div class="card">'+T('数据不可用','Data unavailable')+'</div>';return}
    const ex=d.exchanges||{};
    const names=Object.keys(ex).filter(function(n){return n!=='ALL'});
    if(ex.ALL&&ex.ALL.rows&&ex.ALL.rows.length)names.unshift('ALL');
    const dataMap={}; let grand=0;
    names.forEach(function(n){
      const rows=ex[n].rows||[];
      const total=rows.reduce((s,x)=>s+x.liq_24h,0);
      const longV=rows.reduce((s,x)=>s+x.long_24h,0);
      const shortV=rows.reduce((s,x)=>s+x.short_24h,0);
      const majorRows=rows.filter(function(x){return LIQ_FLICK_MAJOR.indexOf(String(x.symbol||'').toUpperCase().replace(/1000/,''))>=0;});
      const majorLongV=majorRows.reduce((s,x)=>s+(x.long_24h||0),0);
      const majorShortV=majorRows.reduce((s,x)=>s+(x.short_24h||0),0);
      dataMap[n]={rows:rows,total:total,longV:longV,shortV:shortV,majorLongV:majorLongV,majorShortV:majorShortV,covered:(n==='ALL'?ex.ALL.covered:1)};
      if(n!=='ALL')grand+=total; // ALL 本身=各所跨所汇总，只加非 ALL 避免 double-count
    });
    if(!names.length){main.innerHTML='<div class="card"><div class="card-title">💥 清算数据</div>'
      +'<div class="empty">数据源暂不可用（Coinglass API 未恢复），采集会自动重试</div>'
      +'<div class="data-ts" style="margin-top:6px">'+T('来源: ','Source: ')+'Coinglass Liquidation Coin List</div></div>';return}
    const tsHtml=(d.data_ts?'<span class="data-ts">数据 '+fmtTs(d.data_ts)+'</span>':'');
    function miniCard(name){
      const m=dataMap[name];
      const longPct=m.total>0?(m.longV/m.total*100):0;
      const shortPct=m.total>0?(m.shortV/m.total*100):0;
      const title=name==='ALL'?T('🌐 全平台','🌐 All'):esc(name);
      const sub=name==='ALL'?('覆盖 '+m.covered+' 所 · 24h 清算总额'):T('24h 清算总额','24h Liq Total');
      return '<div class="card" style="flex:1;min-width:220px"><div class="card-title" style="margin-bottom:8px">'
        +title+'</div>'
        +'<div style="font-size:22px;font-family:var(--mono);color:var(--down)">'+fmtUsd(m.total)+'</div>'
        +'<div style="font-size:11px;color:var(--text3);margin:2px 0 8px">'+sub+'</div>'
        +'<div style="display:flex;gap:16px;font-size:12px;margin-bottom:6px;flex-wrap:wrap">'
        +'<span style="color:var(--down);font-weight:700;'+(liqFlickStyle(m.majorLongV)?liqFlickStyle(m.majorLongV):'')+'" class="'+(liqFlickStyle(m.majorLongV)?'liq-flick':'')+'">多头爆仓 '+fmtUsd(m.longV)+' <span class="data-ts">'+longPct.toFixed(1)+'%</span></span>'
        +'<span style="color:var(--up);font-weight:700;'+(liqFlickStyle(m.majorShortV)?liqFlickStyle(m.majorShortV):'')+'" class="'+(liqFlickStyle(m.majorShortV)?'liq-flick':'')+'">空头爆仓 '+fmtUsd(m.shortV)+' <span class="data-ts">'+shortPct.toFixed(1)+'%</span></span>'
        +'</div>'
        +'<div class="bar-track" style="max-width:none"><div class="bar-fill" style="background:var(--down);width:'+longPct+'%;'+(longPct>shortPct?liqSideFlickStyle(longPct,shortPct):'')+'"></div><div class="bar-fill" style="background:var(--up);width:'+shortPct+'%;'+(shortPct>longPct?liqSideFlickStyle(longPct,shortPct):'')+'"></div></div>'
        +'<div class="data-ts" style="margin-top:6px">'+m.rows.length+' 个币种有清算</div></div>';
    }
    function tableFor(name){
      const m=dataMap[name];
      if(!m.rows.length)return '<div class="empty">该交易所暂无清算数据</div>';
      const isAll=name==='ALL';
      const body=m.rows.slice(0,30).map(function(r,i){
        const pct=m.total>0?(r.liq_24h/m.total*100):0;
        let ratio='—';
        if(r.short_24h>0)ratio=Number(r.long_24h/r.short_24h).toFixed(2);
        else if(r.long_24h>0)ratio='∞';
        const lf=liqFlickStyleFor(r.symbol, r.long_24h);   // 多头爆仓闪烁(主流币+大额)
        const sf=liqFlickStyleFor(r.symbol, r.short_24h);  // 空头爆仓闪烁(主流币+大额)
        return '<tr><td class="num">'+(i+1)+'</td><td>'+esc(r.symbol)+'</td>'
          +(isAll?'<td class="num">'+r.exch_count+'</td>':'')
          +'<td class="num" style="color:var(--down)">'+fmtUsd(r.liq_24h)+'</td>'
          +'<td class="num'+(lf?' liq-flick':'')+'" style="color:var(--down);'+(lf?lf:'')+'">'+fmtUsd(r.long_24h)+'</td>'
          +'<td class="num'+(sf?' liq-flick':'')+'" style="color:var(--up);'+(sf?sf:'')+'">'+fmtUsd(r.short_24h)+'</td>'
          +'<td class="num">'+ratio+'</td>'
          +'<td class="num"><div style="display:inline-block;width:56px;height:5px;background:var(--bg2);border-radius:3px;vertical-align:middle;margin-right:4px"><div style="width:'+Math.min(pct,100)+'%;height:100%;background:var(--amber);border-radius:3px"></div></div>'+pct.toFixed(1)+'%</td></tr>';
      }).join('');
      return '<div style="overflow-x:auto"><table><thead><tr><th>#</th><th>币种</th>'+(isAll?'<th>覆盖所</th>':'')+'<th>24h 清算</th><th>多头爆仓</th><th>空头爆仓</th><th>多/空比</th><th>占比</th></tr></thead><tbody>'+body+'</tbody></table></div>';
    }
    let cur=names[0];
    const btn=(n)=>{const on=cur===n?' active':'';return '<button class="src-btn'+on+'" data-liq="'+esc(n)+'">'+esc(n)+'</button>'};
    /* ── 清算地图卡（复刻 Coinglass Liquidation Map：多空流动性总额+方向+分布）── */
    let liqmapHtml='';
    function liqMapCardHTML(lm,zoom){
      const lDir=lm.long_dir==='up'?'↑':(lm.long_dir==='down'?'↓':'—');
      const sDir=lm.short_dir==='up'?'↑':(lm.short_dir==='down'?'↓':'—');
      const lSub=lm.long_dir?('<'+(lm.long_dir==='up'?T('增加中','rising'):(lm.long_dir==='down'?T('减少中','falling'):T('持平','flat')))+'>'):('<'+(T('5分钟后显示方向','dir in 5min'))+'>');
      const sSub=lm.short_dir?('<'+(lm.short_dir==='up'?T('增加中','rising'):(lm.short_dir==='down'?T('减少中','falling'):T('持平','flat')))+'>'):('<'+(T('5分钟后显示方向','dir in 5min'))+'>');
      const lastP=lm.last_price;
      const fullLo=lm.buckets[0].price, fullHi=lm.buckets[lm.buckets.length-1].price;
      let lo,hi;
      if(!zoom||zoom<=0){lo=fullLo;hi=fullHi;}
      else{lo=lastP*(1-zoom);hi=lastP*(1+zoom);}
      const inWin=lm.buckets.filter(function(b){return b.price>=lo&&b.price<=hi;});
      const outLow=lm.buckets.filter(function(b){return b.price<lo;}).reduce(function(s2,b){return s2+b.amount;},0);
      const outHigh=lm.buckets.filter(function(b){return b.price>hi;}).reduce(function(s2,b){return s2+b.amount;},0);
      const span=(hi-lo)||1;
      const maxAmt=Math.max.apply(null,inWin.map(function(b){return b.amount;}))||1;
      const bars=inWin.map(function(b){
        const x=((b.price-lo)/span*100);
        const w=Math.max(0.4, 100/inWin.length*0.8);
        const h=Math.max(6, b.amount/maxAmt*100);
        const col=b.price<=lastP?'var(--up)':'var(--down)';
        return '<div style="position:absolute;left:'+x.toFixed(2)+'%;bottom:14px;width:'+w.toFixed(2)+'%;height:'+h.toFixed(1)+'%;background:'+col+';opacity:0.55;border-radius:1px"></div>';
      }).join('');
      let ticks='';
      for(let i=0;i<=4;i++){
        const pv=lo+(hi-lo)*i/4;
        ticks+='<div style="position:absolute;left:'+(i*25)+'%;bottom:1px;transform:translateX(-50%);font-size:9px;color:var(--text3);font-family:var(--mono)">$'+Math.round(pv).toLocaleString('en-US')+'</div>';
      }
      const wall='<div style="position:relative;height:84px;background:var(--bg2);border-radius:8px;margin-top:10px;overflow:hidden">'+bars
        +'<div style="position:absolute;left:'+(((lastP-lo)/span*100)).toFixed(2)+'%;top:0;bottom:14px;width:1.5px;background:#f0b90b"></div>'
        +'<div style="position:absolute;left:'+(((lastP-lo)/span*100)).toFixed(2)+'%;top:2px;transform:translateX(-50%);font-size:9px;color:#f0b90b;font-family:var(--mono);font-weight:700">$'+Math.round(lastP).toLocaleString('en-US')+'</div>'
        +(outLow>0?'<div style="position:absolute;left:3px;top:2px;font-size:9px;color:var(--text3)">◀ '+T('窗外','out')+' $'+(outLow/1e8).toFixed(1)+T('亿','B')+'</div>':'')
        +(outHigh>0?'<div style="position:absolute;right:3px;top:2px;font-size:9px;color:var(--text3)">'+T('窗外','out')+' $'+(outHigh/1e8).toFixed(1)+T('亿','B')+' ▶</div>':'')
        +ticks
        +'</div>';
      const zooms=[[0.03,'±3%'],[0.06,'±6%'],[0.10,'±10%'],[0,T('全部','ALL')]];
      const zbtns=zooms.map(function(z){
        const on=Math.abs((zoom||0)-z[0])<1e-9?' active':'';
        return '<button class="src-btn'+on+'" onclick="window._renderLiqMap(window._liqmap,'+z[0]+')">'+z[1]+'</button>';
      }).join('');
      return '<div class="card-title" style="justify-content:space-between"><span>🗺️ '+T('BTC 清算一览','BTC Liquidation Overview')+'</span><span class="data-ts">Coinglass Pro · 1min · '+(zoom<=0?'24h '+T('全量','ALL'):'±'+Math.round(zoom*100)+'%')+'</span></div>'
        +'<div style="display:flex;gap:12px;flex-wrap:wrap">'
        +'<div style="flex:1;min-width:200px;background:var(--bg1);border:1px solid var(--line);border-radius:10px;padding:12px 14px">'
        +'<div style="font-size:11px;color:var(--text3)">'+T('多单流动性','Long Liquidity')+'</div>'
        +'<div style="font-size:24px;font-family:var(--mono);color:var(--up);font-weight:700;margin-top:2px">'+lDir+' $'+(lm.long_usd/1e8).toFixed(2)+T('亿','B')+'</div>'
        +'<div style="font-size:12px;color:var(--text2);margin-top:2px">'+lm.long_pct+'% <span class="data-ts">'+lSub+'</span></div></div>'
        +'<div style="flex:1;min-width:200px;background:var(--bg1);border:1px solid var(--line);border-radius:10px;padding:12px 14px">'
        +'<div style="font-size:11px;color:var(--text3)">'+T('空单流动性','Short Liquidity')+'</div>'
        +'<div style="font-size:24px;font-family:var(--mono);color:var(--down);font-weight:700;margin-top:2px">'+sDir+' $'+(lm.short_usd/1e8).toFixed(2)+T('亿','B')+'</div>'
        +'<div style="font-size:12px;color:var(--text2);margin-top:2px">'+lm.short_pct+'% <span class="data-ts">'+sSub+'</span></div></div>'
        +'</div>'
        +'<div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin-top:10px;background:var(--bg2)">'
        +'<div style="background:var(--up);width:'+lm.long_pct+'%"></div><div style="background:var(--down);width:'+lm.short_pct+'%"></div></div>'
        +'<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">'+zbtns+'</div>'
        +wall
        +'<div class="data-ts" style="margin-top:6px">'+T('绿=多单流动性（下方支撑）· 红=空单流动性（上方阻力）· 黄线=现价 · 缩放按钮聚焦价格附近（24h波动区间）· 窗外金额标注在两侧','Green=long liq · Red=short liq · Yellow=last price · zoom focuses price vicinity · out-of-window amounts at edges')+'</div>';
    }
    const lm=d.liqmap;
    window._liqmap=lm||null;
    window._renderLiqMap=function(lm2,z){if(!lm2||!document.getElementById('liqMapCard'))return;document.getElementById('liqMapCard').innerHTML=liqMapCardHTML(lm2,z);};
    liqmapHtml=lm&&lm.buckets&&lm.buckets.length?('<div class="card" style="margin-bottom:12px" id="liqMapCard">'+liqMapCardHTML(lm,0.06)+'</div>'):'';
    main.innerHTML=(liqmapHtml||'')+'<div class="card" style="margin-bottom:12px"><div class="card-title">💥 合约清算监控 · 24h</div>'
      +'<div class="liq-cards" style="display:flex;gap:12px;flex-wrap:wrap">'+names.map(miniCard).join('')+'</div>'
      +'<div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">'
      +'<span style="font-size:13px">全平台 24h 合计清算 <b style="color:var(--down);font-family:var(--mono)">'+fmtUsd(grand)+'</b></span>'
      +tsHtml+'</div></div>'
      +'<div class="card"><div class="card-title" style="justify-content:space-between"><span>📊 清算明细 TOP30</span>'
      +'<span style="display:flex;gap:6px;flex-wrap:wrap">'+names.map(btn).join('')+'</span></div>'
      +'<div id="liqTable">'+tableFor(cur)+'</div>'
      +'<div class="data-ts" style="margin-top:8px">来源: Coinglass Liquidation Coin List · 每 30 分钟更新 · 8 所</div></div>'
      +'<div class="card"><div class="card-title">数据说明</div>'
      +'<div class="verdict-block" style="font-size:12px;line-height:1.7">'
      +'清算数据来自 Coinglass 各交易所合约爆仓统计（8 所聚合）。「🌐 全平台」按币种跨所汇总，覆盖所数=该币种在几所有爆仓。'
      +'多头爆仓（红）表示多头仓位被强平，通常伴随价格下行压力；空头爆仓（绿）表示空头被强平。'
      +'多/空比 = 多头爆仓额 ÷ 空头爆仓额，比值越高说明多头踩踏越剧烈。'
      +'数据仅供研究，不构成投资建议。'
      +'</div></div>';
    $$('#liqTable').length&&$$('#liqTable')[0].parentNode.querySelectorAll('[data-liq]').forEach(function(b){
      b.onclick=function(){
        $$('[data-liq]').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        $('#liqTable').innerHTML=tableFor(b.dataset.liq);
      };
    });
  }catch(e){main.innerHTML='<div class="card">加载异常: '+esc(e.message)+'</div>';}
};;

/* ================= PANEL: 筹码分布（Coinglass Pro · 会员可见 · 增强版） ================= */
function cvdColor(v){return v>=0?'var(--up)':'var(--down)';}
function liqBg(v,max){ // 清算热力颜色：0~1 强度映射到透明红绿
  if(v<=0)return 'rgba(0,0,0,0)';
  const a=0.12+0.88*Math.min(1,v/max);
  return 'rgba(224,90,78,'+a.toFixed(3)+')';
}
PANELS['chip-distribution']=async function(){startTabTimer('chip-distribution',PANELS['chip-distribution']);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  try{
    const d=await api('/api/position-distribution');
    if(d&&d.__needLogin){main.innerHTML=lockCardHtml({zh:'筹码分布',en:'Chip Distribution'},null);bindLockCard();return;}
    if(!d||!d.ok){main.innerHTML='<div class="card">'+T('数据不可用','Data unavailable')+'</div>';return;}
    const groups=(d.posdist||[]);
    const whaleTimeline=(d.whaleTimeline||[]);
    const liqwall=d.liqwall;
    const heat=d.heat;
    const footprint=d.footprint;
    const liqOrders=(d.liqOrders||[]);
    const maxPain=(d.maxPain||[]);
    const tsHtml=(d.data_ts?'<span class="data-ts">数据 '+fmtTs(d.data_ts)+'</span>':'');

    /* ============ 工具：K线 SVG 绘制 ============ */
    function drawCandles(candles, opts){
      const o=Object.assign({W:760,H:180,padL:8,padR:8,padT:14,padB:20,showVol:false},opts||{});
      const highs=candles.map(c=>c.h), lows=candles.map(c=>c.l);
      const mn=Math.min.apply(null,lows), mx=Math.max.apply(null,highs);
      const pad=(mx-mn)*0.08||1;
      const lo=mn-pad, hi=mx+pad;
      const n=candles.length;
      const bw=Math.max(1.5,(o.W-o.padL-o.padR)/n*0.7);
      const x=i=>o.padL+(i+0.5)/n*(o.W-o.padL-o.padR);
      const y=v=>o.padT+(o.H-o.padT-o.padB)*(1-(v-lo)/(hi-lo||1));
      let body='',wick='';
      for(let i=0;i<n;i++){
        const c=candles[i];
        const up=c.c>=c.o;
        const col=up?'#3aa06e':'#e05a4e';
        const xc=x(i);
        wick+='<line x1="'+xc+'" y1="'+y(c.h)+'" x2="'+xc+'" y2="'+y(c.l)+'" stroke="'+col+'" stroke-width="1"/>';
        const yo=y(Math.max(c.o,c.c)), yc=y(Math.min(c.o,c.c));
        const hh=Math.max(1,yc-yo);
        body+='<rect x="'+(xc-bw/2)+'" y="'+yo+'" width="'+bw+'" height="'+hh+'" fill="'+(up?col:'rgba(224,90,78,.85)')+'" stroke="'+col+'" stroke-width="0.5"/>';
      }
      return {svg:wick+body, x:x, y:y, lo:lo, hi:hi, W:o.W, H:o.H, padL:o.padL, padR:o.padR, padT:o.padT, padB:o.padB};
    }

    /* ============ 模块2：清算墙 + K线叠加（超过官网的核心图） ============ */
    function liqWallKline(){
      if(!liqwall||!liqwall.buckets||!liqwall.buckets.length)return '<div class="empty">暂无清算墙数据</div>';
      const buckets=liqwall.buckets;
      const lastP=Number(liqwall.last_price)||buckets[Math.floor(buckets.length/2)].price;
      const maxAmt=Math.max.apply(null,buckets.map(b=>b.amount));
      const W=780,H=320,padL=8,padR=64,padT=18,padB=26;
      const lo=Math.min.apply(null,buckets.map(b=>b.price)), hi=Math.max.apply(null,buckets.map(b=>b.price));
      const x=v=>padL+(v-lo)/(hi-lo||1)*(W-padL-padR);
      const yAmt=v=>padT+(H-padT-padB)*(1-v/maxAmt);
      const bw=Math.max(1,(W-padL-padR)/buckets.length*0.72);
      // 清算墙：x=价格，柱高=该价位累计清算金额（绿=下方多头清算密集区，红=上方空头清算密集区）
      let bars='';
      for(const b of buckets){
        const above=b.price>lastP;
        const col=above?'rgba(224,90,78,.6)':'rgba(58,160,110,.6)';
        const yy=yAmt(b.amount);
        bars+='<rect x="'+(x(b.price)-bw/2).toFixed(1)+'" y="'+yy.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+(H-padB-yy).toFixed(1)+'" fill="'+col+'"/>';
      }
      // 现价黄虚线
      const lastX=x(lastP);
      const lastPLabel='<line x1="'+lastX+'" y1="'+padT+'" x2="'+lastX+'" y2="'+(H-padB)+'" stroke="#f0b90b" stroke-width="1.4" stroke-dasharray="5,3"/><text x="'+lastX+'" y="'+(padT-4)+'" fill="#f0b90b" font-size="11" font-weight="700" text-anchor="middle">$'+lastP.toLocaleString('en-US',{maximumFractionDigits:0})+'</text>';
      // 底部价格刻度 + 左侧金额刻度
      let ticks='';
      for(let i=0;i<=6;i++){const pv=lo+(hi-lo)*i/6;ticks+='<text x="'+(padL+(W-padL-padR)*i/6)+'" y="'+(H-8)+'" fill="#8a8f98" font-size="9" text-anchor="middle">$'+Math.round(pv).toLocaleString('en-US')+'</text>';}
      let amtTicks='';
      for(let i=0;i<=4;i++){const av=maxAmt*i/4;const yy=yAmt(av);amtTicks+='<text x="'+(W-padR+6)+'" y="'+(yy+3)+'" fill="#8a8f98" font-size="9">'+fmtUsd(av)+'</text>';}
      // 多空墙汇总 + 最近墙
      let longAmt=0, shortAmt=0;
      for(const b of buckets){if(b.price>lastP)shortAmt+=b.amount;else longAmt+=b.amount;}
      let nearestLong=null, nearestShort=null;
      for(const b of buckets){
        if(b.price<=lastP&&(!nearestLong||b.price>nearestLong.price))nearestLong=b;
        if(b.price>=lastP&&(!nearestShort||b.price<nearestShort.price))nearestShort=b;
      }
      const distLong=nearestLong?((lastP-nearestLong.price)/lastP*100):null;
      const distShort=nearestShort?((nearestShort.price-lastP)/lastP*100):null;
      const distInfo='<div class="stat-row">'
        +'<span class="stat-pill"><span class="k">▼ 下方多墙</span><span class="v up">'+fmtUsd(longAmt)+'</span></span>'
        +'<span class="stat-pill"><span class="k">▲ 上方空墙</span><span class="v down">'+fmtUsd(shortAmt)+'</span></span>'
        +(nearestLong?'<span class="stat-pill"><span class="k">最近多墙</span><span class="v up">'+fmtPrice(nearestLong.price)+(distLong!=null?(' · -'+distLong.toFixed(2)+'%'):'')+'</span></span>':'')
        +(nearestShort?'<span class="stat-pill"><span class="k">最近空墙</span><span class="v down">'+fmtPrice(nearestShort.price)+(distShort!=null?(' · +'+distShort.toFixed(2)+'%'):'')+'</span></span>':'')
        +'<span class="stat-pill"><span class="k">上/下清算比</span><span class="v warn">'+(longAmt>0?(shortAmt/longAmt).toFixed(2):'—')+'</span></span>'
        +'</div>';
      const exchTag=liqwall.instruments?(' · '+liqwall.instruments.map(i=>i.ex).join('/')):'';
      return '<div class="chart-wrap"><svg viewBox="0 0 '+W+' '+H+'" style="width:100%">'
        +'<line x1="'+padL+'" y1="'+(H-padB)+'" x2="'+(W-padR)+'" y2="'+(H-padB)+'" stroke="#3c424d" stroke-width="1"/>'
        +bars+lastPLabel+ticks+amtTicks+'</svg></div>'+distInfo
        +'<div class="data-ts" style="margin-top:6px">横轴=价格 · 柱高=该价位累计清算额（绿=下方多头清算密集区，红=上方空头清算密集区=流动性真空带，波动放大区） · 黄虚线=现价'+exchTag+'</div>';
    }

    /* ============ 模块1：大户持仓分布卡 ============ */
    function groupCard(g){
      const long=Number(g.long_position_usd||0), short=Number(g.short_position_usd||0);
      const tot=long+short;
      const longPct=tot>0?(long/tot*100):50;
      const bias=Number(g.bias_score||0);
      const profit=Number(g.profit_address_count||0), loss=Number(g.loss_address_count||0);
      const pSum=profit+loss;
      const profitPct=pSum>0?(profit/pSum*100):0;
      const biasColor=bias>0.1?'var(--up)':bias<-0.1?'var(--down)':'var(--amber)';
      const biasTxt=bias>0.1?'偏多':bias<-0.1?'偏空':'中性';
      const remark=esc(g.bias_remark||'');
      const tagName=esc(g.group_name||'')==='whale'?'🐋 鲸鱼 Whale':('🏷 '+esc(g.group_name||''));
      return '<div class="card" style="min-width:280px;flex:1">'
        +'<div class="card-title" style="justify-content:space-between"><span>'+tagName+'</span></div>'
        // bias 大数字框（居中）
        +'<div style="text-align:center;margin:10px 0 12px">'
        +'<div style="display:inline-block;padding:12px 26px 10px;border-radius:10px;background:var(--bg2);border:1px solid '+biasColor+';box-shadow:0 0 0 1px '+biasColor+'26, 0 3px 14px rgba(0,0,0,.3)">'
        +'<div style="font-size:32px;font-weight:800;font-family:var(--mono);color:'+biasColor+';line-height:1">'+(bias>=0?'+':'')+bias.toFixed(2)+'</div>'
        +'<div style="font-size:10px;color:var(--text3);margin-top:5px;letter-spacing:1.5px">偏置 BIAS · '+biasTxt+(remark?' ('+remark+')':'')+'</div>'
        +'</div></div>'
        // 持仓三指标（框）
        +'<div class="stat-row" style="margin-top:0;justify-content:center">'
        +'<span class="stat-pill"><span class="k">多单</span><span class="v up">'+fmtUsd(long)+'<span style="font-size:10px;color:var(--text3);font-weight:400"> '+longPct.toFixed(1)+'%</span></span></span>'
        +'<span class="stat-pill"><span class="k">空单</span><span class="v down">'+fmtUsd(short)+'<span style="font-size:10px;color:var(--text3);font-weight:400"> '+(100-longPct).toFixed(1)+'%</span></span></span>'
        +'<span class="stat-pill"><span class="k">多空比</span><span class="v warn">'+(short>0?(long/short).toFixed(2):'—')+'</span></span>'
        +'</div>'
        +'<div class="chip-bar" style="margin:8px 0 0"><span style="background:var(--up);width:'+longPct+'%"></span><span style="background:var(--down);width:'+(100-longPct)+'%"></span></div>'
        +'<div style="text-align:center;font-size:11px;color:var(--text3);margin-top:8px">多空总持仓 '+fmtUsd(tot)+'</div>'
        // 地址盈亏（分框）
        +'<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:9px"><div style="font-size:11px;color:var(--text3);margin-bottom:6px">地址盈亏分布</div>'
        +'<div class="stat-row" style="margin-top:0;justify-content:center">'
        +'<span class="stat-pill"><span class="k">盈利</span><span class="v up">'+profit+'</span></span>'
        +'<span class="stat-pill"><span class="k">亏损</span><span class="v down">'+loss+'</span></span>'
        +'</div>'
        +'<div class="chip-bar" style="margin-top:6px"><span style="background:var(--up);width:'+profitPct+'%"></span><span style="background:var(--down);width:'+(100-profitPct)+'%"></span></div></div></div>';
    }

    /* ============ 模块3：二维清算热力图（价格×时间）+ K线收盘 ============ */
    function heatmapChart(){
  if(!heat||!heat.y_axis||!heat.grid||!heat.grid.length)return '<div class="empty">暂无热力图数据</div>';
  const cid='hmc_'+(window._hmcSeq=(window._hmcSeq||0)+1);
  const yAxis=heat.y_axis, grid=heat.grid, candles=heat.candlesticks||[];
  const nY=yAxis.length, nX=candles.length||144;
  const padL=46,padR=12,padT=18,padB=30;
  const W=820,H=380;
  // ── 预聚合：每个 (价格行,时间桶) 格子的清算额 ──
  const amt=new Float64Array(nY*nX);
  let maxA=0;
  for(let i=0;i<grid.length;i++){
    const g=grid[i];
    if(g.yi>=0&&g.yi<nY&&g.xi>=0&&g.xi<nX){
      const a=Number(g.amount)||0;
      const idx=g.yi*nX+g.xi;
      amt[idx]+=a;
      if(amt[idx]>maxA)maxA=amt[idx];
    }
  }
  if(maxA<=0)return '<div class="empty">暂无热力图数据</div>';
  // 参考价（现价）
  const refP=liqwall?Number(liqwall.last_price):(candles.length?Number(candles[candles.length-1].c):null);
  const curP=refP||yAxis[Math.floor(nY/2)];
  const stepY=(yAxis[1]-yAxis[0])||1;
  let curYi=Math.round((curP-yAxis[0])/stepY);
  curYi=Math.max(0,Math.min(nY-1,curYi));
  // 上/下方累计 + 行聚合 TOP3
  let upAmt=0,dnAmt=0;
  const rowSum=new Float64Array(nY);
  for(let yi=0;yi<nY;yi++){
    for(let xi=0;xi<nX;xi++){
      const a=amt[yi*nX+xi];
      if(a){rowSum[yi]+=a;if(yAxis[yi]>curP)upAmt+=a;else dnAmt+=a;}
    }
  }
  const order=[...Array(nY).keys()].sort((a,b)=>rowSum[b]-rowSum[a]);
  const top=[];
  for(let i=0;i<nY&&top.length<3;i++){if(rowSum[order[i]]>0)top.push({price:yAxis[order[i]],amt:rowSum[order[i]]});}
  // ── 离屏热力层（像素级预渲染，144×129，缩放时 GPU 平滑）──
  const SCL=8; // 离屏超采样倍数：144x129 → 1152x1032，drawImage 近乎 1:1 锐利
  const layer=document.createElement('canvas');
  layer.width=nX*SCL;layer.height=nY*SCL;
  const lctx=layer.getContext('2d');
  const img=lctx.createImageData(nX*SCL,nY*SCL);
  const pxd=img.data;
  const yMax=yAxis[nY-1],yMin=yAxis[0];
  for(let yi=0;yi<nY;yi++){
    const isUp=yAxis[yi]>curP;
    for(let xi=0;xi<nX;xi++){
      const a=amt[yi*nX+xi];
      let r=0,g=0,b=0,al=0;
      if(a>0){
        const t=Math.pow(Math.min(1,a/maxA),0.55); // 非线性增强：突出密集核心
        if(isUp){ r=234;g=Math.round(62+70*t);b=Math.round(52+40*t);al=0.10+0.88*t; }   // 红系=上方空头清算区
        else     { r=44;g=Math.round(150+70*t);b=Math.round(96+50*t);al=0.10+0.88*t; } // 绿系=下方多头清算区
      }
      for(let dy=0;dy<SCL;dy++){
        const row=(yi*SCL+dy)*nX*SCL;
        for(let dx=0;dx<SCL;dx++){
          const i=(row+xi*SCL+dx)*4;
          pxd[i]=r;pxd[i+1]=g;pxd[i+2]=b;pxd[i+3]=al;
        }
      }
    }
  }
  lctx.putImageData(img,0,0);
  // ── 容器 ──
  const html='<div class="chart-wrap" style="position:relative">'
    +'<canvas id="'+cid+'" style="width:100%;cursor:crosshair;display:block" width="'+W+'" height="'+H+'"></canvas>'
    +'<div id="'+cid+'_tip" style="position:absolute;pointer-events:none;display:none;background:rgba(13,16,23,.94);border:1px solid #3a4150;border-radius:6px;padding:6px 10px;font-size:11px;line-height:1.5;color:#e8eaef;z-index:20;box-shadow:0 4px 16px rgba(0,0,0,.45);white-space:nowrap"></div>'
    +'<div style="position:absolute;top:8px;right:12px;font-size:10px;color:var(--text3);pointer-events:none;user-select:none">🖱 滚轮缩放 · 拖拽平移 · Hover 查看明细</div>'
    +'</div>';
  setTimeout(function(){
    const cv=document.getElementById(cid);
    if(!cv)return;
    const ctx=cv.getContext('2d');
    const tip=document.getElementById(cid+'_tip');
  // ── 视口（数据坐标：xi∈[0,nX], yi∈[0,nY]）──
  const vp={x0:0,x1:nX,y0:0,y1:nY};
  function clampVp(){
    const w=vp.x1-vp.x0,h=vp.y1-vp.y0;
    if(w<10){vp.x1=vp.x0+10;} if(h<14){vp.y1=vp.y0+14;}
    if(vp.x0< -nX*0.4)vp.x0=-nX*0.4; if(vp.x1>nX*1.4)vp.x1=nX*1.4;
    if(vp.y0< -nY*0.4)vp.y0=-nY*0.4; if(vp.y1>nY*1.4)vp.y1=nY*1.4;
  }
  const px=x=>padL+(x-vp.x0)/(vp.x1-vp.x0||1)*(W-padL-padR);
  const py=y=>padT+(y-vp.y0)/(vp.y1-vp.y0||1)*(H-padT-padB);
  const fmtAmt=a=>a>=1e9?(a/1e9).toFixed(2)+'B':(a/1e6).toFixed(1)+'M';
  // ── 主绘制（每帧全量，热力层一次 drawImage，性能极高）──
  function draw(){
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#0e1117';ctx.fillRect(0,0,W,H);
    ctx.save();
    ctx.beginPath();ctx.rect(padL,padT,W-padL-padR,H-padT-padB);ctx.clip();
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(layer,px(0),py(nY),px(nX)-px(0),py(0)-py(nY));
    ctx.restore();
    // K线收盘线
    if(candles.length){
      ctx.beginPath();ctx.strokeStyle='#f0b90b';ctx.lineWidth=1.6;ctx.globalAlpha=.9;
      for(let i=0;i<candles.length;i++){
        const yy=py((Number(candles[i].c)-yAxis[0])/stepY);
        const xx=px(i+0.5);
        if(i===0)ctx.moveTo(xx,yy);else ctx.lineTo(xx,yy);
      }
      ctx.stroke();ctx.globalAlpha=1;
    }
    // 现价线
    const pyy=py(curYi);
    if(pyy>=padT-2&&pyy<=H-padB+2){
      ctx.setLineDash([4,3]);ctx.strokeStyle='#4aa3ff';ctx.lineWidth=1.2;ctx.globalAlpha=.85;
      ctx.beginPath();ctx.moveTo(padL,pyy);ctx.lineTo(W-padR,pyy);ctx.stroke();
      ctx.setLineDash([]);ctx.globalAlpha=1;
      ctx.fillStyle='#4aa3ff';ctx.font='700 10px sans-serif';ctx.textAlign='right';ctx.textBaseline='bottom';
      ctx.fillText('$'+Math.round(curP).toLocaleString('en-US'),W-padR-2,pyy-3);
    }
    // y轴价格刻度
    ctx.font='10px sans-serif';ctx.textBaseline='middle';
    const yticks=6;
    for(let i=0;i<=yticks;i++){
      const v=vp.y0+(vp.y1-vp.y0)*i/yticks;
      const p=yAxis[0]+v*stepY;
      const yy=py(v);
      ctx.fillStyle='#8a8f98';ctx.textAlign='right';
      ctx.fillText('$'+Math.round(p).toLocaleString('en-US'),padL-5,yy);
      ctx.strokeStyle='#232833';ctx.lineWidth=.5;
      ctx.beginPath();ctx.moveTo(padL,yy);ctx.lineTo(W-padR,yy);ctx.stroke();
    }
    // x轴时间刻度
    if(candles.length){
      ctx.textAlign='center';ctx.textBaseline='alphabetic';
      const xticks=5;
      for(let i=0;i<=xticks;i++){
        const vi=Math.round(vp.x0+(vp.x1-vp.x0)*i/xticks);
        const ci=Math.max(0,Math.min(candles.length-1,vi));
        const c=candles[ci];
        const xx=px(vi);
        ctx.fillStyle='#8a8f98';
        ctx.fillText(new Date(c.t*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}),xx,H-8);
        ctx.strokeStyle='#1c2028';ctx.beginPath();ctx.moveTo(xx,padT);ctx.lineTo(xx,H-padB);ctx.stroke();
      }
    }
    ctx.strokeStyle='#232833';ctx.lineWidth=1;
    ctx.strokeRect(padL+.5,padT+.5,W-padL-padR-1,H-padT-padB-1);
  }
  // ── 交互（全部绑在本 canvas，随重建自动 GC，无泄漏）──
  // (tip 在 setTimeout 内获取)
  let drag=false,sx=0,sy=0,sox=0,soy=0;
  function showTip(e){
    const r=cv.getBoundingClientRect();
    const mx=(e.clientX-r.left)/r.width*W,my=(e.clientY-r.top)/r.height*H;
    if(mx<padL||mx>W-padR||my<padT||my>H-padB){tip.style.display='none';return;}
    const xi=Math.floor(vp.x0+(mx-padL)/(W-padL-padR)*(vp.x1-vp.x0));
    const yi=Math.floor(vp.y0+(my-padT)/(H-padT-padB)*(vp.y1-vp.y0));
    if(xi<0||xi>=nX||yi<0||yi>=nY){tip.style.display='none';return;}
    const a=amt[yi*nX+xi];
    const price=yAxis[yi];
    const t=candles[xi]?new Date(candles[xi].t*1000):null;
    const side=price>curP?'上方·空头清算区':'下方·多头清算区';
    tip.innerHTML='<div style="font-weight:700;color:'+(price>curP?'#e86a5a':'#3ab070')+'">$'+Math.round(price).toLocaleString('en-US')+' · '+fmtAmt(a)+'</div>'
      +'<div style="color:#9aa1ad">'+(t?t.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'')+' ｜ '+side+'</div>';
    tip.style.display='block';
    const tw=tip.offsetWidth,th=tip.offsetHeight;
    let lx=e.clientX-r.left+14,ly=e.clientY-r.top+14;
    if(lx+tw>r.width-4)lx=e.clientX-r.left-tw-12;
    if(ly+th>r.height-4)ly=e.clientY-r.top-th-12;
    tip.style.left=lx+'px';tip.style.top=ly+'px';
  }
  cv.addEventListener('wheel',function(e){
    e.preventDefault();
    const r=cv.getBoundingClientRect();
    const mx=(e.clientX-r.left)/r.width*W,my=(e.clientY-r.top)/r.height*H;
    const dx=vp.x0+(mx-padL)/(W-padL-padR)*(vp.x1-vp.x0);
    const dy=vp.y0+(my-padT)/(H-padT-padB)*(vp.y1-vp.y0);
    const f=e.deltaY<0?0.82:1.22;
    const nw=Math.max(10,(vp.x1-vp.x0)*f),nh=Math.max(14,(vp.y1-vp.y0)*f);
    vp.x0=dx-(dx-vp.x0)*f;vp.x1=vp.x0+nw;
    vp.y0=dy-(dy-vp.y0)*f;vp.y1=vp.y0+nh;
    clampVp();draw();showTip(e);
  },{passive:false});
  cv.addEventListener('mousedown',function(e){
    if(e.button!==0)return;
    drag=true;sx=e.clientX;sy=e.clientY;sox=vp.x0;soy=vp.y0;
    cv.style.cursor='grabbing';
  });
  cv.addEventListener('mousemove',function(e){
    if(drag){
      const r=cv.getBoundingClientRect();
      const dx=(e.clientX-sx)/r.width*(W-padL-padR)/(vp.x1-vp.x0||1);
      const dy=(e.clientY-sy)/r.height*(H-padT-padB)/(vp.y1-vp.y0||1);
      vp.x0=sox-dx;vp.x1=sox-dx+(vp.x1-vp.x0);
      vp.y0=soy+dy;vp.y1=soy+dy+(vp.y1-vp.y0);
      clampVp();draw();
    }else showTip(e);
  });
  const endDrag=function(){drag=false;cv.style.cursor='crosshair';};
  cv.addEventListener('mouseup',endDrag);
  cv.addEventListener('mouseleave',function(){tip.style.display='none';if(drag)endDrag();});
  // 初始绘制（下一帧确保布局完成）
    requestAnimationFrame(draw);
  }, 60);
  // ── 统计行 + 说明 ──
  const topInfo=top.map(function(t,i){
    const dist=curP?((t.price-curP)/curP*100):null;
    return '<span class="stat-pill"><span class="k">'+(i===0?'最强':'次强')+'清算区</span><span class="v '+(dist!=null&&dist>0?'down':'up')+'">$'+Math.round(t.price).toLocaleString('en-US')+(dist!=null?(dist>0?' · +'+dist.toFixed(1)+'%':' · '+dist.toFixed(1)+'%'):'')+'</span></span>';
  }).join('');
  const upDown='<span class="stat-pill"><span class="k">上方清算</span><span class="v down">'+fmtUsd(upAmt)+'</span></span>'
    +'<span class="stat-pill"><span class="k">下方清算</span><span class="v up">'+fmtUsd(dnAmt)+'</span></span>'
    +'<span class="stat-pill"><span class="k">上/下比</span><span class="v warn">'+(dnAmt>0?(upAmt/dnAmt).toFixed(2):'—')+'</span></span>';
  return html
    +'<div class="stat-row">'+upDown+topInfo+'</div>'
    +'<div class="data-ts" style="margin-top:6px">Canvas 像素级渲染（144×129 格 · 60fps）｜ 绿=下方多头清算密集区，红=上方空头清算密集区（流动性真空带）｜ 滚轮缩放/拖拽平移/Hover 看明细 ｜ 穿墙概率>反转概率，亮区波动放大</div>';
}

    /* ============ 模块4：订单足迹 CVD ============ */
    function footprintChart(){
      if(!footprint||!footprint.cvd||!footprint.cvd.length)return '<div class="empty">暂无足迹数据</div>';
      const cvd=footprint.cvd.slice(-60);
      const W=780,H=160,padL=44,padR=10,padT=14,padB=20;
      const deltas=cvd.map(c=>c.delta);
      const mn=Math.min.apply(null,deltas), mx=Math.max.apply(null,deltas);
      const span=(mx-mn)||1;
      const x=i=>padL+i/(cvd.length-1||1)*(W-padL-padR);
      const y=v=>padT+(H-padT-padB)*(1-(v-mn)/span);
      const zeroY=y(0);
      let bars='', line='';
      const bw=Math.max(1,(W-padL-padR)/cvd.length*0.6);
      for(let i=0;i<cvd.length;i++){
        const c=cvd[i];
        const yy=y(c.delta);
        const up=c.delta>=0;
        const col=up?'rgba(58,160,110,.75)':'rgba(224,90,78,.75)';
        bars+='<rect x="'+(x(i)-bw/2)+'" y="'+Math.min(yy,zeroY)+'" width="'+bw+'" height="'+Math.max(1,Math.abs(yy-zeroY))+'" fill="'+col+'"/>';
        line+=(i?' L':'M')+x(i).toFixed(1)+' '+yy.toFixed(1);
      }
      const linePath='<path d="'+line+'" stroke="#d9a441" stroke-width="1.4" fill="none"/>';
      const zeroLine='<line x1="'+padL+'" y1="'+zeroY+'" x2="'+(W-padR)+'" y2="'+zeroY+'" stroke="#3c424d" stroke-width="1" stroke-dasharray="3,3"/>';
      // 平均值标注
      const avg=cvd.reduce((s,c)=>s+c.delta,0)/cvd.length;
      const lastCvd=cvd[cvd.length-1].delta;
      const legend='<div style="display:flex;gap:14px;font-size:11px;margin-top:6px;flex-wrap:wrap"><span style="color:var(--up)">净主动买入(绿)</span><span style="color:var(--down)">净主动卖出(红)</span><span>当前净差 '+fmtUsd(lastCvd)+'</span><span class="data-ts">均值 '+fmtUsd(avg)+'</span></div>';
      return '<div class="chart-wrap"><svg viewBox="0 0 '+W+' '+H+'" style="width:100%">'+zeroLine+bars+linePath+'</svg></div>'+legend
        +'<div class="data-ts" style="margin-top:4px">CVD=主动买入额-主动卖出额累计 · 绿柱=净买(吸筹) 红柱=净卖(派发) · Binance BTCUSDT 1h</div>';
    }

    /* ============ 模块5：实时大额爆仓流水 ============ */
    function liqOrderFeed(){
      if(!liqOrders.length)return '<div class="empty">暂无大额爆仓流水</div>';
      const rows=liqOrders.slice(0,30).map(o=>{
        const sideTxt=o.side===1?'<span style="color:var(--down);font-weight:700">多爆</span>':'<span style="color:var(--up);font-weight:700">空爆</span>';
        const t=o.time?new Date(o.time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
        return '<tr><td class="num">'+o.ex+'</td><td class="num">'+t+'</td><td>'+sideTxt+'</td><td class="num" style="font-family:var(--mono)">'+fmtUsd(o.usd)+'</td><td class="num" style="font-family:var(--mono)">'+fmtPrice(o.price)+'</td></tr>';
      }).join('');
      const totalLong=liqOrders.filter(o=>o.side===1).reduce((s,o)=>s+o.usd,0);
      const totalShort=liqOrders.filter(o=>o.side===2).reduce((s,o)=>s+o.usd,0);
      const longN=liqOrders.filter(o=>o.side===1).length, shortN=liqOrders.filter(o=>o.side===2).length;
      const totalAll=totalLong+totalShort;
      const maxOrder=liqOrders.length?liqOrders[0].usd:0;
      const top3=liqOrders.slice(0,3).reduce((s,o)=>s+o.usd,0);
      const liqRatio=totalShort>0?totalLong/totalShort:null;
      const stats='<div class="stat-row">'
        +'<span class="stat-pill"><span class="k">多爆/空爆金额</span><span class="v '+(liqRatio!=null&&liqRatio>1.2?'down':liqRatio!=null&&liqRatio<0.8?'up':'')+'">'+(liqRatio!=null?liqRatio.toFixed(2)+' : 1':'—')+'</span></span>'
        +'<span class="stat-pill"><span class="k">笔数</span><span class="v">多爆 '+longN+' / 空爆 '+shortN+'</span></span>'
        +'<span class="stat-pill"><span class="k">最大单笔</span><span class="v warn">'+fmtUsd(maxOrder)+'</span></span>'
        +'<span class="stat-pill"><span class="k">Top3 集中度</span><span class="v">'+(totalAll>0?(top3/totalAll*100).toFixed(1):'—')+'%</span></span>'
        +'</div>';
      return '<div style="overflow-x:auto"><table><thead><tr><th>交易所</th><th>时间</th><th>方向</th><th>金额</th><th>爆仓价</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+stats
    }

    /* ============ 模块6：最大痛点表 ============ */
    function maxPainRows(){
      if(!maxPain.length)return '<div class="empty">暂无最大痛点数据</div>';
      const body=maxPain.filter(x=>x.price).sort((a,b)=>b.price-a.price).slice(0,30).map(x=>{
        const lp=Number(x.long_price||0), sp=Number(x.short_price||0);
        const lll=Number(x.long_level||0), sll=Number(x.short_level||0);
        return '<tr><td>'+esc(x.symbol)+'</td><td class="num">'+fmtPrice(x.price)+'</td>'
          +'<td class="num" style="color:var(--up)">'+fmtPrice(lp)+'</td><td class="num">'+fmtUsd(lll)+'</td>'
          +'<td class="num" style="color:var(--down)">'+fmtPrice(sp)+'</td><td class="num">'+fmtUsd(sll)+'</td></tr>';
      }).join('');
      // BTC 清算密集区指标
      const btc=maxPain.filter(x=>x.symbol==='BTC'&&x.price)[0];
      let stats='';
      if(btc){
        const p=Number(btc.price), lp=Number(btc.long_price||0), sp=Number(btc.short_price||0);
        const dL=p>0?((lp-p)/p*100):null, dS=p>0?((sp-p)/p*100):null;
        stats='<div class="stat-row">'
          +'<span class="stat-pill"><span class="k">多头清算密集区</span><span class="v up">'+fmtPrice(lp)+(dL!=null?(' · '+(dL>=0?'+':'')+dL.toFixed(2)+'%'):'')+'</span></span>'
          +'<span class="stat-pill"><span class="k">空头清算密集区</span><span class="v down">'+fmtPrice(sp)+(dS!=null?(' · '+(dS>=0?'+':'')+dS.toFixed(2)+'%'):'')+'</span></span>'
          +'<span class="stat-pill"><span class="k">痛点区间</span><span class="v warn">'+(p>0?((sp-lp)/p*100).toFixed(2):'—')+'%</span></span>'
          +'<span class="stat-pill"><span class="k">覆盖标的</span><span class="v">'+maxPain.length+' 个</span></span>'
          +'</div>';
      }
      return '<div style="overflow-x:auto"><table><thead><tr><th>标的</th><th>现价</th><th>多头痛点价</th><th>多头痛点量</th><th>空头痛点价</th><th>空头痛点量</th></tr></thead><tbody>'+body+'</tbody></table></div>'+stats;
    }

    /* ============ 模块7：大户多空持仓走势 ============ */
    function whaleTimelineChart(){
      if(!whaleTimeline||whaleTimeline.length<2)return '';
      const sorted=whaleTimeline.slice().sort((a,b)=>a.t-b.t);
      const W=780,H=160,padL=56,padR=12,padT=14,padB=22;
      const maxV=Math.max.apply(null,sorted.map(p=>Math.max(p.long,p.short)));
      const minV=Math.min.apply(null,sorted.map(p=>Math.min(p.long,p.short)));
      const span=(maxV-minV)||1;
      const x=i=>padL+i/(sorted.length-1||1)*(W-padL-padR);
      const y=v=>padT+(H-padT-padB)*(1-(v-minV)/span);
      let longPath='',shortPath='';
      sorted.forEach((p,i)=>{longPath+=(i?'L':'M')+x(i).toFixed(1)+' '+y(p.long).toFixed(1);shortPath+=(i?'L':'M')+x(i).toFixed(1)+' '+y(p.short).toFixed(1);});
      // 面积填充
      const longArea=longPath+' L'+x(sorted.length-1).toFixed(1)+' '+(H-padB)+' L'+x(0).toFixed(1)+' '+(H-padB)+' Z';
      const shortArea=shortPath+' L'+x(sorted.length-1).toFixed(1)+' '+(H-padB)+' L'+x(0).toFixed(1)+' '+(H-padB)+' Z';
      let ticks='';
      for(let i=0;i<=4;i++){const v=minV+span*i/4;const yy=y(v);ticks+='<text x="'+(padL-5)+'" y="'+(yy+3)+'" fill="#8a8f98" font-size="9" text-anchor="end">'+fmtUsd(v)+'</text>';}
      const tFmt=ts=>{const d=new Date(ts);return d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false})};
      const tTicks=[0,Math.floor((sorted.length-1)/2),sorted.length-1].map((i,idx)=>{const xx=x(i);return '<text x="'+xx.toFixed(1)+'" y="'+(H-8)+'" fill="#8a8f98" font-size="9" text-anchor="'+(idx===0?'start':idx===2?'end':'middle')+'">'+tFmt(sorted[i].t)+'</text>';}).join('');
      const lastLong=sorted[sorted.length-1].long, lastShort=sorted[sorted.length-1].short;
      const firstLong=sorted[0].long, firstShort=sorted[0].short;
      const lChg=firstLong>0?((lastLong-firstLong)/firstLong*100):null, sChg=firstShort>0?((lastShort-firstShort)/firstShort*100):null;
      const lsRatio=lastShort>0?(lastLong/lastShort):null;
      const legend='<div class="stat-row">'
        +'<span class="stat-pill"><span class="k">多单持仓</span><span class="v up">'+fmtUsd(lastLong)+(lChg!=null?(' · '+((lChg>=0?'+':'')+lChg.toFixed(1)+'%')):'')+'</span></span>'
        +'<span class="stat-pill"><span class="k">空单持仓</span><span class="v down">'+fmtUsd(lastShort)+(sChg!=null?(' · '+((sChg>=0?'+':'')+sChg.toFixed(1)+'%')):'')+'</span></span>'
        +'<span class="stat-pill"><span class="k">多空比</span><span class="v warn">'+(lsRatio!=null?lsRatio.toFixed(2):'—')+'</span></span>'
        +'<span class="stat-pill"><span class="k">采样</span><span class="v">'+sorted.length+' 点</span></span>'
        +'</div>';
      return '<div class="chart-wrap"><svg viewBox="0 0 '+W+' '+H+'" style="width:100%">'+ticks+tTicks
        +'<path d="'+longArea+'" fill="rgba(58,160,110,.10)"/><path d="'+longPath+'" stroke="#3aa06e" stroke-width="1.6" fill="none"/>'
        +'<path d="'+shortArea+'" fill="rgba(224,90,78,.10)"/><path d="'+shortPath+'" stroke="#e05a4e" stroke-width="1.6" fill="none"/>'
        +'</svg></div>'+legend;
    }

    /* ============ 组装主体 ============ */
    const whaleSummary=(groups.length?groups.map(groupCard).join(''):'<div class="card" style="flex:1;min-width:260px"><div class="empty">暂无大户持仓数据</div></div>');
    main.innerHTML='<div class="card" style="background:linear-gradient(135deg,rgba(240,185,11,.06),var(--bg1));border:1px solid var(--amber)">'
      +'<div class="card-title" style="justify-content:space-between"><span>'+engBadge('chip')+'🧩 筹码分布 Pro · Coinglass</span>'+tsHtml+'</div>'
      +'<div style="font-size:11px;color:var(--text3);margin-top:2px">大户持仓 · 清算墙+K线 · 清算热力图 · 订单足迹 CVD · 实时爆仓流水 · 最大痛点（会员专享）</div></div>'
      // 模块2：清算墙+K线（最核心，置顶）
      +'<div class="card"><div class="card-title">📊 BTC 清算墙（跨所聚合）</div>'+liqWallKline()+'</div>'
      // 模块3：热力图
      +'<div class="card"><div class="card-title">🔥 BTC 清算热力图（价格×时间，12h）</div>'+heatmapChart()+'</div>'
      // 模块4：足迹 CVD
      +'<div class="card"><div class="card-title">👣 订单足迹 CVD（吸筹/派发）</div>'+footprintChart()+'</div>'
      // 模块1：大户持仓
      +'<div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">'+whaleSummary+'</div>'
      // 模块7：大户持仓走势
      +(whaleTimelineChart()?'<div class="card"><div class="card-title">🐋 大户多空持仓走势</div>'+whaleTimelineChart()+'</div>':'')
      // 模块5+6：爆仓流水 + 最大痛点（并排）
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px" class="chip-grid">'
      +'<div class="card"><div class="card-title">⚡ 实时大额爆仓流水</div>'+liqOrderFeed()+'</div>'
      +'<div class="card"><div class="card-title">🎯 多空最大痛点（12h）</div>'+maxPainRows()+'</div>'
      +'</div>'
      +'<div class="card"><div class="card-title">数据说明</div><div class="verdict-block" style="font-size:12px;line-height:1.7">'
      +'筹码分布源自 Coinglass Pro 官方 API 归档。清算墙柱=该价位累计清算额（绿=下方多头清算密集区，红=上方空头清算密集区=流动性真空带，波动放大区）；'
      +'清算热力图亮区=清算密集区，接近时波动放大，穿墙概率>反转概率；CVD 绿柱=净主动买盘（吸筹），红柱=净主动卖盘（派发）。'
      +'数据仅供研究参考，不构成投资建议。</div></div>';
  }catch(e){main.innerHTML='<div class="card">加载异常: '+esc(e.message)+'</div>';}
};
/* ================= PANEL: BTC 预言机 ================= */
function buildLongTrack(d){
  const lh=d.long_history||[];
  const ld=d.long_direction;
  const days=d.long_horizon_days||30;
  let curHtml='';
  if(ld&&ld.direction==='bullish'){
    curHtml='<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:12px;background:rgba(58,160,110,.08);border:1px solid rgba(58,160,110,.3);border-radius:8px;margin-bottom:10px">'
      +'<span style="font-size:22px">🚀</span>'
      +'<div style="flex:1;min-width:200px"><div style="font-weight:700;color:var(--up)">'+esc(ld.label||'强势信号')+'</div>'
      +'<div style="font-size:11px;color:var(--text3);margin-top:2px">30日动量 '+(ld.ret30!=null?((ld.ret30>=0?'+':'')+ld.ret30.toFixed(1)+'%'):'—')+' · 60日 '+(ld.ret60!=null?((ld.ret60>=0?'+':'')+ld.ret60.toFixed(1)+'%'):'—')+' · 信号价 '+fmtPrice(ld.base_price)+'</div></div>'
      +'<div style="text-align:center"><div style="font-size:22px;font-family:var(--mono);color:var(--up);font-weight:700">'+Math.round((ld.p_up||0)*100)+'%</div><div style="font-size:10px;color:var(--text3)">30天上涨概率</div></div>'
      +'</div>';
  }else{
    curHtml='<div style="padding:10px 12px;background:var(--bg2);border:1px solid var(--line);border-radius:8px;margin-bottom:10px;display:flex;gap:10px;align-items:center">'
      +'<span style="font-size:16px">🌊</span><span style="font-size:12px;color:var(--text2)">当前无大方向信号（中性）· 仅「强势延续 / 超跌反弹」触发时给出方向，平均约 53 天 1 个信号</span></div>';
  }
  let rows='';
  if(lh.length){
    rows=lh.map(function(h){
      const t=h.ts?new Date(h.ts*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
      const lab=esc(h.label||'信号');
      const r30=h.ret30!=null?((h.ret30>=0?'+':'')+h.ret30.toFixed(1)+'%'):'—';
      let res='<span class="data-ts">待验证</span>';
      if(h.actual!=null){
        res=h.actual===1?'<span style="color:var(--up);font-weight:700">✓ 兑现</span>':'<span style="color:var(--down);font-weight:700">✗ 未兑现</span>';
      }
      return '<tr><td class="num">'+t+'</td><td>'+lab+'</td><td class="num" style="font-family:var(--mono)">'+fmtPrice(h.base_price)+'</td><td class="num">'+r30+'</td><td>'+res+'</td></tr>';
    }).join('');
  }else{
    rows='<tr><td colspan="5" class="num" style="color:var(--text3);text-align:center;padding:14px">暂无历史信号</td></tr>';
  }
  return '<div class="card" style="margin-bottom:12px"><div class="card-title">🛰 大方向轨（'+days+' 天）</div>'
    +curHtml
    +'<div style="overflow-x:auto"><table><thead><tr><th>触发时间</th><th>信号</th><th>信号价</th><th>30日动量</th><th>结果</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    +'<div class="data-ts" style="margin-top:6px">回测：强势延续 65.7% / 超跌反弹 60.2%（2020~2026）· 只发多头信号（空头无稳定 edge）</div></div>';
}
PANELS.oracle=async function(){startTabTimer('oracle',PANELS.oracle);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  try{
    const d=await fetch('/api/oracle').then(function(r){return r.json()});
    const st=await fetch('/api/oracle/stats').then(function(r){return r.json()}).catch(function(){return null});
    let statsHtml='';
    if(st&&st.ok){
      const winRows=(st.windows||[]).map(function(w){
        if(!w.samples)return '<tr><td class="num">'+w.days+'天</td><td class="num">0</td><td class="num" style="color:var(--text2)">—</td><td class="num" style="color:var(--text2)">—</td><td class="num" style="color:var(--text2)">—</td></tr>';
        const c=w.acc>=0.55?'var(--up)':w.acc<=0.45?'var(--down)':'var(--amber)';
        return '<tr><td class="num">'+w.days+'天</td><td class="num">'+w.samples+'</td>'
          +'<td class="num" style="color:'+c+';font-weight:600">'+Math.round(w.acc*100)+'%</td>'
          +'<td class="num">'+(w.bullish&&w.bullish.acc!=null?Math.round(w.bullish.acc*100)+'% <span class="data-ts">('+w.bullish.n+')</span>':'—')+'</td>'
          +'<td class="num">'+(w.bearish&&w.bearish.acc!=null?Math.round(w.bearish.acc*100)+'% <span class="data-ts">('+w.bearish.n+')</span>':'—')+'</td></tr>';
      }).join('');
      const dayBars=(st.daily||[]).map(function(x){
        const c=x.acc>=0.55?'var(--up)':x.acc<=0.45?'var(--down)':'var(--amber)';
        return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
          +'<span class="data-ts" style="width:38px">'+x.date+'</span>'
          +'<div class="bar-track" style="flex:1;max-width:none"><div class="bar-fill" style="width:'+Math.round(x.acc*100)+'%;background:'+c+'"></div></div>'
          +'<span class="num" style="width:44px;text-align:right">'+Math.round(x.acc*100)+'%</span>'
          +'<span class="data-ts" style="width:26px;text-align:right">'+x.n+'条</span></div>';
      }).join('');
      const fRows=(st.factor_report||[]).slice(0,8).map(function(f){
        const c=f.edge>=0?'var(--up)':'var(--down)';
        return '<tr><td>'+esc(f.name)+'</td><td class="num">'+Math.round(f.acc*100)+'%</td><td class="num">'+f.samples+'</td><td class="num" style="color:'+c+'">'+(f.edge>=0?'+':'')+Math.round(f.edge*100)+'%</td></tr>';
      }).join('');
      const rec=(st.record||{});
      const accC=rec.acc>=0.55?'var(--up)':rec.acc<=0.45?'var(--down)':'var(--amber)';
      // 战绩大数字区
      let hero='';
      if(rec.filled){
        const bullC=rec.bull&&rec.bull.acc!=null?(rec.bull.acc>=0.5?'var(--up)':'var(--down)'):'var(--text2)';
        const bearC=rec.bear&&rec.bear.acc!=null?(rec.bear.acc>=0.5?'var(--up)':'var(--down)'):'var(--text2)';
        const bLen=rec.best_streak?rec.best_streak.len:0;
        const bCol=rec.best_streak&&rec.best_streak.right?'var(--up)':'var(--down)';
        const cLen=rec.cur_streak?rec.cur_streak.len:0;
        const cCol=rec.cur_streak&&rec.cur_streak.right?'var(--up)':'var(--down)';
        hero='<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px">'
          +'<div style="flex:1.6;min-width:200px;background:linear-gradient(135deg,rgba(16,185,129,0.10),rgba(59,130,246,0.06));border:1px solid var(--border);border-radius:12px;padding:14px 16px;text-align:center">'
          +'<div style="font-size:11px;color:var(--text2);letter-spacing:1px">累计战绩 · 总准确率</div>'
          +'<div style="font-size:52px;font-family:var(--mono);font-weight:700;color:'+accC+';line-height:1.1">'+Math.round((rec.acc||0)*100)+'<span style="font-size:24px">%</span></div>'
          +'<div style="font-size:12px;color:var(--text2);margin-top:4px">'+rec.filled+' 次预测 · 命中 '+rec.hits+' 次'+(rec.brier!=null?' · Brier '+rec.brier:'')+'</div>'
          +'</div>'
          +'<div style="flex:1;min-width:120px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;text-align:center">'
          +'<div style="font-size:11px;color:var(--text2);letter-spacing:1px">📈 看涨命中率</div>'
          +'<div style="font-size:34px;font-family:var(--mono);font-weight:700;color:'+bullC+';line-height:1.2">'+(rec.bull&&rec.bull.acc!=null?Math.round(rec.bull.acc*100)+'%':'—')+'</div>'
          +'<div style="font-size:12px;color:var(--text2)">'+(rec.bull?rec.bull.n+' 次':'')+'</div></div>'
          +'<div style="flex:1;min-width:120px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;text-align:center">'
          +'<div style="font-size:11px;color:var(--text2);letter-spacing:1px">📉 看跌命中率</div>'
          +'<div style="font-size:34px;font-family:var(--mono);font-weight:700;color:'+bearC+';line-height:1.2">'+(rec.bear&&rec.bear.acc!=null?Math.round(rec.bear.acc*100)+'%':'—')+'</div>'
          +'<div style="font-size:12px;color:var(--text2)">'+(rec.bear?rec.bear.n+' 次':'')+'</div></div>'
          +'<div style="flex:1;min-width:120px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;text-align:center">'
          +'<div style="font-size:11px;color:var(--text2);letter-spacing:1px">🔥 最长连胜</div>'
          +'<div style="font-size:34px;font-family:var(--mono);font-weight:700;color:'+bCol+';line-height:1.2">'+bLen+'</div>'
          +'<div style="font-size:12px;color:var(--text2)">当前连胜 <b style="color:'+cCol+'">'+cLen+'</b></div></div>'
          +'</div>';
      }
      // 历史总结
      const sumHtml=rec.summary?'<div style="margin-top:10px;padding:10px 12px;background:var(--bg2);border:1px solid var(--border);border-left:3px solid '+accC+';border-radius:8px;font-size:13px;line-height:1.7">📝 <b>历史总结</b>　'+esc(rec.summary)+'</div>':'';
      statsHtml='<div class="card"><div class="card-title">📊 精度统计 · 过去一段时间预言准不准</div>'
        +hero
        +sumHtml
        +'<div style="overflow-x:auto"><table><thead><tr><th>窗口</th><th>样本</th><th>准确率</th><th>看涨命中</th><th>看跌命中</th></tr></thead><tbody>'+winRows+'</tbody></table></div>'
        +(dayBars?'<div style="margin-top:10px"><div class="data-ts" style="margin-bottom:6px">每日准确率（近 '+st.daily.length+' 天 · 已回填样本）</div>'+dayBars+'</div>':'')
        +(fRows?'<div style="margin-top:10px"><div class="data-ts" style="margin-bottom:6px">因子方向精度（30 天 · edge 相对随机基准）</div><div style="overflow-x:auto"><table><thead><tr><th>因子</th><th>精度</th><th>样本</th><th>edge</th></tr></thead><tbody>'+fRows+'</tbody></table></div></div>':'')
        +'<div class="data-ts" style="margin-top:8px">统计生成 '+st.generated_at+' · 回填窗口 24h · 预测保留 90 天</div></div>';
    }

    if(!d||!d.ok){main.innerHTML='<div class="card"><div class="card-title">📡 BTC 预言机</div><div class="empty">引擎暂不可用（独立服务维护中），稍后自动重试</div><div class="data-ts" style="margin-top:6px">不影响其他功能 · 引擎与主看板隔离</div></div>';return}
    const pu=Math.round(d.p_up*100), pd=Math.round(d.p_down*100), conf=Math.round(d.confidence*100);
    const dirCfg={bullish:{t:'看涨',c:'var(--up)',i:'📈'},bearish:{t:'看跌',c:'var(--down)',i:'📉'},neutral:{t:'中性',c:'var(--amber)',i:'⚖️'}};
    const dc=dirCfg[d.direction]||dirCfg.neutral;
    const tsHtml='<span class="data-ts">'+esc(d.generated_at||'')+' · 模型 '+esc((d.model||{}).version||'v1')+(d.model&&d.model.acc_7d!=null?' · 近7日准确率 '+Math.round(d.model.acc_7d*100)+'%':'')+'</span>';
    const factorRows=(d.factors||[]).map(function(f){
      const pct=Math.round(Math.abs(f.score)*50);
      const col=f.score>0?'var(--up)':'var(--down)';
      return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">'
        +'<span>'+esc(f.name)+'</span>'
        +'<span style="font-family:var(--mono);color:'+col+'">'+(f.score>0?'+':'')+Number(f.score).toFixed(2)+'</span></div>'
        +'<div class="bar-track" style="max-width:none"><div class="bar-fill" style="width:'+pct+'%;background:'+col+'"></div></div>'
        +'<div class="data-ts">'+esc(f.detail||'')+'</div></div>';
    }).join('');
    const hist=(d.history||[]).slice(0,14);
    const accRows=hist.filter(function(h){return h.actual!=null});
    const acc=accRows.length?Math.round(accRows.filter(function(h){return (h.actual===1&&h.p_up>0.5)||(h.actual===0&&h.p_up<0.5)}).length/accRows.length*100):null;
    const histRows=hist.map(function(h,i){
      const ht=new Date(h.ts*1000).toLocaleString('zh-CN',{hour12:false,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      const pred=h.p_up>0.58?'看涨':(h.p_up<0.42?'看跌':'中性');
      const pc=pred==='看涨'?'var(--up)':pred==='看跌'?'var(--down)':'var(--amber)';
      let res='<span class="data-ts">待验证</span>';
      if(h.actual!=null){
        const right=(h.actual===1&&h.p_up>0.5)||(h.actual===0&&h.p_up<0.5);
        res=right?'<span style="color:var(--green)">✓ 对</span>':'<span style="color:var(--red)">✗ 错</span>';
      }
      return '<tr><td class="num">'+ht+'</td><td style="color:'+pc+'">'+pred+'</td>'
        +'<td class="num">'+Math.round(h.p_up*100)+'%</td>'
        +'<td class="num">'+Math.round(h.confidence*100)+'%</td><td>'+res+'</td></tr>';
    }).join('');
    main.innerHTML='<div class="card" style="margin-bottom:12px"><div class="card-title">'+engBadge('oracle')+'📡 BTC 预言机 · 未来 12h 方向预测</div>'
      +'<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">'
      +'<div style="text-align:center;min-width:130px"><div style="font-size:46px;font-family:var(--mono);color:'+dc.c+'">'+pu+'<span style="font-size:20px">%</span></div>'
      +'<div style="font-size:12px;color:var(--text2)">上涨概率</div></div>'
      +'<div style="flex:1;min-width:220px">'
      +'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span style="color:var(--up)">📈 上涨 '+pu+'%</span><span style="color:var(--down)">📉 下跌 '+pd+'%</span></div>'
      +'<div style="display:flex;height:14px;border-radius:7px;overflow:hidden;margin-bottom:8px"><div style="width:'+pu+'%;background:var(--up)"></div><div style="width:'+pd+'%;background:var(--down)"></div></div>'
      +'<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px">'
      +'<span>方向 <b style="color:'+dc.c+'">'+dc.i+' '+dc.t+'</b></span>'
      +'<span>置信度 <b style="font-family:var(--mono)">'+conf+'%</b></span>'
      +'<span>跨所共识 <b style="font-family:var(--mono)">'+Math.round((d.consensus||0)*100)+'%</b></span>'
      +'</div></div></div>'
      +'<div style="margin-top:10px">'+tsHtml+'</div></div>'
      // ---- v6.0 大方向轨卡（次首要位置）----
      +buildLongTrack(d)
      // ---- v6.0 历史战绩 + 使用方法 + 意义卡（次首要位置）----
      +'<div class="card" style="margin-bottom:12px"><div class="card-title">🏆 历史战绩 · 使用方法 · 对交易者的意义</div>'
      +'<div style="overflow-x:auto"><table><thead><tr><th>轨道</th><th>信号</th><th>回测区间</th><th>命中率</th><th>样本</th></tr></thead><tbody>'
      +'<tr><td>短线 12h</td><td>v5.1 方向过滤</td><td>2025 年</td><td class="num" style="color:var(--up);font-weight:600">64.4%</td><td class="num">216</td></tr>'
      +'<tr><td>短线 12h</td><td>v5.1 方向过滤</td><td>2026 年</td><td class="num" style="color:var(--up);font-weight:600">62.0%</td><td class="num">108</td></tr>'
      +'<tr><td>大方向 30天</td><td>🚀 强势延续 30d&gt;+20%</td><td>2020~2026</td><td class="num" style="color:var(--up);font-weight:600">65.7%</td><td class="num">449</td></tr>'
      +'<tr><td>大方向 30天</td><td>🔄 超跌反弹 60d&lt;-20%</td><td>2020~2026</td><td class="num" style="color:var(--up);font-weight:600">60.2%</td><td class="num">369</td></tr>'
      +'<tr><td>大方向 30天</td><td>合并信号</td><td>2025 年</td><td class="num" style="color:var(--up);font-weight:600">71.2%</td><td class="num">52</td></tr>'
      +'<tr><td>大方向 30天</td><td>合并信号</td><td>2026 年</td><td class="num" style="color:var(--up);font-weight:600">82.9%</td><td class="num">70</td></tr>'
      +'</tbody></table></div>'
      +'<div style="margin-top:10px"><div class="data-ts" style="margin-bottom:4px;font-weight:600">📖 使用方法</div>'
      +'<div style="font-size:13px;line-height:1.9">'
      +'① <b>短线轨（12h）</b>：每天 2 次自动更新，看涨 / 看跌 / 中性 + 上涨概率，适合短波段方向参考<br>'
      +'② <b>大方向轨（30天）</b>：平时安静（中性），只在「强势延续 / 超跌反弹」触发时给出方向，平均约 53 天才 1 个信号<br>'
      +'③ 信号<b>宁缺毋滥</b>：不硬发信号，只打回测验证过的高确定性窗口，跟随信号即跟随真实 edge</div></div>'
      +'<div style="margin-top:10px"><div class="data-ts" style="margin-bottom:4px;font-weight:600">💡 对交易者的意义</div>'
      +'<div style="font-size:13px;line-height:1.9">'
      +'· <b>大方向导航</b>：月线级别趋势研判，平时安静、关键时刻给方向，适合中线布局参考<br>'
      +'· <b>正确率优先</b>：短线 62~64%、大方向 60~83%，均显著高于随机 50% 基准<br>'
      +'· <b>辅助决策</b>：作为方向参考信号，不构成投资建议；触发后请配合自身仓位管理使用</div></div>'
      +'<div class="data-ts" style="margin-top:8px">战绩来源：2020-01 ~ 2026-08 全量回测（57,961 根 1H K线 / 2,417 天日线）· 2026-08-13 更新</div></div>'
      +'<div class="card"><div class="card-title">🧩 因子分解 · 谁在推动这个判断</div>'
      +(factorRows||'<div class="empty">暂无因子数据</div>')+'</div>'
      +'<div class="card"><div class="card-title">📜 历史验证 · 预言机准不准'+(acc!=null?' <span class="badge" style="margin-left:6px">累计准确率 '+acc+'%</span>':'')+'</div>'
      +(histRows?'<div style="overflow-x:auto"><table><thead><tr><th>时间</th><th>预测方向</th><th>上涨概率</th><th>置信</th><th>结果</th></tr></thead><tbody>'+histRows+'</tbody></table></div>':'<div class="empty">暂无预测历史</div>')
      +'<div class="data-ts" style="margin-top:8px">来源: BTC 预言机引擎（独立 AI 深度分析）· 全平台 8 所清算 + OI + 费率 + DVOL + 动量 · 每 30 分钟更新</div></div>'+(statsHtml||'');
  }catch(e){main.innerHTML='<div class="card">加载异常: '+esc(e.message)+'</div>';}
};;

PANELS.coins=async function(){startTabTimer('coins',PANELS.coins);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  const [d, cd] = await Promise.all([
    api('/api/coins'),
    api('/api/member/consensus').catch(function(){return null})
  ]);
  if(!d.ok){main.innerHTML='<div class="card">'+T('数据不可用','Data unavailable')+'</div>';return}
  const cards=d.coins.map(c=>{
    const confPct=Math.round((c.confidence||0)*100);
    return `<div class="coin-card${c.diverged?' diverged':''}">
      <div class="coin-head">
        <span class="coin-sym">${esc(c.symbol)}</span>
        <span class="badge ${c.stance}"${(function(){var fs=stanceBadgeFlickStyle(c.stance,c.confidence);return fs?' style="'+fs+'"':'';})()}>${state.lang==='zh'?stanceZh(c.stance):stanceEn(c.stance)}</span>
      </div>
      <div class="coin-price num">${fmtPrice(c.price)} <span class="${cls(c.change_24h)}" style="font-size:12px">${fmtPct(c.change_24h)}</span></div>
      <div class="data-ts">${T('资金费率','funding')} ${c.funding!=null?(c.funding*100).toFixed(4)+'%':'—'}</div>
      <div class="conf-bar"><div class="conf-fill" style="width:${confPct}%"></div></div>
      <div class="data-ts">confidence ${confPct}% · <span class="dot ${c.status&&c.status.code==='strengthened'?'g':c.status&&c.status.code==='watch'?'y':'gray'}"></span>${c.status?esc(c.status.code):''}</div>
      <div class="coin-headline" style="margin-top:8px">${esc(state.lang==='zh'?c.headline_zh:c.headline_en)}</div>
      <div class="coin-official">
        <span class="of-tag">William archive</span><br>
        ${c.official?`<span class="badge ${c.official.stance}" style="margin-top:4px">${esc(c.official.stance)}</span>
        ${c.diverged?`<span class="badge diverge" style="margin-left:5px">${T('分歧','DIFF')}</span>`:`<span class="data-ts" style="margin-left:5px">${T('一致','aligned')}</span>`}`:'<span class="data-ts">—</span>'}
      </div>
    </div>`;
  }).join('');
  // 因子共识（Coinglass LSR Consensus · 并入 8 币立场页底部）· v2 因子明细版
  let kolHtml='';
  if(cd&&cd.ok&&(cd.coins||[]).length){
    const kolCards=cd.coins.map(c=>{
      const bias=Number(c.trust_adjusted_bias||0);
      const ew=c.equal_weight||{};
      const totalV=(Number(ew.long)||0)+(Number(ew.short)||0)+(Number(ew.neutral)||0);
      const pLong=totalV?(Number(ew.long)||0)/totalV*100:0;
      const pShort=totalV?(Number(ew.short)||0)/totalV*100:0;
      const pNeutral=totalV?(Number(ew.neutral)||0)/totalV*100:0;
      const isLong=c.decision==='long', isShort=c.decision==='short';
      const decColor=isLong?'var(--up)':isShort?'var(--down)':'#d9a441';
      const confPct=Math.round((c.confidence||0)*100);
      const weak=confPct<50;
      const factors=(c.top_factors||[]);
      const bullN=factors.filter(f=>f.direction==='bullish').length;
      const bearN=factors.filter(f=>f.direction==='bearish').length;
      const weakTag=weak?(' <span style="font-size:9px">('+confPct+'% '+T('弱共识','weak')+' )</span>'):'';
      // 因子明细表（按强度排序）
      const sortedF=factors.slice().sort((a,b)=>Math.abs(b.score||0)-Math.abs(a.score||0));
      const factorRows=sortedF.map(f=>{
        const fb=(f.direction==='bullish'||f.score>0);
        const fcol=fb?'var(--up)':'var(--down)';
        return '<tr><td style="font-size:10.5px">'+esc(f.name||f.id)+'</td>'
          +'<td class="num" style="font-size:10.5px;color:'+fcol+';font-weight:700">'+(fb?'🟢 多':'🔴 空')+'</td>'
          +'<td class="num" style="font-size:10.5px;font-family:var(--mono);color:'+fcol+'">'+(f.score>=0?'+':'')+Number(f.score).toFixed(2)+'</td>'
          +'<td style="font-size:9.5px;color:var(--text3)">'+esc(f.description||'')+'</td></tr>';
      }).join('')||'<tr><td colspan="4" class="empty">—</td></tr>';
      // 因子数据存全局（弹卡用）
      window._fcData=window._fcData||{};
      window._fcData[c.symbol]={count:c.firing_factors_count||factors.length,bullN:bullN,bearN:bearN,sorted:sortedF};
      const factTbl=factors.length?'<div style="margin-top:8px;border-top:1px dashed var(--line);padding-top:8px">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px">'
        +'<span style="color:var(--text3)">📋 '+T('触发因子','Factors')+' '+c.firing_factors_count+' · <span style="color:var(--up)">'+T('多','Long')+' '+bullN+'</span> · <span style="color:var(--down)">'+T('空','Short')+' '+bearN+'</span></span>'
        +'<span class="data-ts" style="cursor:pointer;color:var(--amber);font-weight:700" onclick="openFactorModal(\''+c.symbol+'\')">'+T('查看明细 ▸','View Details ▸')+'</span></div></div>':'';
      const aligned=(c.top_aligned_traders||[]);
      const alignedHtml=aligned.length?'<div style="margin-top:6px;font-size:9.5px;color:var(--text3)">'+T('对齐大户','Aligned')+': '+aligned.slice(0,4).map(function(a){return esc(a.name||a.id||'')}).join(' · ')+'</div>':'';
      return `<div class="coin-card">
        <div class="coin-head"><span class="coin-sym">${esc(c.symbol)}</span>
          <span class="badge ${isLong?'bullish':isShort?'bearish':'neutral'}" style="${weak?'opacity:.55':''}">${esc(c.decision_label||c.decision||'—')}${weakTag}</span></div>
        <div class="coin-price num">${fmtPrice(c.price)}</div>
        ${totalV?('<div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin:6px 0 2px"><div style="width:'+pLong+'%;background:var(--up)"></div><div style="width:'+pNeutral+'%;background:#4a4f58"></div><div style="width:'+pShort+'%;background:var(--down)"></div></div>'
          +'<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3)"><span style="color:var(--up)">'+T('多','Long')+' '+ew.long+'</span><span>'+T('中','Neutral')+' '+ew.neutral+'</span><span style="color:var(--down)">'+T('空','Short')+' '+ew.short+'</span></div>'):'<div class="conf-bar" style="margin-top:6px"><div class="conf-fill" style="width:'+confPct+'%;background:'+decColor+'"></div></div>'}
        <div class="data-ts" style="margin-top:3px">${T('偏置','bias')} <span style="color:'+(bias>=0?'var(--up)':'var(--down)')+';font-weight:700">${bias>=0?'+':''}${bias.toFixed(3)}</span> · ${T('共识','conf')} ${confPct}%${weak?' · <span style="color:var(--amber)">弱</span>':''}</div>
        ${alignedHtml}
        ${factTbl}
        <div class="coin-official" style="margin-top:6px">${T('快照','snapshot')} ${esc(c.snapshot_date||'—')} · ${c.snapshot_age_hours!=null?Number(c.snapshot_age_hours).toFixed(0)+'h':''}</div>
      </div>`;
    }).join('');
    kolHtml='<div class="card" style="margin-top:12px">'
      +'<div class="card-title">🧩 '+T('Coinglass 官方因子共识','Coinglass Official Factor Consensus')+' <span class="data-ts" style="margin-left:8px">'+T('81 因子投票聚合 · 每小时更新','81-factor voting · hourly')+'</span>'
      +'<span style="margin-left:auto;cursor:pointer;color:var(--amber);font-size:11px;font-weight:700" onclick="openFactorIntro()">'+T('因子介绍 ▸','Factor Intro ▸')+'</span>'
      +'</div>'
      +'<div class="coin-grid">'+kolCards+'</div></div>';
  }
  // 因子明细弹卡
  if(!window.__fcModal){window.__fcModal=1;
    window.openFactorModal=function(sym){
      var d=window._fcData&&window._fcData[sym];if(!d)return;
      var m=document.getElementById('fcModal');if(!m)return;
      var rows=d.sorted.map(function(f){
        var fb=(f.direction==='bullish'||f.score>0);
        var fcol=fb?'var(--up)':'var(--down)';
        return '<tr><td style="font-size:12px;padding:6px 8px">'+esc(f.name||f.id)+'</td>'
          +'<td style="font-size:12px;color:'+fcol+';font-weight:700;text-align:center;padding:6px 8px">'+(fb?'🟢 '+T('多','Long'):'🔴 '+T('空','Short'))+'</td>'
          +'<td style="font-size:12px;font-family:var(--mono);color:'+fcol+';text-align:right;padding:6px 8px">'+(f.score>=0?'+':'')+Number(f.score).toFixed(2)+'</td>'
          +'<td style="font-size:11px;color:var(--text2);padding:6px 8px">'+esc(f.description||'')+'</td></tr>';
      }).join('');
      m.querySelector('.fc-title').textContent='📋 '+sym+' · '+T('触发因子明细','Factor Details')+'（'+d.count+' 个 · '+T('多','Long')+' '+d.bullN+' / '+T('空','Short')+' '+d.bearN+'）';
      m.querySelector('.fc-body').innerHTML='<table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;padding:6px 8px">'+T('因子','Factor')+'</th><th style="padding:6px 8px">'+T('方向','Dir')+'</th><th style="padding:6px 8px;text-align:right">'+T('分数','Score')+'</th><th style="padding:6px 8px;text-align:left">'+T('说明','Note')+'</th></tr></thead><tbody>'+rows+'</tbody></table>';
      m.style.display='flex';
    };
    window.closeFactorModal=function(){var m=document.getElementById('fcModal');if(m)m.style.display='none';};
    // 因子体系介绍弹窗
    window.openFactorIntro=function(){
      var m=document.getElementById('fcModal');if(!m)return;
      m.querySelector('.fc-title').textContent='📖 '+T('因子共识体系介绍','Factor Consensus Intro');
      m.querySelector('.fc-body').innerHTML='<div style="font-size:12.5px;line-height:1.9;color:var(--text2)">'
        +'<div style="font-weight:700;color:var(--text);margin-bottom:6px">🧩 '+T('什么是因子共识？','What is Factor Consensus?')+'</div>'
        +T('Coinglass 官方 LSR 共识引擎：用 81 个量化因子对每个币种投票（做多/做空/中性），聚合后给出方向决策。','Coinglass LSR consensus: 81 quant factors vote per coin.')+'<br><br>'
        +'<div style="font-weight:700;color:var(--text);margin-bottom:6px">📊 '+T('怎么读？','How to read?')+'</div>'
        +'<b style="color:var(--up)">'+T('投票分布','Vote split')+'</b>：'+T('多/空/中三色条，一眼看共识结构（如 1 多 40 空 58 中 = 偏空但中性票多）','long/short/neutral split bar')+'<br>'
        +'<b style="color:var(--amber)">'+T('共识度','Confidence')+'</b>：'+T('投票一致性，<50% 为弱共识（中性票占多数）','agreement; <50% = weak')+'<br>'
        +'<b>'+T('偏置 Bias','Bias')+'</b>：'+T('信任加权多空偏置（负=偏空，正=偏多）','trust-adjusted bias')+'<br>'
        +'<b style="color:var(--amber)">'+T('触发因子','Firing factors')+'</b>：'+T('实际触发的因子及其强度（分数越大越强）','triggered factors with scores')+'<br><br>'
        +'<div style="font-weight:700;color:var(--text);margin-bottom:6px">🏷️ '+T('因子命名规则','Factor ID naming')+'</div>'
        +'<b>cap_</b>：'+T('周期/形态类（如 cap_037_halving_cycle 减半周期、cap_050_three_drives 三驱动、cap_056_double_needle_bottom 双针探底）','cycle/pattern (halving, three drives, double needle)')+'<br>'
        +'<b>emg_</b>：'+T('动量/结构类（如 emg_007_htf_reclaim_retest 高位收复回踩、emg_014_horizontal_reclaim 水平收复）','momentum/structure')+'<br>'
        +'<b>cap_hh_defense</b>：'+T('更高低点防守等命名因子','named pattern (higher-high defense)')+'<br><br>'
        +'<div style="font-size:11px;color:var(--text3)">'+T('数据来自 Coinglass 官方 API（lsr/consensus/v1/signals），每小时更新，仅作研究参考。','Source: Coinglass official API, hourly, research only.')+'</div></div>';
      m.style.display='flex';
    };
  }
  main.innerHTML=`<div class="card">
    <div class="card-title">${engBadge('dir')}${T('8 币立场引擎','8-Coin Stance Engine')}
      <span class="data-ts" style="margin-left:8px">${T('黄框 = 与官方分歧','amber border = divergence')}</span>
      <span style="margin-left:auto">${dataTsHtml(d.data_ts,d.stale)}</span></div>
    <div class="coin-grid">${cards}</div></div>`+kolHtml;
};

/* ================= PANEL: 情绪 ================= */
PANELS.sentiment=async function(){startTabTimer('sentiment',PANELS.sentiment);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  const d=await api('/api/fear-greed');
  const x=await api('/api/sentiment-extra');
  let extraHtml='';
  if(x&&x.ok){
    const f=x.funding||null, l=x.liquidation||null;
    const fCard=f&&f.sent?`<div class="card">
      <div class="card-title">💰 ${T('资金费率情绪','Funding Sentiment')} <span style="margin-left:auto">${dataTsHtml(x.data_ts,x.stale)}</span></div>
      <div style="display:flex;align-items:center;gap:14px">
        <div style="font-size:52px;line-height:1">${f.sent.emoji}</div>
        <div><div style="font-size:18px;font-weight:600">${esc(f.sent.label)}</div>
        <div class="data-ts">BTC 永续费率 <b style="color:${f.pct>=0.01?'var(--up)':f.pct<=-0.01?'var(--down)':'var(--text1)'}">${f.pct>0?'+':''}${f.pct.toFixed(4)}%</b></div></div>
      </div>
      <div class="verdict-block" style="margin-top:10px">${esc(f.sent.tip)}</div>
    </div>`:'';
    const imbTxt=l&&l.imbalance!=null?((l.imbalance>0?'空头多 ':'多头多 ')+Math.abs(l.imbalance*100).toFixed(0)+'%'):'—';
    const lCard=l&&l.sent?`<div class="card">
      <div class="card-title">💥 ${T('爆仓失衡','Liquidation Imbalance')} <span style="margin-left:auto">24h ${fmtUsd(l.total_24h)}</span></div>
      <div style="display:flex;align-items:center;gap:14px">
        <div style="font-size:52px;line-height:1">${l.sent.emoji}</div>
        <div><div style="font-size:18px;font-weight:600">${esc(l.sent.label)}</div>
        <div class="data-ts">爆仓差 ${imbTxt} · 空头 ${fmtUsd(l.short_24h)} / 多头 ${fmtUsd(l.long_24h)}</div></div>
      </div>
      <div class="verdict-block" style="margin-top:10px">${esc(l.sent.tip)}</div>
    </div>`:'';
    extraHtml=`<div class="grid2" style="margin-top:12px">${fCard}${lCard}</div>`;
    }

if(!d.ok){main.innerHTML='<div class="card">'+T('数据不可用','Data unavailable')+'</div>';return}
  const cur=d.current||{value:null,classification:'—'};
  const fgZh=v=>v==null?'—':v<=25?'极度恐惧':v<=45?'恐惧':v<=55?'中性':v<=75?'贪婪':'极度贪婪';
  const series=d.series.map(p=>p.value);
  const labels=d.series.map(p=>new Date(p.ts*1000).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit',timeZone:'Asia/Shanghai'}));
  const zone=cur.value<=25?'#c06a5e':cur.value<=45?'#d9a441':cur.value<=55?'#9d998f':cur.value<=75?'#8aa37a':'#5f9e7a';
  main.innerHTML=`
  <div class="grid2">
    <div class="card">
      <div class="card-title">${T('恐惧与贪婪指数','Fear & Greed Index')}
        <span style="margin-left:auto">${dataTsHtml(d.data_ts,d.stale)}</span></div>
      <div class="gauge-wrap">
        ${gaugeSVG(cur.value??50,0,100,{size:260,label:'FGI 0..100'})}
        <div class="gauge-score" style="color:${zone};${fgiFlickStyle(cur.value)}">${cur.value??'—'}</div>
        <div class="gauge-state">${state.lang==='zh'?fgZh(cur.value):esc(cur.classification||'')}</div>
      </div>
      <div class="verdict-block" style="margin-top:14px">${T('极端读数常对应反向机会：极度恐惧区往往是中长期买点观察窗，极度贪婪区则需要警惕杠杆过热。','Extreme readings are often contrarian: extreme fear marks accumulation windows; extreme greed warns of overheated leverage.')}</div>
    </div>
    <div class="card">
      <div class="card-title">${T('90 天序列','90-Day Series')}</div>
      <div class="chart-box">${lineChartSVG(series,{color:'#d9a441',yLabel:v=>Math.round(v)})}</div>
      <div class="legend"><span>${esc(labels[0]||'')}</span><span style="margin-left:auto">${esc(labels[labels.length-1]||'')}</span></div>
      <div class="kv-strip" style="margin-top:10px">
        <span>min <b>${series.length?Math.min(...series):'—'}</b></span>
        <span>max <b>${series.length?Math.max(...series):'—'}</b></span>
        <span>7d Δ <b>${series.length>=8?(series[series.length-1]-series[series.length-8]):'—'}</b></span>
        <span>30d Δ <b>${series.length>=31?(series[series.length-1]-series[series.length-31]):'—'}</b></span>
      </div>
    </div>
  </div>
  ${extraHtml}
  <div id="practical-sentiment" class="grid2" style="margin-top:12px"></div>`;
  if(typeof window.__renderPracticalSentiment==='function') window.__renderPracticalSentiment();
};

/* ---- [batchB] 三层情绪：散户 / 巨鲸机构 多空比 + 背离 + 巨鲸动向（分层一目了然） ---- */
window.__renderPracticalSentiment=async function(){
  var el=document.getElementById('practical-sentiment');
  if(!el) return;
  var html='';
  var tiers=null, wt=null;
  try{ tiers=await api('/api/sentiment-tiers'); }catch(e){}
  try{ wt=await api('/api/whale-tracker'); }catch(e){}

  // 标题
  html+='<div style="grid-column:1/-1"><div class="card-title">👥 '+T('三层情绪 · 散户 vs 巨鲸','Sentiment Tiers: Retail vs Whale')+'</div></div>';

  // 散户情绪卡
  if(tiers && tiers.ok && tiers.retail){
    var rp=tiers.retail.pct_long;
    var rCls=rp>=65?'var(--up)':rp<=35?'var(--down)':'var(--text2)';
    var rLab=rp>=65?'过度看多(拥挤)':rp>=55?'偏多':rp<=35?'过度看空(拥挤)':rp<=45?'偏空':'中性';
    html+='<div class="card"><div class="card-title">🟦 '+T('散户情绪','Retail Sentiment')+'</div>'
      +'<div style="display:flex;align-items:center;gap:12px">'
      +'<div style="font-size:36px;font-weight:800;font-family:var(--mono);color:'+rCls+'">'+rp+'%</div>'
      +'<div style="font-size:14px;font-weight:600;color:'+rCls+'">'+rLab+' <span class="data-ts">做多占比</span></div></div>'
      +'<div class="data-ts" style="margin-top:6px">多 '+esc(String(tiers.retail.long_count||'—'))+' / 空 '+esc(String(tiers.retail.short_count||'—'))+' 账户</div>'
      +'<div class="verdict-block" style="margin-top:8px;font-size:12px">'+T('指标含义：散户做多账户占比。>65% 过度看多（拥挤，谨防回落）；<35% 过度看空（恐慌，或迎反弹）。散户常追涨杀跌，极端时是反向参考。','% of retail accounts long. >65% overcrowded long, <35% panic short; retail often chases, treat extremes as contrarian.')+'</div></div>';
  }

  // 巨鲸/机构情绪卡
  if(tiers && tiers.ok && tiers.whale){
    var wp=tiers.whale.pct_long;
    var wCls=wp>=65?'var(--up)':wp<=35?'var(--down)':'var(--text2)';
    var wLab=wp>=65?'机构做多':wp>=55?'偏多':wp<=35?'机构做空':wp<=45?'偏空':'中性';
    html+='<div class="card"><div class="card-title">🐋 '+T('主力机构/巨鲸情绪','Whale Sentiment')+'</div>'
      +'<div style="display:flex;align-items:center;gap:12px">'
      +'<div style="font-size:36px;font-weight:800;font-family:var(--mono);color:'+wCls+'">'+wp+'%</div>'
      +'<div style="font-size:14px;font-weight:600;color:'+wCls+'">'+wLab+' <span class="data-ts">做多占比</span></div></div>'
      +'<div class="data-ts" style="margin-top:6px">多 '+esc(String(tiers.whale.long_count||'—'))+' / 空 '+esc(String(tiers.whale.short_count||'—'))+' 巨鲸</div>'
      +'<div class="verdict-block" style="margin-top:8px;font-size:12px">'+T('指标含义：巨鲸/机构做多账户占比（大额持仓者）。资金量大、信息更灵，通常比散户更接近真实方向；>65% 看多、<35% 看空。','% of whale/institutional accounts long. Big money, usually closer to real direction; >65% long, <35% short.')+'</div></div>';
  }

  // 背离信号卡（最强信号）
  if(tiers && tiers.ok && tiers.divergence_pct!=null){
    var dv=tiers.divergence_pct;
    var dvAbs=Math.abs(dv);
    var dvCls=dvAbs>=10?'var(--amber)':dvAbs>=5?'#d9a441':'var(--text2)';
    var dvLab=dv>=10?'鲸鱼看多·散户看空':dv<=-10?'鲸鱼看空·散户看多':dv>=5?'鲸鱼偏多背离':dv<=-5?'鲸鱼偏空背离':'方向一致';
    var dvTip=dvAbs>=10?T('强背离：鲸鱼与散户方向相反，鲸鱼通常是对的，最强方向信号','Strong divergence: whales usually right'):dvAbs>=5?T('中等背离，关注鲸鱼方向','Mild divergence'):T('散户与巨鲸方向一致，无背离','No divergence');
    html+='<div class="card"><div class="card-title">⚡ '+T('散户-巨鲸 背离','Retail-Whale Divergence')+'</div>'
      +'<div style="display:flex;align-items:center;gap:12px">'
      +'<div style="font-size:36px;font-weight:800;font-family:var(--mono);color:'+dvCls+'">'+(dv>0?'+':'')+dv+'%</div>'
      +'<div style="font-size:14px;font-weight:600;color:'+dvCls+'">'+dvLab+'</div></div>'
      +'<div class="verdict-block" style="margin-top:8px;font-size:12px">'+esc(dvTip)+'</div>'
      +'<div class="data-ts" style="margin-top:4px">'+T('指标含义：巨鲸做多占比 − 散户做多占比。正值=鲸鱼比散户更看多，负值=鲸鱼更看空；|差值|≥10% 为强背离，鲸鱼方向通常更可信。','Whale %long − Retail %long. Positive = whales more bullish; |Δ|≥10% strong divergence, whales usually right.')+'</div></div>';
  }

  // 巨鲸动向卡（whale-tracker π1：BTC 多空比 + 综合信号）
  if(wt && wt.ok){
    var w=wt.btc||null;
    var sigs=(wt.signals||[]);
    if(w && w.whale_ratio!=null){
      var wr=w.whale_ratio;
      var wd=w.whale_delta_4h;
      var wc2=wr>1.5?'var(--up)':wr<0.67?'var(--down)':'var(--text2)';
      var wdTxt=wd!=null?('<span style="color:'+(wd>=0?'var(--up)':'var(--down)')+'">'+(wd>=0?'+':'')+(wd*100).toFixed(1)+'%</span>'):'--';
      var sigHtml=sigs.length?('<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">'+sigs.slice(0,3).map(function(sg){
        var sc=sg.level==='strong'?'#e0b36a':sg.level==='mid'?'#8ab87a':'var(--text3)';
        return '<span style="display:inline-block;padding:3px 10px;border-radius:5px;font-size:11px;border:1px solid '+sc+';color:'+sc+'" title="'+esc(sg.detail||'')+'">'+esc(sg.label)+'</span>';
      }).join('')+'</div>'):'';
      html+='<div class="card"><div class="card-title">📡 '+T('巨鲸动向','Whale Movement')+' <span class="data-ts">'+esc(w.symbol||'').replace(/USDT$/,'')+'</span></div>'
        +'<div style="font-size:36px;font-weight:800;font-family:var(--mono);color:'+wc2+'">'+Number(wr).toFixed(2)+'</div>'
        +'<div class="data-ts" style="margin-top:4px">4h 变化 '+wdTxt+' · 多空比</div>'
        +sigHtml
        +'<div class="verdict-block" style="margin-top:8px;font-size:12px">'+T('巨鲸多空比>1.5看多、<0.67看空；4h变化反映短期加仓方向','Whale L/S ratio direction')+'</div>'
        +'<div class="data-ts" style="margin-top:4px">'+T('指标含义：巨鲸多空比=多头持仓÷空头持仓，>1 多方占优，>1.5 强多、<0.67 弱多偏空；4h变化是巨鲸近期加减仓的方向。','Whale L/S ratio = long÷short position. >1.5 strong long, <0.67 weak; 4h delta shows recent whale positioning.')+'</div></div>';
    } else if(sigs.length){
      // BTC 行缺失但有综合信号
      var sigHtml=sigs.slice(0,3).map(function(sg){
        var sc=sg.level==='strong'?'#e0b36a':'#8ab87a';
        return '<span style="display:inline-block;padding:3px 10px;border-radius:5px;font-size:11px;border:1px solid '+sc+';color:'+sc+'">'+esc(sg.label)+'</span>';
      }).join('');
      html+='<div class="card"><div class="card-title">📡 '+T('巨鲸动向','Whale Movement')+'</div>'
        +'<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">'+sigHtml+'</div>'
        +'<div class="data-ts" style="margin-top:6px">'+T('暂无 BTC 巨鲸多空比，展示综合信号','No BTC ratio, showing aggregate signals')+'</div></div>';
    }
  }

  el.innerHTML=html||('<div class="empty">'+T('暂无数据','No data')+'</div>');
};/* ================= PANEL: 资金流 ================= */
PANELS.flows=async function(){startTabTimer('flows',PANELS.flows);
  const main=$('#main');
  main.innerHTML='<div class="card">\u52a0\u8f7d\u4e2d\u2026</div>';
  try{
  const d=await api('/api/etf-flows');
  const oi=await api('/api/oi-summary');
  if(!d.ok)throw new Error('etf api failed');
  const etf=(d.etf_btc_flow_14d||[]).map(function(x){return{label:x.label||x.date||'',value:Math.round(x.value*10)/10}});
  var p=oi&&oi.ok?(oi.avg_oi_change_24h_pct||0):0;
  main.innerHTML='<div class="card"><div class="card-title">ETF \u6bd4\u7279\u5e01 14 \u65e5\u8d44\u91d1\u6d41</div>'
    +(etf.length?'<div class="chart-box">'+barChartSVG(etf)+'</div>':'<div class="empty">ETF \u6570\u636e\u6682\u65e0</div>')
    +'<div class="kv-strip" style="margin-top:8px"><span>\u8fd13\u65e5\u5408\u8ba1</span><b>'+(d.etf_recent3_musd>=0?'+':'')+Math.round(d.etf_recent3_musd||0)+'M</b></span>ETF \u63a8\u52a8\u60c5\u7eea\u6307\u6570</div>'
    +(function(){
      var flow=d.etf_recent3_musd||0;
      // \u8ba1\u7b97\u6307\u6570: 0-100, \u57fa\u51c6\u8303\u56f4 -1000~+1000M
      var idx=Math.min(100,Math.max(0,(flow+1000)/2000*100));
      var color=idx<25?'#c06a5e':idx<45?'#d9a441':idx<55?'#8ab87a':'#5f9e7a';
      var label=idx<25?'\u6781\u5ea6\u60b2\u89c2':idx<45?'\u504f\u60b2\u89c2':idx<55?'\u4e2d\u6027':idx<75?'\u504f\u4e50\u89c2':'\u6781\u5ea6\u4e50\u89c2';
      return '<div style="margin-top:10px">'
        +'<div style="display:flex;justify-content:space-between;font-size:11px;color:#888;margin-bottom:4px">'
        +'<span>'+(flow>=0?'\u6d41\u5165 '+(Math.round(flow))+'M':'\u6d41\u51fa '+(Math.round(Math.abs(flow)))+'M')+'</span>'
        +'<span style="color:'+color+';font-weight:600">'+label+'</span></div>'
        +'<div style="display:flex;align-items:center;gap:6px">'
        +'<span style="font-size:9px;color:#c06a5e">\u60b2\u89c2</span>'
        +'<div style="flex:1;height:14px;border-radius:7px;background:linear-gradient(to right,#c06a5e,#d9a441,#8ab87a,#5f9e7a);overflow:hidden;position:relative">'
        +'<div style="position:absolute;top:0;left:0;height:100%;width:'+idx+'%;background:rgba(255,255,255,0.35);border-radius:7px 0 0 7px"></div>'
        +'<div style="position:absolute;top:1px;left:'+(idx-1)+'%;height:12px;width:2px;background:white;border-radius:1px"></div>'
        +'</div>'
        +'<span style="font-size:9px;color:#5f9e7a">\u4e50\u89c2</span></div>'
        +'<div style="font-size:10px;color:#888;margin-top:4px">\u57fa\u4e8e ETF \u8fd13\u65e5\u6d41\u5165/\u6d41\u51fa\u603b\u989d\uff0c\u8303\u56f4 -1000M ~ +1000M</div></div>';
    })()
    +'</div><div class="card" id="flows-oi-card"><div class="card-title">\u6301\u4ed3\u91cf\uff08OI\uff09\u6458\u8981<span style="margin-left:auto" id="flows-oi-ts"></span></div><div id="flows-oi-data" class="empty">\u52a0\u8f7d\u4e2d\u2026</div></div>'+'<div class="card" id="flows-mg-card"><div class="card-title">'+T('\u5e02\u573a\u5168\u5c40 \u00b7 30 \u65e5','Market Global \u00b7 30d')+'</div><div class="empty">'+T('\u52a0\u8f7d\u4e2d\u2026','Loading...')+'</div></div>'+'<div class="card" id="altseason-card"><div class="card-title">'+T('\u5c71\u5be8\u5b63 / \u4e3b\u6d41\u5b63','Altseason / BTC Season')+'</div><div class="empty">'+T('\u52a0\u8f7d\u4e2d\u2026','Loading...')+'</div></div>'+'<div class="card" id="btc-chain-data"><div class="card-title">BTC \u94fe\u4e0a\u6307\u6807\u52a0\u8f7d\u4e2d\u2026</div></div>';
  
fetch('/api/oi-summary').then(function(r){return r.json()}).then(function(oi){
    if(!oi||!oi.ok){var el0=document.getElementById('flows-oi-data');if(el0)el0.innerHTML='<div class="empty">OI 数据暂不可得</div>';return;}
    var pct=oi.avg_oi_change_24h_pct||0;
    var clr=pct>=3?'var(--up)':pct>=1?'#8ab87a':pct>=-0.5?'#d9a441':pct>=-2?'var(--down)':'#a04040';
    var barW=Math.min(100,Math.max(0,(pct+5)/10*100));
    var el=document.getElementById('flows-oi-data');
    if(!el)return;
    el.innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">'
      +'<div style="background:#1c1e24;padding:6px 8px;border-radius:4px"><div style="font-size:10px;color:#888">\u5168\u5e02\u573a OI</div><div style="font-size:14px;font-weight:600">'+fmtUsd(oi.total_oi_usd)+'</div></div>'
      +'<div style="background:#1c1e24;padding:6px 8px;border-radius:4px"><div style="font-size:10px;color:#888">24h \u53d8\u5316</div><div style="font-size:14px;font-weight:600;color:'+clr+'">'+(pct>=0?'+':'')+pct.toFixed(2)+'%</div></div>'
      +'<div style="background:#1c1e24;padding:6px 8px;border-radius:4px"><div style="font-size:10px;color:#888">BTC OI</div><div style="font-size:14px;font-weight:600">'+fmtUsd(oi.btc_oi_usd)+'</div></div>'
      +'<div style="background:#1c1e24;padding:6px 8px;border-radius:4px"><div style="font-size:10px;color:#888">BTC \u5e02\u5360\u7387</div><div style="font-size:14px;font-weight:600;color:#d9a441">'+(oi.btc_dominance!=null?oi.btc_dominance.toFixed(1)+'%':'\u2014')+'</div></div>'
      +'</div>'
      +'<div style="display:flex;justify-content:space-between;font-size:10px;color:#888;margin-bottom:2px"><span>OI \u4fe1\u5fc3</span><span style="color:'+clr+'">'+(pct>=3?'\u6781\u5ea6\u770b\u6da8':pct>=1?'\u770b\u6da8':pct>=-0.5?'\u4e2d\u6027':pct>=-2?'\u504f\u5f31':'\u770b\u8dcc')+'</span></div>'
      +'<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:14px;border-radius:7px;background:#1a1c21;overflow:hidden">'
      +'<div style="height:100%;border-radius:7px;width:'+barW+'%;background:'+clr+'"></div></div>'
      +'<div style="font-size:12px;min-width:50px;text-align:right;color:'+clr+'">'+(pct>=0?'+':'')+pct.toFixed(2)+'%</div></div>';
    var tsEl=document.getElementById('flows-oi-ts');
    if(tsEl)tsEl.innerHTML=dataTsHtml(oi.data_ts,false);
  }).catch(function(){});
// \u5e02\u573a\u5168\u5c40\uff08\u81ea\u7814 CoinGecko\uff09
  fetch('/api/market-global').then(function(r){return r.json()}).then(function(g){
    if(!g||!g.ok)return;
    var el=document.getElementById('flows-mg-card');
    if(!el)return;
    var cur=g.current||{};
    var s=g.series||{};
    var fmtCap=function(v){return v==null?'\u2014':(v>=1e12?(v/1e12).toFixed(2)+'T':(v/1e9).toFixed(0)+'B')};
    var mk=function(pts,color,fmt,ymin,ymax,gn,extras){
      // 先剔除 0/负数/非数值点：成交额历史估算失败会留下 0，折线会突然垂直砸到 0
      pts=(pts||[]).filter(function(p){return p&&p.y!=null&&isFinite(p.y)&&p.y>0});
      if(!pts||pts.length<2)return '<div class="empty">\u2014</div>';
      var ys=pts.map(function(p){return Number(p.y)});
      if(ymin==null)ymin=Math.max(0,Math.min.apply(null,ys)*0.95);
      if(ymax==null)ymax=Math.max.apply(null,ys)*1.08;
      if(ymax<=ymin)ymax=ymin+1;
      var opt={color:color,yLabel:fmt,gridN:gn||5,xTickStep:Math.max(1,Math.ceil(pts.length/6)),xTickFmt:function(i){return pts[i].x.slice(5)},smooth:true,smoothTension:0.6,yMin:ymin,yMax:ymax};
      if(extras&&extras.length)opt.extras=extras;
      return '<div class="chart-box">'+lineChartSVG(pts,opt)+'</div>';
    };
    el.innerHTML='<div class="card-title">'+T('\u5e02\u573a\u5168\u5c40 \u00b7 30 \u65e5','Market Global \u00b7 30d')+'<span style="margin-left:auto" class="data-ts">CoinGecko</span></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:6px 0">'
      +'<div class="oi-i"><div class="oi-l">'+T('\u52a0\u5bc6\u603b\u5e02\u503c','Total Cap')+'</div><div class="oi-v" style="color:#d9a441">'+fmtCap(cur.total_mcap_usd)+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">'+T('24h \u6210\u4ea4\u989d','24h Volume')+'</div><div class="oi-v" style="color:#6ea8d8">'+fmtCap(cur.total_volume_usd)+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">'+T('BTC \u5e02\u503c\u5360\u6bd4','BTC Dom')+'</div><div class="oi-v" style="color:#8aa37a">'+(cur.btc_dom_pct!=null?cur.btc_dom_pct.toFixed(1)+'%':'\u2014')+'</div></div>'
      +'</div>'
      +'<div style="font-size:11px;color:var(--text3);margin:8px 0 2px">'+T('\u52a0\u5bc6\u603b\u5e02\u503c','Total Market Cap')+'</div>'+mk(s.mcap,'#d9a441',fmtCap,null,null)
      +'<div style="font-size:11px;color:var(--text3);margin:10px 0 2px">'+T('24h \u6210\u4ea4\u989d','24h Volume')+'</div>'+mk(s.volume,'#6ea8d8',fmtCap,null,null,8,(function(){
        // 高点连接 + 低点下拉：峰-低-峰交替序列，红线随高低点真实波动
        var vp=(s.volume||[]).filter(function(p){return p&&p.y!=null&&isFinite(p.y)&&p.y>0});if(vp.length<6)return[];
        // 相对高点（span=2）
        var raw=[];
        for(var vi=2;vi<vp.length-2;vi++){
          var vv=vp[vi].y;
          if(vv>vp[vi-1].y&&vv>vp[vi+1].y&&vv>vp[vi-2].y&&vv>vp[vi+2].y)raw.push({i:vi,y:vv});
        }
        var peaks=[];
        for(var pk=0;pk<raw.length;pk++){
          var pp=raw[pk],last=peaks[peaks.length-1];
          if(last&&pp.i-last.i<3){if(pp.y>last.y)peaks[peaks.length-1]=pp;}else peaks.push(pp);
        }
        if(peaks.length<2)return[];
        // 峰间最低点插入（红线在低点处真实下降，降低幅度取一半——避免降太深）
        var pts=[];
        for(var ki=0;ki<peaks.length;ki++){
          pts.push(peaks[ki]);
          if(ki<peaks.length-1){
            var lo=peaks[ki].i,loY=vp[lo].y;
            for(var li=peaks[ki].i+1;li<peaks[ki+1].i;li++){if(vp[li].y<loY){loY=vp[li].y;lo=li;}}
            var peakAvg=(peaks[ki].y+peaks[ki+1].y)/2;
            pts.push({i:lo,y:loY*0.4+peakAvg*0.6}); // 降幅 40%（再柔和一点）
          }
        }
        return [{pts:pts,dots:peaks,color:'#e0533d',lift:5}];
      })())
      +'<div style="font-size:11px;color:var(--text3);margin:10px 0 2px">'+T('BTC \u5e02\u503c\u5360\u6bd4','BTC Dominance')+'</div>'+mk(s.dom,'#8aa37a',function(v){return v.toFixed(1)+'%'},40,70)
      +'<div class="data-ts" style="margin-top:8px">'+T('\u6765\u6e90','Source')+': CoinGecko \u00b7 \u6bcf 30 \u5206\u949f\u81ea\u91c7 \u00b7 '+T('\u5386\u53f2\u4e3a\u4f30\u7b97\uff08BTC\u6210\u4ea4\u91cf\u5360\u6bd4\u951a\u5b9a\uff09','Hist ~est (BTC vol share)')+'</div>';
  }).catch(function(){});
// \u5c71\u5be8\u5b63 / \u4e3b\u6d41\u5b63\uff08\u81ea\u7814\u5224\u65ad\u5f15\u64ce\uff09
  fetch('/api/altseason').then(function(r){return r.json()}).then(function(a){
    if(!a||!a.ok)return;
    var el=document.getElementById('altseason-card');
    if(!el)return;
    var d=a.current||{};
    var stageClr={altseason:'#5f9e7a',transition:'#d9a441',btc_season:'#6ea8d8'}[d.stage]||'#d9a441';
    var stageIcon={altseason:'\ud83c\udf3f',transition:'\u26a1',btc_season:'\ud83d\udc15'}[d.stage]||'';
    // \u8fc7\u6e21\u65b9\u5411\uff1a\u4f18\u5148\u5206\u6570\u5e8f\u5217\u5bf9\u6bd4\uff08\u4eca\u65e5 vs \u6628\u65e5\uff09\uff1b\u65e0\u5386\u53f2\u65f6\u7528 BTC.D \u8fd13\u65e5\u8d8b\u52bf\uff08\u660e\u786e\u6807\u6ce8\u4f9d\u636e\uff09
    var hh=(a.history||[]);
    var dir=0, dirBasis='';
    if(hh.length>=2&&hh[0].score!=null&&hh[1].score!=null){
      dir=hh[0].score>hh[1].score?1:hh[0].score<hh[1].score?-1:0;
      dirBasis=T('\u8fd12\u65e5\u5206\u6570','2d score');
    }else if(d.dom_trend!=null&&d.dom_trend!==0){
      dir = d.dom_trend < 0 ? 1 : -1;   // BTC.D \u8dcc = \u5411\u5c71\u5be8
      dirBasis=T('BTC.D \u8fd13\u65e5','BTC.D 3d');
    }
    var dirClr=dir>0?'#5f9e7a':dir<0?'#6ea8d8':'#8a8f98';
    var dirArrow=dir>0?'\u25b6':dir<0?'\u25c0':'|';
    var dirText=dir>0?T('\u6b63\u5728\u5411\u5c71\u5be8\u5b63\u8fc7\u6e21 \u2192','Trending to Altseason \u2192'):dir<0?T('\u6b63\u5728\u5411\u4e3b\u6d41\u5b63\u8fc7\u6e21 \u2190','Trending to BTC Season \u2190'):T('\u65b9\u5411\u672a\u660e\uff08\u6570\u636e\u79ef\u7d2f\u4e2d\uff09','No direction yet');
    if(dirBasis)dirText+='\uff08'+dirBasis+'\uff09';
    var dimRows=(d.dims?Object.keys(d.dims):[]).map(function(k){
      var v=d.dims[k];
      var pct=Math.round((v.score+1)/2*100);
      var clr=v.score>=0?'var(--up)':v.score<0?'var(--down)':'var(--yellow)';
      return '<div style="margin-top:7px"><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3)"><span>'+esc(v.label_zh)+' <span class="data-ts">'+v.weight+'%</span></span></div>'
        +'<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text2);margin-top:2px"><span>'+esc(v.detail_zh)+'</span><span style="color:'+clr+'">'+pct+'</span></div>'
        +'<div style="height:6px;border-radius:3px;background:var(--bg2);margin-top:3px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+clr+';opacity:.8"></div></div></div>';
    }).join('');
    var hist=(a.history||[]).slice(0,7).map(function(h){
      var hc={altseason:'#5f9e7a',transition:'#d9a441',btc_season:'#6ea8d8'}[h.stage]||'#888';
      return '<span style="font-size:9px;color:var(--text3)"><span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:'+hc+';margin-right:3px;vertical-align:middle"></span>'+h.date.slice(5)+' '+h.score+'</span>';
    }).join('');
    var histChart='';
    var hist30=(a.history||[]).slice().reverse();
    if(hist30.length>=2){
      var pts=hist30.map(function(h){return{x:h.date,y:h.score}});
      histChart='<div style="margin-top:10px"><div style="font-size:11px;color:var(--text3);margin-bottom:2px">'+T('\u8fd1\u534a\u5e74\u5206\u6570','Score 6m')+'</div><div class="chart-box">'+lineChartSVG(pts,{color:'#d9a441',yLabel:function(v){return v},gridN:5,xTickStep:Math.max(1,Math.ceil(pts.length/10)),xTickFmt:function(i){return pts[i].x.slice(5)},smooth:true,smoothTension:0.6,yMin:0,yMax:100,hlines:[{y:35,color:'#8a8f98',dash:'3,4',label:'35 \u4e3b\u6d41'},{y:65,color:'#8a8f98',dash:'3,4',label:'65 \u5c71\u5be8'}]})+ '</div></div>';
    }
    el.innerHTML='<div class="card-title">'+stageIcon+' '+T('\u5c71\u5be8\u5b63 / \u4e3b\u6d41\u5b63','Altseason / BTC Season')+'<span style="margin-left:auto" class="data-ts">'+T('\u81ea\u7814\u5224\u65ad\u5f15\u64ce','Self engine')+'</span></div>'
      +'<div style="display:flex;align-items:center;gap:14px;margin:8px 0">'
      +'<div style="font-size:34px;font-weight:800;font-family:var(--mono);color:'+stageClr+'">'+(d.score!=null?d.score:'—')+'</div>'
      +'<div style="flex:1"><div style="font-size:16px;font-weight:700;color:'+stageClr+'">'+esc(d.stage_zh||d.stage)+'</div>'
      +'<div style="font-size:10px;color:'+dirClr+';margin-top:1px">'+dirArrow+' '+esc(dirText)+'</div>'
      +'<div style="height:10px;border-radius:5px;background:linear-gradient(to right,#6ea8d8,#d9a441,#5f9e7a);margin-top:5px;position:relative;overflow:hidden">'
      +'<div style="position:absolute;top:-3px;left:'+(d.score!=null?d.score:50)+'%;transform:translateX(-50%);color:'+dirClr+';font-size:14px;line-height:1;text-shadow:0 1px 3px rgba(0,0,0,.9)">'+dirArrow+'</div></div>'
      +'<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3);margin-top:2px"><span>0 '+T('\u4e3b\u6d41\u5b63','BTC')+'</span><span>100 '+T('\u5c71\u5be8\u5b63','Alt')+'</span></div></div></div>'
      +dimRows
      +(d.note_zh?'<div class="verdict-block" style="font-size:11px;line-height:1.6;margin-top:8px">'+esc(d.note_zh)+'</div>':'')
      +(hist?'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">'+hist+'</div>':'')
      +histChart
      +'<div class="data-ts" style="margin-top:6px">'+T('\u7f6e\u4fe1','Conf')+': '+esc(d.confidence||'-')+' \u00b7 '+esc(d.coverage_zh||'')+'</div>';
  }).catch(function(){});
// BTC \u94fe\u4e0a\u6307\u6807
  fetch('/api/btc-onchain').then(function(r){return r.json()}).then(function(b){
    if(!b||!b.ok)return;
    var c=b.data;
    var eh=(c.hashrate_exa||'0')+' EH/s';
    var mcap='$'+(c.market_cap_usd>=1e12?(c.market_cap_usd/1e12).toFixed(2)+'T':(c.market_cap_usd/1e9).toFixed(0)+'B');
    document.getElementById('btc-chain-data').innerHTML='<div class="card-title">BTC \u94fe\u4e0a\u6307\u6807</div>'
      +'<div class="onchain-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-top:8px">'
      +'<div class="oi-i"><div class="oi-l">\u4ef7\u683c</div><div class="oi-v">'+fmtPrice(c.price)+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">\u5e02\u503c</div><div class="oi-v">'+mcap+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">\u7b97\u529b</div><div class="oi-v">'+eh+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">\u7f51\u7edc\u96be\u5ea6</div><div class="oi-v">'+(c.difficulty?(c.difficulty/1e12).toFixed(1)+'T':'--')+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">24h \u4ea4\u6613</div><div class="oi-v">'+Number(c.transactions_24h||0).toLocaleString()+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">\u5185\u5b58\u6c60</div><div class="oi-v">'+Number(c.mempool_txs||0).toLocaleString()+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">\u5e73\u5747\u624b\u7eed\u8d39</div><div class="oi-v">'+(c.avg_tx_fee_usd?'$'+Number(c.avg_tx_fee_usd).toFixed(2):'--')+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">\u8282\u70b9\u6570</div><div class="oi-v">'+Number(c.nodes||0).toLocaleString()+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">\u533a\u5757\u9ad8\u5ea6</div><div class="oi-v">'+Number(c.block_height||0).toLocaleString()+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">24h \u6700\u5927\u4ea4\u6613</div><div class="oi-v">'+(c.largest_tx_usd?'$'+(c.largest_tx_usd>=1e9?(c.largest_tx_usd/1e9).toFixed(2)+'B':(c.largest_tx_usd/1e6).toFixed(0)+'M'):'--')+'</div></div>'
      +'<div class="oi-i"><div class="oi-l">24h \u901a\u80c0</div><div class="oi-v">$'+Number((c.inflation_usd_24h||0)/1e6).toFixed(0)+'M</div></div>'
      +'</div>'
      +'<div style="font-size:10px;color:#888;margin-top:6px">\u6765\u6e90: Blockchair + mempool.space</div>';
  }).catch(function(){});


}catch(e){main.innerHTML='<div class="card">Error: '+esc(e.message)+'</div>';}
};PANELS.markets=async function(){
  const main=$('#main');
  async function draw(){
    try{
    const d=await api('/api/markets');
    if(!d.ok||state.tab!=='markets')return;
    const spotRows=(d.spot||[]).map(r=>`<tr>
      <td class="coin-sym" style="font-size:14px">${esc(r.symbol)}</td>
      <td class="num">${fmtPrice(r.price)}</td>
      <td class="num ${cls(r.change_24h)}">${fmtPct(r.change_24h)}</td>
      <td class="num">${fmtPrice(r.high_24h)}</td><td class="num">${fmtPrice(r.low_24h)}</td>
      <td class="num">${fmtUsd(r.volume)}</td></tr>`).join('');
    const futRows=(d.futures_top||[]).map((c,i)=>`<tr>
      <td class="num">${i+1}</td><td>${esc(c.symbol)}</td>
      <td class="num">${fmtPrice(c.price)}</td>
      <td class="num ${cls(c.change_24h)}">${fmtPct(c.change_24h)}</td>
      <td class="num ${cls((c.funding||0)*1e4)}">${c.funding!=null?(c.funding*100).toFixed(4)+'%':'—'}</td>
      <td class="num">${fmtUsd(c.oi_usd)}</td>
      <td class="num ${cls(c.oi_change_24h)}">${fmtPct(c.oi_change_24h)}</td></tr>`).join('');
    main.innerHTML=`
    <div class="card">
      <div class="card-title">${T('现货行情 · Gate 8 币','Spot · Gate 8 Coins')}
        <span style="margin-left:auto">${dataTsHtml(d.data_ts,d.stale)} <span class="data-ts">60s 自刷</span></span></div>
      <div style="overflow-x:auto"><table><thead><tr><th>${T('币种','Symbol')}</th><th>${T('价格','Price')}</th><th>24h</th><th>${T('24h高','High')}</th><th>${T('24h低','Low')}</th><th>${T('成交额','Volume')}</th></tr></thead><tbody>${spotRows||'<tr><td colspan="6" class="empty">—</td></tr>'}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-title">${T('合约市场 TOP50 · Coinglass','Futures TOP50 · Coinglass')}</div>
      <div style="overflow-x:auto"><table><thead><tr><th>#</th><th>${T('币种','Symbol')}</th><th>${T('价格','Price')}</th><th>24h</th><th>${T('全市场费率','Mkt Funding')}</th><th>OI</th><th>OI 24h</th></tr></thead><tbody>${futRows||'<tr><td colspan="7" class="empty">—</td></tr>'}</tbody></table></div>
    </div>`;
    }catch(e){main.innerHTML='<div class="card">'+esc(T('加载异常','Load error'))+': '+esc(e.message)+'</div>';}
  }
  await draw();
  startTabTimer('markets',draw);
};

/* ================= PANEL: 概念词典 ================= */


/* ================= 姿态翻转倒计时组件（并入市场分析页） ================= */
function renderCountdownCard(d){
  const cd=d.countdown||{}, p=d.posture||{};
  const stateZh={'defensive':'防御','neutral':'中性','offensive':'进攻','cautious':'谨慎','aggressive':'积极','risk_off':'避险','risk_on':'进攻'};
  const stateEn={'defensive':'Defensive','neutral':'Neutral','offensive':'Offensive','cautious':'Cautious','aggressive':'Aggressive','risk_off':'Risk Off','risk_on':'Risk On'};
  const stTxt=T(stateZh[p.state]||p.state, stateEn[p.state]||p.state);
  const score=Number(p.score||0);
  const scoreCls=score>0.5?'up':score<-0.5?'down':'';
  const overall=Math.round((cd.overall_progress||0)*100);
  const moveZh={done:'已达成',closer:'接近中',none:'无进展'};
  const moveCol={done:'#5f9e7a',closer:'#d9a441',none:'#6d6a62'};
  const bigCard=(icon,label,valHtml,sub)=>'<div style="background:var(--bg2);border:1px solid var(--line2);border-radius:10px;padding:12px 14px;text-align:center">'
    +'<div style="font-size:10px;color:var(--text3);letter-spacing:1px;margin-bottom:6px">'+icon+' '+label+'</div>'
    +'<div style="font-size:24px;font-weight:800;font-family:var(--mono);line-height:1.2">'+valHtml+'</div>'
    +(sub?'<div style="font-size:10px;color:var(--text3);margin-top:4px">'+sub+'</div>':'')+'</div>';
  // 条件卡
  const conds=(cd.conditions||[]).map(function(c){
    const pct=Math.round((c.progress||0)*100);
    const mv=c.today_move||'none';
    const col=moveCol[mv];
    return '<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:12px 14px">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px">'
      +'<span style="font-size:13px;font-weight:700">'+esc(state.lang==='zh'?c.label_zh:c.label_en)+'</span>'
      +'<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid '+col+';color:'+col+';font-weight:700">'
      +(mv==='done'?'✓':mv==='closer'?'◐':'○')+' '+esc(moveZh[mv]||mv)+(c.distance_bucket?(' · '+esc(c.distance_bucket)):'')+'</span></div>'
      +'<div style="font-size:11px;color:var(--text2);line-height:1.6;margin-bottom:8px">'+esc(state.lang==='zh'?c.line_zh:c.line_en)+'</div>'
      +'<div style="display:flex;align-items:center;gap:10px">'
      +'<div style="flex:1;height:8px;background:var(--bg0);border-radius:4px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:'+col+';border-radius:4px;transition:width .4s"></div></div>'
      +'<span style="font-size:15px;font-weight:800;font-family:var(--mono);color:'+col+'">'+pct+'%</span>'
      +'</div></div>';
  }).join('')||'<div class="empty">'+T('暂无条件数据','No conditions')+'</div>';
  // 评分走势
  const it=cd.intensity||{};
  const trendTxt=it.trend==='up'?'▲ '+T('走强','rising'):it.trend==='down'?'▼ '+T('走弱','falling'):'→ '+T('平稳','steady');
  const flip=p.flip_trigger_zh||'';
  const off=(cd.official||[]);
  const offHtml=off.length?'<div style="margin-top:12px;border-top:1px dashed var(--line);padding-top:10px"><div style="font-size:11px;color:var(--text3);margin-bottom:6px">William 对照口径</div>'
    +'<div style="display:flex;flex-wrap:wrap;gap:6px">'+off.map(function(c){return '<span style="font-size:10px;background:var(--bg2);border:1px solid var(--line);border-radius:4px;padding:3px 8px;color:var(--text2)">'+esc(c.label_zh||c.key)+' · '+esc(c.distance_bucket||'')+' · '+esc(c.today_move||'')+'</span>'}).join('')+'</div></div>':'';
  return '<div class="card" style="border:1px solid var(--amber);background:linear-gradient(135deg,rgba(217,164,65,.06),var(--bg1))">'
    +'<div class="card-title" style="justify-content:space-between"><span>⏳ '+T('姿态翻转倒计时','Flip Countdown')+'</span>'+dataTsHtml(d.data_ts,d.stale)+'</div>'
    // 四大关键数值
    +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px">'
    +bigCard('🧭',T('当前姿态','Posture'),'<span style="font-size:20px">'+esc(stTxt)+'</span>',T('已维持','held')+' '+Number(p.days_held||0)+'d')
    +bigCard('📊',T('姿态评分','Score'),'<span class="'+scoreCls+'">'+(score>=0?'+':'')+score.toFixed(1)+'</span>',trendTxt+(it.score_from!=null&&it.score_to!=null?(' · '+(it.score_from>=0?'+':'')+it.score_from+' → '+(it.score_to>=0?'+':'')+it.score_to):''))
    +bigCard('🎯',T('总体进度','Progress'),'<span style="color:var(--amber)">'+overall+'%</span>','<div style="height:6px;background:var(--bg0);border-radius:3px;margin-top:5px;overflow:hidden"><div style="width:'+overall+'%;height:100%;background:var(--amber);border-radius:3px"></div></div>')
    +bigCard('🚩',T('目标状态','Target'),'<span style="font-size:20px">'+esc(stateZh[cd.target_state]||cd.target_state||'—')+'</span>','')
    +'</div>'
    // 翻转触发提示
    +(flip?'<div style="display:flex;gap:8px;align-items:flex-start;background:var(--bg2);border-left:3px solid var(--amber);border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:12px;font-size:12px;color:var(--text2);line-height:1.7"><span>💡</span><span>'+esc(flip)+'</span></div>':'')
    // 条件卡
    +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">'+conds+'</div>'
    +offHtml
    +'</div>';
}
PANELS['market-analysis']=async function(){startTabTimer('market-analysis',PANELS['market-analysis']);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  try{
    const d=await fetch('/api/market-analysis').then(function(r){return r.json()});
    if(!d||!d.ok){main.innerHTML='<div class="card">'+T('数据不可用','Data unavailable')+'</div>';return}
    var b=d.data.btc, e=d.data.eth, s=d.data.sol, m=d.data.market, q=d.data.quadrants;
    // v6.2：6 档市场状态配色（牛-绿 / 震荡-黄 / 熊-红）
    var stateColor='#c06a5e';
    if(q.state=='BTC 主导牛市'||q.state=='结构性牛市')stateColor='#5f9e7a';
    else if(q.state=='震荡偏多'||q.state=='震荡观望')stateColor='#d9a441';
    var btcDirIcon=q.btc_price_dir=='up'?'↑':(q.btc_price_dir=='down'?'↓':'→');
    var domDirIcon=q.btc_dom_dir=='up'?'↑':(q.btc_dom_dir=='down'?'↓':'→');
    var sigHtml=(q.signals&&q.signals.length)?'<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;justify-content:center">'+q.signals.map(function(x){return '<span style="font-size:10px;background:#1c1e24;border:1px solid var(--line);border-radius:4px;padding:2px 7px;color:var(--text2)">'+esc(x)+'</span>'}).join('')+'</div>':'';
    // ===== 市场分析页 v8 重构（合理化 + 精准化） =====
    const stateZh2={'BTC 主导牛市':'BTC 主导牛市','结构性牛市':'结构性牛市','震荡偏多':'震荡偏多','震荡观望':'震荡观望','震荡偏空':'震荡偏空','熊市':'熊市','深度熊市':'深度熊市'};
    const rowCls=v=>v>0?'up':v<0?'down':'flat';
    const ind=q.indicators||{};
    const rsiH=ind.rsi||{};
    const pctB=ind.pctB||{};
    const bw=ind.bw||{};
    const emaT=ind.ema_trend||{};
    const oi=ind.oi||{};
    const liq=ind.liq||{};
    const lsr=ind.lsr||{};
    // 多周期小卡生成器
    const multiCard=(label, getV, unit, warn)=>{
      return '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:8px">'
        +['1h','4h','1d'].map(function(k){const v=getV(k);const cls=warn?rowCls(v):'';return '<div style="background:var(--bg2);border-radius:6px;padding:6px 8px;text-align:center"><div style="font-size:9px;color:var(--text3)">'+label+' '+k+'</div><div style="font-size:13px;font-weight:700;font-family:var(--mono);color:var(--'+(cls==='up'?'up':cls==='down'?'down':'text')+')">'+v+'</div></div>'}).join('')
        +'</div>';
    };
    main.innerHTML=
      // ===== 卡1：市场状态评估 =====
      '<div class="card" style="border:1px solid var(--amber);background:linear-gradient(135deg,rgba(217,164,65,.06),var(--bg1))">'
      +'<div class="card-title" style="justify-content:space-between"><span>'+engBadge('william')+'📊 '+T('市场状态评估 · 多因子综合','Market Regime')+'</span>'+dataTsHtml(d.data_ts,d.stale)+'</div>'
      +'<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">'
      +'<div style="text-align:center;min-width:140px"><div style="font-size:15px;font-weight:800;background:'+stateColor+';color:#fff;border-radius:8px;padding:10px 14px">'+q.state+'</div><div style="font-size:9.5px;color:var(--text3);margin-top:4px">'+esc(q.state_en||'')+'</div></div>'
      +'<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">'
      +'<div style="text-align:center"><div style="font-size:28px;font-weight:800;font-family:var(--mono);color:'+(q.score>1?'var(--up)':q.score<-1?'var(--down)':'var(--text)')+'">'+(q.score!=null?((q.score>0?'+':'')+q.score):'--')+'</div><div style="font-size:9.5px;color:var(--text3)">'+T('综合评分','Score')+'</div></div>'
      +(q.fgi!=null?'<div style="text-align:center"><div style="font-size:28px;font-weight:800;font-family:var(--mono);color:'+(q.fgi>=60?'var(--up)':q.fgi<=40?'var(--down)':'var(--amber)')+'">'+q.fgi+'</div><div style="font-size:9.5px;color:var(--text3)">FGI '+T('恐惧/贪婪','Fear/Greed')+'</div></div>':'')
      +(q.drawdown_pct!=null?'<div style="text-align:center"><div style="font-size:28px;font-weight:800;font-family:var(--mono);color:'+(q.drawdown_pct<0?'var(--down)':'var(--up)')+'">'+(q.drawdown_pct>0?'+':'')+q.drawdown_pct.toFixed(2)+'%</div><div style="font-size:9.5px;color:var(--text3)">'+T('距高点回撤','Drawdown')+'</div></div>':'')
      +'</div></div>'
      // ===== v9 升级：过热/健康评估 + 资金面佐证 =====
      +((rsiH['4h']>80||rsiH['1d']>75||(ind.funding_z!=null&&Math.abs(ind.funding_z)>1)||(liq.short_24h>liq.long_24h*3)||(oi.chg_24h>10))?'<div style="display:flex;gap:8px;align-items:center;background:rgba(224,90,78,.08);border:1px solid rgba(224,90,78,.3);border-radius:8px;padding:8px 12px;margin-top:10px;font-size:11px"><span>⚠️</span><span style="color:var(--text2)">'+T('强势但过热：','Strong but overheated:')+' '
        +(rsiH['4h']>80?(T('RSI 4h ','RSI 4h ')+rsiH['4h']+T(' 超买',' overbought')+' · '):'')
        +(ind.funding_z!=null&&Math.abs(ind.funding_z)>1?(T('费率 z ','Funding z ')+ind.funding_z+T(' 偏离均值',' deviated')+' · '):'')
        +(liq.short_24h>liq.long_24h*3?(T('空头爆仓 24h $','Short liq 24h $')+(liq.short_24h/1e6).toFixed(0)+'M '+T('逼空行情','squeeze')+' · '):'')
        +(oi.chg_24h>10?(T('OI 24h +','OI 24h +')+oi.chg_24h.toFixed(1)+'% '+T('杠杆升温','leverage heating')):'')
        +T(' — 追高需谨慎，等回踩','— beware of chasing')+'</span></div>':'')
      // 资金面佐证
      +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:10px">'
      +(oi.chg_24h!=null?'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)">'+T('OI 24h','OI 24h')+'</div><div style="font-size:14px;font-weight:700;font-family:var(--mono);color:'+(oi.chg_24h>=0?'var(--up)':'var(--down)')+'">'+(oi.chg_24h>=0?'+':'')+oi.chg_24h.toFixed(1)+'%</div></div>':'')
      +(ind.funding_z!=null?'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)">'+T('资金费率 z','Funding z')+'</div><div style="font-size:14px;font-weight:700;font-family:var(--mono);color:'+(Math.abs(ind.funding_z)>1?'var(--amber)':'var(--text)')+'">'+ind.funding_z+'</div></div>':'')
      +(liq.short_24h!=null?'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)">'+T('空爆 24h','Short liq 24h')+'</div><div style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--up)">$'+(liq.short_24h/1e6).toFixed(0)+'M</div></div>':'')
      +(rsiH['4h']!=null?'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)">'+T('RSI 4h','RSI 4h')+'</div><div style="font-size:14px;font-weight:700;font-family:var(--mono);color:'+(rsiH['4h']>80?'var(--down)':rsiH['4h']<30?'var(--up)':'var(--text)')+'">'+rsiH['4h']+'</div></div>':'')
      +(lsr&&lsr.h4!=null?'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:8px 10px"><div style="font-size:9px;color:var(--text3)">'+T('LSR 4h','LSR 4h')+'</div><div style="font-size:14px;font-weight:700;font-family:var(--mono)">'+lsr.h4+'</div></div>':'')
      +'</div>'
      // 状态解释（为什么判这个状态）
      +'<div style="margin-top:8px;font-size:10.5px;color:var(--text3);line-height:1.7">💡 '+T('判断依据：','Rationale: ')+''
      +(ind.trend_multi>0?(T('三周期多头共振','3-TF bull')+' · '):'')+(q.fgi>=60?(T('FGI '+q.fgi+' 贪婪','FGI '+q.fgi+' greedy')+' · '):'')+(liq.short_24h>liq.long_24h*3?(T('空头踩踏（空爆 $','short squeeze $')+(liq.short_24h/1e6).toFixed(0)+'M） · '):'')+(oi.chg_24h>5?(T('OI 增仓 +','OI rising +')+oi.chg_24h.toFixed(1)+'%'):'')+'</div>'
      // 行情快照
      +'<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:12px">'
      // BTC：价格 + 24h + 主导
      +'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 12px"><div style="font-size:9.5px;color:var(--text3);margin-bottom:3px">BTC · '+T('主导','dom')+' '+b.dominance.toFixed(1)+'%</div><div style="font-size:17px;font-weight:700;font-family:var(--mono)">'+fmtPrice(b.price)+' <span class="'+(b.chg_24h>=0?'up':'down')+'" style="font-size:11px">'+(b.chg_24h>=0?'+':'')+b.chg_24h.toFixed(1)+'%</span></div></div>'
      // ETH/BTC：以太相对强度（低=山寨弱）
      +'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 12px"><div style="font-size:9.5px;color:var(--text3);margin-bottom:3px">ETH/BTC · '+T('以太相对强度','ETH strength')+'</div><div style="font-size:17px;font-weight:700;font-family:var(--mono);color:'+(m.eth_btc_ratio>0.035?'var(--up)':m.eth_btc_ratio<0.028?'var(--down)':'var(--amber)')+'">'+m.eth_btc_ratio.toFixed(4)+'</div><div style="font-size:9px;color:var(--text3)">'+T('ETH 市值占比','ETH mcap share')+' '+(m.total_mcap>0?((e.mcap_est||0)/m.total_mcap*100).toFixed(1)+'%':'--')+' · $'+(e.mcap_est/1e9).toFixed(0)+'B</div></div>'
      // SOL/BTC：SOL 相对强度
      +'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 12px"><div style="font-size:9.5px;color:var(--text3);margin-bottom:3px">SOL/BTC · '+T('SOL 相对强度','SOL strength')+'</div><div style="font-size:17px;font-weight:700;font-family:var(--mono)">'+m.sol_btc_ratio.toFixed(6)+'</div><div style="font-size:9px;color:var(--text3)">'+T('SOL/ETH','SOL/ETH')+' '+(m.eth_btc_ratio>0?((m.sol_btc_ratio/m.eth_btc_ratio)*1000).toFixed(3)+'‰':'--')+'</div></div>'
      // 山寨占比：Total3 / 总市值
      +'<div style="background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px 12px"><div style="font-size:9.5px;color:var(--text3);margin-bottom:3px">'+T('山寨占比 Total3/总市值','Alt share')+'</div><div style="font-size:17px;font-weight:700;font-family:var(--mono);color:var(--amber)">'+(m.total_mcap>0?((m.total3/m.total_mcap*100).toFixed(1)+'%'):'--')+'</div><div style="font-size:9px;color:var(--text3)">'+T('山寨','Alts')+' $'+(m.total3/1e9).toFixed(0)+'B / $'+(m.total_mcap/1e12).toFixed(2)+'T</div></div>'
      +'</div>'
      // 信号标签云
      +(sigHtml?('<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px"><div style="font-size:9.5px;color:var(--text3);margin-bottom:6px">'+T('因子信号','Signals')+'</div>'+sigHtml+'</div>'):'')
      +'</div>'
      // ===== 卡2：多周期技术指标 =====
      +'<div class="card"><div class="card-title">📐 '+T('多周期技术指标','Multi-TF Technicals')+'</div>'
      // 价格定位
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      +'<div style="background:var(--bg2);border-radius:8px;padding:10px 12px"><div style="font-size:9.5px;color:var(--text3)">'+T('日内 VWAP','VWAP')+'</div><div style="font-size:16px;font-weight:700;font-family:var(--mono)">'+fmtPrice(ind.vwap)+'</div></div>'
      +'<div style="background:var(--bg2);border-radius:8px;padding:10px 12px"><div style="font-size:9.5px;color:var(--text3)">'+T('价格 vs VWAP','Price vs VWAP')+'</div><div style="font-size:16px;font-weight:700;font-family:var(--mono);color:'+(b.price>ind.vwap?'var(--up)':'var(--down)')+'">'+((b.price/ind.vwap-1)*100>=0?'+':'')+((b.price/ind.vwap-1)*100).toFixed(2)+'%</div></div>'
      +'<div style="background:var(--bg2);border-radius:8px;padding:10px 12px"><div style="font-size:9.5px;color:var(--text3)">'+T('动量 ROC(12)','Momentum ROC')+'</div><div style="font-size:16px;font-weight:700;font-family:var(--mono);color:'+(ind.roc>=0?'var(--up)':'var(--down)')+'">'+(ind.roc>=0?'+':'')+ind.roc+'%</div></div>'
      +'<div style="background:var(--bg2);border-radius:8px;padding:10px 12px"><div style="font-size:9.5px;color:var(--text3)">'+T('MACD 柱','MACD Hist')+'</div><div style="font-size:16px;font-weight:700;font-family:var(--mono);color:'+(ind.macd_hist>=0?'var(--up)':'var(--down)')+'">'+(ind.macd_hist>=0?'+':'')+ind.macd_hist+'</div></div>'
      +'</div>'
      // RSI 三周期
      +'<div style="margin-top:10px"><div style="font-size:10px;color:var(--text3);margin-bottom:4px">'+T('RSI(14) 多周期','RSI Multi-TF')+'</div>'+multiCard('RSI',function(k){const v=rsiH[k];if(v==null)return'—';const c=v>=70?'over':v<=30?'under':'ok';return '<span style="color:'+(c==='over'?'var(--down)':c==='under'?'var(--up)':'var(--text)')+'">'+v+'</span>'},null,false)+'</div>'
      // 布林带
      +'<div style="margin-top:10px"><div style="font-size:10px;color:var(--text3);margin-bottom:4px">'+T('布林带深度 %B(20,2)','Bollinger %B')+'</div>'+multiCard('%B',function(k){const v=pctB[k];if(v==null)return'—';return '<span style="color:'+(v>=0.8?'var(--down)':v<=0.2?'var(--up)':'var(--text)')+'">'+v.toFixed(2)+'</span>'},null,false)
      +'<div style="font-size:9.5px;color:#666;margin-top:4px">'+T('带宽','BW')+': '+(bw['1h']!=null?('1h '+bw['1h']+'%'):'')+(bw['4h']!=null?(' · 4h '+bw['4h']+'%'):'')+(bw['1d']!=null?(' · 1d '+bw['1d']+'%'):'')+(bw['1h']!=null&&bw['1h']<7?' ⚠️ '+T('收窄=变盘临近','squeeze'):'')+'</div></div>'
      // EMA 趋势
      +'<div style="margin-top:10px"><div style="font-size:10px;color:var(--text3);margin-bottom:4px">'+T('EMA(20/50) 趋势','EMA Trend')+'</div>'+multiCard('EMA',function(k){const v=emaT[k];if(!v)return'—';return '<span style="color:'+(v==='up'?'var(--up)':'var(--down)')+'">'+(v==='up'?'▲ '+T('多头','Bull'):'▼ '+T('空头','Bear'))+'</span>'},null,false)
      +'<div style="font-size:9.5px;color:#666;margin-top:4px">'+(ind.trend_multi>0?'✅ '+T('三周期多头共振','3-TF bull alignment'):ind.trend_multi<0?'⚠️ '+T('三周期空头共振','3-TF bear alignment'):T('方向分歧','mixed'))+'</div></div>'
      +'</div>'
      // ===== 卡4：相关深度页面导航（避免同质化，各司其职） =====
      +'<div class="card"><div class="card-title">🧭 '+T('深度数据导航','Deep-dive Nav')+'</div>'
      +'<div style="display:flex;flex-wrap:wrap;gap:8px">'
      +'<span style="font-size:11px;color:var(--text3);margin-right:4px">'+T('资金面/清算/LSR 等细分数据请前往专页：','Go to dedicated tabs:')+'</span>'
      +'<button class="btn btn-sm" onclick="switchTab(\'flows\')">💧 '+T('资金流','Flows')+'</button>'
      +'<button class="btn btn-sm" onclick="switchTab(\'sentiment\')">🎭 '+T('情绪','Sentiment')+'</button>'
      +'<button class="btn btn-sm" onclick="switchTab(\'lsr\')">⚖️ '+T('多空LSR','LSR')+'</button>'
      +'<button class="btn btn-sm" onclick="switchTab(\'liquidation\')">💥 '+T('清算数据','Liquidation')+'</button>'
      +'<button class="btn btn-sm" onclick="switchTab(\'onchain\')">🔗 '+T('链上数据','On-chain')+'</button>'
      +'<button class="btn btn-sm" onclick="switchTab(\'assets\')">🌍 '+T('全球资产','Global')+'</button>'
      +'</div></div>'
      // ===== 卡5：指标说明 =====
      +'<div class="card"><div class="card-title">'+T('指标说明','Notes')+'</div>'
      +'<div style="font-size:11px;color:#888;line-height:1.7">'
      +T('本页专注市场体制（Regime）：多因子状态评估 + 多周期技术指标 + 姿态翻转倒计时。RSI ≥70 超买 / ≤30 超卖；%B ≥0.8 贴上轨 / ≤0.2 贴下轨；带宽收窄 = 变盘临近。资金面（OI/费率/LSR/清算）与链上（市值/稳定币）请前往对应专页。','This page focuses on regime + multi-TF technicals; funding/on-chain data live in their dedicated tabs.')+'<br>'
      +T('⚠ 综合评分基于估算补充（ETH 市值、稳定币市值），主体为实时数据。','Score partly uses estimated inputs.')+'</div></div>'

    // ⏳ 姿态翻转倒计时（并入本页）
    api('/api/member/countdown').then(function(cd){
      if(cd&&cd.ok&&!cd.__needLogin){
        var box=document.createElement('div');box.innerHTML=renderCountdownCard(cd);
        var cards=main.querySelectorAll('.card');
        if(cards.length>=2){main.insertBefore(box.firstChild, cards[1]);}else{main.appendChild(box.firstChild);}
      }
    }).catch(function(){});
  }catch(e){main.innerHTML='<div class="card">加载异常: '+esc(e.message)+'</div>';}
};
/* ================= PANEL: 全球资产（v6 美股/大宗/外汇/债券 + 财报 + KOL） ================= */
PANELS.assets=async function(){startTabTimer('assets',PANELS.assets);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('指标计算中…','Computing…')+'</div>';
  try{
    const d=await api('/api/macro/indicators');
    if(!d||!d.ok){main.innerHTML='<div class="card">'+T('指标不可用','Unavailable')+'</div>';return}
    let h='';
    // 🎚️ 综合情绪大条（置顶）
    const cs=d.composite;
    const csState=d.compositeState||'—';
    h+='<div class="card" style="border:1px solid var(--amber);background:linear-gradient(135deg,rgba(217,164,65,.08),var(--bg1))">'
      +'<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">'
      +`<div style="text-align:center;min-width:110px"><div style="font-size:40px;font-weight:800;font-family:var(--mono);line-height:1" class="${cs>=70||cs<30?'':'neutral'}">${cs!=null?cs:'—'}</div><div style="font-size:10px;color:var(--text3);margin-top:4px">${T('综合情绪','Composite')}</div></div>`
      +'<div style="flex:1;min-width:220px">'
      +`<div style="font-size:17px;font-weight:800">${esc(csState)}</div>`
      +`<div style="height:12px;background:var(--bg0);border-radius:6px;margin-top:6px;position:relative;overflow:hidden"><div style="width:${cs!=null?cs:0}%;height:100%;border-radius:6px;background:linear-gradient(90deg,#c06a5e,#d9a441,#5f9e7a)"></div></div>`
      +`<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3);margin-top:2px"><span>${T('避险','Fear')} 0</span><span>50</span><span>100 ${T('贪婪','Greed')}</span></div>`
      +'</div>'
      +`<div style="font-size:10.5px;color:var(--text3);max-width:300px">${T('10 大经典指标加权合成 · 真实数据+历史阈值判定 · 非 AI 生成','10 classic indicators · real data')}</div>`
      +'</div></div>';
    // 📊 10 大指标显示条
    h+='<div class="card" style="padding:12px 14px"><div class="card-title">📊 '+T('10 大经典市场指标','10 Market Indicators')+'</div>';
    const order=['cnn_fng','VIXCLS','BAMLH0A0HYM2','T10Y2Y','DTWEXBGS','WALCL','M2_YOY','STABLECOIN','WIDTH50','BTC_QQQ'];
    for(const id of order){
      const x=d.indicators.find(i=>i.id===id);
      if(!x)continue;
      if(x.error){h+=`<div style="display:flex;justify-content:space-between;padding:7px 4px;border-bottom:1px solid var(--line);font-size:11.5px"><span>${esc(x.name)}</span><span style="color:var(--text3)">${esc(x.error)}</span></div>`;continue;}
      const sc=x.score!=null?x.score:50;
      const col=sc>=55?'var(--up)':sc>=45?'var(--amber)':'var(--down)';
      const trendA=x.trend==null?'':x.trend>0?'<span style="color:var(--up)">▲</span>':x.trend<0?'<span style="color:var(--down)">▼</span>':'<span style="color:var(--text3)">—</span>';
      h+=`<div style="padding:9px 4px;border-bottom:1px solid var(--line)">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
          <span style="font-size:12.5px;font-weight:700">${esc(x.name)} ${trendA}</span>
          <span style="font-family:var(--mono);font-size:14px;font-weight:800;color:${col}">${x.value}${x.unit?(' '+esc(x.unit)):''}</span>
          <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${col}22;color:${col};border:1px solid ${col}55">${esc(x.state||'')}</span>
        </div>
        <div style="height:7px;background:var(--bg0);border-radius:4px;margin:5px 0;overflow:hidden"><div style="width:${sc}%;height:100%;border-radius:4px;background:${col}"></div></div>
        <div style="display:flex;justify-content:space-between;gap:10px;font-size:10.5px;color:var(--text3);flex-wrap:wrap">
          <span style="flex:1;min-width:200px">${esc(x.signal||'')}</span>
          <span style="font-family:var(--mono);flex-shrink:0">${x.prev!=null?('prev '+x.prev+(x.unit||'')):''}${x.hist&&x.hist.week!=null?(' · 1周 '+x.hist.week+' · 1月 '+x.hist.month):''}</span>
        </div></div>`;
    }
    h+='</div>';
    main.innerHTML=h;
    // 📈 收益率曲线（宏观背景）
    api('/api/macro/curve').then(cv=>{
      if(!cv||!cv.ok||!cv.points||cv.points.length<2)return;
      const pts=cv.points.filter(p=>p.label!=='FFR');
      if(pts.length<2)return;
      const W=520,H=170,padL=34,padB=26,padT=14;
      const vals=pts.map(p=>p.value);
      const mn=Math.min(...vals)-0.15,mx=Math.max(...vals)+0.15;
      const px=pts.map((p,i)=>({x:padL+i*(W-padL-10)/Math.max(1,pts.length-1),y:padT+(H-padB-padT)*(1-(p.value-mn)/(mx-mn||1))}));
      const path=px.map((p,i)=>(i?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1)).join(' ');
      const box=document.createElement('div');box.className='card';
      box.innerHTML='<div class="card-title">📈 '+T('美债收益率曲线（FRED 官方）','Treasury Curve')+'</div>'
        +`<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:560px"><path d="${path}" stroke="#d9a441" stroke-width="1.8" fill="none"/>`
        +px.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="3" fill="#d9a441"/>`).join('')
        +px.map(p=>`<text x="${p.x}" y="${H-padB+14}" fill="#8a8f98" font-size="9" text-anchor="middle">${p.label}</text>`).join('')
        +px.map(p=>`<text x="${p.x}" y="${p.y-7}" fill="#e8e8e8" font-size="9.5" text-anchor="middle" font-family="monospace">${p.value.toFixed(2)}</text>`).join('')
        +'</svg>';
      main.appendChild(box);
    }).catch(()=>{});
  }catch(e){
    main.innerHTML='<div class="card">'+esc(T('异常','Error'))+': '+esc(e.message)+'</div>';
  }
};


function showKLModal(title,symbol,bars){
  const ov=document.createElement('div');
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:99;display:flex;align-items:center;justify-content:center';
  const W=700,H=340;
  const closes=bars.filter(b=>b.c!=null).map(b=>b.c);
  const mn=Math.min(...closes),mx=Math.max(...closes);
  const pts=closes.map((c,i)=>({x:30+i*(W-60)/Math.max(1,closes.length-1),y:H-30-(c-mn)/(mx-mn||1)*(H-70)}));
  const path=pts.map((p,i)=>(i?'L':'M')+p.x.toFixed(1)+' '+p.y.toFixed(1)).join(' ');
  const last=closes[closes.length-1],first=closes[0];
  const chg=first?((last-first)/first*100):0;
  const col=chg>=0?'#5f9e7a':'#c06a5e';
  ov.innerHTML=`<div style="background:var(--bg1);border:1px solid var(--line);border-radius:12px;width:740px;max-width:92vw;padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-weight:800">${esc(title)} <span style="color:var(--text3);font-size:11px">${esc(symbol)}</span></div>
      <div style="font-size:15px;font-weight:800;color:${col}">${fmt(last)} ${chg>=0?'+':''}${chg.toFixed(2)}%</div>
    </div>
    <svg width="${W}" height="${H}" style="background:var(--bg0);border-radius:8px;width:100%">
      <path d="${path}" stroke="${col}" stroke-width="1.8" fill="none"/>
      <text x="30" y="18" fill="#8a8f98" font-size="10">${fmt(mx,0)}</text>
      <text x="30" y="${H-12}" fill="#8a8f98" font-size="10">${fmt(mn,0)}</text>
    </svg>
    <div style="text-align:right;margin-top:6px;font-size:11px;color:var(--text3)">${T('近30日走势 · 点击空白关闭','30d trend · click outside to close')}</div>
  </div>`;
  ov.onclick=()=>document.body.removeChild(ov);
  document.body.appendChild(ov);
}

/* ================= 每日闯关（概念词典顶部） ================= */
function quizProgress(streak){
  const inRound=streak%3;
  const need=3-inRound;
  return {inRound: inRound, need: need>=3?3:need};
}
function quizStreakLine(streak, answered, correct, rewarded){
  const p=quizProgress(streak||0);
  const dots=[1,2,3].map(function(i){return '<span class="qp'+(i<=p.inRound?' on':'')+'"></span>'}).join('');
  let rightTxt='再答对 '+p.need+' 天送 3 天会员';
  if((streak||0)>0&&(streak||0)%3===0)rightTxt=rewarded?'🎉 本轮奖励已到账':'🎉 已领取本轮奖励';
  if(streak===0&&answered&&!correct)rightTxt='明天再战';
  const leftTxt=(streak||0)>0?('已连续 '+streak+' 天'):(answered?'已连续 0 天':'尚未开始');
  return '<div style="margin-top:12px;border-top:1px dashed var(--line);padding-top:10px">'
    +'<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-bottom:5px"><span>'+leftTxt+'</span><span>'+rightTxt+'</span></div>'
    +'<div class="quiz-progress">'+dots+'</div></div>';
}
function renderQuizCard(q){
  if(!q)return '<div class="card"><div class="card-title">🎯 每日闯关</div><div class="empty">闯关服务暂不可用</div></div>';
  if(q.__needLogin){
    return '<div class="card" style="border:1px dashed var(--amber);background:linear-gradient(135deg,rgba(217,164,65,.05),var(--bg1))">'
      +'<div class="card-title" style="justify-content:space-between"><span>🎯 每日闯关</span><span class="data-ts">连续答对 3 天送 3 天会员</span></div>'
      +'<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
      +'<span style="font-size:26px">🔐</span>'
      +'<div style="flex:1;min-width:200px"><div style="font-size:13px">登录后可参与每日一题，答对金融知识题累计天数，连续 3 天送 <b style="color:var(--amber)">3 天会员</b></div>'
      +'<div style="font-size:11px;color:var(--text3);margin-top:4px">每天限答 1 次 · 答错连续天数归零 · 每满 3 天自动发奖</div></div>'
      +'<button class="btn" onclick="switchTab(\'account\')">去登录</button></div></div>';
  }
  let body='';
  if(!q.answered){
    body='<div style="font-size:14px;font-weight:600;margin-bottom:12px;line-height:1.6">Q: '+esc(q.question)+'</div>'
      +'<div>'+(q.options||[]).map(function(o,i){const L='ABC'[i];return '<button class="quiz-opt" data-a="'+L+'" onclick="answerQuiz(this)"><b>'+L+'</b><span>'+esc(o)+'</span></button>'}).join('')+'</div>';
  }else if(q.correct){
    body='<div style="display:flex;gap:12px;align-items:center;background:rgba(58,160,110,.1);border:1px solid rgba(58,160,110,.35);border-radius:10px;padding:14px">'
      +'<span style="font-size:28px">✅</span>'
      +'<div style="flex:1"><div style="font-weight:700;color:var(--up);font-size:14px">回答正确！连续答对 '+q.streak+' 天</div>'
      +(q.rewarded?'<div style="color:var(--amber);font-weight:700;margin-top:4px">🎁 3 天会员已到账'+(q.vip&&q.vip.days!=null?('，当前会员剩余 '+q.vip.days+' 天'):'')+'</div>':'')
      +'<div style="font-size:11px;color:var(--text3);margin-top:6px">今日已完成，明天 00:00 刷新新题</div></div></div>';
  }else{
    body='<div style="display:flex;gap:12px;align-items:center;background:rgba(224,90,78,.1);border:1px solid rgba(224,90,78,.35);border-radius:10px;padding:14px">'
      +'<span style="font-size:28px">❌</span>'
      +'<div style="flex:1"><div style="font-weight:700;color:var(--down);font-size:14px">回答错误，正确答案是 '+q.correct_answer+'</div>'
      +'<div style="font-size:12px;color:var(--text2);margin-top:4px">'+esc(q.explain||'')+'</div>'
      +'<div style="font-size:11px;color:var(--text3);margin-top:6px">连续天数已归零，明天再来挑战</div></div></div>';
  }
  body+=quizStreakLine(q.streak, q.answered, q.correct, q.rewarded);
  return '<div class="card" style="border:1px solid var(--amber);background:linear-gradient(135deg,rgba(217,164,65,.07),var(--bg1))">'
    +'<div class="card-title" style="justify-content:space-between"><span>🎯 每日闯关</span><span class="data-ts">'+q.date+' · 今日一题</span></div>'
    +'<div style="font-size:11px;color:var(--text3);margin-bottom:10px">连续答对 3 天送 3 天会员 · 每天限答 1 次 · 网站相关金融知识</div>'
    +'<div id="quizBody">'+body+'</div></div>';
}
async function answerQuiz(btn){
  const ans=btn.dataset.a;
  $$('.quiz-opt').forEach(b=>{b.disabled=true});
  const r=await api('/api/quiz/answer',{method:'POST',body:JSON.stringify({answer:ans})});
  if(!r||!r.ok){toast((r&&r.error)||'答题失败，请重试');$$('.quiz-opt').forEach(b=>{b.disabled=false});return}
  const box=$('#quizBody');
  if(!box)return;
  let html='';
  if(r.correct){
    html='<div style="display:flex;gap:12px;align-items:center;background:rgba(58,160,110,.1);border:1px solid rgba(58,160,110,.35);border-radius:10px;padding:14px">'
      +'<span style="font-size:28px">✅</span>'
      +'<div style="flex:1"><div style="font-weight:700;color:var(--up);font-size:14px">回答正确！连续答对 '+r.streak+' 天</div>'
      +(r.rewarded?'<div style="color:var(--amber);font-weight:700;margin-top:4px">🎁 恭喜！3 天会员已到账，当前会员剩余 '+r.vip.days+' 天</div>':'')
      +'<div style="font-size:12px;color:var(--text2);margin-top:6px">'+esc(r.explain||'')+'</div>'
      +'<div style="font-size:11px;color:var(--text3);margin-top:6px">明天 00:00 刷新新题，继续挑战！</div></div></div>';
  }else{
    html='<div style="display:flex;gap:12px;align-items:center;background:rgba(224,90,78,.1);border:1px solid rgba(224,90,78,.35);border-radius:10px;padding:14px">'
      +'<span style="font-size:28px">❌</span>'
      +'<div style="flex:1"><div style="font-weight:700;color:var(--down);font-size:14px">回答错误，正确答案是 '+r.right_answer+'</div>'
      +'<div style="font-size:12px;color:var(--text2);margin-top:4px">'+esc(r.explain||'')+'</div>'
      +'<div style="font-size:11px;color:var(--text3);margin-top:6px">连续天数已归零，明天再来挑战</div></div></div>';
  }
  html+=quizStreakLine(r.streak, true, r.correct, r.rewarded);
  box.innerHTML=html;
  if(r.rewarded)toast('🎁 +3 天会员已到账！');
}
PANELS.glossary=async function(){
  const main=$('#main');
  const d=await api('/api/glossary');
  const q=await api('/api/quiz/today').catch(function(){return null});
  const terms=(d.terms||[]).map((t,i)=>`<div class="g-term" data-i="${i}" title="${esc(t.en)}">
    <span class="gt-zh">${esc(t.zh)}</span><span class="gt-en">${esc(t.en)}</span><span class="gt-arrow">▼</span>
  </div>`).join('');
  main.innerHTML=renderQuizCard(q)+`<div class="card">
    <div class="card-title">${T('概念词典 · 加密/Web3/金融术语','Glossary · Crypto/Web3/Finance')} <span class="data-ts">${d.count||0} terms</span></div>
    <div style="font-size:11px;color:var(--text3);margin-bottom:10px">${T('点击词条展开注释','Click a term to expand')}</div>
    <div class="glossary-grid" id="glossaryGrid">${terms}</div></div>`;
  const termsArr=d.terms||[];
  $$('#glossaryGrid .g-term').forEach(el=>el.onclick=()=>{
    const i=Number(el.dataset.i);
    const t=termsArr[i]; if(!t)return;
    const isOpen=el.classList.contains('open');
    // 关闭其它已展开的
    $$('#glossaryGrid .g-term.open').forEach(o=>{o.classList.remove('open');const dd=o.nextElementSibling;if(dd&&dd.classList.contains('g-detail'))dd.remove()});
    if(isOpen)return;
    el.classList.add('open');
    const detail=document.createElement('div');
    detail.className='g-detail';
    detail.textContent=state.lang==='zh'?t.desc_zh:t.desc_en;
    el.insertAdjacentElement('afterend',detail);
  });
};

'use strict';
/* ================= PANEL: 多空LSR（会员） ================= */
function lsrTable(rows,mode){
  if(!rows||!rows.length)return'<div class="empty">暂无数据，等待采集</div>';
  const body=rows.map(c=>{
    const ratio=mode==='whale'?(c.whale_ratio??c.ratio):(c.trader_ratio??c.ratio);
    const d2m=mode==='whale'?(c.whale_delta_2m??c.delta_2m):c.delta_2m;
    const d4h=mode==='whale'?(c.whale_delta_4h??c.delta_4h):(c.trader_delta_4h??c.delta_4h);
    return `<tr><td class="num">${c.rank??''}</td><td>${esc(c.symbol)}</td>
      <td class="num ${cls((ratio||1)-1)}">${ratio!=null?Number(ratio).toFixed(2):'—'}</td>
      <td class="num ${cls(d2m)}">${d2m!=null?fmtPct(d2m*100):'—'}</td>
      <td class="num ${cls(d4h)}">${d4h!=null?fmtPct(d4h*100):'—'}</td>
      <td class="num">${c.oi_mcap_ratio!=null?(c.oi_mcap_ratio*100).toFixed(1)+'%':'—'}</td></tr>`;
  }).join('');
  return `<div style="overflow-x:auto"><table><thead><tr><th>#</th><th>${T('币种','Symbol')}</th><th>${T('多空比','L/S Ratio')}</th><th>Δ2m</th><th>Δ4h</th><th>OI/MCap</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
PANELS.lsr=async function(){startTabTimer('lsr',PANELS.lsr);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  const d=await api('/api/member/lsr');
  if(d.__needLogin){state.user=null;switchTab('lsr');return}
  main.innerHTML=`<div class="card">
    <div class="card-title">${engBadge('lsr')}${T('多空比双榜 TOP20','Long/Short Ratio Dual Rankings TOP20')}
      <span style="margin-left:auto">${dataTsHtml(d.data_ts,d.stale)}</span></div>
    <div class="grid2">
      <div><div class="verdict-label">${T('交易者模式','TRADER MODE')}</div>${lsrTable(d.trader,'trader')}</div>
      <div><div class="verdict-label">${T('大户模式','WHALE MODE')}</div>${lsrTable(d.whale,'whale')}</div>
    </div></div>`;
};

/* ================= PANEL: 费率套利（会员） ================= */
PANELS.funding=async function(){startTabTimer('funding',PANELS.funding);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  const d=await api('/api/member/funding-arb');
  if(d.__needLogin){state.user=null;switchTab('funding');return}
  const rows=(d.rows||[]).map(r=>`<tr>
    <td class="num">${r.rank??''}</td><td class="coin-sym" style="font-size:13px">${esc(r.symbol)}</td>
    <td class="num up">${r.apr!=null?Number(r.apr).toFixed(0)+'%':'—'}</td>
    <td>${esc(r.buy&&r.buy.exchange||'—')} <span class="num ${cls(-(r.buy&&r.buy.funding_rate||0))}">${r.buy?(r.buy.funding_rate).toFixed(3)+'%':''}</span></td>
    <td>${esc(r.sell&&r.sell.exchange||'—')} <span class="num ${cls(r.sell&&r.sell.funding_rate||0)}">${r.sell?(r.sell.funding_rate).toFixed(3)+'%':''}</span></td>
    <td class="num">${r.fee!=null?Number(r.fee).toFixed(2):'—'}</td>
    <td class="num">${r.next_funding_time?new Date(r.next_funding_time).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'—'}</td></tr>`).join('');
  main.innerHTML=`<div class="card">
    <div class="card-title">${T('资金费率套利榜 · 按 APR','Funding Rate Arbitrage · by APR')}
      <span style="margin-left:auto">${dataTsHtml(d.data_ts,d.stale)}</span></div>
    <div class="verdict-block" style="margin-bottom:10px">${T('买 = 低费率交易所做多，卖 = 高费率交易所做空，赚取费率差。APR 为年化参考，不构成收益承诺。','Buy low-funding exchange, sell high-funding one, harvest the spread.')}</div>
    <div style="overflow-x:auto"><table><thead><tr><th>#</th><th>${T('币种','Symbol')}</th><th>APR</th><th>${T('买(多)','Buy(Long)')}</th><th>${T('卖(空)','Sell(Short)')}</th><th>${T('费用','Fee')}</th><th>${T('下次结算','Next')}</th></tr></thead><tbody>${rows||'<tr><td colspan="7" class="empty">—</td></tr>'}</tbody></table></div>
  </div>`;
};

/* ================= PANEL: KOL中期共识信号（会员） ================= */
PANELS.consensus=async function(){startTabTimer('consensus',PANELS.consensus);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  const d=await api('/api/member/consensus');
  if(d.__needLogin){state.user=null;switchTab('consensus');return}
  const cards=(d.coins||[]).map(c=>{
    const bias=c.trust_adjusted_bias||0;
    return `<div class="coin-card">
      <div class="coin-head"><span class="coin-sym">${esc(c.symbol)}</span>
        <span class="badge ${c.decision==='long'?'bullish':c.decision==='short'?'bearish':'neutral'}">${esc(c.decision_label||c.decision||'—')}</span></div>
      <div class="coin-price num">${fmtPrice(c.price)}</div>
      <div class="conf-bar"><div class="conf-fill" style="width:${Math.round((c.confidence||0)*100)}%;background:${c.decision==='long'?'var(--up)':c.decision==='short'?'var(--down)':'#d9a441'}"></div></div>
      <div class="data-ts">confidence ${Math.round((c.confidence||0)*100)}% · bias <span class="${cls(bias)}">${bias>=0?'+':''}${bias.toFixed(3)}</span></div>
      <div class="coin-headline" style="margin-top:8px">${(c.top_factors||[]).map(f=>`· ${esc(f.name||f.id)}（${f.score>=0?'+':''}${f.score}）`).join('<br>')||'—'}</div>
      <div class="coin-official">${T('快照','snapshot')} ${esc(c.snapshot_date||'—')} · ${c.snapshot_age_hours!=null?Number(c.snapshot_age_hours).toFixed(0)+'h ago':''}</div>
    </div>`;
  }).join('');
  main.innerHTML=`<div class="card">
    <div class="card-title">${T('因子共识','Factor Consensus')}
      <span style="margin-left:auto">${dataTsHtml(d.data_ts,d.stale)}</span></div>
    <div class="coin-grid">${cards||'<div class="empty">'+T('暂无数据','No data')+'</div>'}</div></div>'`;
};

/* ================= PANEL: 倒计时（会员） ================= */
/* ================= PANEL: 留言板 ================= */
PANELS.messages=async function(){
  const main=$('#main');
  const loggedIn=!!state.user;
  // 头像色板：按用户名 hash 稳定选色
  const AVATAR_COLORS=['#d9a441','#5f9e7a','#7c4dff','#c06a5e','#4d9dd9','#d96a5e','#5ec4a4','#b8862f','#8a7cff','#e07b54','#4db8b8','#c94da0'];
  const nameHash=s=>{let h=0;for(const c of String(s))h=(h*31+c.charCodeAt(0))>>>0;return h};
  const avatarHtml=name=>{
    const color=AVATAR_COLORS[nameHash(name)%AVATAR_COLORS.length];
    const ch=String(name||'?').slice(0,1).toUpperCase();
    return `<div class="msg-avatar" style="background:${color}">${esc(ch)}</div>`;
  };
  // 组装线程：主留言 + 其下回复
  const buildThreads=msgs=>{
    const replyMap={};
    msgs.forEach(m=>{if(m.parent_id!=null){(replyMap[m.parent_id]=replyMap[m.parent_id]||[]).push(m);}});
    const tops=msgs.filter(m=>m.parent_id==null);
    tops.sort((a,b)=>b.created_at-a.created_at);
    Object.keys(replyMap).forEach(k=>replyMap[k].sort((a,b)=>a.created_at-b.created_at));
    return tops.map(m=>{
      const replies=(replyMap[m.id]||[]).map(r=>replyItem(r));
      return messageItem(m)+ (replies.length?('<div class="msg-replies">'+replies.join('')+'</div>'):'');
    }).join('');
  };
  const messageItem=m=>{
    const vipHtml=vipBadge(m.vip);
    const canDel=state.admin||(state.user&&state.user.id===m.user_id);
    const displayName=m.nickname||m.username||'?';
    return `<div class="msg-thread">
      <div class="msg-item">${avatarHtml(displayName)}
        <div class="msg-body">
          <div class="msg-head"><span class="msg-user">${esc(displayName)}</span>${m.nickname?'<span class="msg-at">@'+esc(m.username)+'</span>':''}${vipHtml}<span class="msg-time">${fmtTs(Math.floor(m.created_at/1000))}</span></div>
          <div class="msg-bubble">${esc(m.content)}</div>
          <div class="msg-actions">${loggedIn?'<span class="msg-reply-btn" data-id="'+m.id+'" data-name="'+esc(displayName)+'">↩ '+T('回复','Reply')+'</span>':''}${canDel?'<span class="msg-del" data-id="'+m.id+'">'+T('删除','Delete')+'</span>':''}</div>
          <div class="msg-reply-box" id="replyBox-'+m.id+'" style="display:none">
            <textarea maxlength="500" placeholder="${T('回复','Reply')} @'+esc(displayName)+'…"></textarea>
            <div class="msg-reply-actions"><span class="msg-reply-cancel" data-id="'+m.id+'">'+T('取消','Cancel')+'</span><button class="btn small" data-id="'+m.id+'">'+T('发送','Send')+'</button></div>
          </div>
        </div></div></div>`;
  };
  const replyItem=r=>{
    const vipHtml=vipBadge(r.vip);
    const canDel=state.admin||(state.user&&state.user.id===r.user_id);
    const displayName=r.nickname||r.username||'?';
    return `<div class="msg-item msg-reply-item">${avatarHtml(displayName)}
      <div class="msg-body">
        <div class="msg-head"><span class="msg-user">${esc(displayName)}</span>${r.nickname?'<span class="msg-at">@'+esc(r.username)+'</span>':''}${vipHtml}<span class="msg-time">${fmtTs(Math.floor(r.created_at/1000))}</span></div>
        <div class="msg-bubble">${esc(r.content)}</div>
        ${canDel?'<div class="msg-actions"><span class="msg-del" data-id="'+r.id+'">'+T('删除','Delete')+'</span></div>':''}
      </div></div>`;
  };
  const bindDelete=()=>{
    $$('#msgList .msg-del').forEach(b=>b.onclick=async()=>{
      if(!confirm(T('删除这条留言？','Delete this message?')))return;
      const r=await api('/api/messages/'+b.dataset.id,{method:'DELETE'});
      if(r.ok){toast(T('已删除','Deleted'));loadList()}else toast(r.error||'failed');
    });
  };
  const bindReply=()=>{
    $$('#msgList .msg-reply-btn').forEach(b=>b.onclick=()=>{
      const id=b.dataset.id;
      const box=$('#replyBox-'+id);
      $$('#msgList .msg-reply-box').forEach(x=>{if(x!==box)x.style.display='none';});
      box.style.display=box.style.display==='none'?'block':'none';
      if(box.style.display==='block')box.querySelector('textarea').focus();
    });
    $$('#msgList .msg-reply-cancel').forEach(c=>c.onclick=()=>{$('#replyBox-'+c.dataset.id).style.display='none';});
    $$('#msgList .msg-reply-box .btn').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.id;
      const ta=$('#replyBox-'+id).querySelector('textarea');
      const content=ta.value.trim();
      if(!content){toast(T('写点什么吧','Type something'));return}
      const r=await api('/api/messages',{method:'POST',body:JSON.stringify({content,parent_id:Number(id)})});
      if(r.ok){ta.value='';$('#replyBox-'+id).style.display='none';toast(T('已回复','Replied'));loadList()}
      else if(r.__needLogin){toast(T('请先登录','Login first'));switchTab('account')}
      else toast(r.message||r.error||T('回复失败','Failed'));
    });
  };
  const loadList=async()=>{
    const d=await api('/api/messages?limit=200');
    const list=$('#msgList');
    if(!d||!d.ok){list.innerHTML='<div class="msg-empty">'+T('加载失败','Load failed')+'</div>';return}
    const msgs=(d.messages||[]);
    if(!msgs.length){list.innerHTML='<div class="msg-empty">'+T("还没有留言，来抢沙发~","No messages yet, be the first!")+'</div>';return}
    list.innerHTML=buildThreads(msgs);
    bindDelete();bindReply();
  };
  // 渲染
  const composer=loggedIn
    ? `<div class="msg-composer">
        <textarea id="msgInput" maxlength="500" placeholder="${T('写下你的观点…','Share your thoughts…')}"></textarea>
        <div class="msg-bar">
          <span class="msg-count" id="msgCount">0/500 · ${T('每日限 5 条','5/day')}</span>
          <button class="btn small" id="msgSend">${T('发布','Post')}</button>
        </div></div>`
    : `<div class="msg-login-hint">🔒 ${T('登录后才能留言','Login required to post')} — <b>${T('去登录','Login')}</b> → <a href="#" id="msgGoLogin">${T('登录/注册','Login / Register')}</a></div>`;
  main.innerHTML=`<div class="card"><div class="card-title">💬 ${T('留言板 · 大家怎么说','Messages Board')} <span class="data-ts">${T('每日每人 5 条 · 支持回复','5 per user per day · with replies')}</span></div>${composer}<div class="msg-list" id="msgList"><div class="msg-empty">${T('加载中…','Loading…')}</div></div></div>`;
  if(loggedIn){
    $('#msgInput').oninput=()=>{const n=$('#msgInput').value.length;$('#msgCount').textContent=n+'/500 · '+T('每日限 5 条','5/day');};
    $('#msgSend').onclick=async()=>{
      const content=$('#msgInput').value.trim();
      if(!content){toast(T('写点什么吧','Type something'));return}
      const r=await api('/api/messages',{method:'POST',body:JSON.stringify({content})});
      if(r.ok){$('#msgInput').value='';$('#msgCount').textContent='0/500';toast(T('已发布','Posted'));loadList()}
      else if(r.__needLogin){toast(T('请先登录','Login first'));switchTab('account')}
      else toast(r.message||r.error||T('发布失败','Failed'));
    };
  }else{
    const gl=$('#msgGoLogin');
    if(gl)gl.onclick=e=>{e.preventDefault();switchTab('account')};
  }
  loadList();
};

PANELS.countdown=async function(){startTabTimer('countdown',PANELS.countdown);
  const main=$('#main');
  main.innerHTML='<div class="card">'+T('加载中…','Loading…')+'</div>';
  const d=await api('/api/member/countdown');
  if(d.__needLogin){state.user=null;switchTab('countdown');return}
  const cd=d.countdown,p=d.posture;
  const moveZh={done:'已达成',closer:'接近中',none:'无进展'};
  const conds=(cd.conditions||[]).map(c=>{
    const pct=Math.round((c.progress||0)*100);
    const col=c.today_move==='done'?'#5f9e7a':c.today_move==='closer'?'#d9a441':'#6d6a62';
    return `<div class="cond-card">
      <div class="cond-head"><span class="cond-label">${esc(state.lang==='zh'?c.label_zh:c.label_en)}</span>
        <span class="cond-bucket" style="color:${col}">${esc(c.distance_bucket||'')} · ${esc(moveZh[c.today_move]||c.today_move)}</span></div>
      <div class="cond-line">${esc(state.lang==='zh'?c.line_zh:c.line_en)}</div>
      <div class="progress"><div class="progress-fill" style="width:${pct}%;${c.today_move==='done'?'background:#5f9e7a':''}"></div></div>
      <div class="data-ts">${pct}%</div>
    </div>`;
  }).join('');
  const off=(cd.official||[]).map(c=>`<tr><td>${esc(c.label_zh||c.key)}</td><td>${esc(c.line_zh||'')}</td><td class="num">${esc(c.distance_bucket||'')}</td><td class="num">${esc(c.today_move||'')}</td></tr>`).join('');
  main.innerHTML=`<div class="card">
    <div class="card-title">${T('翻转条件倒计时','Flip Condition Countdown')}
      <span style="margin-left:auto">${dataTsHtml(d.data_ts,d.stale)}</span></div>
    <div class="kv-strip">
      <span>${T('当前姿态','posture')} <b>${esc(p.state)} ${p.score>0?'+':''}${p.score}</b></span>
      <span>${T('已维持','held')} <b>${p.days_held}d</b></span>
      <span>${T('目标状态','target')} <b>${esc(cd.target_state)}</b></span>
      <span>${T('总体进度','overall')} <b>${Math.round((cd.overall_progress||0)*100)}%</b></span>
    </div>
    <div class="verdict-block" style="margin-bottom:14px">${esc(cd.note_zh||'')}</div>
    ${conds}
  </div>
  ${off?`<div class="card"><div class="card-title">${T('William countdown 对照','William Countdown')}</div>
    <div style="overflow-x:auto"><table><thead><tr><th>${T('条件','Cond')}</th><th>${T('描述','Line')}</th><th>${T('距离','Distance')}</th><th>${T('今日动向','Move')}</th></tr></thead><tbody>${off}</tbody></table></div></div>`:''}`;
};

'use strict';
/* ================= PANEL: 登录/注册/我的账户 ================= */
PANELS.account=async function(){
  const main=$('#main');
  if(state.user){
    main.innerHTML=vipHero(state.user.vip)+`
    <div class="card form-box">
      <div class="card-title">${T('我的账户','My Account')}</div>
      <div class="kv-strip" style="flex-direction:column;gap:8px;align-items:flex-start">
        <span>${T('用户名','username')} <b>${esc(state.user.username)}</b></span>
        <span>${T('昵称','nickname')} <b id="nickShow">${esc(state.user.nickname||state.user.username)}</b> <a href="javascript:void 0" id="nickEdit" style="font-size:11px">✏️ ${T('修改','edit')}</a></span>
        <span id="nickForm" style="display:none;width:100%"><input id="nickInput" maxlength="24" placeholder="${T('输入新昵称，留空恢复用户名','new nickname, empty = username')}" style="background:var(--bg1);border:1px solid var(--line2);border-radius:4px;color:var(--text);padding:4px 8px;font-size:12px;width:220px"> <button class="btn small" id="nickSave">${T('保存','Save')}</button></span>
        <span>${T('状态','status')} <span class="badge ${state.user.status}">${state.user.status==='approved'?T('已开通','approved'):state.user.status}</span></span>
        <span>${T('注册时间','registered')} <b>${state.user.created_at?new Date(state.user.created_at).toLocaleString('zh-CN',{hour12:false}):'—'}</b></span>
        <span>${T('开通时间','approved at')} <b>${state.user.approved_at?new Date(state.user.approved_at).toLocaleString('zh-CN',{hour12:false}):'—'}</b></span>
        <span>${T('会员等级','Membership')} ${vipBadge(state.user.vip)}</span>
        <span>${T('剩余天数','Days left')} <b>${state.user.vip&&state.user.vip.days&&isFinite(state.user.vip.days)?state.user.vip.days+' 天':'∞'}</b></span>
        <span>${T('到期时间','Expires at')} <b>${state.user.vip&&state.user.vip.expires_at?new Date(state.user.vip.expires_at).toLocaleString('zh-CN',{hour12:false}):(state.user.vip&&state.user.vip.permanent?'永久':'—')}</b></span>
      </div>
      <div class="verdict-block" style="margin:12px 0">${T('会员栏目已解锁：市场分析 / 链上数据 / 清算数据 / 筹码分布 / 实盘信号 / BTC预言机 / 多空LSR / 费率套利 / 消息面。会话 7 天有效，httpOnly cookie 存储。','Member tabs unlocked: Market Analysis / On-Chain / Liquidation / Chip Distribution / Live Signals / BTC Oracle / LSR / Funding / News. Session valid 7 days via httpOnly cookie.')}</div>
      <button class="btn danger" id="logoutBtn">${T('退出登录','Sign out')}</button>
    </div>`;
    $('#logoutBtn').onclick=async()=>{await api('/api/auth/logout',{method:'POST',body:'{}'});state.user=null;refreshUserChip();toast(T('已退出','Signed out'));switchTab('account')};
    // 昵称修改
    $('#nickEdit').onclick=()=>{$('#nickForm').style.display='inline';$('#nickInput').value=state.user.nickname||'';$('#nickInput').focus()};
    $('#nickSave').onclick=async()=>{
      const nick=$('#nickInput').value.trim();
      if(nick && !/^[A-Za-z0-9_\-一-龥]{2,24}$/.test(nick)){toast(T('昵称需 2-24 位','Nickname 2-24 chars'));return}
      const r=await api('/api/user/profile',{method:'POST',body:JSON.stringify({nickname:nick})});
      if(r.ok){state.user.nickname=nick||null;$('#nickShow').textContent=nick||state.user.username;$('#nickForm').style.display='none';toast(T('已保存','Saved'))}
      else toast(r.error||T('保存失败','Failed'));
    };
    return;
  }
  main.innerHTML=`<div class="card form-box">
    <div class="card-title" id="authTitle">${T('登录','Sign In')}</div>
    <div id="loginForm">
      <div class="field"><label>${T('用户名','Username')}</label><input id="liUser" autocomplete="username"></div>
      <div class="field"><label>${T('密码','Password')}</label><input id="liPass" type="password" autocomplete="current-password"></div>
      <div class="form-msg" id="liMsg"></div>
      <button class="btn" style="width:100%" id="liBtn">${T('登录','Sign in')}</button>
      <div class="form-switch">${T('还没有账号？','No account?')} <a href="javascript:void 0" id="showReg">${T('注册（需管理员审批）','Register')}</a></div>
    </div>
    <div id="regForm" style="display:none">
      <div class="field"><label>${T('用户名（2-24位）','Username (2-24)')}</label><input id="rgUser" autocomplete="username"></div>
      <div class="field"><label>${T('昵称（可选）','Nickname (optional)')}</label><input id="rgNick" placeholder="${T('留空则显示用户名','empty = show username')}" maxlength="24"></div>
      <div class="field"><label>${T('密码（至少6位）','Password (6+)')}</label><input id="rgPass" type="password" autocomplete="new-password"></div>
      <div class="field"><label>${T('确认密码','Confirm')}</label><input id="rgPass2" type="password" autocomplete="new-password"></div>
      <div class="form-msg" id="rgMsg"></div>
      <button class="btn" style="width:100%" id="rgBtn">${T('提交注册','Register')}</button>
      <div class="form-switch">${T('已有账号？','Have an account?')} <a href="javascript:void 0" id="showLogin">${T('直接登录','Sign in')}</a></div>
    </div>
  </div>`;
  const liMsg=$('#liMsg'),rgMsg=$('#rgMsg');
  $('#showReg').onclick=()=>{$('#loginForm').style.display='none';$('#regForm').style.display='block';$('#authTitle').textContent=T('注册 · 审批制','Register · Approval-gated')};
  $('#showLogin').onclick=()=>{$('#regForm').style.display='none';$('#loginForm').style.display='block';$('#authTitle').textContent=T('登录','Sign In')};
  $('#liBtn').onclick=async()=>{
    liMsg.className='form-msg';liMsg.textContent='…';
    const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:$('#liUser').value,password:$('#liPass').value})});
    if(r.ok){state.user=r.user;refreshUserChip();toast(T('登录成功','Welcome'));
      if(r.user&&(r.user.username==='13665437670'||r.user.is_owner))state.admin=true;
      renderNav();
      switchTab(r.user&&r.user.is_owner?'admin':'overview')}
    else{liMsg.className='form-msg err';liMsg.textContent=r.message||r.error||T('登录失败','failed')}
  };
  $('#rgBtn').onclick=async()=>{
    rgMsg.className='form-msg';
    if($('#rgPass').value!==$('#rgPass2').value){rgMsg.className='form-msg err';rgMsg.textContent=T('两次密码不一致','passwords differ');return}
    rgMsg.textContent='…';
    const r=await api('/api/auth/register',{method:'POST',body:JSON.stringify({username:$('#rgUser').value,password:$('#rgPass').value,nickname:$('#rgNick').value})});
    if(r.ok){rgMsg.className='form-msg ok';rgMsg.textContent=T('✓ 注册成功，账号为待审批状态，管理员批准后即可登录。','✓ Registered. Pending admin approval.')}
    else{rgMsg.className='form-msg err';rgMsg.textContent=r.message||r.error||T('注册失败','failed')}
  };
};
function vipBadge(v){
  if(!v)return '';
  const cfg={
    owner:{icon:'👑',cls:'vip-owner',text:'老板',sub:'无限'},
    eternal:{icon:'💎',cls:'vip-eternal',text:'至尊',sub:'永久'},
    gold:{icon:'★',cls:'vip-gold',text:'黄金',sub:v.desc||''},
    platinum:{icon:'◆',cls:'vip-platinum',text:'白金',sub:v.desc||''},
    normal:{icon:'●',cls:'vip-normal',text:'普通',sub:v.desc||''},
    expired:{icon:'○',cls:'vip-expired',text:'到期',sub:'额度已归零'}
  };
  const c=cfg[v.level]||cfg.normal;
  const body=(v.level==='owner'||v.level==='eternal')?c.text:(c.text+' '+c.sub.replace(' 天','天'));
  return '<span class="vip-badge '+c.cls+'" title="'+c.text+' · '+c.sub+'">'+c.icon+' '+body+'</span>';
}
function vipHero(v){
  if(!v)return '';
  const cfg={
    owner:{icon:'👑',cls:'vip-owner',text:'老板',sub:'无限',tip:'尊贵的老板，欢迎回来'},
    eternal:{icon:'💎',cls:'vip-eternal',text:'至尊会员',sub:'永久',tip:'永久尊享全部会员权益'},
    gold:{icon:'🌟',cls:'vip-gold',text:'黄金会员',sub:v.desc||'',tip:'黄金尊享 · 90 天以上权益'},
    platinum:{icon:'💠',cls:'vip-platinum',text:'白金会员',sub:v.desc||'',tip:'白金尊享 · 30 天以上权益'},
    normal:{icon:'✨',cls:'vip-normal',text:'普通会员',sub:v.desc||'',tip:'会员权益生效中'},
    expired:{icon:'⏳',cls:'vip-expired',text:'会员已到期',sub:'额度已归零',tip:'请联系管理员续费'}
  };
  const c=cfg[v.level]||cfg.normal;
  return '<div class="card vip-hero" style="background:linear-gradient(135deg,var(--bg1),var(--bg2));border:1px solid var(--line)">'
    +'<span style="font-size:26px">'+c.icon+'</span>'
    +'<div><div class="vip-title">'+c.text+'</div>'
    +'<div class="vip-meta">'+c.sub+(v.expires_at?' · 到期 '+new Date(v.expires_at).toLocaleString('zh-CN',{hour12:false}):'')+'</div></div>'
    +'<span class="vip-badge '+c.cls+'" style="margin-left:auto">'+c.text+'</span></div>';
}
function refreshUserChip(){
  const chip=$('#userChip');
  const vchip=$('#vipChip');
  if(state.admin){
    chip.style.display='';chip.className='user-chip vip-chip-owner';chip.innerHTML='👑 老板·无限';
    vchip.style.display='none';
    return;
  }
  if(state.user){
    chip.style.display='';chip.className='user-chip';
    chip.innerHTML='◆ '+esc(state.user.nickname||state.user.username);
    vchip.style.display='';vchip.innerHTML=vipBadge(state.user.vip);
  }else{
    chip.style.display='none';vchip.style.display='none';
  }
}

/* ================= PANEL: 后台 ================= */
/* ========== 系统蓝图动态渲染（ABC 重做 2026-08-22）========== */
/* ========== 系统蓝图 SVG 拓扑图（工程级 v2 2026-08-22 方案一）========== */
/* ========== 系统蓝图 v3 双端响应式（大卡片+主线拓扑）2026-08-22 ========== */
let bpGraphData = null;
function bpColor(ok, minutes, sla){
  if (ok === false) return '#c06a5e';
  if (minutes == null) return '#888';
  const lim = sla || 60;
  if (minutes > lim) return '#c06a5e';
  if (minutes > lim * 0.75) return '#e0b36a';
  return '#5f9e7a';
}
function bpSvgArrow(uid,x1,y1,x2,y2,color){
  return `<defs><marker id="mk${uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker></defs><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2" opacity="0.6" marker-end="url(#mk${uid})"/>`;
}
function renderBlueprint(bp){
  const root = $('#bpRoot');
  if(!root) return;
  if(!bp || !bp.ok){ root.innerHTML = `<div class="empty">${T('蓝图数据加载失败','Blueprint data unavailable')}</div>`; return; }
  bpGraphData = bp;
  const g = bp.graph||{};
  const sources = g.sources||[], conn = g.connectivity||[], engines = g.engine_nodes||[];
  const procsAll = (bp.processes||[]);
  const procs = procsAll.filter(p=>p.status==='running');
  const stats = (bp.tianji&&bp.tianji.stats)||{}, okx = bp.okx||{};
  const srcStale = (s)=>s.minutes!=null && s.minutes > (s.sla_min||60);
  const staleN = sources.filter(srcStale).length;
  const badN = sources.filter(s=>s.ok===false).length;
  const okN = sources.filter(s=>s.ok).length;
  const connRate = sources.length?Math.round(okN/sources.length*100):0;
  const groupOrder=['行情/合约','多空/清算','情绪/共识','宏观/经济','新闻','其他'];
  const byGroup={}; for(const s of sources){(byGroup[s.group]=byGroup[s.group]||[]).push(s);}

  let html='';

  /* 智能摘要条（一眼看全局） */
  const sumCls = (badN||staleN)?'warn':'ok';
  const sumTxt = badN? `⚠️ ${badN} 源连接失败 · ${staleN} 源超出采集节奏 · 连通度 ${connRate}%`
    : staleN? `⚠️ ${staleN} 源超出采集节奏 · 连通度 ${connRate}%`
    : `✅ 系统健康 · ${okN}/${sources.length} 源在线 · 连通度 ${connRate}% · 全部按节奏更新`;
  html += `<div class="bp-summary ${sumCls}">${sumTxt}</div>`;

  /* ① KPI（点击显示详情） */
  html += `<div class="bp-kpi">`;
  html += `<div class="bp-kpi-item" onclick="bpShowKpi('src')"><div class="v" style="color:var(--amber)">${sources.length}</div><div class="l">数据源节点</div></div>`;
  html += `<div class="bp-kpi-item" onclick="bpShowKpi('conn')"><div class="v" style="color:${connRate>=90?'#5f9e7a':'#e0b36a'}">${connRate}%</div><div class="l">整体连通度</div></div>`;
  html += `<div class="bp-kpi-item" onclick="bpShowKpi('stale')"><div class="v" style="color:${staleN?'#c06a5e':'#5f9e7a'}">${staleN}</div><div class="l">滞后源(>1h)</div></div>`;
  html += `<div class="bp-kpi-item" onclick="bpShowKpi('eng')"><div class="v" style="color:#4da6ff">${engines.length}</div><div class="l">策略引擎</div></div>`;
  html += `<div class="bp-kpi-item" onclick="bpShowKpi('proc')"><div class="v" style="color:#7c4dff">${procs.length}</div><div class="l">运行进程</div></div>`;
  html += `<div class="bp-kpi-item" onclick="bpShowKpi('tianji')"><div class="v" style="color:#5f9e7a">${stats.winRate!=null?stats.winRate.toFixed(1)+'%':'—'}</div><div class="l">tianji 胜率</div></div>`;
  html += `</div>`;

  /* ② 主线拓扑（节点可点击看层详情） */
  const F={w:900,h:160};
  function laneBox(cx,cy,w,txt,sub,color,lay){return `<g style="cursor:pointer" onclick="bpShowLayer('${lay}')"><rect x="${cx-w/2}" y="${cy}" width="${w}" height="40" rx="10" fill="var(--bg1)" stroke="${color}" stroke-width="2"/><text x="${cx}" y="${cy+18}" font-size="13" fill="${color}" font-weight="700" text-anchor="middle" font-family="var(--mono)">${txt}</text><text x="${cx}" y="${cy+32}" font-size="9" fill="#7d8590" text-anchor="middle" font-family="var(--mono)">${sub}</text></g>`;}
  // 5 个节点等距：宽 158 × 5 + 间距 22 × 4 + 左右 20 = 900
  const wN=158, gapN=22, x0=20;
  const cxN = (i) => x0 + wN/2 + i*(wN+gapN);
  const l1=cxN(0),l2=cxN(1),l3=cxN(2),l4=cxN(3),l5=cxN(4);
  let svg=`<svg viewBox="0 0 ${F.w} ${F.h}" style="width:100%;height:auto">`;
  svg+=`<rect width="${F.w}" height="${F.h}" fill="transparent"/>`;
  svg+=laneBox(l1,55,wN,'📡 数据源',sources.length+' 节点','#4da6ff','src');
  svg+=laneBox(l2,55,wN,'⚙️ 采集调度','cron · WAL','#d9a441','sched');
  svg+=laneBox(l3,55,wN,'🧠 策略引擎',engines.length+' 引擎','#5f9e7a','eng');
  svg+=laneBox(l4,55,wN,'💰 执行层','OKX auto='+(okx.auto?'ON':'OFF'),'#58a06e','exe');
  svg+=laneBox(l5,55,wN,'📤 输出层','看板/QQ/实盘','#7c4dff','out');
  svg+=bpSvgArrow(1,l1+wN/2,40,l2-wN/2,40,'#4da6ff');
  svg+=bpSvgArrow(2,l2+wN/2,40,l3-wN/2,40,'#d9a441');
  svg+=bpSvgArrow(3,l3+wN/2,40,l4-wN/2,40,'#5f9e7a');
  svg+=bpSvgArrow(4,l4+wN/2,40,l5-wN/2,40,'#58a06e');
  svg+=`<text x="${F.w/2}" y="${F.h-10}" font-size="10" fill="#7d8590" text-anchor="middle" font-family="var(--mono)">五层主链路 · 点击节点看层详情</text></svg>`;
  html += `<div class="bp-flow">${svg}</div>`;

  /* ③ 数据源分组卡片（点击详情） */
  html += `<div class="bp-section"><div class="bp-section-title">📡 ${T('数据源层','Data Sources')}<span class="bp-tag">${sources.length} 节点 · 点击查看详情</span></div>`;
  for(const gname of groupOrder){
    const items=byGroup[gname]; if(!items||!items.length) continue;
    const gStale=items.filter(srcStale).length;
    const gBad=items.filter(s=>s.ok===false).length;
    html += `<div style="margin-bottom:12px"><div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:6px">${gname} <span style="color:var(--text3);font-weight:400">${items.length} 源${gBad?' · 🔴'+gBad+' 失败':''}${gStale?' · '+gStale+' 滞后':''}</span></div>`;
    html += `<div class="bp-src-grid">`;
    for(const s of items){
      const c=bpColor(s.ok,s.minutes,s.sla_min);
      const meta = s.ok===false?`🔴 失败 · ${s.ms}ms · ${s.cadence||''}节奏`
        : s.minutes==null?`⚪ 无时间戳 · ${s.cadence||''}节奏`
        : s.stale?`⚠️ 超时 · ${s.ms}ms · ${s.minutes}m前 · 应≤${s.cadence||''}`
        : `🟢 正常 · ${s.ms}ms · ${s.minutes}m前 · ${s.cadence||''}节奏`;
      html += `<div class="bp-src-card" style="border-left-color:${c}" onclick="bpShowSource('${s.source}')">
        <div class="name"><span class="dot" style="background:${c};color:${c}"></span>${s.source}<span class="grp">${s.up_rate}%</span></div>
        <div class="meta">${meta}</div>
      </div>`;
    }
    html += `</div></div>`;
  }
  html += `</div>`;

  /* ④ 数据连通度（点击显示该组源） */
  html += `<div class="bp-section"><div class="bp-section-title">📶 ${T('数据连通度','Connectivity')}<span class="bp-tag">点击查看组内源</span></div><div class="bp-conn-grid">`;
  for(const c of conn){
    const rc=c.rate>=90?'#5f9e7a':c.rate>=60?'#e0b36a':'#c06a5e';
    html += `<div class="bp-conn-item" onclick="bpShowConn('${c.group}')"><div class="g">${c.group}</div><div class="r" style="color:${rc}">${c.rate}%</div><div class="m">${c.ok}/${c.total} 通${c.stale?' · '+c.stale+' 滞后':''}</div><div class="bp-conn-bar"><i style="width:${c.rate}%;background:${rc}"></i></div></div>`;
  }
  html += `</div></div>`;

  /* ⑤ 引擎卡片（点击详情，模块在位检测） */
  const mods = new Set((bp.engines||[]).map(f=>f.replace(/\.js$/,'')));
  html += `<div class="bp-section"><div class="bp-section-title">🧠 ${T('策略引擎层','Strategy Engines')}<span class="bp-tag">${engines.length} 核心引擎 · 点击看详情</span></div><div class="bp-eng-grid">`;
  for(const e of engines){
    const inPlace = e.mod && mods.has(e.mod);
    html += `<div class="bp-eng-card" onclick="bpShowEngine('${e.id}','${e.name}','${e.mod||''}')" style="border-left-color:${inPlace?'#5f9e7a':'#c06a5e'}"><div><span class="id" style="background:${inPlace?'#5f9e7a':'#c06a5e'}">${e.id}</span><span class="name">${e.name}</span></div><div class="mod">${inPlace?'✅ 模块在位':'⚠️ 模块缺失'} · ${e.mod||'—'}</div></div>`;
  }
  html += `</div></div>`;

  /* ⑥ 运行进程（点击详情） */
  html += `<div class="bp-section"><div class="bp-section-title">🖥 ${T('运行进程','Processes')}<span class="bp-tag">${procs.length}/${procsAll.length} 在线${procsAll.length-procs.length?` · ${procsAll.length-procs.length} 异常`:''} · 点击看详情</span></div><div class="bp-eng-grid">`;
  for(const p of procsAll.slice().sort((a,b)=>(a.status==='running'?0:1)-(b.status==='running'?0:1))){
    const bad = p.status!=='running';
    const cpuCls = bad?'#c06a5e':p.cpu>80?'#c06a5e':p.cpu>50?'#e0b36a':'#5f9e7a';
    const upH = p.uptime_sec? (p.uptime_sec/3600).toFixed(1)+'h':'—';
    html += `<div class="bp-eng-card" onclick="bpShowProc('${p.name}')" style="border-left-color:${bad?'#c06a5e':'#7c4dff'}"><div><span class="id" style="background:${bad?'#c06a5e':'#7c4dff'}">${p.pid||'?'}</span><span class="name">${esc(p.name)}</span></div><div class="mod" style="color:${cpuCls}">${bad?'⚠ '+(p.status_raw||p.status)+' · ':''}CPU ${p.cpu||0}% · MEM ${p.mem_mb||0}MB · 重启${p.restarts||0}次 · ${upH}</div></div>`;
  }
  html += `</div></div>`;

  /* 详情面板 */
  html += `<div class="data-ts" style="margin-top:8px">W1 v${bp.version||'5.0.0'} · ${T('点击节点查看详情','Click node for details')} · 刷新 ${new Date(bp.ts*1000).toLocaleTimeString('zh-CN',{hour12:false})} CST</div>`;
  root.innerHTML = html;
}
function bpShowKpi(kind){
  if(!bpGraphData) return;
  const g=bpGraphData.graph||{};
  const sources=g.sources||[], conn=g.connectivity||[], engines=g.engine_nodes||[];
  const stats=(bpGraphData.tianji&&bpGraphData.tianji.stats)||{};
  if(kind==='src'){
    bpOpenModal(`<div class="bp-modal-t">📡 数据源节点 · ${sources.length}<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
      <div class="bp-kv2">${conn.map(c=>`<div>${c.group} <b>${c.ok}/${c.total}</b> ${c.rate}%</div>`).join('')}</div>`);
  } else if(kind==='conn'){
    bpOpenModal(`<div class="bp-modal-t">📶 整体连通度<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
      <div class="bp-mini-list">${conn.map(c=>`<div class="bp-mini-row"><span class="k">${c.group}</span><span>${c.ok}/${c.total} 通</span><span class="v2">${c.rate}%</span></div>`).join('')}</div>`);
  } else if(kind==='stale'){
    const st=sources.filter(s=>s.minutes!=null && s.minutes > (s.sla_min||60));
    bpOpenModal(`<div class="bp-modal-t">⏳ 滞后源 (>1h) · ${st.length}<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
      ${st.length?`<div class="bp-mini-list">${st.map(s=>`<div class="bp-mini-row"><span class="k">${s.source}</span><span>${s.ok?'🟢':'🔴'}</span><span class="v2">${s.minutes}m前 / 应≤${s.cadence||''}</span></div>`).join('')}</div>`:'<div class="b">✅ 全部按节奏更新</div>'}`);
  } else if(kind==='eng'){
    bpOpenModal(`<div class="bp-modal-t">🧠 策略引擎 · ${engines.length}<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
      <div class="bp-mini-list">${engines.map(e=>`<div class="bp-mini-row" style="cursor:pointer" onclick="bpShowEngine('${e.id}','${e.name}','${e.mod||''}')"><span class="k">${e.id}</span><span>${e.name}</span><span class="v2">${e.present?'🟢':'⚪'}</span></div>`).join('')}</div>`);
  } else if(kind==='proc'){
    bpShowProcs();
  } else if(kind==='tianji'){
    const s=bpGraphData.tianji||{};
    bpOpenModal(`<div class="bp-modal-t">🎯 tianji 状态<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
      <div class="bp-kv2"><div>胜率 <b>${stats.winRate!=null?stats.winRate.toFixed(1)+'%':'—'}</b></div><div>监控标的 <b>${s.watch!=null?s.watch:'—'}</b></div><div>周末屏蔽 <b>${s.weekend_blocked?'是':'否'}</b></div><div>样本 <b>${stats.total!=null?stats.total:'—'}</b></div></div>`);
  }
}
function bpShowLayer(lay){
  if(!bpGraphData) return;
  const g=bpGraphData.graph||{};
  const okx=bpGraphData.okx||{};
  const titles={src:'📡 数据源层',sched:'⚙️ 采集调度',eng:'🧠 策略引擎层',exe:'💰 执行层',out:'📤 输出层'};
  let b='';
  if(lay==='src'){
    const sources=g.sources||[];
    const bad=sources.filter(s=>s.ok===false), stale=sources.filter(s=>s.minutes!=null&&s.minutes>(s.sla_min||60));
    b=`<div class="bp-kv2"><div>节点 <b>${sources.length}</b></div><div>失败 <b style="color:${bad.length?'#c06a5e':'#5f9e7a'}">${bad.length}</b></div><div>滞后 <b>${stale.length}</b></div><div>健康率 <b>${sources.length?Math.round(sources.filter(s=>s.ok).length/sources.length*100):0}%</b></div></div>`;
  } else if(lay==='sched'){
    b=`<div class="b">cron 定时采集 · SQLite WAL 模式 · 各源按自身节奏入库（5min~24h）<br>价格/合约/清算/共识等高频表 5~10min 一更，宏观/新闻低频</div>`;
  } else if(lay==='eng'){
    b=`<div class="b">${(g.engine_nodes||[]).length} 个策略引擎（天机/方向/判官/预言机/观点/季节/宏观/KOL/清算技术/LSR/筹码/情绪/鲸鱼…）<br>点击上方「策略引擎」KPI 查看完整清单</div>`;
  } else if(lay==='exe'){
    b=`<div class="bp-kv2"><div>OKX 自动跟单 <b>${okx.auto?'🟢 ON':'⚪ OFF'}</b></div><div>跟随比例 <b>${okx.follow_ratio!=null?okx.follow_ratio:'—'}</b></div><div>杠杆 <b>${okx.leverage!=null?okx.leverage:'—'}</b></div><div>风险比例 <b>${okx.risk_pct!=null?okx.risk_pct:'—'}</b></div></div>`;
  } else if(lay==='out'){
    b=`<div class="b">输出通道：W1 看板 · QQ 群推送（信号/监测/分析）· 实盘 OKX 执行</div>`;
  }
  bpOpenModal(`<div class="bp-modal-t">${titles[lay]||lay}<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
    <div class="b">${b}</div>`);
}
function bpShowConn(group){
  if(!bpGraphData) return;
  const n=(bpGraphData.graph.sources||[]).filter(s=>s.group===group);
  bpOpenModal(`<div class="bp-modal-t">📶 ${group} · ${n.length} 源<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
    <div class="bp-mini-list">${n.map(s=>`<div class="bp-mini-row" style="cursor:pointer" onclick="bpShowSource('${s.source}')"><span class="k">${s.source}</span><span>${s.ok?'🟢':'🔴'}</span><span class="v2">${s.ms}ms · ${s.minutes==null?'无数据':s.minutes+'m前'}</span></div>`).join('')}</div>`);
}
function bpShowSource(src){
  if(!bpGraphData) return;
  const n=(bpGraphData.graph.sources||[]).find(s=>s.source===src); if(!n) return;
  const c=bpColor(n.ok,n.minutes,n.sla_min);
  const dots=(n.history||[]).slice(0,16).map(h=>`<i style="background:${h.ok?'#5f9e7a':'#c06a5e'}" title="${h.ms}ms"></i>`).join('');
  bpOpenModal(`<div class="bp-modal-t">📡 ${esc(n.source)} <span style="font-size:11px;color:var(--text3);font-weight:400">${esc(n.group)}</span><button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
    <div class="bp-kv2">
      <div>状态 <b>${n.ok?'🟢 连接正常':'🔴 失败'}</b></div>
      <div>延迟 <b>${n.ms}ms</b></div>
      <div>上次更新 <b>${n.minutes==null?'无数据':n.minutes+'分钟前'}</b></div>
      <div>健康率 <b>${n.up_rate}%</b> (${n.health_ok}/${n.health_total})</div>
    </div>
    ${n.detail?`<div class="b" style="margin-top:8px">缓存: ${esc(String(n.detail).slice(0,120))}</div>`:''}
    <div class="bp-dots" style="margin-top:8px">${dots}</div>`);
}
function bpShowEngine(id,name,mod){
  if(!bpGraphData) return;
  const mods=new Set((bpGraphData.engines||[]).map(f=>f.replace(/\.js$/,'')));
  const inPlace = mod && mods.has(mod);
  bpOpenModal(`<div class="bp-modal-t">🧠 ${id} ${esc(name)}<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
    <div class="bp-kv2">
      <div>模块 <b>${esc(mod||'—')}</b></div>
      <div>文件状态 <b>${inPlace?'🟢 在位':'🔴 缺失'}</b></div>
      <div>类型 <b>策略引擎</b></div>
      <div>编号 <b>${id}</b></div>
    </div>`);
}
function bpOpenModal(html){
  const ov=document.createElement('div');
  ov.className='bp-modal-ov';
  ov.innerHTML=`<div class="bp-modal" onclick="event.stopPropagation()">${html}</div>`;
  ov.onclick=()=>ov.remove();
  document.body.appendChild(ov);
}
function bpShowProc(name){
  if(!bpGraphData) return;
  const p=(bpGraphData.processes||[]).find(x=>x.name===name); if(!p) return;
  const upH=p.uptime_sec?fmtDur(p.uptime_sec):'—';
  const cpuC=p.cpu>80?'#c06a5e':p.cpu>50?'#e0b36a':'#5f9e7a';
  bpOpenModal(`<div class="bp-modal-t">🖥 ${esc(p.name)}<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
  <div class="bp-kv2">
    <div>PID <b>${p.pid||'—'}</b></div>
    <div>状态 <b>${p.status==='running'?'🟢 运行中':'🔴 '+(p.status||'停止')}${p.status_raw&&p.status_raw!==p.status?' ('+esc(p.status_raw)+')':''}</b></div>
    <div>CPU <b style="color:${cpuC}">${p.cpu||0}%</b></div>
    <div>内存 <b>${p.mem_mb||0}MB</b></div>
    <div>重启 <b>${p.restarts||0} 次</b>${p.unstable_restarts?` · 不稳定 <b>${p.unstable_restarts}</b>`:''}</div>
    <div>运行时长 <b>${upH}</b></div>
  </div>`);
}
function bpShowProcs(){
  if(!bpGraphData) return;
  const procs=(bpGraphData.processes||[]).slice().sort((a,b)=>(a.status==='running'?0:1)-(b.status==='running'?0:1));
  if(!procs.length){ bpOpenModal(`<div class="bp-modal-t">💻 进程<button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div><div class="b">无法读取进程状态</div>`); return; }
  const rows=procs.map(p=>{
    const bad=p.status!=='running';
    const cpuC=bad?'#c06a5e':p.cpu>80?'#c06a5e':p.cpu>50?'#e0b36a':'#5f9e7a';
    return `<tr><td><span class="dot ${bad?'r':'g'}"></span>${esc(p.name)}${p.version?' <span style="color:var(--text3)">v'+esc(p.version)+'</span>':''}</td><td class="num">${p.pid||'—'}</td><td class="num" style="color:${cpuC}">${p.cpu||0}%</td><td class="num">${p.mem_mb||0}MB</td><td class="num">${p.restarts||0}</td><td class="num">${p.uptime_sec?fmtDur(p.uptime_sec):'—'}</td></tr>`;
  }).join('');
  const onlineN=procs.filter(p=>p.status==='running').length;
  bpOpenModal(`<div class="bp-modal-t">💻 ${T('运行进程','Processes')} <span class="bp-tag">${onlineN}/${procs.length} 在线</span><button class="bp-modal-x" onclick="this.closest('.bp-modal-ov').remove()">✕</button></div>
  <div style="overflow-x:auto"><table class="bp-proc-tbl"><thead><tr><th>名称</th><th>PID</th><th>CPU</th><th>内存</th><th>重启</th><th>运行时长</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

PANELS.admin=async function(){
  const main=$('#main');
  if(!state.admin){
    main.innerHTML=`<div class="card form-box">
      <div class="card-title">${T('管理员后台','Admin Console')}</div>
      <div class="field"><label>${T('管理密码','Admin password')}</label><input id="adPass" type="password"></div>
      <div class="form-msg" id="adMsg"></div>
      <button class="btn" style="width:100%" id="adBtn">${T('进入后台','Enter')}</button>
      <div class="verdict-block" style="margin-top:12px;font-size:12px">${T('后台会话与会员会话相互独立（不同 cookie），互不影响。','Admin session is independent from member session.')}</div>
    </div>`;
    $('#adBtn').onclick=async()=>{
      const r=await api('/api/admin/login',{method:'POST',body:JSON.stringify({password:$('#adPass').value})});
      if(r.ok){state.admin=true;renderNav();PANELS.admin()}else{$('#adMsg').className='form-msg err';$('#adMsg').textContent=T('密码错误','wrong password')}
    };
    $('#adPass').onkeydown=e=>{if(e.key==='Enter')$('#adBtn').click()};
    return;
  }
  main.innerHTML='<div class="card">加载后台数据…</div>';
  const [users,health,sys,access]=await Promise.all([api('/api/admin/users'),api('/api/admin/health'),api('/api/admin/system-stats'),api('/api/admin/access')]);
  if(users.__needAdmin){state.admin=false;PANELS.admin();return}
  const acc=access&&access.ok?access:{today_count:0,today_ips:0,total_count:0,total_ips:0};
  const statusZh={pending:'待审批',approved:'已开通',rejected:'已拒绝'};
  const urows=(users.users||[]).map(u=>`<tr class="${u.status==='pending'?'pending-row':''}">
    <td class="num">${u.id}</td><td>${esc(u.username)}</td>
    <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start"><input id="note_${u.id}" maxlength="100" placeholder="${T('备注(仅后台可见)','note (admin only)')}" title="${T('后台备注，用户端不可见','admin-only note')}" value="${esc(u.admin_note||'')}" style="width:110px;background:var(--bg1);border:1px solid var(--line2);border-radius:4px;color:var(--text);padding:3px 6px;font-size:11px"><button class="btn small secondary" data-act="note" data-id="${u.id}" title="${T('保存备注','save note')}">${T('存','Save')}</button></div></td>
    <td><span class="badge ${u.status}">${statusZh[u.status]||u.status}</span></td>
    <td>${vipBadge(u.vip)}</td>
    <td class="num">${new Date(u.created_at).toLocaleString('zh-CN',{hour12:false})}</td>
    <td class="num">${u.approved_at?new Date(u.approved_at).toLocaleString('zh-CN',{hour12:false}):'—'}</td>
    <td style="white-space:nowrap">
      <span class="admin-set">
        <input type="number" min="0" max="3650" id="expDays_${u.id}" placeholder="天" title="设置到期天数(0=立即到期)">
        <button class="btn small" data-act="expiry" data-id="${u.id}">${T('设到期','Expiry')}</button>
        <button class="btn small ${u.permanent?'':'secondary'}" data-act="perm" data-id="${u.id}" data-on="${u.permanent?'0':'1'}">${u.permanent?'💎永久':'永久'}</button>
        <button class="btn small ${u.is_owner?'':'secondary'}" data-act="owner" data-id="${u.id}" data-on="${u.is_owner?'0':'1'}">${u.is_owner?'👑老板':'老板'}</button>
      </span>
      ${u.status!=='approved'?`<button class="btn small" data-act="approve" data-id="${u.id}">${T('批准','Approve')}</button>`:''}
      ${u.status!=='rejected'?`<button class="btn small secondary" data-act="reject" data-id="${u.id}">${T('拒绝','Reject')}</button>`:''}
      <button class="btn small danger" data-act="delete" data-id="${u.id}">${T('删除','Delete')}</button>
    </td></tr>`).join('');
  const hrows=(health.latest_by_source||[]).map(h=>`<div class="health-row">
    <span><span class="dot ${h.ok?'g':'r'}"></span>${esc(h.source)}</span>
    <span class="data-ts">${h.ms}ms · ${fmtTs(h.ts)}${h.detail?' · '+esc(String(h.detail).slice(0,60)):''}</span></div>`).join('');
  const jobs=['gate-prices','futures-markets','lsr-trader','lsr-whale','funding-arb','consensus','fear-greed','openclue','daily-verdict'];
  // 进程概览：异常优先排序，再按累计重启降序
  const procAll=(sys.pm2||[]).slice();
  const procSt={running:'运行中',stopped:'已停止',errored:'错误',launching:'启动中',stopping:'停止中',unknown:'未知'};
  const procOn=procAll.filter(p=>p.status==='running').length;
  const procBad=procAll.length-procOn;
  const procRestarts=procAll.reduce((a,p)=>a+(p.restarts||0),0);
  const procUnstable=procAll.reduce((a,p)=>a+(p.unstable_restarts||0),0);
  const procList=procAll.sort((a,b)=>{
    const ab=a.status==='running'?0:1, bb=b.status==='running'?0:1;
    if(ab!==bb)return ab-bb;
    return (b.restarts||0)-(a.restarts||0) || String(a.name).localeCompare(String(b.name));
  });
  main.innerHTML=`
  <div class="card">
    <div class="card-title">👥 ${T('访问统计','Access')}
      <span style="margin-left:auto" class="data-ts">${T('今日/累计 · 自动记录','Today / Total')}</span></div>
    <div class="kv-strip" style="flex-wrap:wrap;gap:10px">
      <span>${T('今日访问','Today')} <b>${acc.today_count}</b> ${T('次','')}</span>
      <span>${T('今日独立IP','Today IPs')} <b class="up">${acc.today_ips}</b></span>
      <span>${T('总访问','Total')} <b>${acc.total_count}</b> ${T('次','')}</span>
      <span>${T('总独立IP','Total IPs')} <b class="up">${acc.total_ips}</b></span>
    </div>
  </div>
  <div class="card">
    <div class="card-title">${T('用户审批','User Approval')}
      <span class="badge pending" style="margin-left:6px">${(users.users||[]).filter(u=>u.status==='pending').length} ${T('待审批','pending')}</span>
      <span style="margin-left:auto"><button class="btn small secondary" id="adLogout">${T('退出后台','Exit admin')}</button></span></div>
    <div style="overflow-x:auto"><table><thead><tr><th>ID</th><th>${T('用户名','User')}</th><th>${T('后台备注','Note')}</th><th>${T('状态','Status')}</th><th>${T('会员','VIP')}</th><th>${T('注册时间','Registered')}</th><th>${T('开通时间','Approved')}</th><th>${T('操作','Actions')}</th></tr></thead><tbody>${urows||'<tr><td colspan="8" class="empty">暂无用户</td></tr>'}</tbody></table></div>
  </div>
  <div class="admin-grid">
    <div class="card">
      <div class="card-title">${T('数据源健康','Source Health')}</div>
      ${hrows||'<div class="empty">—</div>'}
    </div>
    <div class="card">
      <div class="card-title">${T('系统状态','System')}</div>
      <div class="kv-strip" style="flex-direction:column;gap:6px;align-items:flex-start">
        <span>uptime <b>${health.uptime_sec}s</b> · RSS <b>${health.memory_mb}MB</b> · DB <b>${(health.db_bytes/1048576).toFixed(1)}MB</b></span>
        <span>CG key <b>${esc(health.cg_key.masked)}</b> ${health.cg_key.cooling?'<span class="badge bearish">冷却中</span>':'<span class="badge approved">正常</span>'}</span>
        <span>AI keys <b>A:${health.ai_keys.a?'✓':'✗'} B:${health.ai_keys.b?'✓':'✗'}</b> model <b>${esc(health.ai_keys.model)}</b></span>
        <span>QQ <b>${esc(health.qq.appid)}</b> group_openid <b>${health.qq.group_openid_set?'已配置':'未配置(推送静默跳过)'}</b></span>
        <span>tables <b>${Object.entries(health.table_counts||{}).map(([k,v])=>k+':'+v).join(' · ')}</b></span>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">${T('系统监控','System Monitor')}</div>
    <div class="mon-bar">🖥 ${esc(sys.host)} · ${esc(sys.os)} · ${T('运行','up')} ${fmtDur(sys.uptime_sec)}</div>
    <div class="mon-bar">⚙️ ${T('CPU负载','CPU Load')}
      <div class="bar-track"><div class="bar-fill ${barClass(sys.cpu.load_1m/sys.cpu.cores*100)}" style="width:${Math.min(sys.cpu.load_1m/sys.cpu.cores*100,100)}%"></div></div>
      <span class="bar-label">${sys.cpu.load_1m.toFixed(2)} / ${sys.cpu.load_5m.toFixed(2)} / ${sys.cpu.load_15m.toFixed(2)}</span>
    </div>
    <div class="mon-bar">💾 ${T('内存','RAM')}
      <div class="bar-track"><div class="bar-fill ${barClass(sys.memory.used_pct)}" style="width:${sys.memory.used_pct}%"></div></div>
      <span class="bar-label">${(sys.memory.used_bytes/1073741824).toFixed(1)}G / ${(sys.memory.total_bytes/1073741824).toFixed(1)}G (${sys.memory.used_pct}%)</span>
    </div>
    <div class="mon-bar">📀 ${T('磁盘','Disk')}
      <div class="bar-track"><div class="bar-fill ${barClass(sys.disk.used_pct)}" style="width:${sys.disk.used_pct}%"></div></div>
      <span class="bar-label">${(sys.disk.used_bytes/1073741824).toFixed(1)}G / ${(sys.disk.total_bytes/1073741824).toFixed(1)}G (${sys.disk.used_pct}%)</span>
    </div>
    <div class="card-title" style="margin-top:14px;font-size:13px">${T('进程','Processes')}</div>
    <div class="proc-summary">
      <span class="ps-item ok">● ${procOn}/${procAll.length} ${T('在线','online')}</span>
      ${procBad?`<span class="ps-item bad">● ${procBad} ${T('异常','down')}</span>`:`<span class="ps-item ok">${T('全部正常','all healthy')}</span>`}
      <span class="ps-item">↺ ${T('累计重启','total restarts')} <b>${procRestarts}</b></span>
      ${procUnstable?`<span class="ps-item bad">${T('不稳定重启','unstable')} <b>${procUnstable}</b></span>`:''}
      <span class="ps-item" style="margin-left:auto">${T('异常优先排列','problems first')}</span>
    </div>
    <div class="proc-grid">
      ${procList.map(p => {
        const bad = p.status!=='running';
        const cpuPct = Math.min(Number(p.cpu)||0,100);
        const memMb = Math.round((p.mem_bytes||0)/1048576);
        return `<div class="proc-card ${bad?'proc-bad':''}">
          <div class="proc-name"><span class="dot ${bad?'r':'g'}"></span>${esc(p.name)}
            <span class="proc-pill ${bad?'bad':'ok'}">${procSt[p.status]||esc(p.status||'unknown')}</span>
            ${p.version?`<span class="proc-ver">v${esc(p.version)}</span>`:''}
          </div>
          <div class="proc-stat">
            <span>PID <b>${p.pid||'—'}</b></span>
            <span>CPU <div class="bar-track" style="display:inline-flex;width:50px;height:6px;vertical-align:middle"><div class="bar-fill ${barClass(cpuPct)}" style="width:${cpuPct}%"></div></div> <b>${p.cpu||0}%</b></span>
            <span>MEM <b>${memMb}MB</b></span>
            <span title="${T('本次运行时长','current uptime')}">⏱ ${p.uptime_ms?fmtDur(Math.floor(p.uptime_ms/1000)):'—'}</span>
            <span title="${T('pm2 累计重启次数（含部署重启）','pm2 restarts incl. deploys')}">↺ <b>${p.restarts||0}</b></span>
          </div>
        </div>`;
      }).join('')||`<div class="empty">${T('无法读取进程状态','process state unavailable')}</div>`}
    </div>
    ${sys.top_cpu&&sys.top_cpu.length ?
      `<div class="card-title" style="margin-top:12px;font-size:13px">${T('活跃进程 Top5','Top 5 by CPU')}</div>
      <div class="proc-grid">
        ${sys.top_cpu.map(t =>
          `<div class="proc-card">
            <div class="proc-name" style="font-size:11px;color:var(--text2)">${esc(t.comm||t.user)} <span class="data-ts">${esc(t.user)}·${t.pid}</span></div>
            <div class="proc-stat">
              <span>CPU <div class="bar-track" style="display:inline-flex;width:50px;height:6px;vertical-align:middle"><div class="bar-fill ${barClass(parseFloat(t.cpu_pct))}" style="width:${Math.min(parseFloat(t.cpu_pct),100)}%"></div></div> <b>${t.cpu_pct}%</b></span>
              <span>MEM <b>${t.mem_pct}%</b></span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.cmd)}</span>
            </div>
          </div>`
        ).join('')}
      </div>`
    : ''}
  </div>
<div style="grid-column:1/-1">
  <div class="card">
    <div class="card-title" style="margin-top:14px">${T('手动触发采集','Manual Trigger')}</div>
      <div class="trigger-grid">${jobs.map(j=>`<button class="btn small secondary" data-job="${j}">${j}</button>`).join('')}</div>
      <div class="form-msg" id="trigMsg"></div>
    </div>
  </div>
  <div style="grid-column:1/-1">
    <div class="card">
      <div class="card-title">🏗️ ${T('系统蓝图 · 生产架构','Blueprint · Production')}</div>
      <div class="blueprint" id="bpRoot"><div class="empty">${T('加载系统蓝图…','Loading blueprint…')}</div></div>
      <div class="data-ts" style="margin-top:10px">WILLIAM QUANT BOARD W1 v5.2.0 · 自 2026-07 持续迭代 · 全球宏观数据接入 2026-08-14 · 全部数据仅供研究</div>
    </div>
  </div>
`;
  // 动态渲染系统蓝图（拉真实组件状态）
  try {
    const bp = await api('/api/blueprint');
    renderBlueprint(bp);
  } catch (e) { const r=$('#bpRoot'); if(r) r.innerHTML = '<div class="empty">'+T('蓝图加载失败','Blueprint load failed')+'</div>'; }
  $('#adLogout').onclick=async()=>{
    await api('/api/admin/logout',{method:'POST',body:'{}'});
    const wasOwner=!!(state.user&&state.user.is_owner);
    if(wasOwner){await api('/api/auth/logout',{method:'POST',body:'{}'});state.user=null;}
    state.admin=false;refreshUserChip();renderNav();
    if(wasOwner)switchTab('overview');else PANELS.admin();
  };
  $$('[data-act]').forEach(b=>b.onclick=async()=>{
    let body='{}';
    if(b.dataset.act==='expiry'){
      const inp=$('#expDays_'+b.dataset.id);
      const days=parseInt((inp?inp.value:''),10);
      if(isNaN(days)){toast(T('请输入天数','Enter days'));return}
      body=JSON.stringify({days});
    }else if(b.dataset.act==='perm'||b.dataset.act==='owner'){
      body=JSON.stringify({on:b.dataset.on==='1'});
    }else if(b.dataset.act==='note'){
      const inp=$('#note_'+b.dataset.id);
      body=JSON.stringify({note: inp?inp.value:''});
    }
    const r=await api(`/api/admin/users/${b.dataset.id}/${b.dataset.act}`,{method:'POST',body});
    if(r.ok){toast(T('操作成功','done'));PANELS.admin()}else toast(r.error||'failed');
  });
  $$('[data-job]').forEach(b=>b.onclick=async()=>{
    $('#trigMsg').className='form-msg';$('#trigMsg').textContent=b.dataset.job+' …';
    const r=await api(`/api/admin/trigger/${b.dataset.job}`,{method:'POST',body:'{}'});
    $('#trigMsg').className='form-msg '+(r.ok&&r.success?'ok':'err');
    $('#trigMsg').textContent=`${b.dataset.job}: ${r.success?'OK':'FAIL'} (${r.ms}ms)`;
  });
};

/* ================= 启动 ================= */
async function boot(){
  renderNav();
  // 时钟
  const tick=()=>{$('#clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})+' CST'};
  tick();setInterval(tick,1000);
  // 指纹
  const v=await api('/api/version');
  if(v.ok)$('#fp').textContent=`${v.name}@${v.version} sha:${v.dashboard_html.sha256_16} ${v.dashboard_html.bytes}B full:${v.dashboard_html.is_full_terminal}`;
  // 会话恢复（会员与后台互不影响）
  const me=await api('/api/auth/me');
  if(me.ok&&me.user&&me.user.status==='approved'){state.user=me.user;
    if(me.user.username==='13665437670'||me.user.is_owner)state.admin=true;
    renderNav();}
  refreshUserChip();
  // 后台会话恢复：只认 w1_admin cookie 是否真实有效，不再用「接口能通就当 admin」的兜底。
  // 杜绝普通会员残留后台 cookie 时被误判为 admin，从而看到实盘控制/回测选项卡。
  const ah=await api('/api/admin/users?status=pending');
  if(ah && ah.__needAdmin){state.admin=false;}
  // 涨跌配色切换（绿涨红跌 ↔ 红涨绿跌）
  (function(){
    var saved=null;try{saved=localStorage.getItem('w1_color_flip')}catch(e){}
    if(saved==='1')document.body.classList.add('cn-flip');
    var btn=$('#colorBtn');
    if(btn)btn.onclick=function(){
      document.body.classList.toggle('cn-flip');
      var on=document.body.classList.contains('cn-flip');
      try{localStorage.setItem('w1_color_flip',on?'1':'0')}catch(e){}
      if(on)btn.title='涨跌配色：红涨绿跌（点击切回）';else btn.title='涨跌配色：绿涨红跌（点击切换）';
      // 重绘当前 tab 使动态渲染的颜色立即生效
      switchTab(state.tab);
    };
  })();
  // 语言切换
  $('#langBtn').onclick=()=>{state.lang=state.lang==='zh'?'en':'zh';$('#langBtn').textContent=state.lang==='zh'?'EN':'中';renderNav();switchTab(state.tab)};
  $('#langBtn').textContent='EN';
  switchTab('overview');
  initTableAutoFix();
}
/* ---- 表格溢出自动化处理：监听渲染，自动给所有 <table> 包横向滚动容器 ---- */
function autoWrapTables(root){
  var tables=root.querySelectorAll('table');
  for(var i=0;i<tables.length;i++){
    var t=tables[i];
    // 已在滚动容器内则跳过；已经包过则跳过
    if(t.__wrapped||t.closest('.table-scroll')||t.parentElement&&t.parentElement.style&&t.parentElement.style.overflowX==='auto')continue;
    var w=document.createElement('div');
    w.className='table-scroll';
    t.parentNode.insertBefore(w,t);
    w.appendChild(t);
    t.__wrapped=true;
  }
}
function initTableAutoFix(){
  var main=document.getElementById('main');
  if(!main||main.__tableObs)return;
  main.__tableObs=true;
  autoWrapTables(main);
  new MutationObserver(function(){autoWrapTables(main)}).observe(main,{childList:true,subtree:true});
}
boot();

/* ---- 数据源健康红绿灯（2026-10-12 阶段2） ---- */
(function () {
  function paint() {
    fetch('/api/health/sources', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok || !d.sources) return;
      var bad = d.sources.filter(function (s) { return s.status !== 'ok'; });
      var total = d.sources.length;
      var color = bad.length === 0 ? '#20d4a0' : (bad.length <= 2 ? '#f5a623' : '#ff5f5f');
      var el = document.getElementById('dataHealth');
      if (!el) {
        var host = document.querySelector('.top-actions');
        if (!host) return;
        el = document.createElement('span');
        el.id = 'dataHealth';
        el.style.cssText = 'font-family:var(--mono);font-size:11px;display:inline-flex;align-items:center;gap:5px;cursor:default';
        host.insertBefore(el, host.firstChild);
      }
      el.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:' + color + ';display:inline-block"></span>数据 ' + (total - bad.length) + '/' + total;
      el.title = bad.length ? ('陈旧/断供: ' + bad.map(function (s) { return s.zh; }).join('、')) : '全部数据源正常';
    }).catch(function () {});
  }
  paint();
  setInterval(paint, 300000);
})();

function rsGrid(items){return '<div class="rs-grid">'+items.join('')+'</div>'}
function rsCard(label,value,sub){return '<div class="rs-card"><div class="rs-label">'+esc(label)+'</div><div class="rs-value">'+esc(value)+'</div><div class="rs-sub">'+esc(sub||'')+'</div></div>'}
function rsTable(head,rows){
  return '<div class="rs-table-wrap"><table class="rs-table"><thead><tr>'+head.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
}
function rsRegimeZh(k){return ({trend_up:'趋势上行',trend_down:'趋势下行',range:'震荡',high_vol:'高波动',unknown:'未知'})[k]||k}
function rsSpark(bars){
  if(!bars||bars.length<2) return '<div style="color:var(--muted)">无K线</div>';
  const vals=bars.map(b=>Number(b.c)), min=Math.min.apply(null,vals), max=Math.max.apply(null,vals);
  const w=680,h=180,pad=8, span=max-min||1;
  const pts=vals.map((v,i)=>((i/(vals.length-1))*(w-pad*2)+pad).toFixed(1)+','+((h-pad)-((v-min)/span)*(h-pad*2)).toFixed(1)).join(' ');
  const up=vals[vals.length-1]>=vals[0];
  return '<svg viewBox="0 0 '+w+' '+h+'" style="width:100%;height:auto;background:rgba(0,0,0,.15);border-radius:8px"><polyline fill="none" stroke="'+(up?'#c0392b':'#2e7d5b')+'" stroke-width="2" points="'+pts+'"/></svg><div style="color:var(--muted);font-size:11px;margin-top:4px">'+bars.length+' 根 5m · 区间 '+min.toFixed(2)+' ~ '+max.toFixed(2)+'</div>';
}
PANELS.research=async function(){
  startTabTimer('research',PANELS.research);
  const main=$('#main');
  const tabs=[['regime','体制实验室'],['positioning','仓位压力'],['news','新闻冲击'],['cross','跨资产轮动'],['replay','逐日回放'],['risk','风险舱']];
  const cur=state.rsTab||'regime';
  main.innerHTML='<div class="card" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><div style="font-size:20px;font-weight:800">🔬 研究 / 交易支持</div><div style="color:var(--muted);font-size:12px;margin-top:4px">体制 · 仓位压力 · 新闻冲击 · 跨资产 · 回放 · 风险</div></div><button class="btn secondary" id="rsRefresh">⟳ 刷新</button></div><div class="rs-nav" id="rsNav">'+tabs.map(t=>'<button class="rs-tab'+(t[0]===cur?' active':'')+'" data-rs="'+t[0]+'">'+t[1]+'</button>').join('')+'</div></div><div id="rsBody"><div style="color:var(--muted);padding:12px">加载中…</div></div>';
  $('#rsRefresh').onclick=function(){PANELS.research()};
  $$('#rsNav [data-rs]').forEach(function(b){b.onclick=function(){state.rsTab=b.dataset.rs;PANELS.research()}});
  const body=$('#rsBody');
  try{
    if(cur==='regime'){
      const d=await api('/api/research/regime');
      if(!d||!d.ok){body.innerHTML='<div class="rs-card">数据不足：'+esc((d&&d.error)||'unknown')+'</div>';return}
      body.innerHTML=rsGrid([
        rsCard('当前体制',rsRegimeZh(d.current&&d.current.regime),'EMA20 '+d.current.ema20+' / EMA60 '+d.current.ema60+' · 波动分位 '+(d.current.vol_pct==null?'—':d.current.vol_pct+'%')),
        rsCard('样本',d.coverage.bars+' 根 1h','覆盖 '+d.coverage.from+' ~ '+d.coverage.to),
        rsCard('策略数',String(d.strategies.length),'持有 24 根 · 扣 0.08% 手续费')
      ])+'<div class="rs-card"><div class="rs-title">体制统计（未来 24h）</div>'+rsTable(['体制','样本','平均收益','胜率','P10','P90'],d.regimes.map(function(r){return [rsRegimeZh(r.regime),r.n,r.avg_fwd_24h_pct+'%',r.win_rate_pct+'%',r.p10_pct+'%',r.p90_pct+'%']}))+'</div>'
        +'<div class="rs-card"><div class="rs-title">策略 × 体制</div>'+d.strategies.map(function(s){return '<div style="margin:10px 0 4px;font-weight:700">'+esc(s.zh)+'（'+s.trades+' 笔）</div>'+rsTable(['体制','样本','胜率','平均收益','盈亏比','最大回撤'],Object.keys(s.by_regime).map(function(k){var v=s.by_regime[k];return [rsRegimeZh(k),v.n,v.win_rate_pct+'%',v.avg_ret_pct+'%',v.profit_factor==null?'—':v.profit_factor,v.max_drawdown_pct+'%']}))}).join('')+'</div>';
      return;
    }
    if(cur==='positioning'){
      const d=await api('/api/research/positioning');
      if(!d||!d.ok){body.innerHTML='<div class="rs-card">数据不足</div>';return}
      const rows=d.rows.map(function(r){
        const col=r.stress>=70?'#b83a2e':r.stress>=45?'#d99e2b':'#4da6ff';
        return [esc(r.symbol),'<div style="min-width:90px"><div style="height:6px;background:rgba(255,255,255,.08);border-radius:3px"><div style="height:6px;width:'+Math.min(100,r.stress)+'%;background:'+col+';border-radius:3px"></div></div><span style="font-size:11px;color:'+col+'">'+r.stress+'</span></div>',r.funding==null?'—':r.funding,r.funding_z,r.oi_change_24h==null?'—':r.oi_change_24h+'%',r.lsr_ratio==null?'—':r.lsr_ratio,r.liq_imbalance_pct+'%',esc(r.trapped)];
      });
      body.innerHTML=rsGrid([
        rsCard('市场平均压力',String(d.market.avg_stress),d.market.high_stress.length?('高压：'+d.market.high_stress.join(' / ')):'无高压币种'),
        rsCard('最高压力',d.market.max?d.market.max.symbol+' '+d.market.max.stress:'—',d.market.max?d.market.max.trapped:''),
        rsCard('验证样本',String(d.validation.samples||0),'费率z vs 未来4h收益 相关 '+(d.validation.corr_funding_z_vs_fwd_4h==null?'—':d.validation.corr_funding_z_vs_fwd_4h))
      ])+'<div class="rs-card"><div class="rs-title">币种仓位压力</div>'+rsTable(['币','压力','费率','费率z','OI24h','LSR','清算偏斜','判断'],rows)+'</div>'
        +'<div class="rs-card"><div class="rs-title">说明</div><div class="rs-sub">'+esc(d.notes)+'</div></div>';
      return;
    }
    if(cur==='news'){
      const d=await api('/api/research/news-impact');
      if(!d||!d.ok){body.innerHTML='<div class="rs-card">数据不足</div>';return}
      body.innerHTML=rsGrid([
        rsCard('评估新闻',String(d.coverage.evaluated),'样本 '+d.coverage.from+' ~ '+d.coverage.to),
        rsCard('新闻总数',String(d.coverage.news),'BTC 5m 基准'),
        rsCard('方向命中率',(d.by_sentiment.find(function(x){return x.sentiment==='bullish'})||{}).hit_rate_pct+'%','仅统计多空情绪')
      ])+'<div class="rs-card"><div class="rs-title">来源影响</div>'+rsTable(['来源','样本','方向命中','1h均值','1h绝对','4h绝对'],d.by_source.map(function(x){return [esc(x.source),x.n,x.hit_rate_pct==null?'—':x.hit_rate_pct+'%',x.avg_ret_1h_pct+'%',x.avg_abs_1h_pct+'%',x.avg_abs_4h_pct+'%']}))+'</div>'
        +'<div class="rs-card"><div class="rs-title">情绪影响</div>'+rsTable(['情绪','样本','方向命中','1h均值','1h绝对'],d.by_sentiment.map(function(x){return [esc(x.sentiment),x.n,x.hit_rate_pct==null?'—':x.hit_rate_pct+'%',x.avg_ret_1h_pct+'%',x.avg_abs_1h_pct+'%']}))+'</div>'
        +'<div class="rs-card"><div class="rs-title">近 7 天高冲击新闻</div>'+rsTable(['时间','来源','标题','1h','4h'],(d.top||[]).map(function(x){return [new Date(x.ts*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}),esc(x.source),'<a href="'+esc(x.url||'#')+'" target="_blank" style="color:inherit">'+esc(x.title)+'</a>',x.ret_1h==null?'—':x.ret_1h+'%',x.ret_4h==null?'—':x.ret_4h+'%']}))+'</div>';
      return;
    }
    if(cur==='cross'){
      const d=await api('/api/research/cross-asset');
      if(!d||!d.ok){body.innerHTML='<div class="rs-card">数据不足</div>';return}
      body.innerHTML=rsGrid([
        rsCard('风险偏好',String(d.risk_on_score),'0 防守 / 100 进攻'),
        rsCard('5日广度',d.breadth_5d_pct+'%','风险资产上涨占比'),
        rsCard('防御资产',d.defensives_5d_avg+'%','黄金/白银/波动率 5日均值')
      ])+'<div class="rs-card"><div class="rs-title">5日领涨</div>'+rsTable(['标的','类别','1日','5日','20日','BTC相关'],d.top_5d.map(function(x){return [esc(x.name),esc(x.cls),x.ret_1d==null?'—':x.ret_1d.toFixed(2)+'%',x.ret_5d==null?'—':x.ret_5d.toFixed(2)+'%',x.ret_20d==null?'—':x.ret_20d.toFixed(2)+'%',x.corr_btc_20d==null?'—':x.corr_btc_20d]}))+'</div>'
        +'<div class="rs-card"><div class="rs-title">5日领跌</div>'+rsTable(['标的','类别','1日','5日','20日','BTC相关'],d.bottom_5d.map(function(x){return [esc(x.name),esc(x.cls),x.ret_1d==null?'—':x.ret_1d.toFixed(2)+'%',x.ret_5d==null?'—':x.ret_5d.toFixed(2)+'%',x.ret_20d==null?'—':x.ret_20d.toFixed(2)+'%',x.corr_btc_20d==null?'—':x.corr_btc_20d]}))+'</div>';
      return;
    }
    if(cur==='replay'){
      const today=new Date(Date.now()-86400000).toISOString().slice(0,10);
      body.innerHTML='<div class="rs-card"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input type="date" id="rsDate" value="'+today+'" style="background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px"><button class="btn" id="rsGo">加载</button><span style="color:var(--muted);font-size:12px">按北京时间日界</span></div><div id="rsChart" style="margin-top:12px"></div><div id="rsEvents"></div></div>';
      const load=async function(){
        const date=$('#rsDate').value;
        const d=await api('/api/research/replay?date='+encodeURIComponent(date)+'&symbol=BTC');
        if(!d||!d.ok){$('#rsEvents').innerHTML='<div class="rs-card">加载失败：'+esc((d&&d.error)||'')+'</div>';return}
        $('#rsChart').innerHTML=rsSpark(d.bars);
        $('#rsEvents').innerHTML='<div class="rs-card"><div class="rs-title">当日信号（'+d.signals.length+'）</div>'+rsTable(['时间','币','方向','入场','止损','止盈1','状态'],d.signals.map(function(s){return [new Date(s.pushed_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),esc(s.symbol),esc(s.direction),s.entry,s.stop,s.target1,esc(s.status)]}))+'</div>'
          +'<div class="rs-card"><div class="rs-title">因子快照（'+d.factors.length+'）</div>'+rsTable(['时间','OI24h','费率','LSR','清算分'],d.factors.filter(function(_,i){return i%6===0}).map(function(f){return [new Date(f.ts*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),f.oi_chg_24h==null?'—':f.oi_chg_24h,f.funding==null?'—':f.funding,f.lsr==null?'—':f.lsr,f.qibao_score==null?'—':f.qibao_score]}))+'</div>'
          +'<div class="rs-card"><div class="rs-title">当日新闻</div>'+rsTable(['时间','来源','标题'],d.news.map(function(n){return [new Date(n.ts*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),esc(n.source),'<a href="'+esc(n.url||'#')+'" target="_blank" style="color:inherit">'+esc(n.title)+'</a>']}))+'</div>';
      };
      $('#rsGo').onclick=load; await load(); return;
    }
    if(cur==='risk'){
      const d=await api('/api/research/risk');
      if(!d||!d.ok){body.innerHTML='<div class="rs-card">数据不足</div>';return}
      const s=d.summary;
      body.innerHTML=rsGrid([
        rsCard('BTC 现价','$'+s.current_equity,'周期峰值 $'+s.peak_equity),
        rsCard('回撤',s.drawdown_pct+'%','峰值回落'),
        rsCard('VaR 95%',s.var95_pct==null?'—':s.var95_pct+'%','CVaR '+(s.cvar95_pct==null?'—':s.cvar95_pct+'%')),
        rsCard('年化波动',s.annual_vol_pct+'%','Sharpe '+(s.sharpe==null?'—':s.sharpe))
      ])+'<div class="rs-card"><div class="rs-title">区间收益</div>'+rsTable(['7 日','30 日','90 日'],[[s.ret_7d_pct==null?'—':s.ret_7d_pct+'%',s.ret_30d_pct==null?'—':s.ret_30d_pct+'%',s.ret_90d_pct==null?'—':s.ret_90d_pct+'%']])+'</div>'
        +'<div class="rs-card"><div class="rs-sub">'+esc(d.notes||'')+'</div></div>';
      return;
    }
  }catch(e){body.innerHTML='<div class="rs-card" style="color:#b83a2e">加载失败：'+esc(e.message)+'</div>'}
};

/* ================= 新版任务型面板（2026-10-21） ================= */
PANELS.today=async function(){
  startTabTimer('today',PANELS.today);
  const main=$('#main');
  main.innerHTML='<div class="today-hero"><div class="today-title">☀️ 今日决策台</div><div class="today-sub">加载中…</div></div>';
  const res=await Promise.all([api('/api/today'),api('/api/today/deep')]);
  const b=res[0],d=res[1];
  if(!b||!b.ok){main.innerHTML='<div class="card">今日简报暂不可用：'+esc((b&&b.error)||'数据不足')+'</div>';return}
  function p(n,s){return n==null?'—':(Number(n)>=0?'+':'')+Number(n).toFixed(s==null?2:s)+'%'}
  const bias=b.bias||{}, col=bias.code==='long'?'#c0392b':bias.code==='short'?'#2e7d5b':'#d9a441';
  const hero='<div class="today-hero"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start"><div><div class="today-title">☀️ 今日决策台</div><div class="today-sub">BTC 盘前/盘中简报 · '+new Date((b.as_of||0)*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})+'</div></div><div style="text-align:right"><span class="today-bias" style="background:'+col+'">'+esc(bias.label_zh||'中性')+'</span><div class="rs-sub" style="margin-top:6px">置信 '+esc(bias.confidence||0)+'% · 评分 '+esc(bias.score||0)+'</div></div></div><div style="margin-top:14px;font-size:16px;font-weight:700;line-height:1.6">'+esc(b.headline||'')+'</div></div>';
  const cards=rsGrid([
    rsCard('BTC 现价','$'+esc(b.price==null?'—':b.price),'24h '+(b.change_24h==null?'—':p(b.change_24h))),
    rsCard('市场体制',b.regime?esc(b.regime.regime):'—','EMA20 '+esc(b.regime?b.regime.ema20:'—')+' / EMA60 '+esc(b.regime?b.regime.ema60:'—')),
    rsCard('恐慌贪婪',b.fgi?esc(b.fgi.value)+' · '+esc(b.fgi.classification):'—','变化 '+(b.fgi&&b.fgi.change!=null?p(b.fgi.change,0):'—')+' · '+(b.fgi?Math.round((b.fgi.age_sec||0)/3600)+'h 前':'—')),
    rsCard('ETF 3 日',b.etf_3d?esc(b.etf_3d.sum)+'M':'-','较前 3 日 '+(b.etf_3d?p(b.etf_3d.sum-b.etf_3d.prev,1):'—'))
  ]);
  const comp=b.components||{};
  const compHtml='<div class="card"><div class="rs-title">评分构成</div>'+rsTable(['趋势','新闻','情绪','ETF 流','仓位'],[[comp.trend==null?'—':comp.trend,comp.news==null?'—':comp.news,comp.sentiment==null?'—':comp.sentiment,comp.flow==null?'—':comp.flow,comp.positioning==null?'—':comp.positioning]])+'</div>';
  const dl=b.delta||{};
  const deltaHtml='<div class="card"><div class="rs-title">相比昨天变了什么</div>'+rsTable(['指标','当前/变化'],[
    ['价格 24h',p(dl.price_24h_pct)],
    ['EMA20 变化',p(dl.ema20_change_pct)],
    ['EMA60 变化',p(dl.ema60_change_pct)],
    ['FGI 变化',p(dl.fgi_change,0)],
    ['ETF 3 日变化',p(dl.etf_3d_change,1)],
    ['新闻多空差变化',p(dl.news_balance_change,0)],
    ['前一日体制',esc(dl.regime_prev||'—')]
  ])+'</div>';
  const checks='<div class="card"><div class="rs-title">交易者清单</div>'+(b.checklist||[]).map(function(x,i){return '<div class="today-row"><span class="today-sev">'+(i+1)+'</span><span>'+esc(x)+'</span></div>'}).join('')+'</div>';
  const levels=b.key_levels||{};
  const levelHtml='<div class="card"><div class="rs-title">关键价位</div>'+rsTable(['支撑','阻力','EMA20','EMA60','下方清算墙','上方清算墙'],[[esc(levels.support),esc(levels.resistance),esc(levels.ema20),esc(levels.ema60),esc(levels.liquidation_long),esc(levels.liquidation_short)]])+'</div>';
  const s=b.sessions||{};
  const sessHtml='<div class="card"><div class="rs-title">亚/欧/美盘高低点</div>'+rsTable(['时段','高点','低点','K线数'],[
    ['亚洲',s.asia?esc(s.asia.high):'—',s.asia?esc(s.asia.low):'—',s.asia?esc(s.asia.bars):'0'],
    ['伦敦',s.london?esc(s.london.high):'—',s.london?esc(s.london.low):'—',s.london?esc(s.london.bars):'0'],
    ['纽约',s.ny?esc(s.ny.high):'—',s.ny?esc(s.ny.low):'—',s.ny?esc(s.ny.bars):'0'],
    ['尾盘',s.late?esc(s.late.high):'—',s.late?esc(s.late.low):'—',s.late?esc(s.late.bars):'0']
  ])+'</div>';
  const watch='<div class="card"><div class="rs-title">自选行动板</div>'+rsTable(['币','价格','24h','支撑','阻力','状态','触发','失效','压力'],(b.symbols||[]).map(function(x){return [esc(x.symbol),x.price==null?'—':x.price,x.change_24h==null?'—':p(x.change_24h),x.support==null?'—':x.support,x.resistance==null?'—':x.resistance,esc(x.state),x.trigger==null?'—':x.trigger,x.invalidation==null?'—':x.invalidation,x.stress==null?'—':x.stress]}))+'</div>';
  const rb=b.risk_budget||{};
  const riskBox='<div class="card"><div class="rs-title">风险预算</div><div id="todayRiskBox">'+rsGrid([
    rsCard('账户',rb.account_size+' U','1% 风险 = '+rb.max_loss+' U'),
    rsCard('止损距离',rb.stop_pct==null?'—':rb.stop_pct+'%','ATR '+(rb.atr==null?'—':rb.atr)),
    rsCard('名义仓位',rb.position_size==null?'—':rb.position_size+' U','按 1% 风险/止损距离'),
    rsCard('BTC-ETH 20d 相关',rb.corr_btc_eth==null?'—':rb.corr_btc_eth,'组合集中度参考')
  ])+'<div class="today-links" style="margin-top:8px"><input id="todayAccount" type="number" value="'+esc(rb.account_size||1000)+'" min="100" style="background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 10px;min-width:140px"><button class="btn secondary" id="todayRiskCalc">按账户重算</button></div></div></div>';
  const scenarios='<div class="card"><div class="rs-title">情景推演</div>'+(b.scenarios||[]).map(function(x){return '<div class="today-scenario '+(x.type==='down'?'down':'up')+'">'+esc(x.text)+'</div>'}).join('')+'</div>';
  const flags='<div class="card"><div class="rs-title">风险提示</div><div class="today-links">'+(b.risk_flags||[]).map(function(x){return '<span class="today-flag">'+esc(x)+'</span>'}).join('')+'</div></div>';
  const evHtml='<div class="card"><div class="rs-title">事件时间轴</div>'+((b.events||[]).length?(b.events||[]).map(function(e){var cd=Number(e.countdown_sec||0);var t=cd<0?'已过':cd<3600?Math.round(cd/60)+'分钟后':cd<86400?(cd/3600).toFixed(1)+'小时后':Math.round(cd/86400)+'天后';return '<div class="today-row"><span class="today-time">'+esc(e.time||'')+'</span><span>'+esc(e.title||'')+'</span><span class="today-impact '+esc(e.impact||'')+'">'+esc(e.impact||'')+'</span><span class="'+(e.blackout?'today-impact high':'rs-sub')+'">'+t+(e.blackout?' · 禁交易窗口':'')+'</span></div>'}).join(''):'<div class="rs-sub">未来 24h 无高影响事件</div>')+'</div>';
  const n=b.news||{};
  const newsHtml='<div class="card"><div class="rs-title">最近消息（6h）</div><div class="today-row"><span>利多 '+esc((n.counts&&n.counts.bullish)||0)+'</span><span>利空 '+esc((n.counts&&n.counts.bearish)||0)+'</span><span>中性 '+esc((n.counts&&n.counts.neutral)||0)+' · 前 6h 多空差 '+(n.prev_total?p((n.counts.bullish-n.counts.bearish)-(n.prev_counts.bullish-n.prev_counts.bearish)):'—')+'</span></div>'+((n.top||[]).slice(0,4).map(function(x){return '<div class="today-row"><span class="today-time">'+esc(x.source||'')+'</span><span>'+esc(x.title||'')+'</span></div>'}).join(''))+'</div>';
  let deepHtml='<div class="card"><div class="rs-title">仓位 / 告警（会员）</div><div class="rs-sub">登录会员后解锁仓位压力、被套方向与活动告警。</div></div>';
  if(d&&d.ok){const rows=(d.positioning&&d.positioning.rows)||[];const alerts=d.alerts||{};deepHtml='<div class="card"><div class="rs-title">仓位压力 / 告警</div>'+rsTable(['币','压力','判断'],rows.slice(0,5).map(function(r){return [esc(r.symbol),r.stress,esc(r.trapped)]}))+'<div class="today-row" style="margin-top:8px"><span>活动告警</span><span>'+esc(alerts.open||0)+' 条</span><span>P0 '+(alerts.by_severity&&alerts.by_severity.P0||0)+' / P1 '+(alerts.by_severity&&alerts.by_severity.P1||0)+'</span></div></div>';}
  const trust='<div class="card"><div class="rs-title">数据可信度</div>'+rsTable(['数据源','年龄','状态'],(b.data_trust||[]).map(function(x){return [esc(x.name),x.age_sec==null?'—':Math.round(x.age_sec/60)+'m',esc(x.status)]}))+'</div>';
  const ask='<div class="card"><div class="rs-title">问今日简报</div><div class="today-links"><input id="todayAsk" placeholder="例如：为什么偏多？关键位在哪？" style="background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px;min-width:240px;flex:1"><button class="btn" id="todayAskBtn">提问</button></div><div id="todayAnswer" class="rs-sub" style="margin-top:10px">会员可问：为什么、关键位、事件、止损/失效、风险。</div></div>';
  const review='<div class="card"><div class="rs-title">盘后复盘</div><div class="today-links"><input id="todayReviewDate" type="date" value="'+new Date(Date.now()-86400000).toISOString().slice(0,10)+'" style="background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 10px"><button class="btn secondary" id="todayReviewBtn">复盘</button></div><div id="todayReviewOut" class="rs-sub" style="margin-top:8px">对比当日快照与实际涨跌。</div></div>';
  main.innerHTML=hero+cards+compHtml+deltaHtml+checks+levelHtml+sessHtml+watch+riskBox+scenarios+flags+evHtml+newsHtml+deepHtml+trust+ask+review+'<div class="card"><div class="rs-sub">'+esc(b.notes||'')+'</div></div>';
  const calc=$('#todayRiskCalc'); if(calc) calc.onclick=async function(){const v=($('#todayAccount').value||'').trim();const r=await api('/api/today?accountSize='+encodeURIComponent(v));if(r&&r.ok&&r.risk_budget){const x=r.risk_budget;$('#todayRiskBox').innerHTML=rsGrid([rsCard('账户',x.account_size+' U','1% 风险 = '+x.max_loss+' U'),rsCard('止损距离',x.stop_pct==null?'—':x.stop_pct+'%','ATR '+(x.atr==null?'—':x.atr)),rsCard('名义仓位',x.position_size==null?'—':x.position_size+' U','按 1% 风险/止损距离'),rsCard('BTC-ETH 20d 相关',x.corr_btc_eth==null?'—':x.corr_btc_eth,'组合集中度参考')]);}};
  const askBtn=$('#todayAskBtn'); if(askBtn) askBtn.onclick=async function(){const q=($('#todayAsk').value||'').trim();if(!q)return;const r=await api('/api/today/ask?q='+encodeURIComponent(q));$('#todayAnswer').textContent=(r&&r.ok)?r.answer:((r&&r.error==='login_required')?'会员专属问答，请先登录。':'暂时无法回答');};
  const rv=$('#todayReviewBtn'); if(rv) rv.onclick=async function(){const date=$('#todayReviewDate').value;const r=await api('/api/today/review?date='+encodeURIComponent(date));const out=$('#todayReviewOut');if(!r||!r.ok){out.textContent='复盘数据不足：'+((r&&r.error)||'');return}out.innerHTML='当日 BTC '+r.day.open+' → '+r.day.close+'（'+r.day.ret_pct+'%），快照 '+esc(r.snapshot.bias)+'，判定 '+(r.hit?'✅ 命中':'❌ 未命中');};
};

PANELS.watchlist=async function(){
  startTabTimer('watchlist',PANELS.watchlist);
  const main=$('#main');
  let list=[]; try{list=JSON.parse(localStorage.getItem('w1_watchlist')||'["BTC","ETH","SOL"]')}catch(e){list=['BTC','ETH','SOL']}
  if(!Array.isArray(list))list=['BTC','ETH','SOL'];
  const d=await api('/api/coins'); const coins=(d&&d.coins)||[];
  const map={}; coins.forEach(function(c){map[c.symbol]=c});
  const u=state.user||{};
  const vip=u.vip||{};
  main.innerHTML='<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><div class="rs-title" style="font-size:20px">👤 我的 / 自选</div><div class="rs-sub">本地保存 · 会员状态 · 快速查看</div></div><button class="btn secondary" id="wlAccount">账户</button></div>'
    +'<div class="today-links" style="margin-top:12px"><input id="wlInput" placeholder="输入币种，如 BTC" style="background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px;min-width:180px"><button class="btn" id="wlAdd">+ 添加</button></div>'
    +'<div id="wlChips" class="today-links" style="margin-top:10px"></div>'
    +'<div id="wlGrid" class="rs-grid" style="margin-top:14px"></div></div>'
    +'<div class="card"><div class="rs-title">会员状态</div><div class="today-row"><span>账户</span><span>'+esc(u.username||'未登录')+'</span><span>'+esc(u.status||'')+'</span></div><div class="today-row"><span>会员</span><span>'+esc(vip.expired?'已到期':(vip.expires_at?('到期 '+new Date(Number(vip.expires_at)*1000).toLocaleDateString('zh-CN')):'—'))+'</span><span></span></div><div class="rs-sub">自选列表仅保存在当前浏览器；会员数据由后端账户体系管理。</div></div>';
  function save(){try{localStorage.setItem('w1_watchlist',JSON.stringify(list))}catch(e){}}
  function render(){
    $('#wlChips').innerHTML=list.map(function(s){return '<span class="wl-chip">'+esc(s)+' <b data-rm="'+esc(s)+'">×</b></span>'}).join('')||'<span class="rs-sub">尚未添加自选</span>';
    $('#wlGrid').innerHTML=list.map(function(s){var c=map[s]; if(!c)return ''; var chg=Number(c.change_24h||0); var col=chg>=0?'#c0392b':'#2e7d5b'; return '<div class="rs-card"><div class="rs-label">'+esc(s)+'</div><div class="rs-value">$'+Number(c.price||0).toLocaleString('en-US',{maximumFractionDigits:2})+'</div><div class="rs-sub" style="color:'+col+'">'+(chg>=0?'+':'')+chg.toFixed(2)+'%</div></div>'}).join('');
    $$('#wlChips [data-rm]').forEach(function(b){b.onclick=function(){list=list.filter(function(x){return x!==b.dataset.rm});save();render()}});
  }
  $('#wlAdd').onclick=function(){var v=($('#wlInput').value||'').trim().toUpperCase(); if(v&&!list.includes(v)){list.push(v);save();render();$('#wlInput').value=''}};
  $('#wlInput').onkeydown=function(e){if(e.key==='Enter')$('#wlAdd').click()};
  $('#wlAccount').onclick=function(){switchTab('account')};
  render();
};
