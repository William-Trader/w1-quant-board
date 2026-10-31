(function(){
  if (typeof PANELS === 'undefined') return;
  var css = document.createElement('style');
  css.textContent = '.md-hero{display:flex;gap:18px;flex-wrap:wrap;align-items:center;justify-content:space-between;background:linear-gradient(135deg,rgba(124,92,255,.16),rgba(34,211,238,.10));border:1px solid rgba(124,92,255,.35);border-radius:14px;padding:16px 18px;margin-bottom:14px}.md-regime{font-size:26px;font-weight:800;letter-spacing:.5px}.md-sub{color:var(--text3);font-size:11px;margin-top:4px}.md-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}.md-card{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.md-card .k{font-size:10.5px;color:var(--text3)}.md-card .v{font-size:28px;font-weight:800;font-family:var(--mono);line-height:1.1;margin-top:4px}.md-card .s{font-size:10px;color:var(--text3);margin-top:4px}.md-bar{height:6px;border-radius:4px;background:var(--bg2);overflow:hidden;margin-top:8px}.md-bar i{display:block;height:100%;border-radius:4px}.md-eng{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.md-eng-row{background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:10px;padding:9px 11px}.md-eng-row .n{font-size:11px;color:var(--text2)}.md-eng-row .x{font-size:16px;font-weight:800;font-family:var(--mono)}.md-eng-row .t{font-size:9.5px;color:var(--text3);margin-top:3px}.md-bt{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--text3);margin-top:10px}.md-bt b{color:var(--text);font-family:var(--mono)}@media(max-width:900px){.md-grid{grid-template-columns:1fr 1fr}.md-eng{grid-template-columns:1fr 1fr}}@media(max-width:520px){.md-grid,.md-eng{grid-template-columns:1fr}}';
  document.head.appendChild(css);

  function col(v, inverse) {
    if (v == null) return '#8b93a7';
    var x = inverse ? 100 - v : v;
    return x >= 65 ? '#34d399' : x >= 45 ? '#d9a441' : '#fb7185';
  }
  function bar(v, c) { return '<div class="md-bar"><i style="width:' + Math.max(0, Math.min(100, v || 0)) + '%;background:' + c + '"></i></div>'; }

  function render(d) {
    if (!d || !d.ok) return '<div class="card">宏观数据不可用</div>';
    var s = d.scores || {}, e = d.engines || [], bt = d.backtest;
    var conf = d.confidence != null ? d.confidence + '%' : '—';
    var cards = [
      ['全球风险偏好', s.risk_appetite, false, s.risk_appetite >= 60 ? '风险偏好回升' : s.risk_appetite <= 40 ? '避险' : '中性'],
      ['美元流动性', s.usd_liquidity, false, s.usd_liquidity >= 60 ? '宽裕' : s.usd_liquidity <= 40 ? '收紧' : '中性'],
      ['实际利率压力', s.real_rate_pressure, true, s.real_rate_pressure >= 60 ? '限制性' : s.real_rate_pressure <= 40 ? '缓释' : '中性'],
      ['加密市场环境', s.crypto_env, false, s.crypto_env >= 60 ? '改善' : s.crypto_env <= 40 ? '恶化' : '中性']
    ].map(function(x) {
      var c = col(x[1], x[2]);
      return '<div class="md-card"><div class="k">' + x[0] + '</div><div class="v" style="color:' + c + '">' + (x[1] == null ? '—' : x[1]) + '</div><div class="s">' + x[3] + '</div>' + bar(x[1], c) + '</div>';
    }).join('');
    var eng = e.map(function(x) {
      var c = col(x.value, true);
      return '<div class="md-eng-row"><div class="n">' + x.name + '</div><div class="x" style="color:' + c + '">' + (x.value == null ? '—' : x.value) + '</div><div class="t">' + (x.note || '') + '</div>' + bar(x.value, c) + '</div>';
    }).join('');
    var btHtml = bt ? '<div class="md-bt"><span>复验样本 <b>' + bt.days + '</b> 天</span><span>相关性 <b>' + bt.corr + '</b></span><span>高分后 7d 命中 <b>' + (bt.high.hit == null ? '—' : bt.high.hit + '%') + '</b>（均值 ' + (bt.high.avg_ret == null ? '—' : bt.high.avg_ret + '%') + '）</span><span>低分后 7d 命中 <b>' + (bt.low.hit == null ? '—' : bt.low.hit + '%') + '</b>（均值 ' + (bt.low.avg_ret == null ? '—' : bt.low.avg_ret + '%') + '）</span></div>' : '';
    return '<div class="md-hero"><div><div class="md-sub">全球宏观 · ' + (d.as_of ? new Date(d.as_of * 1000).toLocaleString('zh-CN', { hour12: false }) : '—') + '</div>'
      + '<div class="md-regime">' + (d.regime || '—') + ' <span style="color:#22d3ee">' + conf + '</span></div>'
      + '<div class="md-sub">增长 ' + (d.growth == null ? '—' : d.growth) + ' / 通胀 ' + (d.inflation == null ? '—' : d.inflation) + ' · FRED + 本地缓存合成</div></div>'
      + '<div style="min-width:220px;flex:1;max-width:320px"><div class="md-sub">增长</div>' + bar(d.growth, '#22d3ee') + '<div class="md-sub" style="margin-top:6px">通胀</div>' + bar(d.inflation, '#7c5cff') + '</div></div>'
      + '<div class="md-grid">' + cards + '</div>'
      + '<div class="card"><div class="card-title">核心引擎</div><div class="md-eng">' + eng + '</div>' + btHtml
      + '<div class="data-ts" style="margin-top:8px">压力类数值越高越紧；复验为 composite 日度 vs BTC 未来 7 日收益，样本有限，仅作参考。</div></div>';
  }

  var orig = PANELS.assets;
  PANELS.assets = async function() {
    await orig.call(this);
    try {
      var d = await api('/api/macro/dashboard');
      var main = document.getElementById('main');
      if (!main || !d) return;
      var old = document.getElementById('macroDash');
      if (old) old.remove();
      var box = document.createElement('div');
      box.id = 'macroDash';
      box.innerHTML = render(d);
      main.insertBefore(box, main.firstChild);
    } catch (e) {}
  };
})();
