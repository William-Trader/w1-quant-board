(function(){
  function go(){
    try{
      var q = new URLSearchParams(location.search).get('tab');
      if (!q || typeof TABS === 'undefined' || typeof switchTab !== 'function') return;
      if (!TABS.some(function(t){ return t.id === q; })) return;
      switchTab(q);
    }catch(e){}
  }
  if (document.readyState === 'complete') { setTimeout(go, 500); setTimeout(go, 1800); setTimeout(go, 3200); }
  else window.addEventListener('load', function(){ setTimeout(go, 500); setTimeout(go, 1800); setTimeout(go, 3200); });
})();
