(function(){
  'use strict';

  /*
   * Frontend Display state must come from the CURRENT BO/API response.
   * Do not pre-decide Home Bonus from localStorage. The previous implementation
   * saved a false value and then reused it on the next refresh before the brand
   * context/API request had settled, which made the first refresh show and the
   * following refresh disappear.
   */
  const LEADERBOARD_STORAGE_KEY = 'naga_leaderboard_enabled';

  function normalizeEnabled(value, defaultValue){
    if(value === undefined || value === null || value === '') return defaultValue !== false;
    if(value === false || value === 0) return false;
    const text = String(value).trim().toLowerCase();
    return !['0','false','disabled','disable','off','no'].includes(text);
  }

  function unwrapPayload(payload){
    if(payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'){
      return payload.data;
    }
    return payload && typeof payload === 'object' ? payload : {};
  }

  function extractHomeBonusEnabled(payload){
    const data = unwrapPayload(payload);
    const candidates = [
      data.homeBonusEnabled,
      data.home_bonus_enabled,
      data.bonusEnabled,
      data.bonusDisplayEnabled
    ];
    const value = candidates.find(v => v !== undefined && v !== null);
    return normalizeEnabled(value, true);
  }

  function extractLeaderboardEnabled(payload){
    const data = unwrapPayload(payload);
    const candidates = [
      data.leaderboardEnabled,
      data.leaderboard_enabled,
      data.showLeaderboard,
      data.leaderboardDisplayEnabled
    ];
    const value = candidates.find(v => v !== undefined && v !== null);
    return normalizeEnabled(value, true);
  }

  function extractVipSidebarEnabled(payload){
    const data = unwrapPayload(payload);
    const candidates = [data.vipSidebarEnabled, data.vip_sidebar_enabled, data.showVipInSidebar];
    const value = candidates.find(v => v !== undefined && v !== null);
    return normalizeEnabled(value, true);
  }

  function setStorage(key, enabled){
    try{ localStorage.setItem(key, enabled ? '1' : '0'); }catch(e){}
  }

  function getStorage(key, defaultValue){
    try{
      const value = localStorage.getItem(key);
      if(value === null) return defaultValue;
      return value === '1';
    }catch(e){ return defaultValue; }
  }

  function currentApiUrl(){
    const configured = window.NAGA_API && window.NAGA_API.frontendDisplaySetting;
    if(configured) return String(configured);
    const base = (window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) || '';
    return base ? String(base).replace(/\/+$/,'') + '/api/frontend/display-setting' : '';
  }

  function brandDomain(){
    return String((window.NAGA_BRAND && window.NAGA_BRAND.domain) || location.hostname || '')
      .trim().toLowerCase();
  }

  function applyHomeBonus(enabled, source){
    const isEnabled = enabled !== false;
    window.NAGA_HOME_BONUS_ENABLED = isEnabled;

    /* One authoritative state marker. Final CSS uses only this marker. */
    document.documentElement.dataset.homeBonusEnabled = isEnabled ? '1' : '0';
    document.documentElement.classList.toggle('home-bonus-disabled', !isEnabled);
    if(document.body){
      document.body.classList.toggle('home-bonus-disabled', !isEnabled);
    }

    document.querySelectorAll('[data-home-bonus-display]').forEach(el => {
      el.hidden = !isEnabled;
      el.setAttribute('aria-hidden', isEnabled ? 'false' : 'true');
    });

    document.dispatchEvent(new CustomEvent('naga:home-bonus-display', {
      detail:{ enabled:isEnabled, source:source || 'unknown' }
    }));
  }

  function applyLeaderboard(enabled, source){
    const isEnabled = enabled === true;
    window.NAGA_LEADERBOARD_ENABLED = isEnabled;
    document.documentElement.classList.toggle('leaderboard-disabled', !isEnabled);
    if(document.body) document.body.classList.toggle('leaderboard-disabled', !isEnabled);

    document.querySelectorAll('[data-leaderboard-menu]').forEach(el => {
      el.hidden = !isEnabled;
      if(isEnabled) el.style.removeProperty('display');
      else el.style.display = 'none';
      el.setAttribute('aria-hidden', isEnabled ? 'false' : 'true');
    });
    setStorage(LEADERBOARD_STORAGE_KEY, isEnabled);
    document.dispatchEvent(new CustomEvent('naga:leaderboard-visibility', {
      detail:{ enabled:isEnabled, source:source || 'unknown' }
    }));
  }

  function applyVipSidebar(enabled, source){
    const isEnabled = enabled !== false;
    window.NAGA_VIP_SIDEBAR_ENABLED = isEnabled;
    document.documentElement.classList.toggle('vip-sidebar-disabled', !isEnabled);
    if(document.body) document.body.classList.toggle('vip-sidebar-disabled', !isEnabled);
    document.querySelectorAll('[data-vip-menu], .mobile-menu-list a[href="vip.html"], .mobile-menu-list a[href$="/vip.html"]').forEach(el => {
      el.hidden = !isEnabled;
      if(isEnabled) el.style.removeProperty('display'); else el.style.display='none';
      el.setAttribute('aria-hidden', isEnabled ? 'false' : 'true');
    });
    document.dispatchEvent(new CustomEvent('naga:vip-sidebar-visibility',{detail:{enabled:isEnabled,source:source||'unknown'}}));
  }

  function applySettings(payload, source){
    applyHomeBonus(extractHomeBonusEnabled(payload), source);
    applyLeaderboard(extractLeaderboardEnabled(payload), source);
    applyVipSidebar(extractVipSidebarEnabled(payload), source);
  }

  function cachedLeaderboard(){
    return getStorage(LEADERBOARD_STORAGE_KEY, true);
  }

  let refreshPromise = null;
  let lastPayload = null;
  let lastSuccessAt = 0;
  let retryTimer = null;
  let retryCount = 0;
  const REFRESH_DEDUPE_MS = 1500;
  const MAX_RETRY_COUNT = 12;

  async function waitForBrand(){
    try{
      if(window.NAGA_BRAND && window.NAGA_BRAND.ready){
        await window.NAGA_BRAND.ready;
      }
    }catch(e){}
  }

  async function refresh(options){
    if(refreshPromise) return refreshPromise;
    const force = !!(options && options.force);
    if(!force && lastPayload && (Date.now() - lastSuccessAt) < REFRESH_DEDUPE_MS) return lastPayload;

    refreshPromise = (async function(){
      try{
        /* Brand bootstrap must finish BEFORE choosing endpoint/request identity. */
        await waitForBrand();

        let apiUrl = currentApiUrl();
        if(!apiUrl) throw new Error('Frontend display setting API URL is empty');
        const separator = apiUrl.indexOf('?') >= 0 ? '&' : '?';
        apiUrl += separator + '_nagaDisplayTs=' + Date.now();

        const headers = {
          'Accept':'application/json',
          'Cache-Control':'no-cache, no-store, must-revalidate',
          'Pragma':'no-cache'
        };
        const domain = brandDomain();
        if(domain) headers['X-Brand-Domain'] = domain;

        const response = await fetch(apiUrl, {
          method:'GET',
          credentials:'omit',
          cache:'no-store',
          headers:headers
        });
        if(!response.ok) throw new Error('HTTP ' + response.status);

        const payload = await response.json();
        if(payload && String(payload.status || '').toLowerCase() === 'error'){
          throw new Error(payload.message || 'Frontend display setting API error');
        }

        applySettings(payload, 'api');
        retryCount = 0;
        clearTimeout(retryTimer);
        lastPayload = payload;
        lastSuccessAt = Date.now();
        return payload;
      }catch(error){
        /*
         * IMPORTANT: Home Bonus does NOT fall back to an old stored Disabled value.
         * On request failure we keep the current DOM/default state. This prevents a
         * stale refresh from permanently hiding an Enabled BO setting.
         */
        console.warn('Frontend display setting load failed; preserving current display state.', error);
        applyLeaderboard(cachedLeaderboard(), 'cache-fallback');

        // Internal pages may initialize before brand/config bootstrapping is fully
        // ready. Retry instead of permanently leaving VIP at its default visible
        // state after one early failed request.
        if(retryCount < MAX_RETRY_COUNT){
          retryCount += 1;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(function(){ refresh({force:true}); }, Math.min(250 * retryCount, 1500));
        }
        return null;
      }finally{
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function reapplyVisibility(){
    if(window.NAGA_HOME_BONUS_ENABLED !== undefined){
      applyHomeBonus(window.NAGA_HOME_BONUS_ENABLED, 'dom-reapply');
    }
    applyLeaderboard(
      window.NAGA_LEADERBOARD_ENABLED !== undefined ? window.NAGA_LEADERBOARD_ENABLED : cachedLeaderboard(),
      'dom-reapply'
    );
    if(window.NAGA_VIP_SIDEBAR_ENABLED !== undefined) applyVipSidebar(window.NAGA_VIP_SIDEBAR_ENABLED, 'dom-reapply');
  }

  document.addEventListener('naga:layout-section-applied', reapplyVisibility);
  document.addEventListener('naga:site-shell-customized', reapplyVisibility);
  document.addEventListener('i18n:changed', reapplyVisibility);

  function init(){
    /* Home Bonus intentionally has NO cached/predefined visibility decision here. */
    applyLeaderboard(cachedLeaderboard(), 'initial-cache');
    refresh({force:true});
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init, {once:true});
  }else{
    init();
  }

  window.NagaFrontendDisplay = {
    refresh:refresh,
    applySettings:applySettings,
    applyHomeBonus:applyHomeBonus,
    applyLeaderboard:applyLeaderboard,
    applyVipSidebar:applyVipSidebar,
    reapplySidebarVisibility:reapplyVisibility
  };
})();
