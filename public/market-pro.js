(function(){
  if (typeof PANELS === 'undefined') return;
  var style = document.createElement('style');
  style.textContent = '.mm-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}.mm-search{background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px;min-width:180px;flex:1}.mm-select{background:var(--bg2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:7px 10px}.mm-chip{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;color:var(--text2);cursor:pointer}.mm-chip.active{background:var(--amber);border-color:transparent;color:#111;font-weight:700}.mm-empty{color:var(--text3);padding:18px;text-align:center}.mm-skeleton{height:74px;border-radius:8px;background:linear-gradient(90deg,rgba(255,255,255,.04),rgba(255,255,255,.08),rgba(255,255,255,.04));background-size:200% 100%;animation:mmShine 1.2s infinite}@keyframes mmShine{0%{background-position:200% 0}100%{background-position:-200% 0}}@media(max-width:640px){.mm-search{min-width:100%}.mm-toolbar{gap:6px}}';
  document.head.appendChild(style);

  PANELS['coin-detail'] = async function(){
    startTabTimer('coin-detail', PANELS['coin-detail']);
    var sym = state.coinSymbol || 'BTC';
    var main = $('#main');
    main.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><div class="rs-title" style="font-size:20px">🔎 ' + esc(sym) + ' '+T('技术分析','Analysis')+'</div><div class="rs-sub">'+T('4h 趋势 / 指标 / 关键位 / 仓位','4h trend / indicators / key levels / positioning')+'</div></div><button class="btn secondary" id="cdBack">← '+T('市场地图','Market Map')+'</button></div><div id="cdBody" style="margin-top:12px"><div class="mm-skeleton" style="height:120px"></div></div></div>';
    $('#cdBack').onclick = function(){ switchTab('market-map'); };
    async function load(){
      $('#cdBody').innerHTML = '<div class="mm-skeleton" style="height:120px"></div>';
      var d = await api('/api/coin/analysis?symbol=' + encodeURIComponent(sym));
      var body = $('#cdBody');
      if (!d || !d.ok) { body.innerHTML = '<div class="mm-empty">加载失败：' + esc((d && d.error) || '') + ' <button class="btn secondary" id="cdRetry">重试</button></div>'; var b=$('#cdRetry'); if(b)b.onclick=load; return; }
      var btc = sym === 'BTC' ? null : await api('/api/coin/analysis?symbol=BTC');
      var rel = btc && btc.ok && btc.change_24h != null && d.change_24h != null ? +(d.change_24h - btc.change_24h).toFixed(2) : null;
      var col = d.tech_score >= 0.35 ? 'var(--up)' : d.tech_score <= -0.35 ? 'var(--down)' : '#d9a441';
      body.innerHTML = '<div class="today-hero"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><div class="today-title">' + esc(d.symbol) + ' · ' + esc(d.trend) + '</div><div class="today-sub">' + esc(d.summary) + '</div></div><div style="text-align:right"><span class="today-bias" style="background:' + col + '">' + esc(d.trend) + '</span><div class="rs-sub" style="margin-top:6px">技术分 ' + esc(d.tech_score) + ' · 置信 ' + esc(d.confidence) + '%</div></div></div></div>'
        + rsGrid([rsCard('现价','$' + esc(d.price),'24h ' + (d.change_24h == null ? '—' : (d.change_24h >= 0 ? '+' : '') + d.change_24h + '%')), rsCard('相对 BTC',rel == null ? '—' : (rel >= 0 ? '+' : '') + rel + '%','24h 相对强弱'), rsCard('RSI 14',esc(d.indicators.rsi14),'ADX ' + esc(d.indicators.adx14)), rsCard('ATR 14',esc(d.indicators.atr14),'MACD ' + esc(d.indicators.macd))])
        + '<div class="card"><div class="rs-title">均线结构</div>' + rsTable(['EMA20','EMA50','EMA200'],[[esc(d.indicators.ema20),esc(d.indicators.ema50),esc(d.indicators.ema200)]]) + '</div>'
        + '<div class="card"><div class="rs-title">关键位 / 清算墙</div>' + rsTable(['20日支撑','20日阻力','60日支撑','60日阻力','下方清算墙','上方清算墙'],[[esc(d.levels.support20),esc(d.levels.resistance20),esc(d.levels.support60),esc(d.levels.resistance60),esc(d.levels.liquidation_long),esc(d.levels.liquidation_short)]]) + '</div>'
        + '<div class="card"><div class="rs-title">仓位与资金</div>' + rsTable(['费率','OI 24h','OI 名义','LSR','24h 多头清算','24h 空头清算','交易所数'],[[esc(d.positioning.funding),d.positioning.oi_change_24h == null ? '—' : esc(d.positioning.oi_change_24h) + '%',d.positioning.oi_usd == null ? '—' : esc(Math.round(d.positioning.oi_usd / 1e6)) + 'M',esc(d.positioning.lsr_ratio),d.positioning.liq_long_24h == null ? '—' : esc(Math.round(d.positioning.liq_long_24h / 1e6)) + 'M',d.positioning.liq_short_24h == null ? '—' : esc(Math.round(d.positioning.liq_short_24h / 1e6)) + 'M',esc(d.positioning.exchanges)]]) + '</div>'
        + '<div class="card"><div class="rs-title">情景推演</div>' + (d.scenarios || []).map(function(x){ return '<div class="today-scenario">' + esc(x) + '</div>'; }).join('') + '</div>'
        + '<div class="card"><div class="rs-sub">' + esc(d.notes || '') + '</div></div>';
    }
    await load();
  };
})();
