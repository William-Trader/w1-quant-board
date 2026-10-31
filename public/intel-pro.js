(function(){
  if (typeof PANELS === 'undefined') return;
  var style = document.createElement('style');
  style.textContent = '.intel-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}.intel-search{background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px;min-width:180px;flex:1}.intel-select{background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px}.intel-chip{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;color:var(--text2);cursor:pointer}.intel-chip.active{background:var(--amber);border-color:transparent;color:#111;font-weight:700}.intel-item{padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)}.intel-meta{color:var(--text3);font-size:11px;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px}.intel-title{font-weight:700;line-height:1.5}.intel-title a{color:inherit;text-decoration:none}.intel-body{color:var(--text3);font-size:12px;line-height:1.6;margin-top:4px}.intel-sent{font-size:10px;border-radius:4px;padding:1px 6px}.intel-empty{color:var(--text3);padding:18px;text-align:center}.intel-skel{height:70px;border-radius:8px;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.08),rgba(255,255,255,.04));background-size:200% 100%;animation:intelShine 1.2s infinite;margin-bottom:8px}@keyframes intelShine{0%{background-position:200% 0}100%{background-position:-200% 0}}@media(max-width:640px){.intel-search{min-width:100%}.intel-toolbar{gap:6px}}';
  document.head.appendChild(style);
  state.intelNews = state.intelNews || { q:'', source:'all', sent:'all', sort:'time', high:false };
  state.intelEvents = state.intelEvents || { q:'', impact:'all' };
  state.intelCross = state.intelCross || { q:'', cls:'all', sort:'5d' };

  PANELS.onchain = async function(){
    startTabTimer('onchain', PANELS.onchain);
    var main = $('#main');
    main.innerHTML = '<div class="card"><div class="rs-title" style="font-size:20px">'+T("⛓️ 情报 · 链上 / 鲸鱼","⛓️ Intel · On-Chain")+'</div><div class="rs-sub">'+T("全市场多空 · 稳定币铸造 · 大额转账 · BTC 链上指标","Market L/S · stablecoin mint · large transfers · BTC on-chain")+'</div><div id="intelOnBody" style="margin-top:12px"><div class="intel-skel"></div></div></div>';
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

})();
