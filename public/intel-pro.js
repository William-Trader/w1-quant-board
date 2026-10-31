(function(){
  if (typeof PANELS === 'undefined') return;
  var style = document.createElement('style');
  style.textContent = '.intel-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}.intel-search{background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px;min-width:180px;flex:1}.intel-select{background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px}.intel-chip{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;color:var(--text2);cursor:pointer}.intel-chip.active{background:var(--amber);border-color:transparent;color:#111;font-weight:700}.intel-item{padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)}.intel-meta{color:var(--text3);font-size:11px;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}.intel-title{font-weight:700;line-height:1.5}.intel-title a{color:inherit;text-decoration:none}.intel-body{color:var(--text3);font-size:12px;line-height:1.6;margin-top:4px}.intel-sent{font-size:10px;border-radius:4px;padding:1px 6px}.intel-empty{color:var(--text3);padding:18px;text-align:center}.intel-skel{height:70px;border-radius:8px;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.08),rgba(255,255,255,.04));background-size:200% 100%;animation:intelShine 1.2s infinite;margin-bottom:8px}@keyframes intelShine{0%{background-position:200% 0}100%{background-position:-200% 0}}@media(max-width:640px){.intel-search{min-width:100%}.intel-toolbar{gap:6px}}';
  document.head.appendChild(style);
  state.intelNews = state.intelNews || { q:'', source:'all', sent:'all', sort:'time', high:false };
  state.intelEvents = state.intelEvents || { q:'', impact:'all' };
  state.intelCross = state.intelCross || { q:'', cls:'all', sort:'5d' };

  PANELS.news = async function(){
    startTabTimer('news', PANELS.news);
    var main = $('#main');
    main.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><div class="rs-title" style="font-size:20px">📰 情报 · 消息面</div><div class="rs-sub">来源筛选 · 情绪筛选 · 影响力排序</div></div><button class="btn secondary" id="intelNewsRefresh">⟳ 刷新</button></div><div class="intel-toolbar"><input id="intelNewsQ" class="intel-search" placeholder="搜索标题/内容"><select id="intelNewsSrc" class="intel-select"><option value="all">全部来源</option></select><span class="intel-chip" data-sent="all">全部</span><span class="intel-chip" data-sent="bullish">利多</span><span class="intel-chip" data-sent="bearish">利空</span><span class="intel-chip" data-sent="neutral">中性</span><span class="intel-chip" data-high="1">仅高影响</span><select id="intelNewsSort" class="intel-select"><option value="time">按时间</option><option value="impact">按影响力</option></select><span id="intelNewsCount" class="rs-sub"></span></div><div id="intelNewsBody"></div></div>';
    $('#intelNewsQ').value = state.intelNews.q || '';
    $('#intelNewsSort').value = state.intelNews.sort || 'time';
    var data = null;
    function chips(){ $$('.intel-chip').forEach(function(x){ if(x.dataset.sent) x.classList.toggle('active', x.dataset.sent === state.intelNews.sent); if(x.dataset.high) x.classList.toggle('active', state.intelNews.high); }); }
    chips();
    async function load(){
      $('#intelNewsBody').innerHTML = '<div class="intel-skel"></div><div class="intel-skel"></div><div class="intel-skel"></div>';
      var d = await api('/api/news');
      if (!d || !d.ok) { $('#intelNewsBody').innerHTML = '<div class="intel-empty">加载失败 <button class="btn secondary" id="intelNewsRetry">重试</button></div>'; var b=$('#intelNewsRetry'); if(b)b.onclick=load; return; }
      data = d;
      var sel = $('#intelNewsSrc');
      sel.innerHTML = '<option value="all">全部来源</option>' + (d.sources || []).map(function(s){ return '<option value="' + esc(s.source) + '">' + esc(s.source) + ' (' + s.count + ')</option>'; }).join('');
      sel.value = state.intelNews.source || 'all';
      render();
    }
    function render(){
      if (!data) return;
      var q = (state.intelNews.q || '').toLowerCase();
      var arr = (data.items || []).filter(function(n){
        if (state.intelNews.source !== 'all' && n.source !== state.intelNews.source) return false;
        if (state.intelNews.sent !== 'all' && (n.sentiment || 'neutral') !== state.intelNews.sent) return false;
        if (state.intelNews.high && Number(n.influence || 0) < 4) return false;
        if (q && ((n.title || '') + ' ' + (n.content || '')).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      if (state.intelNews.sort === 'impact') arr.sort(function(a,b){ return (b.influence||0)-(a.influence||0) || (b.ts||0)-(a.ts||0); });
      else arr.sort(function(a,b){ return (b.ts||0)-(a.ts||0); });
      $('#intelNewsCount').textContent = arr.length + ' / ' + (data.items || []).length + ' 条 · age ' + (data.age_sec == null ? '—' : data.age_sec + 's') + (data.stale ? ' · STALE' : '');
      if (!arr.length) { $('#intelNewsBody').innerHTML = '<div class="intel-empty">没有符合条件的新闻</div>'; return; }
      $('#intelNewsBody').innerHTML = arr.map(function(n){
        var s = n.sentiment || 'neutral'; var col = s === 'bullish' ? 'var(--up)' : s === 'bearish' ? 'var(--down)' : '#8b93a7';
        var sl = s === 'bullish' ? '利多' : s === 'bearish' ? '利空' : '中性';
        return '<div class="intel-item"><div class="intel-meta"><span>' + new Date(Number(n.ts || 0) * 1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) + '</span><span>' + esc(n.source || '') + '</span><span class="intel-sent" style="color:' + col + ';border:1px solid ' + col + '">' + sl + '</span><span>影响力 ' + esc(n.influence || 1) + '/5</span></div><div class="intel-title"><a href="' + esc(n.url || '#') + '" target="_blank">' + esc(n.title || '') + '</a></div>' + (n.content ? '<div class="intel-body">' + esc(String(n.content).slice(0, 180)) + '</div>' : '') + '</div>';
      }).join('');
    }
    $('#intelNewsQ').oninput = function(){ state.intelNews.q = this.value; render(); };
    $('#intelNewsSrc').onchange = function(){ state.intelNews.source = this.value; render(); };
    $('#intelNewsSort').onchange = function(){ state.intelNews.sort = this.value; render(); };
    $$('.intel-chip').forEach(function(x){ x.onclick = function(){ if(x.dataset.sent){ state.intelNews.sent = x.dataset.sent; } if(x.dataset.high){ state.intelNews.high = !state.intelNews.high; } chips(); render(); }; });
    $('#intelNewsRefresh').onclick = load;
    await load();
  };

  PANELS.events = async function(){
    startTabTimer('events', PANELS.events);
    var main = $('#main');
    main.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><div class="rs-title" style="font-size:20px">📅 情报 · 事件日历</div><div class="rs-sub">按日期分组 · 影响力筛选 · 禁交易窗口</div></div><button class="btn secondary" id="intelEvRefresh">⟳ 刷新</button></div><div class="intel-toolbar"><input id="intelEvQ" class="intel-search" placeholder="搜索事件"><span class="intel-chip" data-impact="all">全部</span><span class="intel-chip" data-impact="high">高影响</span><span class="intel-chip" data-impact="medium">中影响</span><span class="intel-chip" data-impact="low">低影响</span><span id="intelEvCount" class="rs-sub"></span></div><div id="intelEvBody"></div></div>';
    $('#intelEvQ').value = state.intelEvents.q || '';
    var data = null;
    function chips(){ $$('.intel-chip').forEach(function(x){ if(x.dataset.impact) x.classList.toggle('active', x.dataset.impact === state.intelEvents.impact); }); }
    chips();
    async function load(){
      $('#intelEvBody').innerHTML = '<div class="intel-skel"></div><div class="intel-skel"></div>';
      var d = await api('/api/eco-calendar');
      if (!d || !d.ok) { $('#intelEvBody').innerHTML = '<div class="intel-empty">加载失败 <button class="btn secondary" id="intelEvRetry">重试</button></div>'; var b=$('#intelEvRetry'); if(b)b.onclick=load; return; }
      data = d;
      render();
    }
    function render(){
      if (!data) return;
      var q = (state.intelEvents.q || '').toLowerCase();
      var arr = (data.future || []).filter(function(e){
        if (state.intelEvents.impact !== 'all' && e.impact !== state.intelEvents.impact) return false;
        if (q && ((e.title_zh || e.title || '') + ' ' + (e.country || '')).toLowerCase().indexOf(q) < 0) return false;
        return true;
      }).sort(function(a,b){ var order={high:0,medium:1,low:2}; return (order[a.impact]||3)-(order[b.impact]||3) || String(a.date+a.time).localeCompare(String(b.date+b.time)); });
      $('#intelEvCount').textContent = arr.length + ' 条';
      if (!arr.length) { $('#intelEvBody').innerHTML = '<div class="intel-empty">没有符合条件的事件</div>'; return; }
      var groups = {};
      arr.forEach(function(e){ var k=e.date||'未知'; (groups[k]=groups[k]||[]).push(e); });
      var html = Object.keys(groups).sort().map(function(k){
        return '<div class="rs-title" style="margin-top:14px">' + esc(k) + '</div>' + groups[k].map(function(e){
          var ts = new Date((e.date || '') + 'T' + (e.time || '00:00') + ':00+08:00').getTime();
          var cd = isFinite(ts) ? Math.round((ts - Date.now()) / 60000) : null;
          var cdTxt = cd == null ? '' : cd < 0 ? '已过' : cd < 60 ? cd + ' 分钟后' : (cd / 60).toFixed(1) + ' 小时后';
          var col = e.impact === 'high' ? 'var(--up)' : e.impact === 'medium' ? '#d99e2b' : '#8b93a7';
          return '<div class="intel-item"><div class="intel-meta"><span>' + esc(e.time || '') + '</span><span>' + esc(e.country || '') + '</span><span style="color:' + col + '">' + esc(e.impact || '') + '</span><span>' + cdTxt + '</span></div><div class="intel-title">' + esc(e.title_zh || e.title || '') + '</div></div>';
        }).join('');
      }).join('');
      $('#intelEvBody').innerHTML = html;
    }
    $('#intelEvQ').oninput = function(){ state.intelEvents.q = this.value; render(); };
    $$('.intel-chip').forEach(function(x){ if(x.dataset.impact) x.onclick = function(){ state.intelEvents.impact = x.dataset.impact; chips(); render(); }; });
    $('#intelEvRefresh').onclick = load;
    await load();
  };

  PANELS.onchain = async function(){
    startTabTimer('onchain', PANELS.onchain);
    var main = $('#main');
    main.innerHTML = '<div class="card"><div class="rs-title" style="font-size:20px">⛓️ 情报 · 链上 / 鲸鱼</div><div class="rs-sub">全市场多空 · 稳定币铸造 · 大额转账 · BTC 链上指标</div><div id="intelOnBody" style="margin-top:12px"><div class="intel-skel"></div></div></div>';
    var res = await Promise.all([api('/api/btc-onchain'), api('/api/onchain')]);
    var d = res[0], w = res[1] || {}; var body = $('#intelOnBody');
    if (!d || !d.ok) { body.innerHTML = '<div class="intel-empty">链上数据不可用</div>'; return; }
    var x = d.data || {}; var whales = w.whales || [];
    var ml = w.market_ls || {}, sc = w.stablecoin || {}, ef = w.exchange_flow || {}, lt = w.large_transfers || {};
    var longPct = ml.oi_weighted_long_pct;
    var shareCls = longPct == null ? 'mid' : longPct >= 60 ? 'up' : longPct <= 40 ? 'down' : 'mid';
    var biasZh = longPct == null ? '—' : longPct >= 65 ? '多头拥挤' : longPct >= 55 ? '偏多' : longPct > 45 ? '均衡' : longPct > 35 ? '偏空' : '空头拥挤';
    var dist = (ml.distribution || []).map(function(b){ return '<div class="ls-dist-row"><span class="k">'+esc(b.label)+'</span><div class="track"><i style="width:'+Math.min(100,b.pct)+'%"></i></div><span class="v">'+b.pct+'%</span></div>'; }).join('');
    function extremes(arr, clsId){ return (arr||[]).slice(0,5).map(function(v){ return '<tr><td>'+esc(v.symbol)+'</td><td class="num" style="color:'+(clsId==='up'?'var(--up)':'var(--down)')+'">'+v.share+'%</td><td class="num">'+fmtUsd(v.oi_usd)+'</td></tr>'; }).join(''); }
    var stableTop = (sc.top||[]).slice(0,6).map(function(a){ var pct=Math.max(0,Math.min(100,a.usd/(sc.total_usd||1)*100)); return '<div class="ls-dist-row"><span class="k">'+esc(a.symbol)+'</span><div class="track"><i style="width:'+pct+'%"></i></div><span class="v">'+fmtUsd(a.usd)+'</span></div>'; }).join('');
    var flowEnt = (ef.by_entity||[]).slice(0,6).map(function(e){ return '<tr><td>'+esc(e.entity)+'</td><td class="num" style="color:var(--down)">'+fmtUsd(e.inflow)+'</td><td class="num" style="color:var(--up)">'+fmtUsd(e.outflow)+'</td><td class="num">'+(e.outflow-e.inflow>=0?'+':'-')+fmtUsd(Math.abs(e.outflow-e.inflow))+'</td></tr>'; }).join('');
    var topTx = (lt.top||[]).map(function(t){ var f=(t.from&&(t.from.entity||((t.from.addr||'').slice(0,8)+'…')))||'—'; var to=(t.to&&(t.to.entity||((t.to.addr||'').slice(0,8)+'…')))||'—'; return '<div class="mini-row"><span>'+fmtUsd(t.usd)+'</span><span>'+esc(f)+' → '+esc(to)+'</span></div>'; }).join('');
    body.innerHTML = rsGrid([
      rsCard('BTC 价格','$' + Number(x.price || 0).toLocaleString('en-US',{maximumFractionDigits:2}),'链上快照'),
      rsCard('市值','$' + (Number(x.market_cap_usd || 0) / 1e12).toFixed(2) + 'T','24h 交易 ' + Number(x.transactions_24h || 0).toLocaleString()),
      rsCard('活跃地址',Number(x.active_addresses_estimated || 0).toLocaleString(),'估算值'),
      rsCard('算力',esc(x.hashrate_exa || '—') + ' EH/s','难度 ' + Number(x.difficulty || 0).toExponential(2))
    ])
    + '<div class="grid2" style="margin-top:12px">'
      + '<div class="card"><div class="card-title">🌐 全市场多空<span class="data-ts" style="margin-left:auto">OI 加权 · '+(ml.coins||0)+' 币</span></div>'
        + '<div class="big-metric"><div class="big-v '+shareCls+'">'+(longPct!=null?longPct.toFixed(1)+'%':'—')+'</div><div class="big-l">多头 OI 占比 · '+biasZh+'</div></div>'
        + '<div class="split-bar"><i class="up" style="width:'+(longPct||0)+'%"></i><i class="down" style="width:'+(100-(longPct||0))+'%"></i></div>'
        + '<div class="kv-strip" style="margin-top:8px"><span>主动买量占比 <b class="'+((ml.volume_long_pct||0)>=50?'up':'down')+'">'+(ml.volume_long_pct!=null?ml.volume_long_pct.toFixed(1)+'%':'—')+'</b></span><span>总持仓 <b>'+fmtUsd(ml.total_oi_usd)+'</b></span></div>'
        + '<div class="ls-dist" style="margin-top:10px">'+dist+'</div>'
        + '<div class="mini-tables"><div><div class="mini-t">多头最拥挤</div><table class="mini-table"><tbody>'+extremes(ml.top_long,'up')+'</tbody></table></div><div><div class="mini-t">空头最拥挤</div><table class="mini-table"><tbody>'+extremes(ml.top_short,'down')+'</tbody></table></div></div></div>'
      + '<div class="card"><div class="card-title">💵 稳定币供应与铸造</div>'
        + '<div class="big-metric"><div class="big-v amber">'+fmtUsd(sc.total_usd)+'</div><div class="big-l">美元稳定币总供应</div></div>'
        + '<div class="kv-strip" style="margin-top:8px;flex-wrap:wrap;gap:10px"><span>24h 新增 <b class="'+((sc.mint_24h_usd||0)>=0?'up':'down')+'">'+((sc.mint_24h_usd||0)>=0?'+':'-')+fmtUsd(Math.abs(sc.mint_24h_usd||0))+'</b></span><span>7d 变化 <b class="'+((sc.mint_7d_usd||0)>=0?'up':'down')+'">'+((sc.mint_7d_usd||0)>=0?'+':'-')+fmtUsd(Math.abs(sc.mint_7d_usd||0))+'</b></span></div>'
        + '<div class="ls-dist" style="margin-top:10px">'+stableTop+'</div>'
        + '<div class="data-ts" style="margin-top:6px">来源 DefiLlama · 24h 新增=当前供应-前一日供应</div></div>'
      + '</div>'
    + '<div class="card" style="margin-top:12px"><div class="card-title">🏦 大额钱包转账 · BTC<span class="data-ts" style="margin-left:auto">mempool 实时 · ≥0.5 BTC</span></div>'
      + '<div class="big-metric"><div class="big-v amber">'+fmtUsd(lt.total_usd||0)+'</div><div class="big-l">大额转账总额 · '+(lt.count||0)+' 笔</div></div>'
      + '<div class="kv-strip" style="margin-top:8px;flex-wrap:wrap;gap:10px"><span>最大单笔 <b>'+fmtUsd(lt.largest_usd||0)+'</b></span><span>命中机构标签 <b>'+(lt.labeled_count||0)+'</b></span>'+(ef.sample?'<span>交易所净流 <b class="'+((ef.net_usd||0)>=0?'up':'down')+'">'+((ef.net_usd||0)>=0?'+':'-')+fmtUsd(Math.abs(ef.net_usd||0))+'</b></span>':'')+'</div>'
      + (ef.sample ? ('<div style="overflow-x:auto;margin-top:8px"><table><thead><tr><th>机构</th><th>流入</th><th>流出</th><th>净额</th></tr></thead><tbody>'+flowEnt+'</tbody></table></div>')
        : '<div class="data-ts" style="margin-top:8px">当前内存池大额转账未命中交易所标签；净流仅在命中标签时统计，不估算。</div>')
      + (topTx?'<div class="mini-t" style="margin-top:10px">最大 8 笔</div><div class="mini-list">'+topTx+'</div>':'')
      + '<div class="data-ts" style="margin-top:6px">来源 mempool.space · 每 10 分钟入库积累净流窗口</div></div>'
    + '<div class="card" style="margin-top:12px"><div class="rs-title">鲸鱼多空（按 whale_ratio 排序）</div>' + rsTable(['标的','鲸鱼比','散户比','4h 鲸鱼变化','多头量','空头量'], whales.slice(0,15).map(function(v){ return [esc(v.symbol || v.exchange),esc(v.whale_ratio),esc(v.trader_ratio),esc(v.whale_delta_4h),v.long_qty==null?'—':esc(v.long_qty),v.short_qty==null?'—':esc(v.short_qty)]; })) + '</div>';
  };

  PANELS['cross-asset'] = async function(){
    startTabTimer('cross-asset', PANELS['cross-asset']);
    var main = $('#main');
    main.innerHTML = '<div class="card"><div class="rs-title" style="font-size:20px">🌐 情报 · 跨资产轮动</div><div class="rs-sub">风险偏好 · 类别筛选 · 相对强弱</div><div id="intelCrossBody" style="margin-top:12px"><div class="intel-skel"></div></div></div>';
    var d = await api('/api/research/cross-asset'); var body = $('#intelCrossBody');
    if (!d || !d.ok) { body.innerHTML = '<div class="intel-empty">' + (d && d.__needLogin ? '会员专属：请先登录' : '数据不足') + '</div>'; return; }
    var rows = d.rows || []; var clsSet = {}; rows.forEach(function(x){ clsSet[x.cls || 'other'] = 1; });
    body.innerHTML = '<div class="intel-toolbar"><input id="intelCrossQ" class="intel-search" placeholder="搜索标的"><select id="intelCrossCls" class="intel-select"><option value="all">全部类别</option>' + Object.keys(clsSet).map(function(c){ return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('') + '</select><select id="intelCrossSort" class="intel-select"><option value="5d">按 5 日</option><option value="1d">按 1 日</option><option value="20d">按 20 日</option></select><span id="intelCrossCount" class="rs-sub"></span></div>'
      + rsGrid([rsCard('风险偏好',String(d.risk_on_score),'0 防守 / 100 进攻'), rsCard('5 日广度',d.breadth_5d_pct + '%','风险资产上涨占比'), rsCard('防御资产',d.defensives_5d_avg + '%','黄金/白银/波动率')])
      + '<div class="card"><div class="rs-title">跨资产明细</div><div id="intelCrossTable"></div></div>';
    function render(){
      var q = ($('#intelCrossQ').value || '').toLowerCase(); var cls = $('#intelCrossCls').value; var sort = $('#intelCrossSort').value;
      var arr = rows.filter(function(x){ return (cls === 'all' || (x.cls || 'other') === cls) && (!q || (x.name || '').toLowerCase().indexOf(q) >= 0 || (x.symbol || '').toLowerCase().indexOf(q) >= 0); });
      var key = sort === '1d' ? 'ret_1d' : sort === '20d' ? 'ret_20d' : 'ret_5d';
      arr.sort(function(a,b){ return (b[key] || -999) - (a[key] || -999); });
      $('#intelCrossCount').textContent = arr.length + ' / ' + rows.length;
      $('#intelCrossTable').innerHTML = rsTable(['标的','类别','1 日','5 日','20 日','BTC 相关'], arr.map(function(x){ return [esc(x.name),esc(x.cls),x.ret_1d==null?'—':x.ret_1d.toFixed(2)+'%',x.ret_5d==null?'—':x.ret_5d.toFixed(2)+'%',x.ret_20d==null?'—':x.ret_20d.toFixed(2)+'%',x.corr_btc_20d==null?'—':x.corr_btc_20d]; }));
    }
    $('#intelCrossQ').oninput = render; $('#intelCrossCls').onchange = render; $('#intelCrossSort').onchange = render; render();
  };
})();
