(function(){
  function getToken(){ return localStorage.getItem('member_token') || ''; }

  function isLoggedIn(){
    return !!getToken();
  }

  function formatMoney(value){
    if(value === undefined || value === null || value === '') return '-';
    var n = Number(value);
    return isNaN(n) ? '-' : 'MYR ' + n.toFixed(2);
  }

  function setAllWalletText(value){
    var text;
    if(typeof value === 'number' || (/^-?\d+(\.\d+)?$/.test(String(value || '').trim()))){
      text = formatMoney(value);
    }else{
      text = value || '-';
    }
    document.querySelectorAll('[data-main-wallet-balance]').forEach(function(el){ el.textContent = text; });
  }

  var BALANCE_CONFIRMED_AT_KEY = 'member_main_wallet_balance_confirmed_at';

  function signalWalletReady(){
    window.__NAGA_WALLET_READY__ = true;
    try{ document.dispatchEvent(new CustomEvent('naga:wallet-ready')); }catch(e){}
  }

  function invalidateStoredBalance(){
    try{ localStorage.removeItem('member_main_wallet_balance'); }catch(e){}
    try{ localStorage.removeItem(BALANCE_CONFIRMED_AT_KEY); }catch(e){}
  }

  function getStoredBalance(){
    try{
      var raw = localStorage.getItem('member_main_wallet_balance');
      if(raw === null || raw === '') return null;
      var value = Number(raw);
      if(isNaN(value)) return null;
      var confirmedAt = Number(localStorage.getItem(BALANCE_CONFIRMED_AT_KEY) || 0);
      // Migrate old caches safely: a legacy non-zero balance is useful for first paint,
      // but legacy 0.00 may have been written by the old missing-field fallback.
      if(!confirmedAt && value === 0) return null;
      return value;
    }catch(e){ return null; }
  }

  function rememberBalance(value){
    try{
      if(value === null || value === undefined || isNaN(Number(value))){
        invalidateStoredBalance();
        return;
      }
      localStorage.setItem('member_main_wallet_balance', String(Number(value)));
      localStorage.setItem(BALANCE_CONFIRMED_AT_KEY, String(Date.now()));
    }catch(e){}
  }

  var refreshTokenPromise = null;
  function refreshMemberToken(){
    var oldToken = getToken();
    if(!oldToken) return Promise.resolve({ok:false, terminal:true});
    if(refreshTokenPromise) return refreshTokenPromise;

    var cfg = window.NAGA_CONFIG && window.NAGA_CONFIG.api;
    var base = String((cfg && cfg.baseUrl) || 'https://bo.titanx7.com').replace(/\/+$/, '');
    refreshTokenPromise = fetch(base + '/api/auth/member/refresh', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Authorization': 'Bearer ' + oldToken,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(json){ return {res:res, json:json}; });
    }).then(function(pair){
      var token = pair.json && pair.json.token;
      if(pair.res.ok && pair.json.status !== 'error' && token){
        try{
          localStorage.setItem('member_token', token);
          if(pair.json.data && typeof pair.json.data === 'object'){
            var current = {};
            try{ current = JSON.parse(localStorage.getItem('member_info') || '{}') || {}; }catch(e){}
            localStorage.setItem('member_info', JSON.stringify(Object.assign({}, current, pair.json.data)));
          }
        }catch(e){}
        refreshHeaderAuth();
        try{ document.dispatchEvent(new CustomEvent('naga:member-session-refreshed')); }catch(e){}
        return {ok:true, terminal:false};
      }
      return {ok:false, terminal:true};
    }).catch(function(){
      // Laptop wake-up can briefly have no network. Do not destroy a locally
      // remembered session just because the first request after resume failed.
      return {ok:false, terminal:false};
    }).then(function(result){
      refreshTokenPromise = null;
      return result;
    }, function(err){
      refreshTokenPromise = null;
      throw err;
    });
    return refreshTokenPromise;
  }

  function noCacheUrl(url){
    var separator = String(url).indexOf('?') >= 0 ? '&' : '?';
    return String(url) + separator + '_wallet_ts=' + Date.now();
  }

  function extractBalance(json){
    var data = (json && json.data) || json || {};
    var candidates = [
      data.balance, data.mainWalletBalance, data.main_wallet_balance,
      data.walletBalance, data.wallet_balance, data.amount,
      data.mainWallet && data.mainWallet.balance,
      data.main_wallet && data.main_wallet.balance,
      data.wallet && data.wallet.balance
    ];
    for(var i=0;i<candidates.length;i++){
      if(candidates[i] !== undefined && candidates[i] !== null && candidates[i] !== ''){
        var n = Number(candidates[i]);
        return isNaN(n) ? null : n;
      }
    }
    return null;
  }

  function walletBalanceUrl(){
    var api = window.NAGA_API || {};
    var cfg = window.NAGA_CONFIG && window.NAGA_CONFIG.api;
    var base = (cfg && cfg.baseUrl) || 'https://bo.titanx7.com';
    return api.playerMainWalletBalance || (String(base).replace(/\/+$/, '') + '/api/member/wallet/balance');
  }

  function refreshShellBalance(retried){
    if(!getToken()){
      setAllWalletText('');
      signalWalletReady();
      return Promise.resolve(null);
    }
    return fetch(noCacheUrl(walletBalanceUrl()), {
      cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + getToken(), 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' }
    })
    .then(function(res){ return res.json().catch(function(){ return {}; }).then(function(json){ return {res:res, json:json}; }); })
    .then(function(pair){
      var unauthorized = pair.res.status === 401 || String(pair.json && pair.json.message || '').toLowerCase() === 'unauthorized';
      if(unauthorized && !retried){
        return refreshMemberToken().then(function(refreshResult){
          if(refreshResult.ok) return refreshShellBalance(true);
          if(refreshResult.terminal){
            doShellLogout();
            return null;
          }
          return getStoredBalance();
        });
      }
      if(!pair.res.ok || pair.json.status === 'error') throw new Error(pair.json.message || 'Unable to load wallet balance');
      var balance = extractBalance(pair.json);
      if(balance !== null){
        rememberBalance(balance);
        setAllWalletText(balance);
      }
      signalWalletReady();
      return balance;
    })
    .catch(function(){
      // Preserve the last confirmed amount during temporary Wi-Fi/network/API
      // recovery after laptop sleep instead of replacing it with "-".
      var cached = getStoredBalance();
      if(cached !== null) setAllWalletText(cached);
      signalWalletReady();
      return cached;
    });
  }

  function scheduleBalanceRefresh(){
    // Paint the last API-confirmed balance immediately, then refresh silently.
    // This avoids a "-" flash while a laptop is reconnecting after sleep.
    var cached = getStoredBalance();
    if(getToken() && cached !== null){ setAllWalletText(cached); signalWalletReady(); }
    else if(!getToken()) signalWalletReady();
    // One initial refresh is enough. The old code also refreshed again on load
    // and pageshow, which could issue 2-3 identical wallet requests per navigation.
    setTimeout(function(){ refreshShellBalance(); }, 0);
    window.addEventListener('pageshow', function(e){ if(e && e.persisted) refreshShellBalance(); });
    window.addEventListener('focus', function(){ refreshShellBalance(); });
    document.addEventListener('visibilitychange', function(){ if(!document.hidden) refreshShellBalance(); });
  }

  var presenceTimer = null;
  var lastPresenceAt = 0;
  var PRESENCE_INTERVAL_MS = 60000;
  var PRESENCE_MIN_GAP_MS = 15000;
  function presenceBase(){ var cfg=window.NAGA_CONFIG&&window.NAGA_CONFIG.api; return String((cfg&&cfg.baseUrl)||'https://bo.titanx7.com').replace(/\/+$/,''); }
  function sendPresence(path, keepalive){
    var token=getToken(); if(!token) return Promise.resolve();
    return fetch(presenceBase()+path,{method:'POST',keepalive:!!keepalive,cache:'no-store',headers:{'Authorization':'Bearer '+token,'Cache-Control':'no-store'}}).catch(function(){});
  }
  function heartbeatPresence(force){
    if(!getToken()) return;
    var now=Date.now();
    if(!force && now-lastPresenceAt<PRESENCE_MIN_GAP_MS) return;
    lastPresenceAt=now;
    sendPresence('/api/auth/member/presence/heartbeat', false);
  }
  function startPresence(){
    if(presenceTimer) clearInterval(presenceTimer);
    heartbeatPresence(true);
    // One minute is enough for online presence and avoids 12 heartbeat requests
    // per minute per player. Focus/visibility wakeups are also de-duplicated.
    presenceTimer=setInterval(function(){ heartbeatPresence(false); },PRESENCE_INTERVAL_MS);
    document.addEventListener('visibilitychange',function(){ if(!document.hidden) heartbeatPresence(false); });
    window.addEventListener('focus',function(){ heartbeatPresence(false); });
  }

  function doShellLogout(){
    if(getToken()) sendPresence('/api/auth/member/presence/offline', true);
    try{ localStorage.removeItem('member_token'); }catch(e){}
    try{ localStorage.removeItem('member_info'); }catch(e){}
    invalidateStoredBalance();
    ['token','user','member','memberInfo','auth_token','access_token','jwt','main_wallet_balance'].forEach(function(k){try{localStorage.removeItem(k);}catch(e){}});
    document.body.classList.remove('member-logged-in');
    setAllWalletText('');
    signalWalletReady();
    refreshHeaderAuth();
    try{ document.dispatchEvent(new CustomEvent('naga:member-logout')); }catch(e){}
    closeMenu();
    if(window.NAGA_MEMBER_AUTH && typeof window.NAGA_MEMBER_AUTH.refresh === 'function'){
      try{ window.NAGA_MEMBER_AUTH.refresh(); }catch(e){}
    }
  }

  function tr(key, fallback){
    try{
      if(window.I18N && typeof window.I18N.t === 'function'){
        var value = window.I18N.t(key);
        if(value && value !== key) return value;
      }
    }catch(e){}
    return fallback || key;
  }


  // Translate only shell-owned DOM. Calling global I18N.apply() from header/sidebar
  // lifecycle code dispatches i18n:changed and can make data-heavy modules reload.
  function translateShellScope(root){
    if(!root || !window.I18N || typeof window.I18N.t !== 'function') return;
    function nodes(selector){
      var list=[];
      if(root.matches && root.matches(selector)) list.push(root);
      if(root.querySelectorAll) list.push.apply(list, root.querySelectorAll(selector));
      return list;
    }
    function value(key){
      if(!key) return '';
      try{
        var v=window.I18N.t(key);
        return v == null || v === key ? '' : String(v);
      }catch(e){ return ''; }
    }
    nodes('[data-i18n]').forEach(function(el){ var v=value(el.getAttribute('data-i18n')); if(v) el.textContent=v; });
    nodes('[data-i18n-html]').forEach(function(el){ var v=value(el.getAttribute('data-i18n-html')); if(v) el.innerHTML=v; });
    nodes('[data-i18n-placeholder]').forEach(function(el){ var v=value(el.getAttribute('data-i18n-placeholder')); if(v) el.setAttribute('placeholder',v); });
    nodes('[data-i18n-alt]').forEach(function(el){ var v=value(el.getAttribute('data-i18n-alt')); if(v) el.setAttribute('alt',v); });
    nodes('[data-i18n-title]').forEach(function(el){ var v=value(el.getAttribute('data-i18n-title')); if(v) el.setAttribute('title',v); });
    nodes('[data-i18n-aria-label]').forEach(function(el){ var v=value(el.getAttribute('data-i18n-aria-label')); if(v) el.setAttribute('aria-label',v); });
  }

  function getCurrentLang(){
    return (window.I18N && window.I18N.current) || localStorage.getItem('site_lang') || localStorage.getItem('lang') || document.documentElement.lang || 'en';
  }

  function isCurrentZh(){
    return String(getCurrentLang()).toLowerCase().startsWith('zh') || String(getCurrentLang()).toLowerCase().startsWith('cn');
  }

  function nextLangLabel(){
    return isCurrentZh()
      ? { text: tr('side_language_english', 'English'), suffix: 'EN ›' }
      : { text: tr('side_language_chinese', '简体中文'), suffix: 'CN ›' };
  }

  function updateSideLangLabel(){
    const btn = document.getElementById('sideLangBtn');
    if(!btn) return;
    const next = nextLangLabel();
    btn.innerHTML = '<span>🌐 ' + next.text + '</span><span>' + next.suffix + '</span>';
  }


  function flashSideLangChanged(lang){
    const btn = document.getElementById('sideLangBtn');
    if(!btn) return;
    const label = String(lang || getCurrentLang()).toLowerCase().startsWith('zh') ? tr('language_changed_zh','已切换：中文') : tr('language_changed_en','Changed: English');
    btn.classList.add('changed');
    btn.innerHTML = '<span>✅ ' + label + '</span><span>✓</span>';
    clearTimeout(btn._nagaLangTimer);
    btn._nagaLangTimer = setTimeout(function(){
      btn.classList.remove('changed');
      updateSideLangLabel();
      // Keep the mobile sidebar open after switching language.
      // The user should close it explicitly with the close button, overlay, or Escape key.
    }, 350);
  }

  function normaliseWebsiteTemplates(){
    var rows = window.NAGA_CONFIG && Array.isArray(window.NAGA_CONFIG.websiteTemplates)
      ? window.NAGA_CONFIG.websiteTemplates : [];
    return rows.map(function(item, index){
      if(!item || item.enabled === false) return null;
      var name = String(item.name || item.label || ('Website ' + (index + 1))).trim();
      var rawUrl = String(item.url || item.href || '').trim();
      if(!rawUrl) return null;
      try{
        var url = new URL(rawUrl, window.location.href);
        if(url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return {name:name, url:url.href};
      }catch(e){ return null; }
    }).filter(Boolean);
  }

  function ensureWebsiteTemplateSelector(){
    var overlay = document.getElementById('websiteTemplateOverlay');
    if(overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'websiteTemplateOverlay';
    overlay.className = 'lang-overlay website-template-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<div class="lang-modal website-template-modal" role="dialog" aria-modal="true" aria-labelledby="websiteTemplateTitle">' +
      '<div class="website-template-title" id="websiteTemplateTitle">Select Website</div>' +
      '<div class="website-template-list" data-website-template-list></div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function(e){
      if(e.target === overlay){ closeWebsiteTemplateSelector(); return; }
      var option = e.target.closest && e.target.closest('[data-website-template-url]');
      if(!option) return;
      var destination = option.getAttribute('data-website-template-url');
      if(!destination) return;
      closeWebsiteTemplateSelector();
      window.location.assign(destination);
    });
    return overlay;
  }

  function renderWebsiteTemplateSelector(){
    var overlay = ensureWebsiteTemplateSelector();
    var list = overlay.querySelector('[data-website-template-list]');
    var templates = normaliseWebsiteTemplates();
    if(!list) return templates;
    list.textContent = '';

    templates.forEach(function(item){
      var btn = document.createElement('button');
      btn.className = 'lang-option website-template-option';
      btn.type = 'button';
      btn.setAttribute('data-website-template-url', item.url);
      btn.textContent = item.name;
      try{
        var destinationHost = new URL(item.url).hostname.toLowerCase();
        if(destinationHost === String(window.location.hostname || '').toLowerCase()){
          btn.classList.add('active');
          var mark = document.createElement('span');
          mark.className = 'website-template-checkmark';
          mark.textContent = '✔';
          btn.appendChild(mark);
        }
      }catch(e){}
      list.appendChild(btn);
    });
    return templates;
  }

  function openWebsiteTemplateSelector(){
    var templates = renderWebsiteTemplateSelector();
    if(!templates.length) return;
    var overlay = ensureWebsiteTemplateSelector();
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function closeWebsiteTemplateSelector(){
    var overlay = document.getElementById('websiteTemplateOverlay');
    if(!overlay) return;
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function ensureWebsiteTemplateSwitchButton(){
    var header = document.querySelector('.top-header');
    if(!header) return null;
    var logoBox = header.querySelector('.logo-box');
    if(!logoBox) return null;

    var existing = logoBox.querySelector('.website-template-switch');
    if(existing){
      existing.hidden = !normaliseWebsiteTemplates().length;
      return existing;
    }

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'website-template-switch';
    button.setAttribute('aria-label', 'Switch website template');
    button.setAttribute('title', 'Switch website template');
    button.innerHTML = '<span class="website-template-switch-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
    button.hidden = !normaliseWebsiteTemplates().length;
    logoBox.appendChild(button);
    return button;
  }

  function initWebsiteTemplateSelector(){
    ensureWebsiteTemplateSwitchButton();
    // Delegated binding is intentional: BO layout customization can replace the
    // header after page load, and the replacement must keep this behavior.
    document.addEventListener('click', function(e){
      var switchButton = e.target.closest && e.target.closest('.website-template-switch');
      if(!switchButton) return;
      if(!normaliseWebsiteTemplates().length) return;
      e.preventDefault();
      e.stopPropagation();
      openWebsiteTemplateSelector();
    });
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape') closeWebsiteTemplateSelector();
    });
    document.addEventListener('naga:layout-sections-loaded', ensureWebsiteTemplateSwitchButton);
    document.addEventListener('naga:site-shell-customized', ensureWebsiteTemplateSwitchButton);
    document.addEventListener('naga:layout-section-applied', function(e){
      if(!e || !e.detail || e.detail.sectionKey === 'frontend-header') ensureWebsiteTemplateSwitchButton();
    });
    document.addEventListener('naga:layout-section-restored', function(e){
      if(!e || !e.detail || e.detail.sectionKey === 'frontend-header') ensureWebsiteTemplateSwitchButton();
    });
  }

  function enhanceHeader(){
    const header = document.querySelector('.top-header');
    if(!header || header.dataset.shellReady === '1') return;
    header.dataset.shellReady = '1';
    header.setAttribute('data-layout-section', 'frontend-header');

    const logoBox = header.querySelector('.logo-box');
    if(logoBox) logoBox.classList.add('mobile-style-logo');

    // Header language/translate control is intentionally removed on every page.
    header.querySelectorAll('.lang-btn, .top-lang-btn').forEach(function(el){ el.remove(); });
    const actions = document.createElement('div');
    actions.className = 'top-header-actions';

    const guest = document.createElement('div');
    guest.className = 'top-auth-actions';
    guest.innerHTML = '<a class="top-login-btn auth-image-link" href="login.html" aria-label="Login"><img class="header-auth-image header-login-image" src="assets/custom/images/login.png" alt="LOGIN" decoding="async" loading="eager"></a><a class="top-register-btn auth-image-link" href="register.html" aria-label="Register"><img class="header-auth-image header-register-image" src="assets/custom/images/register.png" alt="REGISTER" decoding="async" loading="eager"></a>';

    const member = document.createElement('div');
    member.className = 'top-member-actions';
    member.innerHTML = '<a class="top-wallet-pill" href="deposit.html"><span data-main-wallet-balance>&nbsp;</span></a><button type="button" class="top-logout-btn" data-member-logout data-i18n="logout">Logout</button>';

    actions.appendChild(guest);
    actions.appendChild(member);
    header.appendChild(actions);
    refreshHeaderAuth();
    watchHeaderAuthReplacement();
    translateShellScope(header);
  }

  function refreshHeaderAuth(){
    var logged = isLoggedIn();
    document.body.classList.toggle('member-logged-in', logged);

    // Apply visibility directly as well as through CSS. The BO layout loader can
    // replace the header after initial render, especially on iPhone Safari.
    document.querySelectorAll('.top-auth-actions').forEach(function(el){
      el.style.setProperty('display', logged ? 'none' : 'flex', 'important');
      el.setAttribute('aria-hidden', logged ? 'true' : 'false');
    });
    document.querySelectorAll('.top-member-actions').forEach(function(el){
      el.style.setProperty('display', logged ? 'flex' : 'none', 'important');
      el.setAttribute('aria-hidden', logged ? 'false' : 'true');
    });

    document.querySelectorAll('.mobile-menu-member').forEach(function(el){
      el.style.display = logged ? 'flex' : 'none';
    });
    document.querySelectorAll('.mobile-menu-list-logout').forEach(function(el){
      el.style.display = logged ? 'flex' : 'none';
    });
    document.querySelectorAll('.mobile-menu-auth').forEach(function(el){
      el.style.display = logged ? 'none' : '';
    });
    if(!logged){
      document.querySelectorAll('#mobileSideMenu [data-main-wallet-balance]').forEach(function(el){
        el.textContent = '';
      });
    }
  }

  function watchHeaderAuthReplacement(){
    var header = document.querySelector('.top-header');
    if(!header || header.dataset.authWatchReady === '1') return;
    header.dataset.authWatchReady = '1';
    var queued = false;
    new MutationObserver(function(){
      if(queued) return;
      queued = true;
      requestAnimationFrame(function(){
        queued = false;
        refreshHeaderAuth();
      });
    }).observe(header, {childList:true});
    window.addEventListener('pageshow', refreshHeaderAuth);
    window.addEventListener('focus', refreshHeaderAuth);
    window.addEventListener('storage', function(e){
      if(!e || e.key === 'member_token' || e.key === 'member_info') refreshHeaderAuth();
    });
  }

  function createSideMenu(){
    if(document.getElementById('mobileSideMenu')) return;
    const overlay = document.createElement('div');
    overlay.className = 'mobile-menu-overlay';
    overlay.id = 'mobileSideMenu';
    overlay.setAttribute('aria-hidden','true');
    overlay.innerHTML = `
      <div class="mobile-menu-backdrop" data-menu-close></div>
      <aside class="mobile-menu-panel" role="dialog" aria-modal="true" aria-label="Menu">
        <div class="mobile-menu-head">
          <div class="mobile-avatar"><i class="fa-solid fa-user"></i></div>
          <div class="mobile-menu-auth">
            <a href="login.html" class="mobile-login-btn auth-image-link" aria-label="Login"><img class="sidebar-auth-image sidebar-login-image" src="assets/custom/images/login.png" alt="LOGIN" decoding="async" loading="eager"></a>
            <a href="register.html" class="mobile-register-btn auth-image-link" aria-label="Register"><img class="sidebar-auth-image sidebar-register-image" src="assets/custom/images/register.png" alt="REGISTER" decoding="async" loading="eager"></a>
          </div>
          <div class="mobile-menu-member"><div class="mobile-menu-wallet"><span data-main-wallet-balance>&nbsp;</span></div></div>
        </div>
        <div class="mobile-menu-list">
          <a href="index.html"><i class="fa-solid fa-house mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_home">Home</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>
          <a href="downline.html"><i class="fa-solid fa-users mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_downline">Downline</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>
          <a href="vip.html" data-vip-menu><i class="fa-solid fa-crown mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_vip">VIP</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>
          <a href="bonus.html"><i class="fa-solid fa-gift mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_bonus">Bonus</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>
          <a href="spin.html"><i class="fa-solid fa-dharmachakra mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_spin">Spin</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>
          <a href="leaderboard.html" data-leaderboard-menu style="display:none;"><i class="fa-solid fa-ranking-star mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_leaderboard">Leaderboard</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>
          <a href="policies.html"><i class="fa-solid fa-shield-halved mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_compliance_policy">Compliance Policy</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>
          <a href="chat.html"><i class="fa-solid fa-headset mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_live_chat">Live Chat</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>
          <button type="button" class="mobile-menu-list-logout" data-member-logout><i class="fa-solid fa-right-from-bracket mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_logout">Logout</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></button>
        </div>
        <div class="mobile-menu-lang" id="sideLangBtn"><span>🌐 简体中文</span><span>CN ›</span></div>
        <div class="mobile-menu-version"><span data-i18n="side_version">Version:</span> 1.1.0</div>
      </aside>`;
    document.body.appendChild(overlay);
    const panel = overlay.querySelector('.mobile-menu-panel');
    if(panel) panel.setAttribute('data-layout-section', 'frontend-sidebar');
    updateSideLangLabel();
    translateShellScope(overlay);
  }

  // <a href="rebate.html"><i class="fa-solid fa-coins mobile-menu-icon" aria-hidden="true"></i><span data-i18n="side_rebate">Rebate</span><i class="fa-solid fa-chevron-right mobile-menu-arrow" aria-hidden="true"></i></a>

  // Ensure sidebar display controls are available on every page that uses the
  // shared shell. Historically only index.html loaded frontend-display.js, so
  // BO-controlled items such as Leaderboard stayed hidden on direct/internal
  // pages. Delay until DOMContentLoaded so config.js has been parsed first.
  let frontendDisplayLoadTimer = null;
  let frontendDisplayLoadAttempts = 0;
  function ensureFrontendDisplayController(){
    if(window.NagaFrontendDisplay || document.querySelector('script[data-naga-frontend-display-loader]')) return;

    // Most pages load site-shell.js before config.js. On those pages the old
    // loader could fetch frontend-display.js before NAGA_CONFIG/NAGA_API existed,
    // causing its first API request to have an empty URL. index.html worked only
    // because it also loaded frontend-display.js explicitly after config.js.
    // Wait until the shared API config is ready so BO display settings behave the
    // same on every frontend page.
    const hasApiConfig = !!(
      (window.NAGA_API && window.NAGA_API.frontendDisplaySetting) ||
      (window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl)
    );
    if(!hasApiConfig && frontendDisplayLoadAttempts < 80){
      frontendDisplayLoadAttempts += 1;
      clearTimeout(frontendDisplayLoadTimer);
      frontendDisplayLoadTimer = setTimeout(ensureFrontendDisplayController, 50);
      return;
    }

    const script=document.createElement('script');
    script.src='assets/js/frontend-display.js?v=1.0.8';
    script.async=false;
    script.setAttribute('data-naga-frontend-display-loader','1');
    script.onload=function(){
      if(window.NagaFrontendDisplay && typeof window.NagaFrontendDisplay.refresh === 'function'){
        window.NagaFrontendDisplay.refresh({force:true});
      }
    };
    document.head.appendChild(script);
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',ensureFrontendDisplayController,{once:true});
  }else{
    ensureFrontendDisplayController();
  }


  function openMenu(){
    createSideMenu();
    const overlay = document.getElementById('mobileSideMenu');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden','false');
    document.body.classList.add('mobile-menu-open');
  }

  function closeMenu(){
    const overlay = document.getElementById('mobileSideMenu');
    if(!overlay) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden','true');
    document.body.classList.remove('mobile-menu-open');
  }

  function bindMenu(){
    document.addEventListener('click', function(e){
      // The main logo always returns to Home. Template switching is handled by
      // the dedicated icon beside the logo, so the two actions never conflict.
      const logo = e.target.closest && e.target.closest('.top-header .site-logo');
      if(logo){
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation && e.stopImmediatePropagation();
        window.location.href = 'index.html';
        return;
      }
      const logoutBtn = e.target.closest && e.target.closest('[data-member-logout]');
      if(logoutBtn){
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation && e.stopImmediatePropagation();
        doShellLogout();
        window.location.href = 'index.html';
        return;
      }
      const homeLink = e.target.closest && e.target.closest('.bottom-nav a:first-child');
      if(homeLink){
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation && e.stopImmediatePropagation();
        openMenu();
        return;
      }
      if(e.target.closest && e.target.closest('[data-menu-close]')) closeMenu();
      if(e.target.closest && e.target.closest('#sideLangBtn')){
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation && e.stopImmediatePropagation();
        const targetLang = isCurrentZh() ? 'en' : 'zh';
        const sideBtn = document.getElementById('sideLangBtn');
        if(sideBtn){ sideBtn.classList.add('switching'); }
        if(window.I18N && typeof window.I18N.switchAndReload === 'function'){
          // Persist + reload instead of refreshing every BO-driven module in-place.
          // This prevents Bonus/VIP/catalog/site-customize from briefly becoming empty.
          window.I18N.switchAndReload(targetLang);
        }else{
          // Safe fallback for pages where lang.js has not initialized yet.
          localStorage.setItem('site_lang', targetLang);
          localStorage.setItem('lang', targetLang);
          document.documentElement.lang = targetLang === 'zh' ? 'zh-CN' : 'en';
          window.location.reload();
        }
        return;
      }
    }, true);
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeMenu(); });
    document.addEventListener('i18n:changed', function(){
      updateSideLangLabel();
      translateShellScope(document.querySelector('.top-header'));
      translateShellScope(document.querySelector('#mobileSideMenu .mobile-menu-panel'));
    });
  }


  /*
   * VIP claim reminder
   * ------------------
   * The mobile sidebar can be replaced at runtime by BO -> Layout Section
   * (frontend-sidebar).  Do not rely on a hard-coded sidebar DOM node.  Instead,
   * locate the current VIP link after every layout replacement and attach the
   * reminder badge to whatever markup BO supplied.
   */
  var vipClaimReminderCount = 0;
  var vipClaimReminderTimer = null;
  var vipClaimReminderObserver = null;
  var vipClaimReminderRequest = null;

  function vipApiBase(){
    var cfg = window.NAGA_CONFIG && window.NAGA_CONFIG.api;
    return String((cfg && cfg.baseUrl) || 'https://bo.titanx7.com').replace(/\/+$/, '');
  }

  function isVipHref(anchor){
    if(!anchor) return false;
    var href = String(anchor.getAttribute('href') || '').trim();
    if(!href) return false;
    try{
      var url = new URL(href, window.location.href);
      return /(^|\/)vip\.html$/i.test(url.pathname || '');
    }catch(e){
      return /(^|\/)vip\.html(?:[?#].*)?$/i.test(href);
    }
  }

  function currentVipSidebarLinks(){
    var roots = [
      document.querySelector('#mobileSideMenu .mobile-menu-panel'),
      document.querySelector('[data-layout-section="frontend-sidebar"]')
    ].filter(Boolean);
    var seen = new Set(), links = [];
    roots.forEach(function(root){
      root.querySelectorAll('a[href]').forEach(function(a){
        if(isVipHref(a) && !seen.has(a)){
          seen.add(a);
          links.push(a);
        }
      });
    });
    return links;
  }

  function renderVipClaimReminder(){
    var loggedIn = isLoggedIn();
    currentVipSidebarLinks().forEach(function(link){
      link.classList.add('naga-vip-reminder-link');
      var badge = link.querySelector(':scope > .naga-vip-claim-badge');
      if(!loggedIn || vipClaimReminderCount <= 0){
        if(badge) badge.remove();
        link.classList.remove('has-vip-claim-reminder');
        link.removeAttribute('data-vip-claim-count');
        return;
      }
      if(!badge){
        badge = document.createElement('span');
        badge.className = 'naga-vip-claim-badge';
        badge.setAttribute('aria-hidden','true');
        link.appendChild(badge);
      }
      var display = vipClaimReminderCount > 99 ? '99+' : String(vipClaimReminderCount);
      if(badge.textContent !== display) badge.textContent = display;
      badge.title = vipClaimReminderCount + ' VIP reward' + (vipClaimReminderCount === 1 ? '' : 's') + ' ready to claim';
      link.classList.add('has-vip-claim-reminder');
      link.setAttribute('data-vip-claim-count', String(vipClaimReminderCount));
    });
  }

  function isSidebarVipStepClaim(row){
    if(!row || String(row.status || '').toUpperCase() !== 'AVAILABLE') return false;

    // The Level Bonus screen renders Claim buttons only for STEP_BONUS rows
    // whose period keys are STEP-<levelKey>-<stepId>.  The states endpoint also
    // returns UPGRADE_BONUS rows; counting those made the sidebar badge larger
    // than the number of Claim buttons the player can actually see.
    var rewardType = String(row.rewardType || '').toUpperCase();
    var periodKey = String(row.periodKey || '').toUpperCase();
    return rewardType === 'STEP_BONUS' && periodKey.indexOf('STEP-') === 0;
  }

  function setVipClaimReminderRows(rows){
    var list = Array.isArray(rows) ? rows : [];
    vipClaimReminderCount = list.reduce(function(total, row){
      return total + (isSidebarVipStepClaim(row) ? 1 : 0);
    }, 0);
    renderVipClaimReminder();
    try{
      document.dispatchEvent(new CustomEvent('naga:vip-claim-reminder-updated', {
        detail: { count: vipClaimReminderCount }
      }));
    }catch(e){}
  }

  function refreshVipClaimReminder(force){
    var token = getToken();
    if(!token){
      vipClaimReminderCount = 0;
      renderVipClaimReminder();
      return Promise.resolve([]);
    }
    if(vipClaimReminderRequest && !force) return vipClaimReminderRequest;
    var url = vipApiBase() + '/api/player/vip/rewards/states?_sidebar_vip=' + Date.now();
    vipClaimReminderRequest = fetch(url, {
      cache: 'no-store',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(json){ return {res:res,json:json}; });
    }).then(function(pair){
      if(pair.res.status === 401 || pair.res.status === 403){
        vipClaimReminderCount = 0;
        renderVipClaimReminder();
        return [];
      }
      if(!pair.res.ok || !pair.json || pair.json.status === 'error') throw new Error((pair.json && pair.json.message) || 'VIP reward state unavailable');
      var rows = Array.isArray(pair.json.data) ? pair.json.data : [];
      setVipClaimReminderRows(rows);
      return rows;
    }).catch(function(err){
      // A temporary API/network failure must not destroy the last known badge.
      console.warn('[VIP Reminder] Unable to refresh claim state:', err && err.message ? err.message : err);
      renderVipClaimReminder();
      return [];
    }).then(function(rows){
      vipClaimReminderRequest = null;
      return rows;
    }, function(err){
      vipClaimReminderRequest = null;
      throw err;
    });
    return vipClaimReminderRequest;
  }

  function scheduleVipClaimReminder(){
    if(vipClaimReminderTimer) clearInterval(vipClaimReminderTimer);
    vipClaimReminderTimer = setInterval(function(){
      if(document.visibilityState === 'visible') refreshVipClaimReminder(false);
    }, 60000);
  }

  function observeVipSidebarReplacement(){
    if(vipClaimReminderObserver) return;
    var queued = false;
    vipClaimReminderObserver = new MutationObserver(function(){
      if(queued) return;
      queued = true;
      requestAnimationFrame(function(){
        queued = false;
        renderVipClaimReminder();
      });
    });
    vipClaimReminderObserver.observe(document.body || document.documentElement, {childList:true, subtree:true});
  }

  function initVipClaimReminder(){
    observeVipSidebarReplacement();
    renderVipClaimReminder();
    refreshVipClaimReminder(true);
    scheduleVipClaimReminder();
    document.addEventListener('naga:layout-section-applied', function(e){
      if(!e || !e.detail || e.detail.sectionKey === 'frontend-sidebar') renderVipClaimReminder();
    });
    document.addEventListener('naga:layout-section-restored', function(e){
      if(!e || !e.detail || e.detail.sectionKey === 'frontend-sidebar') renderVipClaimReminder();
    });
    document.addEventListener('naga:layout-sections-loaded', renderVipClaimReminder);
    document.addEventListener('naga:site-shell-customized', renderVipClaimReminder);
    document.addEventListener('naga:vip-claim-states-updated', function(e){
      if(e && e.detail && Array.isArray(e.detail.rows)) setVipClaimReminderRows(e.detail.rows);
      else refreshVipClaimReminder(true);
    });
    document.addEventListener('naga:member-session-refreshed', function(){ refreshVipClaimReminder(true); });
    window.addEventListener('pageshow', function(){ refreshVipClaimReminder(true); });
    window.addEventListener('focus', function(){ refreshVipClaimReminder(false); });
    window.addEventListener('storage', function(e){
      if(!e || e.key === 'member_token') refreshVipClaimReminder(true);
    });
  }

  function rehydrateShell(){
    const header = document.querySelector('.top-header');
    if(header){
      header.setAttribute('data-layout-section', 'frontend-header');
      header.dataset.shellReady = '1';
    }
    const panel = document.querySelector('#mobileSideMenu .mobile-menu-panel');
    if(panel) panel.setAttribute('data-layout-section', 'frontend-sidebar');
    refreshHeaderAuth();
    updateSideLangLabel();
    var cached = getStoredBalance();
    if(getToken() && cached !== null) setAllWalletText(cached);
    // Re-applying BO header HTML keeps the last confirmed amount while the
    // current balance is refreshed in the background.
    refreshShellBalance();
    translateShellScope(header);
    translateShellScope(panel);
    ensureWebsiteTemplateSwitchButton();
    renderVipClaimReminder();
  }



  function syncCustomGeneratedPageViewport(){
    if(!document.body || !document.body.classList.contains('custom-generated-page')) return;
    var root = document.documentElement;
    var main = document.querySelector('.pc-page-main');
    var header = document.querySelector('.top-header');
    var nav = document.querySelector('.bottom-nav');
    if(!main) return;
    root.classList.add('pc-custom-page-root');
    function apply(){
      var vh = window.visualViewport && window.visualViewport.height ? window.visualViewport.height : window.innerHeight;
      var top = 0;
      var bottom = 0;
      if(header){
        var hr = header.getBoundingClientRect();
        top = Math.max(0, Math.round(hr.bottom));
        // Page Customize pages place the global BO-controlled marquee directly
        // below the normal top header. Use the marquee bottom edge as the real
        // content start so generated pages never render underneath it.
        var marquee = document.getElementById('nagaGlobalMarquee');
        if(marquee && getComputedStyle(marquee).display !== 'none'){
          var mr = marquee.getBoundingClientRect();
          top = Math.max(top, Math.round(mr.bottom));
        }
      }
      if(!top) top = window.matchMedia('(max-width:768px)').matches ? 57 : 69;
      if(nav){
        var nr = nav.getBoundingClientRect();
        bottom = Math.max(0, Math.round(vh - nr.top));
        if(bottom < 40 || bottom > 140) bottom = Math.round(nr.height || 57);
      }
      if(!bottom) bottom = 57;
      root.style.setProperty('--pc-page-top', top + 'px');
      root.style.setProperty('--pc-page-bottom', bottom + 'px');
      main.style.setProperty('overflow-y','scroll','important');
      main.style.setProperty('overscroll-behavior-y','contain','important');
      main.style.setProperty('-webkit-overflow-scrolling','touch','important');
      main.style.setProperty('touch-action','pan-y','important');
    }
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply,120);
    setTimeout(apply,500);
    setTimeout(apply,1200);
    window.addEventListener('resize', apply, {passive:true});
    window.addEventListener('orientationchange', apply, {passive:true});
    if(window.visualViewport) window.visualViewport.addEventListener('resize', apply, {passive:true});
    document.addEventListener('naga:layout-sections-loaded', apply);
    document.addEventListener('naga:layout-section-applied', apply);
    if(window.ResizeObserver){
      var ro = new ResizeObserver(apply);
      if(header) ro.observe(header);
      if(nav) ro.observe(nav);
    }
  }

  function init(){
    syncCustomGeneratedPageViewport();
    enhanceHeader();
    initWebsiteTemplateSelector();
    createSideMenu();
    bindMenu();
    window.addEventListener('storage', refreshHeaderAuth);
    document.addEventListener('click', function(e){
      if(e.target.closest && e.target.closest('[data-member-logout]')) setTimeout(refreshHeaderAuth, 80);
    });
    refreshHeaderAuth();
    scheduleBalanceRefresh();
    startPresence();
    initVipClaimReminder();
    document.dispatchEvent(new CustomEvent('naga:site-shell-ready'));
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.NAGA_SITE_SHELL = { refreshHeaderAuth: refreshHeaderAuth, refreshBalance: refreshShellBalance, refreshMemberToken: refreshMemberToken, openMenu: openMenu, closeMenu: closeMenu, logout: doShellLogout, rehydrate: rehydrateShell, refreshVipClaimReminder: refreshVipClaimReminder, openWebsiteTemplateSelector: openWebsiteTemplateSelector, closeWebsiteTemplateSelector: closeWebsiteTemplateSelector };
})();
