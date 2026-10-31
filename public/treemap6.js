(function(){
  if (typeof PANELS === 'undefined') return;
  var CACHE_MS = 15 * 60 * 1000;  // 15 分钟缓存
  var _cache = null;
  function squarify(items, x, y, w, h, out) {
    if (!items.length) return;
    if (items.length === 1) { out.push({ x:x, y:y, w:w, h:h, it:items[0] }); return; }
    var total = items.reduce(function(s,i){return s+i.value;},0);
    var acc = 0, split = 1;
    for (var i=0;i<items.length;i++){ acc += items[i].value; if (acc >= total/2) { split = i+1; break; } }
    var a = items.slice(0, split), b = items.slice(split);
    var av = a.reduce(function(s,i){return s+i.value;},0), bv = total - av;
    if (w >= h) {
      var aw = w * (av/total);
      squarify(a, x, y, aw, h, out); squarify(b, x+aw, y, w-aw, h, out);
    } else {
      var ah = h * (av/total);
      squarify(a, x, y, w, ah, out); squarify(b, x, y+ah, w, h-ah, out);
    }
  }
  function fmtCap(v){ v=Number(v)||0; return v>=1e12?(v/1e12).toFixed(2)+'T':v>=1e9?(v/1e9).toFixed(0)+'B':v>=1e6?(v/1e6).toFixed(0)+'M':'—'; }
  function buildSVG(d){
    var coins = d.futures_top.filter(function(c){ return c && Number(c.mcap_usd) > 0; }).sort(function(a,b){ return Number(b.mcap_usd)-Number(a.mcap_usd); }).slice(0, 50);
    var total = coins.reduce(function(s,c){return s+Number(c.mcap_usd);},0);
    var W = 1200, H = 860, items = coins.map(function(c){ return { value:Number(c.mcap_usd)/total*W*H, c:c }; });
    var rects = []; squarify(items, 0, 0, W, H, rects);
    var svg = '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;display:block;border-radius:10px;overflow:hidden;background:var(--bg0)">';
    rects.forEach(function(r){
      var c=r.it.c, chg=Number(c.change_24h)||0;
      var fill = chg >= 0 ? 'var(--up)' : 'var(--down)';
      var op = Math.min(0.85, 0.25 + Math.abs(chg)/8);
      var fs = Math.max(10, Math.min(24, Math.sqrt(r.w*r.h)/8));
      svg += '<g style="cursor:pointer" data-sym="'+esc(c.symbol)+'"><rect x="'+(r.x+1)+'" y="'+(r.y+1)+'" width="'+Math.max(0,r.w-2)+'" height="'+Math.max(0,r.h-2)+'" rx="4" style="fill:'+fill+';fill-opacity:'+op.toFixed(2)+';stroke:var(--bg0);stroke-width:1"><title>'+esc(c.symbol)+' '+chg.toFixed(2)+'% · 市值 '+fmtCap(c.mcap_usd)+'</title></rect>';
      if (r.w > 46 && r.h > 30) {
        svg += '<text x="'+(r.x+6)+'" y="'+(r.y+fs+4)+'" font-size="'+fs+'" font-weight="700" fill="#fff" style="pointer-events:none">'+esc(String(c.symbol).replace(/USDT$/,''))+'</text>';
        svg += '<text x="'+(r.x+6)+'" y="'+(r.y+fs*2+6)+'" font-size="'+Math.max(8,fs*0.62)+'" fill="rgba(255,255,255,.85)" style="pointer-events:none">'+(chg>=0?'+':'')+chg.toFixed(2)+'%</text>';
      }
      if (r.w > 80 && r.h > 60) svg += '<text x="'+(r.x+6)+'" y="'+(r.y+fs*2.9+6)+'" font-size="'+Math.max(8,fs*0.5)+'" fill="rgba(255,255,255,.6)" style="pointer-events:none">'+fmtCap(c.mcap_usd)+'</text>';
      svg += '</g>';
    });
    svg += '</svg>';
    return svg;
  }
  function cardHTML(svg, d){
    return '<div class="card"><div class="card-title">🗺️ 市场地图 · 市值树图</div><div class="rs-sub">面积=市值 · 颜色=24h 涨跌（红涨绿跌，受全站配色切换控制）· 点击进入币种详情</div><div id="mmTree" style="margin-top:12px">'+svg+'<div class="data-ts" style="margin-top:6px">来源 Coinglass 合约市场 · '+(d&&d.data_ts?new Date(d.data_ts*1000).toLocaleString('zh-CN',{hour12:false}):'')+'</div></div></div>';
  }
  function bind(box){
    Array.prototype.forEach.call(box.querySelectorAll('g[data-sym]'), function(g){
      g.onclick = function(){ state.coinSymbol = g.getAttribute('data-sym'); switchTab('coin-detail'); };
    });
  }
  PANELS['market-map'] = async function(){
    startTabTimer('market-map', PANELS['market-map']);
    var main = $('#main');
    if (_cache && _cache.html && (Date.now() - _cache.ts < CACHE_MS)) {
      main.innerHTML = _cache.html;
      bind(main);
      return;
    }
    main.innerHTML = '<div class="card"><div class="card-title">🗺️ 市场地图 · 市值树图</div><div class="rs-sub">面积=市值 · 颜色=24h 涨跌 · 点击进入币种详情</div><div id="mmTree" style="margin-top:12px"><div class="empty">加载中…</div></div></div>';
    try {
      var d = await api('/api/markets');
      if (!d || !d.ok || !d.futures_top || !d.futures_top.length) {
        if (_cache && _cache.html) { main.innerHTML = _cache.html; bind(main); return; }
        var b0 = $('#mmTree'); if (b0) b0.innerHTML = '<div class="empty">数据不可用</div>';
        return;
      }
      var html = cardHTML(buildSVG(d), d);
      _cache = { html: html, ts: Date.now() };
      main.innerHTML = html;
      bind(main);
    } catch(e) {
      if (_cache && _cache.html) { main.innerHTML = _cache.html; bind(main); }
      else { var b1 = $('#mmTree'); if (b1) b1.innerHTML = '<div class="empty">数据不可用</div>'; }
    }
  };
})();

