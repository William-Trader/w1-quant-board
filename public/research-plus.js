(function(){
  if (typeof TABS === 'undefined' || typeof GROUPS === 'undefined' || typeof PANELS === 'undefined') return;
  function hasTab(id){ return TABS.some(function(t){return t.id===id}); }
  if (!hasTab('coin-detail')) TABS.push({id:'coin-detail',zh:'币种分析',en:'Coin Analysis',pub:true});
  if (!hasTab('evolution')) TABS.push({id:'evolution',zh:'观点演化',en:'Evolution',pub:false});
  var mg = GROUPS.find(function(g){return g.id==='market'});
  if (mg && mg.subs.indexOf('coin-detail') < 0) mg.subs.splice(mg.subs.indexOf('market-map')+1, 0, 'coin-detail');
  var rg = GROUPS.find(function(g){return g.id==='research'});
  if (rg && rg.subs.indexOf('evolution') < 0) rg.subs.push('evolution');

  var stanceZh = {bullish:'看多',cautiously_bullish:'谨慎看多',neutral:'中性',bearish:'看空',cautiously_bearish:'谨慎看空'};
  var stanceCol = {bullish:'var(--up)',cautiously_bullish:'#d99e2b',neutral:'#8b93a7',bearish:'var(--down)',cautiously_bearish:'#4da6ff'};

  PANELS['market-map'] = async function(){
    startTabTimer('market-map', PANELS['market-map']);
    var main = $('#main');
    main.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><div class="rs-title" style="font-size:20px">🗺️ 市场地图</div><div class="rs-sub">颜色=24h 涨跌 · 徽章=8 币立场 · 点击进入技术分析</div></div><button class="btn secondary" id="mmRefresh">⟳ 刷新</button></div><div id="mmBody" style="margin-top:14px">加载中…</div></div>';
    $('#mmRefresh').onclick = function(){ PANELS['market-map'](); };
    var d = await api('/api/coins'); var coins = (d && d.coins) || [];
    if (!coins.length) { $('#mmBody').innerHTML = '<div class="rs-sub">暂无数据</div>'; return; }
    $('#mmBody').innerHTML = '<div class="mm-grid">' + coins.map(function(c){
      var chg = Number(c.change_24h || 0); var col = chg >= 0 ? 'var(--up)' : 'var(--down)';
      var st = c.stance || 'neutral'; var sc = stanceCol[st] || '#8b93a7';
      return '<div class="mm-cell" data-sym="' + esc(c.symbol) + '"><div style="display:flex;justify-content:space-between;gap:6px;align-items:center"><div class="mm-sym">' + esc(c.symbol) + '</div><span style="font-size:10px;color:' + sc + ';border:1px solid ' + sc + ';border-radius:999px;padding:1px 6px">' + esc(stanceZh[st] || st) + '</span></div><div class="mm-px">$' + Number(c.price || 0).toLocaleString('en-US',{maximumFractionDigits:2}) + '</div><div class="mm-chg" style="color:' + col + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div><div class="rs-sub" style="margin-top:4px">置信 ' + Math.round((c.confidence || 0) * 100) + '%</div></div>';
    }).join('') + '</div>';
    $$('#mmBody .mm-cell').forEach(function(el){ el.onclick = function(){ state.coinSymbol = el.dataset.sym; switchTab('coin-detail'); }; });
  };

  PANELS['coin-detail'] = async function(){
    startTabTimer('coin-detail', PANELS['coin-detail']);
    var sym = state.coinSymbol || 'BTC';
    var main = $('#main');
    main.innerHTML = '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><div class="rs-title" style="font-size:20px">🔎 ' + esc(sym) + ' 技术分析</div><div class="rs-sub">4h 趋势 / 指标 / 关键位 / 仓位</div></div><button class="btn secondary" id="cdBack">← 市场地图</button></div><div id="cdBody" style="margin-top:12px">加载中…</div></div>';
    $('#cdBack').onclick = function(){ switchTab('market-map'); };
    var d = await api('/api/coin/analysis?symbol=' + encodeURIComponent(sym));
    var body = $('#cdBody');
    if (!d || !d.ok) { body.innerHTML = '<div class="rs-sub">数据不足：' + esc((d && d.error) || '') + '</div>'; return; }
    var col = d.tech_score >= 0.35 ? 'var(--up)' : d.tech_score <= -0.35 ? 'var(--down)' : '#d9a441';
    body.innerHTML = '<div class="today-hero"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><div class="today-title">' + esc(d.symbol) + ' · ' + esc(d.trend) + '</div><div class="today-sub">' + esc(d.summary) + '</div></div><div style="text-align:right"><span class="today-bias" style="background:' + col + '">' + esc(d.trend) + '</span><div class="rs-sub" style="margin-top:6px">技术分 ' + esc(d.tech_score) + ' · 置信 ' + esc(d.confidence) + '%</div></div></div></div>'
      + rsGrid([rsCard('现价','$' + esc(d.price),'24h ' + (d.change_24h == null ? '—' : (d.change_24h >= 0 ? '+' : '') + d.change_24h + '%')), rsCard('RSI 14',esc(d.indicators.rsi14),'ADX ' + esc(d.indicators.adx14)), rsCard('ATR 14',esc(d.indicators.atr14),'波动率参考'), rsCard('MACD',esc(d.indicators.macd),'EMA12-EMA26')])
      + '<div class="card"><div class="rs-title">均线结构</div>' + rsTable(['EMA20','EMA50','EMA200'],[[esc(d.indicators.ema20),esc(d.indicators.ema50),esc(d.indicators.ema200)]]) + '</div>'
      + '<div class="card"><div class="rs-title">关键位 / 清算墙</div>' + rsTable(['20日支撑','20日阻力','60日支撑','60日阻力','下方清算墙','上方清算墙'],[[esc(d.levels.support20),esc(d.levels.resistance20),esc(d.levels.support60),esc(d.levels.resistance60),esc(d.levels.liquidation_long),esc(d.levels.liquidation_short)]]) + '</div>'
      + '<div class="card"><div class="rs-title">仓位与资金</div>' + rsTable(['费率','OI 24h','OI 名义','LSR','24h 多头清算','24h 空头清算','交易所数'],[[esc(d.positioning.funding),d.positioning.oi_change_24h == null ? '—' : esc(d.positioning.oi_change_24h) + '%',d.positioning.oi_usd == null ? '—' : esc(Math.round(d.positioning.oi_usd / 1e6)) + 'M',esc(d.positioning.lsr_ratio),d.positioning.liq_long_24h == null ? '—' : esc(Math.round(d.positioning.liq_long_24h / 1e6)) + 'M',d.positioning.liq_short_24h == null ? '—' : esc(Math.round(d.positioning.liq_short_24h / 1e6)) + 'M',esc(d.positioning.exchanges)]]) + '</div>'
      + '<div class="card"><div class="rs-title">情景推演</div>' + (d.scenarios || []).map(function(x){ return '<div class="today-scenario">' + esc(x) + '</div>'; }).join('') + '</div>'
      + '<div class="card"><div class="rs-sub">' + esc(d.notes || '') + '</div></div>';
  };

  PANELS.evolution = async function(){
    startTabTimer('evolution', PANELS.evolution);
    var main = $('#main');
    main.innerHTML = '<div class="card"><div class="rs-title" style="font-size:20px">🧭 观点演化</div><div class="rs-sub">每日判断快照 · 观点变化 · 历史轨迹</div><div id="evoBody" style="margin-top:12px">加载中…</div></div>';
    var d = await api('/api/evolution');
    var body = $('#evoBody');
    if (!d || !d.ok) { body.innerHTML = '<div class="rs-sub">数据不足</div>'; return; }
    var cur = d.current || {}, prev = d.previous || {};
    var rows = (d.rows || []).slice().reverse();
    var vals = rows.map(function(x){ return x.score == null ? 0 : x.score; });
    var min = Math.min.apply(null, vals.concat([0])), max = Math.max.apply(null, vals.concat([0])); var span = max - min || 1;
    var pts = vals.map(function(v,i){ return (i / Math.max(1, vals.length - 1) * 680).toFixed(1) + ',' + (120 - ((v - min) / span) * 100).toFixed(1); }).join(' ');
    var svg = '<svg viewBox="0 0 680 140" style="width:100%;height:auto;background:rgba(0,0,0,.12);border-radius:8px"><line x1="0" y1="' + (120 - ((0 - min) / span) * 100) + '" x2="680" y2="' + (120 - ((0 - min) / span) * 100) + '" stroke="#3c424d" stroke-dasharray="3 4"/><polyline fill="none" stroke="#d9a441" stroke-width="2" points="' + pts + '"/></svg>';
    body.innerHTML = rsGrid([rsCard('当前观点',cur.verdict_zh || cur.verdict || '—','评分 ' + esc(cur.score) + ' · 持续 ' + esc(cur.days_held == null ? '—' : cur.days_held) + ' 天'), rsCard('较上次',d.score_change == null ? '—' : (d.score_change >= 0 ? '+' : '') + d.score_change,'前值 ' + esc(prev.score == null ? '—' : prev.score)), rsCard('历史快照',String((d.rows || []).length),'最近 120 个交易日')])
      + '<div class="card"><div class="rs-title">评分轨迹</div>' + svg + '</div>'
      + '<div class="card"><div class="rs-title">观点切换</div>' + rsTable(['日期','从','到','评分变化','结论'],(d.changes || []).map(function(x){ return [esc(x.date),esc(x.from),esc(x.to),esc(x.score_from) + ' → ' + esc(x.score_to),esc(x.headline)]; })) + '</div>'
      + '<div class="card"><div class="rs-title">每日快照</div>' + rsTable(['日期','评分','观点','多/空/中性','持续','来源'],(d.rows || []).slice(0,40).map(function(x){ return [esc(x.date),esc(x.score),esc(x.verdict_zh || x.verdict),esc(x.bull) + '/' + esc(x.bear) + '/' + esc(x.neutral),esc(x.days_held),esc(x.ai_source || '—')]; })) + '</div>'
      + '<div class="card"><div class="rs-sub">' + esc(d.notes || '') + '</div></div>';
  };

  var origToday = PANELS.today;
  PANELS.today = async function(){
    await origToday();
    var box = $('#todayAI');
    if (!box) {
      var main = $('#main');
      main.insertAdjacentHTML('beforeend', '<div class="card" id="todayAI"><div class="rs-title">AI 解读</div><div class="rs-sub">加载中…</div></div>');
      box = $('#todayAI');
    }
    if (!box) return;
    var deep = await api('/api/today/deep');
    if (!deep || !deep.ok) { box.innerHTML = '<div class="rs-title">AI 解读</div><div class="rs-sub">会员解锁 AI 解读。</div>'; return; }
    var r = await api('/api/today/ai');
    if (r && r.ok) box.innerHTML = '<div class="rs-title">AI 解读</div><div class="rs-sub" style="white-space:pre-wrap;line-height:1.8">' + esc(r.text) + '</div>';
    else box.innerHTML = '<div class="rs-title">AI 解读</div><div class="rs-sub">暂时不可用：' + esc((r && r.error) || '') + '</div>';
  };

  if (typeof renderNav === 'function') renderNav();
})();
