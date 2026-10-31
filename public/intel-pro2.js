(function(){
  if (typeof PANELS === 'undefined') return;
  var style = document.createElement('style');
  style.textContent = '.intel-hero{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;background:linear-gradient(135deg,rgba(59,158,255,.10),rgba(217,164,65,.05));border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px}.intel-hero-title{font-family:var(--serif);font-size:22px;font-weight:800}.intel-hero-sub{color:var(--text3);font-size:12px;margin-top:5px;line-height:1.6}.intel-stats{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}.intel-stat{background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:88px}.intel-stat b{display:block;font-size:18px;font-family:var(--mono)}.intel-stat span{font-size:10px;color:var(--text3)}.intel-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}.intel-card{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;min-width:0}.intel-card:hover{border-color:rgba(217,164,65,.45)}.intel-card .title{font-weight:700;line-height:1.45;font-size:13px}.intel-card .title a{color:inherit;text-decoration:none}.intel-card .excerpt{color:var(--text3);font-size:11.5px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.intel-card .meta{display:flex;gap:7px;flex-wrap:wrap;color:var(--text3);font-size:10.5px}.intel-topic{font-size:10px;border:1px solid var(--line);border-radius:999px;padding:1px 7px;color:var(--text2)}.intel-topic.active{background:var(--amber);border-color:transparent;color:#111;font-weight:700}.intel-top-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-bottom:12px}.intel-top-card{border:1px solid rgba(217,164,65,.35);background:linear-gradient(135deg,rgba(217,164,65,.10),rgba(255,255,255,.02));border-radius:10px;padding:12px 14px}.intel-top-card .k{font-size:10px;color:var(--amber);font-weight:800;letter-spacing:.08em}.intel-top-card .t{font-weight:800;line-height:1.5;margin-top:5px;font-size:13px}.intel-top-card .d{color:var(--text3);font-size:11.5px;line-height:1.55;margin-top:5px}.intel-sentbar{height:8px;border-radius:4px;display:flex;overflow:hidden;background:var(--bg2);margin-top:8px}.intel-sentbar i{display:block;height:100%}.intel-load{text-align:center;margin:12px 0}.intel-pill{font-size:10px;border-radius:999px;padding:1px 7px}.intel-cat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px}.intel-cat{border:1px solid var(--line);border-radius:8px;padding:10px;background:rgba(255,255,255,.02)}.intel-cat b{font-size:16px;font-family:var(--mono)}.intel-cat span{font-size:10px;color:var(--text3);display:block;margin-top:2px}@media(max-width:700px){.intel-hero{padding:12px}.intel-hero-title{font-size:19px}.intel-card-grid{grid-template-columns:1fr}.intel-top-grid{grid-template-columns:1fr}}';
  document.head.appendChild(style);
  state.intelNews = state.intelNews || { q:'', source:'all', sent:'all', sort:'time', high:false, topic:'all', limit:24 };
  state.intelNews.limit = state.intelNews.limit || 24;
  state.intelNews.topic = state.intelNews.topic || 'all';

  function topicOf(n){
    var t = ((n.title || '') + ' ' + (n.content || '')).toLowerCase();
    if (/etf|blackrock|grayscale|贝莱德|灰度/.test(t)) return 'ETF';
    if (/美联储|fed|cpi|通胀|利率|降息|加息|非农|gdp|宏观/.test(t)) return '宏观';
    if (/sec |监管|合规|法案|诉讼|罚款|禁令|政策/.test(t)) return '监管';
    if (/黑客|被盗|攻击|漏洞|exploit|hack|安全/.test(t)) return '安全';
    if (/币安|coinbase|okx|交易所|上线|listing/.test(t)) return '交易所';
    if (/链上|whale|鲸鱼|地址|转账|onchain/.test(t)) return '链上';
    return '其他';
  }
  function sentMeta(s){
    if (s === 'bullish') return { zh:'利多', col:'#c0392b' };
    if (s === 'bearish') return { zh:'利空', col:'#2e7d5b' };
    return { zh:'中性', col:'#8b93a7' };
  }
  function stars(n){ var k=Math.max(1,Math.min(5,Number(n)||1)); return '●'.repeat(k)+'○'.repeat(5-k); }

  PANELS.news = async function(){
    startTabTimer('news', PANELS.news);
    var main = $('#main');
    main.innerHTML = '<div class="intel-hero"><div><div class="intel-hero-title">📰 情报 · 消息面</div><div class="intel-hero-sub">先看摘要与高影响，再看卡片流；权重按类别去重，不按关键词次数叠加。</div></div><div id="intelSummary" class="intel-stats"></div></div><div id="newsBiasPro"></div><div class="intel-toolbar"><input id="intelNewsQ" class="intel-search" placeholder="搜索标题/内容"><select id="intelNewsSrc" class="intel-select"><option value="all">全部来源</option></select><span class="intel-chip" data-sent="all">全部</span><span class="intel-chip" data-sent="bullish">利多</span><span class="intel-chip" data-sent="bearish">利空</span><span class="intel-chip" data-sent="neutral">中性</span><span class="intel-chip" data-high="1">仅高影响</span><select id="intelNewsSort" class="intel-select"><option value="time">按时间</option><option value="impact">按影响力</option></select><span id="intelNewsCount" class="rs-sub"></span></div><div id="intelTopics" class="intel-toolbar" style="margin-top:0"></div><div id="intelTop"></div><div id="intelNewsBody"></div>';
    $('#intelNewsQ').value = state.intelNews.q || '';
    $('#intelNewsSort').value = state.intelNews.sort || 'time';
    var data = null;
    function chips(){
      $$('.intel-chip').forEach(function(x){
        if (x.dataset.sent) x.classList.toggle('active', x.dataset.sent === state.intelNews.sent);
        if (x.dataset.high) x.classList.toggle('active', state.intelNews.high);
      });
    }
    chips();
    async function load(){
      $('#intelNewsBody').innerHTML = '<div class="intel-skel"></div><div class="intel-skel"></div>';
      var d = await api('/api/news');
      if (!d || !d.ok) { $('#intelNewsBody').innerHTML = '<div class="intel-empty">加载失败 <button class="btn secondary" id="intelNewsRetry">重试</button></div>'; var b=$('#intelNewsRetry'); if(b)b.onclick=load; return; }
      data = d;
      renderBiasPro(d.bias_24h);
      var sel = $('#intelNewsSrc');
      sel.innerHTML = '<option value="all">全部来源</option>' + (d.sources || []).map(function(s){ return '<option value="' + esc(s.source) + '">' + esc(s.source) + ' (' + s.count + ')</option>'; }).join('');
      sel.value = state.intelNews.source || 'all';
      render();
    }
    function renderTopics(){
      var all = (data && data.items) || [];
      var counts = {}; all.forEach(function(n){ var t=topicOf(n); counts[t]=(counts[t]||0)+1; });
      var keys = ['all'].concat(Object.keys(counts).sort(function(a,b){return counts[b]-counts[a]}));
      $('#intelTopics').innerHTML = keys.map(function(k){ var active=state.intelNews.topic===k; return '<span class="intel-topic'+(active?' active':'')+'" data-topic="'+esc(k)+'">'+(k==='all'?'全部':esc(k))+' '+(k==='all'?all.length:(counts[k]||0))+'</span>'; }).join('');
      $$('#intelTopics [data-topic]').forEach(function(x){ x.onclick=function(){ state.intelNews.topic=x.dataset.topic; renderTopics(); render(); }; });
    }
    function renderBiasPro(b){
      var el=$('#newsBiasPro'); if(!el) return;
      if(!b||!b.scored){ el.innerHTML=''; return; }
      var share=Number(b.bull_share)||0;
      var cls=share>=58?'up':share<=42?'down':'mid';
      var cats=(b.categories||[]).slice(0,5).map(function(c){
        var s=c.share==null?null:Number(c.share); var cl=s==null?'':s>=58?'up':s<=42?'down':'mid';
        return '<span class="nb-cat '+(cl||'')+'" title="多 '+c.bull.toFixed(2)+' / 空 '+c.bear.toFixed(2)+'">'+esc(c.label)+' '+(s==null?'—':s.toFixed(0)+'%')+'</span>';
      }).join('');
      var tops=(b.top_points||[]).slice(0,4).map(function(p){ return '<span class="nb-point '+(p.side==='bull'?'up':'down')+'" title="'+esc(p.title||'')+'">'+(p.side==='bull'?'多':'空')+' · '+esc(p.text||p.category)+'</span>'; }).join('');
      el.innerHTML='<div class="news-bias"><div class="nb-head"><span class="nb-title">消息面多空权重点 · 24h</span><span class="nb-count">'+b.scored+'/'+b.count+' 条已评分 · 同类去重</span></div>'
        +'<div class="nb-bar"><i class="up" style="width:'+share+'%"></i><i class="down" style="width:'+(100-share)+'%"></i><b style="left:'+share+'%"></b></div>'
        +'<div class="nb-meta"><span class="'+cls+'">多头 '+share.toFixed(1)+'% · 空头 '+(100-share).toFixed(1)+'%</span><span>多权重 '+b.bull_weight+' / 空权重 '+b.bear_weight+'</span></div>'
        +(cats?'<div class="nb-cats">'+cats+'</div>':'')
        +(tops?'<div class="nb-points">'+tops+'</div>':'')+'</div>';
    }
    function renderSummary(items){
      var counts={bullish:0,bearish:0,neutral:0}; items.forEach(function(n){ counts[n.sentiment||'neutral']++; });
      var total=items.length||1;
      var topBull=items.find(function(n){return n.sentiment==='bullish'}); var topBear=items.find(function(n){return n.sentiment==='bearish'});
      $('#intelSummary').innerHTML = '<div class="intel-stat"><b style="color:#c0392b">'+counts.bullish+'</b><span>利多</span></div><div class="intel-stat"><b style="color:#2e7d5b">'+counts.bearish+'</b><span>利空</span></div><div class="intel-stat"><b>'+counts.neutral+'</b><span>中性</span></div><div class="intel-stat"><b>'+((data&&data.age_sec!=null)?data.age_sec+'s':'—')+'</b><span>'+(data&&data.stale?'STALE':'新鲜度')+'</span></div><div style="min-width:180px;flex:1"><div class="rs-sub">多空占比</div><div class="intel-sentbar"><i style="width:'+(counts.bullish/total*100)+'%;background:#c0392b"></i><i style="width:'+(counts.neutral/total*100)+'%;background:#8b93a7"></i><i style="width:'+(counts.bearish/total*100)+'%;background:#2e7d5b"></i></div></div>';
      $('#intelTop').innerHTML = '<div class="intel-top-grid">'
        + '<div class="intel-top-card"><div class="k">最重要 · 利多</div><div class="t">'+(topBull?esc(topBull.title):'暂无明确利多')+'</div><div class="d">'+(topBull?esc((topBull.content||'').slice(0,120)):'')+'</div></div>'
        + '<div class="intel-top-card"><div class="k">最重要 · 利空</div><div class="t">'+(topBear?esc(topBear.title):'暂无明确利空')+'</div><div class="d">'+(topBear?esc((topBear.content||'').slice(0,120)):'')+'</div></div>'
        + '<div class="intel-top-card"><div class="k">情报要点</div><div class="t">'+counts.bullish+' 利多 / '+counts.bearish+' 利空</div><div class="d">来源 '+((data&&data.sources)||[]).length+' 个 · 高影响 '+items.filter(function(n){return Number(n.influence||0)>=4}).length+' 条</div></div>'
        + '</div>';
    }
    function render(){
      if (!data) return;
      var q = (state.intelNews.q || '').toLowerCase();
      var arr = (data.items || []).filter(function(n){
        if (state.intelNews.source !== 'all' && n.source !== state.intelNews.source) return false;
        if (state.intelNews.sent !== 'all' && (n.sentiment || 'neutral') !== state.intelNews.sent) return false;
        if (state.intelNews.high && Number(n.influence || 0) < 4) return false;
        if (state.intelNews.topic !== 'all' && topicOf(n) !== state.intelNews.topic) return false;
        if (q && ((n.title || '') + ' ' + (n.content || '')).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      if (state.intelNews.sort === 'impact') arr.sort(function(a,b){ return (b.influence||0)-(a.influence||0) || (b.ts||0)-(a.ts||0); });
      else arr.sort(function(a,b){ return (b.ts||0)-(a.ts||0); });
      renderSummary(arr);
      $('#intelNewsCount').textContent = arr.length + ' / ' + (data.items || []).length + ' 条';
      if (!arr.length) { $('#intelNewsBody').innerHTML = '<div class="intel-empty">没有符合条件的新闻</div>'; return; }
      var shown = arr.slice(0, state.intelNews.limit || 24);
      $('#intelNewsBody').innerHTML = '<div class="intel-card-grid">' + shown.map(function(n){
        var sm = sentMeta(n.sentiment); var topic = topicOf(n);
        return '<div class="intel-card"><div class="meta"><span>'+new Date(Number(n.ts||0)*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})+'</span><span>'+esc(n.source||'')+'</span><span class="intel-pill" style="color:'+sm.col+';border:1px solid '+sm.col+'">'+sm.zh+'</span><span class="intel-topic">'+esc(topic)+'</span></div><div class="title"><a href="'+esc(n.url||'#')+'" target="_blank">'+esc(n.title||'')+'</a></div><div class="excerpt">'+esc((n.content||'').slice(0,180))+'</div><div class="meta"><span>影响力 '+esc(n.influence||1)+'/5</span><span>'+stars(n.influence)+'</span>'+(n.bull_share!=null?'<span class="news-share '+(n.bull_share>=58?'up':n.bull_share<=42?'down':'')+'">多 '+Number(n.bull_share).toFixed(0)+'% · 空 '+(100-Number(n.bull_share)).toFixed(0)+'%</span>':'')+'</div></div>';
      }).join('') + '</div>' + (arr.length > shown.length ? '<div class="intel-load"><button class="btn secondary" id="intelMore">加载更多（'+(arr.length-shown.length)+'）</button></div>' : '');
      var more=$('#intelMore'); if(more) more.onclick=function(){ state.intelNews.limit=(state.intelNews.limit||24)+24; render(); };
    }
    $('#intelNewsQ').oninput = function(){ state.intelNews.q = this.value; render(); };
    $('#intelNewsSrc').onchange = function(){ state.intelNews.source = this.value; render(); };
    $('#intelNewsSort').onchange = function(){ state.intelNews.sort = this.value; render(); };
    $$('.intel-chip').forEach(function(x){ x.onclick=function(){ if(x.dataset.sent){state.intelNews.sent=x.dataset.sent;} if(x.dataset.high){state.intelNews.high=!state.intelNews.high;} chips(); render(); }; });
    await load();
  };

  PANELS.events = async function(){
    startTabTimer('events', PANELS.events);
    var main = $('#main');
    main.innerHTML = '<div class="intel-hero"><div><div class="intel-hero-title">📅 情报 · 事件日历</div><div class="intel-hero-sub">高影响事件优先，按日期成组，事件前 1h 禁交易窗口。</div></div><div id="eventStats" class="intel-stats"></div></div><div class="intel-toolbar"><input id="intelEvQ" class="intel-search" placeholder="搜索事件/国家"><span class="intel-chip" data-impact="all">全部</span><span class="intel-chip" data-impact="high">高影响</span><span class="intel-chip" data-impact="medium">中影响</span><span class="intel-chip" data-impact="low">低影响</span><span id="intelEvCount" class="rs-sub"></span></div><div id="intelEvBody"></div>';
    $('#intelEvQ').value = state.intelEvents.q || '';
    var data = null;
    function chips(){ $$('.intel-chip').forEach(function(x){ if(x.dataset.impact)x.classList.toggle('active',x.dataset.impact===state.intelEvents.impact); }); }
    chips();
    async function load(){
      $('#intelEvBody').innerHTML = '<div class="intel-skel"></div><div class="intel-skel"></div>';
      var d=await api('/api/eco-calendar');
      if(!d||!d.ok){$('#intelEvBody').innerHTML='<div class="intel-empty">加载失败 <button class="btn secondary" id="intelEvRetry">重试</button></div>';var b=$('#intelEvRetry');if(b)b.onclick=load;return;}
      data=d; render();
    }
    function render(){
      if(!data)return;
      var q=(state.intelEvents.q||'').toLowerCase();
      var arr=(data.future||[]).filter(function(e){ if(state.intelEvents.impact!=='all'&&e.impact!==state.intelEvents.impact)return false; if(q&&((e.title_zh||e.title||'')+' '+(e.country||'')).toLowerCase().indexOf(q)<0)return false; return true; });
      arr.sort(function(a,b){var order={high:0,medium:1,low:2};return (order[a.impact]||3)-(order[b.impact]||3)||String(a.date+a.time).localeCompare(String(b.date+b.time));});
      var high=arr.filter(function(e){return e.impact==='high'}).length;
      var now=Date.now(); var next=arr.map(function(e){var t=new Date((e.date||'')+'T'+(e.time||'00:00')+':00+08:00').getTime();return {e:e,t:t}}).filter(function(x){return x.t>now}).sort(function(a,b){return a.t-b.t})[0];
      $('#eventStats').innerHTML='<div class="intel-stat"><b>' + arr.length + '</b><span>事件</span></div><div class="intel-stat"><b style="color:#c0392b">' + high + '</b><span>高影响</span></div><div class="intel-stat"><b>' + (next?esc(next.e.time||'—'):'—') + '</b><span>下一个</span></div>';
      $('#intelEvCount').textContent=arr.length+' 条';
      if(!arr.length){$('#intelEvBody').innerHTML='<div class="intel-empty">没有符合条件的事件</div>';return;}
      var groups={}; arr.forEach(function(e){var k=e.date||'未知';(groups[k]=groups[k]||[]).push(e);});
      $('#intelEvBody').innerHTML=Object.keys(groups).sort().map(function(k){
        return '<div class="rs-title" style="margin-top:14px">'+esc(k)+'</div><div class="intel-card-grid">'+groups[k].map(function(e){
          var t=new Date((e.date||'')+'T'+(e.time||'00:00')+':00+08:00').getTime(); var cd=isFinite(t)?Math.round((t-Date.now())/60000):null;
          var cdTxt=cd==null?'':cd<0?'已过':cd<60?cd+' 分钟后':(cd/60).toFixed(1)+' 小时后';
          var col=e.impact==='high'?'#c0392b':e.impact==='medium'?'#d99e2b':'#8b93a7';
          return '<div class="intel-card"><div class="meta"><span>'+esc(e.time||'')+'</span><span>'+esc(e.country||'')+'</span><span class="intel-pill" style="color:'+col+';border:1px solid '+col+'">'+esc(e.impact||'')+'</span><span>' + cdTxt + '</span></div><div class="title">'+esc(e.title_zh||e.title||'')+'</div></div>';
        }).join('')+'</div>';
      }).join('');
    }
    $('#intelEvQ').oninput=function(){state.intelEvents.q=this.value;render();};
    $$('.intel-chip').forEach(function(x){if(x.dataset.impact)x.onclick=function(){state.intelEvents.impact=x.dataset.impact;chips();render();};});
    await load();
  };

  PANELS['cross-asset'] = async function(){
    startTabTimer('cross-asset', PANELS['cross-asset']);
    var main=$('#main');
    main.innerHTML='<div class="intel-hero"><div><div class="intel-hero-title">🌐 情报 · 跨资产</div><div class="intel-hero-sub">风险偏好、类别强弱与 BTC 相关性。</div></div><div id="crossStats" class="intel-stats"></div></div><div class="intel-toolbar"><input id="crossQ" class="intel-search" placeholder="搜索标的"><select id="crossCls" class="intel-select"><option value="all">全部类别</option></select><select id="crossSort" class="intel-select"><option value="5d">按 5 日</option><option value="1d">按 1 日</option><option value="20d">按 20 日</option></select><span id="crossCount" class="rs-sub"></span></div><div id="crossTop"></div><div id="crossBody"></div>';
    var d=await api('/api/research/cross-asset');
    if(!d||!d.ok){$('#crossBody').innerHTML='<div class="intel-empty">'+(d&&d.__needLogin?'会员专属：请先登录':'数据不足')+'</div>';return;}
    var rows=d.rows||[]; var cls={}; rows.forEach(function(x){cls[x.cls||'other']=1;});
    $('#crossCls').innerHTML='<option value="all">全部类别</option>'+Object.keys(cls).map(function(c){return '<option value="'+esc(c)+'">'+esc(c)+'</option>';}).join('');
    $('#crossStats').innerHTML='<div class="intel-stat"><b style="color:var(--amber)">'+d.risk_on_score+'</b><span>风险偏好</span></div><div class="intel-stat"><b>'+d.breadth_5d_pct+'%</b><span>5日广度</span></div><div class="intel-stat"><b>'+d.defensives_5d_avg+'%</b><span>防御资产</span></div>';
    function render(){
      var q=($('#crossQ').value||'').toLowerCase(); var c=$('#crossCls').value; var sort=$('#crossSort').value;
      var arr=rows.filter(function(x){return (c==='all'||(x.cls||'other')===c)&&(!q||(x.name||'').toLowerCase().indexOf(q)>=0||(x.symbol||'').toLowerCase().indexOf(q)>=0);});
      var key=sort==='1d'?'ret_1d':sort==='20d'?'ret_20d':'ret_5d';
      arr.sort(function(a,b){return (b[key]||-999)-(a[key]||-999);});
      $('#crossCount').textContent=arr.length+' / '+rows.length;
      var top=arr.slice(0,3), bot=arr.slice(-3).reverse();
      function mini(x){var v=x.ret_5d;var col=v==null?'#8b93a7':v>=0?'#c0392b':'#2e7d5b';return '<div class="intel-card"><div class="meta"><span>'+esc(x.name||x.symbol)+'</span><span>'+esc(x.cls||'')+'</span></div><div class="title" style="color:'+col+'">'+(v==null?'—':(v>=0?'+':'')+v.toFixed(2)+'%')+'</div><div class="meta"><span>1日 '+(x.ret_1d==null?'—':x.ret_1d.toFixed(2)+'%')+'</span><span>20日 '+(x.ret_20d==null?'—':x.ret_20d.toFixed(2)+'%')+'</span></div></div>';}
      $('#crossTop').innerHTML='<div class="intel-top-grid"><div><div class="rs-title">5 日领涨</div><div class="intel-card-grid">'+top.map(mini).join('')+'</div></div><div><div class="rs-title">5 日领跌</div><div class="intel-card-grid">'+bot.map(mini).join('')+'</div></div></div>';
      $('#crossBody').innerHTML=rsTable(['标的','类别','1 日','5 日','20 日','BTC 相关'],arr.map(function(x){return [esc(x.name),esc(x.cls),x.ret_1d==null?'—':x.ret_1d.toFixed(2)+'%',x.ret_5d==null?'—':x.ret_5d.toFixed(2)+'%',x.ret_20d==null?'—':x.ret_20d.toFixed(2)+'%',x.corr_btc_20d==null?'—':x.corr_btc_20d];}));
    }
    $('#crossQ').oninput=render; $('#crossCls').onchange=render; $('#crossSort').onchange=render; render();
  };
})();
