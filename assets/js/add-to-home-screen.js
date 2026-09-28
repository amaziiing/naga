(function(){
  'use strict';

  // Isolated A2HS helper. It intentionally does NOT touch NAGA_SITE_SHELL,
  // layout-section loading, I18N.apply(), API calls, scrolling or game rendering.
  var deferredPrompt = null;
  var installed = false;
  var installConfig = null;

  function isZh(){
    try {
      var saved = localStorage.getItem('site_lang');
      return saved === 'zh' || (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
    } catch (_) {
      return (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
    }
  }

  function apiInstallSetting(){
    return (window.NAGA_API && window.NAGA_API.installAppSetting)
      || ((window.NAGA_CONFIG&&window.NAGA_CONFIG.api&&window.NAGA_CONFIG.api.baseUrl)||'').replace(/\/$/,'')+'/api/frontend/install-app';
  }

  function versionedLogoUrl(data){
    var logo=String((data&&data.logoUrl)||'').trim();
    if(!logo) return '';
    var version=encodeURIComponent((data&&data.version)||1);
    // Strip an older v= value first so the URL always has exactly one current version.
    try {
      var u=new URL(logo,location.href);
      u.searchParams.set('v',version);
      return u.toString();
    } catch (_) {
      return logo+(logo.indexOf('?')>=0?'&':'?')+'v='+version;
    }
  }

  function applyInstallConfig(data){
    if(!data||typeof data!=='object') return;
    installConfig=data;

    var displayName=String(data.displayName||'').trim();
    if(displayName){
      var meta=document.querySelector('meta[name="apple-mobile-web-app-title"]');
      if(!meta){
        meta=document.createElement('meta');
        meta.name='apple-mobile-web-app-title';
        document.head.appendChild(meta);
      }
      meta.content=displayName;
    }

    var logo=versionedLogoUrl(data);
    if(logo){
      // Update EVERY Apple icon declaration defensively. Older project versions
      // contained more than one apple-touch-icon and Safari may choose the later one.
      var icons=document.querySelectorAll('link[rel~="apple-touch-icon"]');
      if(!icons.length){
        var icon=document.createElement('link');
        icon.rel='apple-touch-icon';
        icon.id='nagaInstallAppleTouchIcon';
        document.head.appendChild(icon);
        icons=[icon];
      }
      Array.prototype.forEach.call(icons,function(icon){
        icon.href=logo;
        icon.setAttribute('sizes','180x180');
      });
    }
  }

  var installConfigPromise=null;
  function loadInstallConfig(fresh){
    if(installConfigPromise && !fresh) return installConfigPromise;
    var url=apiInstallSetting();
    if(!url||url.indexOf('/api/')<0) return Promise.resolve(null);

    if(fresh){
      url += (url.indexOf('?')>=0?'&':'?') + '_a2hs=' + Date.now();
    }

    var request=fetch(url,{
      method:'GET',
      credentials:'omit',
      cache:fresh?'no-store':'default',
      headers:{'Accept':'application/json'}
    })
      .then(function(r){return r.ok?r.json():null})
      .then(function(j){
        if(j&&j.status!=='error'){
          applyInstallConfig(j.data||{});
          return j.data||{};
        }
        return null;
      })
      .catch(function(){return null;});

    if(!fresh){
      installConfigPromise=request;
      request.finally(function(){installConfigPromise=null;});
    }
    return request;
  }

  function isIos(){
    var ua=navigator.userAgent||'';
    return /iPad|iPhone|iPod/i.test(ua) ||
      (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  }

  function isStandalone(){
    try {
      return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    } catch (_) { return false; }
  }

  function label(){ return isZh() ? '添加到主屏幕' : 'Add to Home Screen'; }

  function helpText(){
    var ua = navigator.userAgent || '';
    var ios = /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var android = /Android/i.test(ua);
    if (isZh()) {
      if (ios) return '请使用 Safari：点击“分享”，选择“添加到主屏幕”，然后点击“添加”。';
      if (android) return '如果没有出现安装提示，请打开浏览器菜单（⋮），选择“安装应用”或“添加到主屏幕”。';
      return '请打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。';
    }
    if (ios) return 'In Safari, tap Share, choose “Add to Home Screen”, then tap Add.';
    if (android) return 'If no install prompt appears, open the browser menu (⋮) and choose “Install app” or “Add to Home screen”.';
    return 'Open the browser menu and choose “Install app” or “Add to Home screen”.';
  }

  function showHelp(){
    var msg = helpText();
    var title = label();
    if (window.NAGA_MODAL && typeof window.NAGA_MODAL.alert === 'function') {
      window.NAGA_MODAL.alert(msg, title);
    } else {
      window.alert(msg);
    }
  }

  function onInstallClick(e){
    if(e) { e.preventDefault(); e.stopPropagation(); }
    if(isStandalone() || installed) return;

    // iOS snapshots apple-touch-icon when the user adds the site.
    // Fetch the BO setting NOW (cache bypassed) before we tell the user to open
    // Safari Share -> Add to Home Screen, so the newest BO logo/name is in DOM.
    if(isIos()){
      var settled=false;
      var safety=new Promise(function(resolve){
        window.setTimeout(function(){ if(!settled) resolve(null); },1200);
      });
      Promise.race([loadInstallConfig(true),safety]).then(function(){
        settled=true;
        showHelp();
      });
      return;
    }

    // Android/Chromium uses the manifest. The manifest endpoint is no-store and
    // the icon URL includes the BO install version.
    if(deferredPrompt && typeof deferredPrompt.prompt==='function'){
      var p=deferredPrompt;
      deferredPrompt=null;
      try {
        p.prompt();
        Promise.resolve(p.userChoice).catch(function(){}).then(refreshButton);
      } catch (_) {
        showHelp();
      }
    } else {
      showHelp();
    }
  }

  function getButtons(){
    return document.querySelectorAll('#nagaAddToHomeScreen, [data-add-to-home-screen]');
  }

  function refreshButton(){
    var buttons = getButtons();
    Array.prototype.forEach.call(buttons, function(btn){
      if (isStandalone() || installed) {
        btn.hidden = true;
        return;
      }
      btn.hidden = false;
      var text = btn.querySelector('.naga-a2hs-label');
      if (text) text.textContent = label();
      btn.setAttribute('aria-label', label());
    });
  }

  function bindExistingButtons(){
    // BO Layout Section is the source of truth for sidebar markup.
    // Never create/prefetch/append a sidebar item here; only bind install
    // behaviour when BO explicitly includes an install button/hook.
    var buttons = getButtons();
    Array.prototype.forEach.call(buttons, function(btn){
      if (btn.dataset.nagaA2hsBound === '1') return;
      btn.dataset.nagaA2hsBound = '1';
      btn.addEventListener('click', onInstallClick, {passive:false});
    });
    refreshButton();
  }

  function scheduleInsert(){
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(bindExistingButtons, {timeout:1200});
    } else {
      window.setTimeout(bindExistingButtons, 0);
    }
  }

  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    deferredPrompt = e;
    refreshButton();
  });
  window.addEventListener('appinstalled', function(){
    installed = true;
    deferredPrompt = null;
    refreshButton();
  });

  // The BO layout loader emits these only after its normal work is complete.
  document.addEventListener('naga:layout-sections-loaded', scheduleInsert, {passive:true});
  document.addEventListener('naga:site-shell-customized', function(e){
    if (!e.detail || !e.detail.sectionKey || e.detail.sectionKey === 'frontend-sidebar') scheduleInsert();
  }, {passive:true});
  document.addEventListener('i18n:changed', refreshButton, {passive:true});

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInsert, {once:true, passive:true});
  } else {
    scheduleInsert();
  }
})();
