(function(){
  if (typeof PANELS === 'undefined') return;
  var css = document.createElement('style');
  css.textContent = '.mon-hero{display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between;background:linear-gradient(135deg,rgba(77,166,255,.12),rgba(217,164,65,.06));border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px}.mon-hero-title{font-family:var(--serif);font-size:22px;font-weight:800}.mon-hero-sub{color:var(--text3);font-size:12px;margin-top:5px}.mon-stats{display:flex;gap:8px;flex-wrap:wrap}.mon-stat{background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:80px}.mon-stat b{display:block;font-size:17px;font-family:var(--mono)}.mon-stat span{font-size:10px;color:var(--text3)}.mon-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.mon-card{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.mon-card:hover{border-color:rgba(77,166,255,.4)}.mon-card-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.mon-card-title{font-weight:800;font-size:14px}.mon-alert{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer}.mon-alert:last-child{border-bottom:none}.mon-alert:hover{background:rgba(255,255,255,.02)}.mon-alert-l{border-left:4px solid #888;padding-left:10px;flex:1;min-width:0}.mon-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:999;padding:20px}.mon-modal.open{display:flex}.mon-dialog{background:var(--bg1);border:1px solid var(--line);border-radius:14px;max-width:560px;width:100%;max-height:80vh;overflow-y:auto;padding:20px}.mon-dialog-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}.mon-dialog-title{font-weight:800;font-size:16px;line-height:1.4}.mon-close{background:none;border:none;color:var(--text3);font-size:22px;cursor:pointer;line-height:1}.mon-actions{display:flex;gap:8px;margin-top:16px}@media(max-width:640px){.mon-grid{grid-template-columns:1fr}}';
  document.head.appendChild(css);

  var sevColor = { P0:'#b83a2e', P1:'#d99e2b', P2:'#4da6ff' };
  function sevLabel(s){ return s==='P0'?T('严重','Critical'):s==='P1'?T('重要','High'):s==='P2'?T('一般','Info'):(s||''); }

  function alertRow(x){
    var col = sevColor[x.severity] || '#888';
    var ack = x.state === 'ack' ? '<span style="color:var(--up)">'+T('已确认','Acked')+'</span>' : '';
    return '<div class="mon-alert" data-id="'+esc(x.id)+'"><div class="mon-alert-l" style="border-left-color:'+col+'"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span style="color:'+col+';font-weight:800;font-size:11px">'+esc(x.severity)+'</span><span style="font-weight:700">'+esc(x.title)+'</span></div><div style="color:var(--text3);font-size:11px;margin-top:4px">'+esc(x.rule||'')+' · '+Math.round((x.age_sec||0)/60)+'m · ×'+(x.count||1)+' '+ack+'</div></div><div style="color:var(--text3)">›</div></div>';
  }

  function openModal(x){
    var m = document.getElementById('monModal');
    if (!m) return;
    var col = sevColor[x.severity] || '#888';
    var detail = x.detail ? '<div style="white-space:pre-wrap;color:var(--text2);font-size:12.5px;line-height:1.6;margin-top:10px;background:rgba(255,255,255,.03);border-radius:8px;padding:10px 12px">'+esc(x.detail)+'</div>' : '';
    m.querySelector('.mon-dialog-title').innerHTML = '<span style="color:'+col+'">'+esc(x.severity)+'</span> · '+esc(x.title);
    m.querySelector('.mon-dialog-meta').innerHTML = '<div style="color:var(--text3);font-size:11px;margin-top:6px">'+esc(x.rule||'')+' · '+Math.round((x.age_sec||0)/60)+'m · ×'+(x.count||1)+' · '+sevLabel(x.severity)+'</div>';
    m.querySelector('.mon-dialog-body').innerHTML = detail || '<div style="color:var(--text3);font-size:12px">'+T('无详细信息','No detail')+'</div>';
    m.querySelector('[data-ack]').dataset.id = x.id;
    m.querySelector('[data-silence]').dataset.id = x.id;
    m.classList.add('open');
  }

  PANELS.monitor = async function(){
    startTabTimer('monitor', PANELS.monitor);
    var main = $('#main');
    main.innerHTML = '<div class="mon-hero"><div><div class="mon-hero-title">🛰️ '+T('监测中心','Monitor Center')+'</div><div class="mon-hero-sub">'+T('统一告警 · SLO · 跨源一致性 · 评分卡','Alerts · SLO · Cross-source consistency · Scorecard')+'</div></div><button class="btn secondary" id="monRefresh">⟳ '+T('刷新','Refresh')+'</button></div><div id="monStats" class="mon-stats" style="margin-bottom:14px"></div><div class="mon-grid"><div class="mon-card"><div class="mon-card-h"><span class="mon-card-title">🚨 '+T('活动告警','Active Alerts')+'</span><span class="rs-sub" id="monAlertsCount"></span></div><div id="monAlerts">'+T('加载中…','Loading...')+'</div></div><div class="mon-card"><div class="mon-card-h"><span class="mon-card-title">📊 '+T('数据源 SLO（24h）','Source SLO (24h)')+'</span></div><div id="monSlo">'+T('加载中…','Loading...')+'</div></div><div class="mon-card"><div class="mon-card-h"><span class="mon-card-title">🎯 '+T('告警评分卡（30d）','Alert Scorecard (30d)')+'</span></div><div id="monScore">'+T('加载中…','Loading...')+'</div></div></div>'
      + '<div class="mon-modal" id="monModal"><div class="mon-dialog"><div class="mon-dialog-top"><div class="mon-dialog-title"></div><button class="mon-close" id="monClose">×</button></div><div class="mon-dialog-meta"></div><div class="mon-dialog-body"></div><div class="mon-actions"><button class="btn secondary" data-ack>'+T('确认告警','Acknowledge')+'</button><button class="btn secondary" data-silence>'+T('静默 1 小时','Silence 1h')+'</button></div></div></div>';
    $('#monRefresh').onclick = function(){ PANELS.monitor(); };
    $('#monClose').onclick = function(){ $('#monModal').classList.remove('open'); };
    $('#monModal').onclick = function(e){ if (e.target === this) this.classList.remove('open'); };
    $('#monModal [data-ack]').onclick = async function(){ await api('/api/alerts/'+this.dataset.id+'/ack',{method:'POST',body:'{}'}); $('#monModal').classList.remove('open'); PANELS.monitor(); };
    $('#monModal [data-silence]').onclick = async function(){ await api('/api/alerts/'+this.dataset.id+'/silence',{method:'POST',body:JSON.stringify({minutes:60})}); $('#monModal').classList.remove('open'); PANELS.monitor(); };

    var res = await Promise.all([api('/api/alerts?state=active&limit=100'), api('/api/slo?hours=24'), api('/api/alerts/scorecard?days=30')]);
    var a = res[0], s = res[1], c = res[2];
    if (a && a.__needLogin) { main.innerHTML = '<div class="lock-card"><div class="lock-title">'+T('请先登录','Sign in required')+'</div></div>'; return; }
    var st = (a && a.stats) || {};
    var sev = st.by_severity || {};
    $('#monStats').innerHTML = '<div class="mon-stat"><b style="color:var(--up)">'+(st.open||0)+'</b><span>'+T('活动','Active')+'</span></div>'
      + '<div class="mon-stat"><b style="color:#b83a2e">'+(sev.P0||0)+'</b><span>P0</span></div>'
      + '<div class="mon-stat"><b style="color:#d99e2b">'+(sev.P1||0)+'</b><span>P1</span></div>'
      + '<div class="mon-stat"><b style="color:#4da6ff">'+(sev.P2||0)+'</b><span>P2</span></div>'
      + '<div class="mon-stat"><b>'+(st.last_24h||0)+'</b><span>24h</span></div>'
      + '<div class="mon-stat"><b>'+(st.ack && st.ack.mtta_sec != null ? Math.round(st.ack.mtta_sec/60)+'m' : '—')+'</b><span>MTTA</span></div>'
      + '<div class="mon-stat"><b>'+(st.resolved && st.resolved.mttr_sec != null ? Math.round(st.resolved.mttr_sec/60)+'m' : '—')+'</b><span>MTTR</span></div>';

    var rows = (a && a.alerts) || [];
    $('#monAlertsCount').textContent = rows.length + ' '+T('条','items');
    if (!rows.length) { $('#monAlerts').innerHTML = '<div style="color:var(--text3)">'+T('当前无活动告警','No active alerts')+'</div>'; }
    else {
      $('#monAlerts').innerHTML = rows.map(alertRow).join('');
      $$('#monAlerts .mon-alert').forEach(function(el){ el.onclick = function(){ var x = rows.find(function(r){ return String(r.id) === String(el.dataset.id); }); if (x) openModal(x); }; });
    }

    var sl = (s && s.sources) || [];
    if (!sl.length) { $('#monSlo').innerHTML = '<div style="color:var(--text3)">'+T('暂无数据','No data')+'</div>'; }
    else {
      $('#monSlo').innerHTML = '<table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr style="color:var(--text3);text-align:left"><th>'+T('源','Source')+'</th><th>'+T('成功','Success')+'</th><th>'+T('目标','Target')+'</th><th>'+T('燃烧率','Burn')+'</th><th>p95</th></tr></thead><tbody>'
        + sl.map(function(x){ return '<tr style="border-top:1px solid rgba(255,255,255,.06)"><td>'+esc(x.source)+'</td><td style="color:'+(x.status==='ok'?'var(--up)':'#d99e2b')+'">'+x.success_pct+'%</td><td>'+x.target_pct+'%</td><td>'+x.burn_rate+'</td><td>'+(x.p95_ms==null?'—':x.p95_ms+'ms')+'</td></tr>'; }).join('')
        + '</tbody></table>';
    }

    var sc = (c && c.rows) || [];
    if (!sc.length) { $('#monScore').innerHTML = '<div style="color:var(--text3)">'+T('暂无已评估告警（需先产生带币种的告警）','No evaluated alerts yet')+'</div>'; }
    else {
      $('#monScore').innerHTML = '<table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr style="color:var(--text3);text-align:left"><th>'+T('规则','Rule')+'</th><th>'+T('级别','Level')+'</th><th>'+T('周期','Horizon')+'</th><th>'+T('样本','N')+'</th><th>'+T('命中率','Hit')+'</th><th>'+T('平均收益','Avg ret')+'</th></tr></thead><tbody>'
        + sc.map(function(x){ return '<tr style="border-top:1px solid rgba(255,255,255,.06)"><td>'+esc(x.rule)+'</td><td>'+esc(x.severity)+'</td><td>'+(x.horizon_sec/60)+'m</td><td>'+x.samples+'</td><td>'+(x.hit_rate_pct==null?'—':x.hit_rate_pct+'%')+'</td><td>'+(x.avg_ret_pct==null?'—':x.avg_ret_pct+'%')+'</td></tr>'; }).join('')
        + '</tbody></table>';
    }
  };
})();

