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

  PANELS.evolution = async function(){
    startTabTimer('evolution', PANELS.evolution);
    var main = $('#main');
    main.innerHTML = '<div class="card"><div class="rs-title" style="font-size:20px">'+T('🧭 观点演化','🧭 View Evolution')+'</div><div class="rs-sub">'+T('每日判断快照 · 观点变化 · 历史轨迹','Daily snapshots · view changes · history')+'</div><div id="evoBody" style="margin-top:12px">加载中…</div></div>';
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
