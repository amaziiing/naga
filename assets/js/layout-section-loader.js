(function () {
  'use strict';

  const GLOBAL_CSS_SECTION = 'home';
  const sectionPromises = new Map();
  const executedJs = new Set();
  const authoritativeSections = new Map();
  const sectionObservers = new Map();
  const CACHE_PREFIX = 'naga_layout_section_v3:';

  function brandHeaders(extra) {
    const headers = new Headers(extra || {});
    const host = String(location.hostname || '').toLowerCase();
    if (host) headers.set('X-Brand-Domain', host);
    return headers;
  }
  let initialized = false;
  let shellReadySeen = false;
  let freshHeaderLoaded = false;
  let customAssetsReady = !!window.__NAGA_CUSTOM_ASSETS_READY__;
  const criticalReadyParts = new Set();

  function isCriticalSection(sectionKey) {
    return sectionKey === 'home' || sectionKey === 'frontend-header' || sectionKey === 'frontend-sidebar';
  }

  function criticalSectionHasContent(sectionKey, data) {
    data = data || {};
    if (sectionKey === 'frontend-header' || sectionKey === 'frontend-sidebar') {
      return !!String(data.html || '').trim();
    }
    if (sectionKey === 'home') {
      return !!(String(data.css || '').trim() || String(data.html || '').trim() || String(data.js || '').trim());
    }
    return true;
  }

  function markCriticalPart(sectionKey, data) {
    if (!isCriticalSection(sectionKey) || !criticalSectionHasContent(sectionKey, data)) return;
    criticalReadyParts.add(sectionKey);
    if (criticalReadyParts.has('home') && criticalReadyParts.has('frontend-header')) {
      if (!window.__NAGA_CRITICAL_LAYOUT_READY__) {
        window.__NAGA_CRITICAL_LAYOUT_READY__ = true;
        document.dispatchEvent(new CustomEvent('naga:critical-layout-ready'));
      }
    }
  }


  // The HTML/CSS bundled with Naga is a complete safe fallback. BO Layout is an
  // enhancement, not a prerequisite for rendering the site. If BO temporarily
  // returns an empty brand section (or the brand has not seeded Layout Section
  // rows yet), keep the existing static markup and release the page loader.
  // This prevents the header/sidebar/home design from looking blank after a hard
  // refresh while still allowing a later valid BO response to replace it.
  function markCriticalFallbackReady(sectionKey) {
    if (!isCriticalSection(sectionKey)) return;
    criticalReadyParts.add(sectionKey);

    if (sectionKey === 'frontend-header') {
      freshHeaderLoaded = true;
      const root = document.documentElement;
      const alreadyReady = root.classList.contains('naga-header-ready');
      root.classList.add('naga-header-ready');
      window.__NAGA_HEADER_READY__ = true;
      if (!alreadyReady) {
        try { document.dispatchEvent(new CustomEvent('naga:header-ready')); } catch (_) {}
      }
    }

    if (criticalReadyParts.has('home') && criticalReadyParts.has('frontend-header')) {
      if (!window.__NAGA_CRITICAL_LAYOUT_READY__) {
        window.__NAGA_CRITICAL_LAYOUT_READY__ = true;
        try { document.dispatchEvent(new CustomEvent('naga:critical-layout-ready')); } catch (_) {}
      }
    }
  }

  function markHeaderReady() {
    if (!freshHeaderLoaded || !customAssetsReady) return;
    const root = document.documentElement;
    const header = document.querySelector('.top-header');
    let sent = root.classList.contains('naga-header-ready');
    const finish = function () {
      root.classList.add('naga-header-ready');
      if (!sent) {
        sent = true;
        window.__NAGA_HEADER_READY__ = true;
        try { document.dispatchEvent(new CustomEvent('naga:header-ready')); } catch (_) {}
      }
    };
    if (!header) { finish(); return; }
    const logo = header.querySelector('.site-logo, .logo-box img');
    if (!logo) { finish(); return; }
    try { logo.loading = 'eager'; logo.fetchPriority = 'high'; } catch (_) {}
    if (logo.complete) { finish(); return; }
    logo.addEventListener('load', finish, { once: true });
    logo.addEventListener('error', finish, { once: true });
    setTimeout(finish, 550);
  }

  function cacheKey(sectionKey) {
    return CACHE_PREFIX + sectionKey;
  }

  function readCachedSection(sectionKey) {
    try {
      const raw = localStorage.getItem(cacheKey(sectionKey));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const normalized = normalizeData(parsed.data || parsed);
      // Older builds could cache an HTTP-200 but empty BO response. Never restore
      // that poisoned entry on a hard refresh; discard it and wait for a valid
      // last-known-good section instead.
      if (isCriticalSection(sectionKey) && !criticalSectionHasContent(sectionKey, normalized)) {
        try { localStorage.removeItem(cacheKey(sectionKey)); } catch (_) {}
        return null;
      }
      return normalized;
    } catch (_) {
      return null;
    }
  }

  function writeCachedSection(sectionKey, data) {
    try {
      const normalized = normalizeData(data);
      // Do not preserve a previous critical customization after BO explicitly
      // clears that section. The bundled frontend then becomes the clean fallback.
      if (isCriticalSection(sectionKey) && !criticalSectionHasContent(sectionKey, normalized)) {
        localStorage.removeItem(cacheKey(sectionKey));
        return;
      }
      localStorage.setItem(cacheKey(sectionKey), JSON.stringify({
        savedAt: Date.now(),
        data: normalized
      }));
    } catch (_) {}
  }

  function endpoint() {
    if (window.NAGA_API && window.NAGA_API.layoutSection) return window.NAGA_API.layoutSection;
    const base = window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl;
    return String(base || 'https://bo.titanx7.com').replace(/\/+$/, '') + '/api/customize/section';
  }

  function normalizeData(json) {
    const data = (json && json.data) || json || {};
    return {
      html: data.html == null ? '' : String(data.html),
      css: data.css == null ? '' : String(data.css),
      js: data.js == null ? '' : String(data.js),
      cssUrl: data.cssUrl == null ? '' : String(data.cssUrl),
      htmlUrl: data.htmlUrl == null ? '' : String(data.htmlUrl),
      jsUrl: data.jsUrl == null ? '' : String(data.jsUrl)
    };
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function requestSectionOnce(sectionKey) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { try { controller.abort(); } catch (_) {} }, 2800) : 0;
    try {
      const response = await fetch(endpoint() + '?key=' + encodeURIComponent(sectionKey) + '&_=' + Date.now(), {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller ? controller.signal : undefined,
        headers: brandHeaders({
          Accept: 'application/json',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache'
        })
      });
      const json = await response.json().catch(function () { return {}; });
      if (!response.ok || (json && json.status === 'error')) {
        throw new Error((json && json.message) || ('Unable to load layout section: ' + sectionKey));
      }
      const normalized = normalizeData(json);
      // A successful BO response is authoritative even when the section is empty.
      // Empty is a valid state when an admin intentionally removes Layout Section
      // CSS/JS/HTML. Older builds treated an empty `home` response as a failure
      // and restored stale localStorage CSS, which made online differ from localhost.
      normalized.__authoritative = true;
      return normalized;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchSection(sectionKey, force) {
    // A startup section must have only one in-flight request. Previously the
    // DOMContentLoaded initializer and naga:site-shell-ready could start two
    // forced requests for the same Header/Sidebar; whichever finished last won.
    if (sectionPromises.has(sectionKey)) return sectionPromises.get(sectionKey);

    const request = (async function () {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const normalized = await requestSectionOnce(sectionKey);
          writeCachedSection(sectionKey, normalized);
          return normalized;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await wait(attempt === 0 ? 180 : 520);
        }
      }

      // Never replace a known-good BO layout with empty fallback markup just
      // because one refresh hit a transient API/network failure. Use the last
      // successfully saved BO section and refresh it on the next navigation.
      const cached = readCachedSection(sectionKey);
      if (cached) {
        console.warn('[Layout Section] fresh request failed; using cached', sectionKey,
          lastError && lastError.message ? lastError.message : lastError);
        return cached;
      }
      console.warn('[Layout Section] BO section unavailable; keeping bundled frontend layout:', sectionKey, lastError && lastError.message ? lastError.message : lastError);
      return { html: '', css: '', js: '', __unavailable: true };
    })();

    sectionPromises.set(sectionKey, request);
    request.finally(function () {
      if (sectionPromises.get(sectionKey) === request) sectionPromises.delete(sectionKey);
    });
    return request;
  }

  function ensureHomeLayoutSafetyCss() {
    let safetyStyle = document.getElementById('naga-home-layout-safety');
    if (!safetyStyle) {
      safetyStyle = document.createElement('style');
      safetyStyle.id = 'naga-home-layout-safety';
    }

    safetyStyle.textContent = `
      /* Keep BO Layout Section styling inside the available desktop viewport. */
      @media (min-width: 901px) {
        body.home-page .main-layout {
          width: 100% !important;
          max-width: 100vw !important;
          grid-template-columns: 400px minmax(0, 1fr) 400px !important;
          overflow: hidden !important;
        }

        body.home-page .left-sidebar,
        body.home-page .center-content,
        body.home-page .right-panel {
          min-width: 0 !important;
          max-width: 100% !important;
        }

        body.home-page .right-panel {
          padding-left: 20px !important;
          padding-right: 20px !important;
          overflow: hidden !important;
        }

        body.home-page .right-content-box {
          width: 100% !important;
          min-width: 0 !important;
          max-width: 350px !important;
          margin-left: auto !important;
          margin-right: auto !important;
          flex: 0 1 350px !important;
        }

        body.home-page .right-content-box .balance-box {
          width: 100% !important;
          min-width: 0 !important;
          max-width: 350px !important;
          grid-template-columns: minmax(0, 1fr) minmax(108px, 132px) !important;
          gap: 10px !important;
        }

        body.home-page .right-content-box .money-btns {
          width: 100% !important;
          min-width: 0 !important;
          max-width: 132px !important;
        }

        body.home-page .right-content-box .money-btns button,
        body.home-page .right-content-box .money-btns button img {
          width: 100% !important;
          min-width: 0 !important;
          max-width: 132px !important;
        }
      }

      @media (min-width: 901px) and (max-width: 1280px) {
        body.home-page .main-layout {
          grid-template-columns: 400px minmax(0, 1fr) 400px !important;
        }

        body.home-page .right-panel {
          padding-left: 10px !important;
          padding-right: 10px !important;
        }

        body.home-page .right-content-box .balance-box {
          padding-left: 12px !important;
          padding-right: 12px !important;
          grid-template-columns: minmax(0, 1fr) minmax(104px, 120px) !important;
          gap: 8px !important;
        }
      }
    `;

    // Re-append it so these geometry guards remain after BO-provided custom CSS.
    document.head.appendChild(safetyStyle);
  }

  // BO sidebar HTML is stored as one language-neutral template. It may contain
  // English fallback text together with data-i18n attributes. Because the Layout
  // Section request and the language JSON load asynchronously, the sidebar can be
  // replaced *after* I18N has already translated the page. In that race the raw
  // English fallback used to remain visible until the user changed language again.
  // Translate only the freshly inserted sidebar subtree without dispatching another
  // global i18n:changed event (which would unnecessarily reload language-aware data).
  function translateLayoutTarget(target, sectionKey) {
    if (!target || ['frontend-header','frontend-sidebar','login-page','register-page'].indexOf(sectionKey) < 0) return;
    if (!window.I18N || typeof window.I18N.t !== 'function' || !window.I18N.dict) return;

    function translated(key) {
      if (!key) return '';
      try {
        const value = window.I18N.t(key);
        return value == null ? '' : String(value);
      } catch (_) {
        return '';
      }
    }

    function nodes(selector) {
      const list = [];
      if (target.matches && target.matches(selector)) list.push(target);
      if (target.querySelectorAll) list.push.apply(list, target.querySelectorAll(selector));
      return list;
    }

    nodes('[data-i18n]').forEach(function (el) {
      const value = translated(el.getAttribute('data-i18n'));
      if (value) el.textContent = value;
    });
    nodes('[data-i18n-html]').forEach(function (el) {
      const value = translated(el.getAttribute('data-i18n-html'));
      if (value) el.innerHTML = value;
    });
    nodes('[data-i18n-placeholder]').forEach(function (el) {
      const value = translated(el.getAttribute('data-i18n-placeholder'));
      if (value) el.setAttribute('placeholder', value);
    });
    nodes('[data-i18n-alt]').forEach(function (el) {
      const value = translated(el.getAttribute('data-i18n-alt'));
      if (value) el.setAttribute('alt', value);
    });
    nodes('[data-i18n-title]').forEach(function (el) {
      const value = translated(el.getAttribute('data-i18n-title'));
      if (value) el.setAttribute('title', value);
    });
    nodes('[data-i18n-aria-label]').forEach(function (el) {
      const value = translated(el.getAttribute('data-i18n-aria-label'));
      if (value) el.setAttribute('aria-label', value);
    });
  }

  function brandAssetBaseFromSection(data) {
    const cssUrl = data && data.cssUrl ? String(data.cssUrl) : '';
    // API returns e.g. https://bo.titanx7.com/api/public/custom-assets/2/sections/home.css
    // Use that authoritative brand-scoped path for every legacy custom image URL
    // inside saved Layout Section CSS. This prevents ../custom/images/... from
    // resolving against t1.titanx7.com and accidentally loading Brand 1 assets.
    const m = cssUrl.match(/^(https?:\/\/[^/]+\/api\/public\/custom-assets\/\d+)\/sections\/[^?#]+/i);
    return m ? m[1].replace(/\/+$/, '') : '';
  }

  function rewriteBrandAssetUrls(css, data) {
    const base = brandAssetBaseFromSection(data);
    if (!base || !css) return css || '';
    return String(css).replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, function (full, quote, raw) {
      let value = String(raw || '').trim();
      if (!value || /^(?:data:|blob:|https?:|\/\/)/i.test(value)) return full;
      const clean = value.replace(/\\/g, '/');
      const marker = 'custom/images/';
      const idx = clean.toLowerCase().lastIndexOf(marker);
      if (idx < 0) return full;
      const tail = clean.slice(idx + marker.length).replace(/^\/+/, '');
      if (!tail || tail.indexOf('..') !== -1) return full;
      return 'url("' + base + '/images/' + tail + '")';
    });
  }

  function applyCss(sectionKey, css, data) {
    let style = document.querySelector('style[data-layout-section-css="' + sectionKey + '"]');
    if (!css.trim()) {
      if (style) style.remove();
      if (sectionKey === GLOBAL_CSS_SECTION) ensureHomeLayoutSafetyCss();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('data-layout-section-css', sectionKey);
      document.head.appendChild(style);
    }
    style.textContent = rewriteBrandAssetUrls(css, data);
    if (sectionKey === GLOBAL_CSS_SECTION) ensureHomeLayoutSafetyCss();
  }


  function normalizeShellTextI18nHtml(html, sectionKey) {
    if (!html || (sectionKey !== 'frontend-header' && sectionKey !== 'frontend-sidebar')) return html;

    const template = document.createElement('template');
    template.innerHTML = html;

    // BO Layout is allowed to own the visual markup, but authentication wording
    // still follows the currently selected frontend language. Re-attach semantic
    // keys even when BO custom HTML omitted data-i18n attributes/classes.
    const logoutSelectors = [
      '[data-member-logout]',
      '.top-logout-btn',
      '.mobile-menu-list-logout',
      'button[id*="logout" i]',
      'a[id*="logout" i]',
      'button[class*="logout" i]',
      'a[class*="logout" i]'
    ];
    logoutSelectors.forEach(function(selector){
      template.content.querySelectorAll(selector).forEach(function(el){
        // Do not replace graphic-only controls; translate their accessibility label instead.
        if (el.querySelector('img') && !(el.textContent || '').trim()) {
          el.setAttribute('data-i18n-aria-label', 'logout');
          return;
        }
        el.setAttribute('data-i18n', 'logout');
      });
    });

    return template.innerHTML;
  }

  // BO owns the sidebar markup, but icon/chevron presentation roles must stay
  // independent. Preserve all BO classes and add semantic runtime classes only.
  // This also makes future BO-added menu items work without requiring the saved
  // Layout Section HTML to be migrated.
  function normalizeSidebarItemRolesHtml(html, sectionKey) {
    if (!html || sectionKey !== 'frontend-sidebar') return html;

    const template = document.createElement('template');
    template.innerHTML = html;
    const list = template.content.querySelector('.mobile-menu-list');
    if (!list) return template.innerHTML;

    Array.from(list.children).forEach(function (item) {
      if (!item || !item.matches || !item.matches('a,button')) return;
      const directIcons = Array.from(item.children).filter(function (child) {
        return child && child.tagName === 'I';
      });
      if (!directIcons.length) return;

      let chevron = directIcons.find(function (icon) {
        return icon.classList.contains('mobile-menu-arrow') ||
          icon.classList.contains('sidebar-item-chevron') ||
          icon.classList.contains('fa-chevron-right') ||
          icon.classList.contains('fa-angle-right');
      });
      if (!chevron && directIcons.length > 1) chevron = directIcons[directIcons.length - 1];

      directIcons.forEach(function (icon, index) {
        if (icon === chevron) {
          icon.classList.add('sidebar-item-chevron');
          icon.classList.remove('sidebar-item-icon');
        } else if (index === 0 || icon.classList.contains('mobile-menu-icon')) {
          icon.classList.add('sidebar-item-icon');
          icon.classList.remove('sidebar-item-chevron');
        }
      });
    });

    return template.innerHTML;
  }

  function normalizeAuthImageHtml(html, sectionKey) {
    if (!html || (sectionKey !== 'frontend-header' && sectionKey !== 'frontend-sidebar')) return html;

    const template = document.createElement('template');
    template.innerHTML = html;

    const isHeader = sectionKey === 'frontend-header';
    const items = [
      {
        selectors: isHeader
          ? ['a.top-login-btn', '.top-auth-actions a[href*="login"]']
          : ['a.mobile-login-btn', '.mobile-menu-auth a[href*="login"]'],
        src: 'assets/custom/images/login.png',
        alt: 'LOGIN',
        imgClass: isHeader ? 'header-auth-image header-login-image' : 'sidebar-auth-image sidebar-login-image'
      },
      {
        selectors: isHeader
          ? ['a.top-register-btn', '.top-auth-actions a[href*="register"]']
          : ['a.mobile-register-btn', '.mobile-menu-auth a[href*="register"]'],
        src: 'assets/custom/images/register.png',
        alt: 'REGISTER',
        imgClass: isHeader ? 'header-auth-image header-register-image' : 'sidebar-auth-image sidebar-register-image'
      }
    ];

    items.forEach(function (item) {
      let anchor = null;
      for (let i = 0; i < item.selectors.length && !anchor; i++) {
        anchor = template.content.querySelector(item.selectors[i]);
      }
      if (!anchor) return;

      anchor.classList.add('auth-image-link');
      anchor.setAttribute('aria-label', item.alt.charAt(0) + item.alt.slice(1).toLowerCase());
      anchor.removeAttribute('data-i18n');
      anchor.replaceChildren();

      const image = document.createElement('img');
      image.className = item.imgClass;
      image.src = item.src;
      image.alt = item.alt;
      image.decoding = 'async';
      image.loading = 'eager';
      anchor.appendChild(image);
    });

    return template.innerHTML;
  }

  function isAuthoritativePageSection(sectionKey) {
    return sectionKey === 'login-page' || sectionKey === 'register-page';
  }


  function normalizeAuthPageHtml(html, sectionKey) {
    if (!html || !isAuthoritativePageSection(sectionKey)) return html;

    const template = document.createElement('template');
    template.innerHTML = html;

    [
      { selector: '#loginForm', id: 'loginMessage' },
      { selector: '#registerForm', id: 'registerMessage' }
    ].forEach(function (config) {
      const form = template.content.querySelector(config.selector);
      if (!form) return;

      let message = form.querySelector('.auth-message');
      if (!message) {
        message = document.createElement('div');
        message.className = 'auth-message';
        const submit = form.querySelector('.submit-login, button[type="submit"]');
        if (submit) submit.insertAdjacentElement('afterend', message);
        else form.appendChild(message);
      }
      if (!message.id) message.id = config.id;
      message.setAttribute('role', 'alert');
      message.setAttribute('aria-live', 'polite');
    });

    // BO Layout can replace the complete Login/Register markup. Re-attach
    // semantic i18n keys to the known auth controls so BO styling/layout remains
    // authoritative while visible wording still follows the frontend language.
    function setI18n(selector, attr, key) {
      const el = template.content.querySelector(selector);
      if (el && !el.hasAttribute(attr)) el.setAttribute(attr, key);
    }

    template.content.querySelectorAll('[data-login-tab]').forEach(function (el) {
      const tab = (el.getAttribute('data-login-tab') || '').toLowerCase();
      if (tab === 'login' || tab === 'register') el.setAttribute('data-i18n', tab);
    });

    setI18n('#loginForm input[autocomplete="username"], #loginForm input[type="text"]', 'data-i18n-placeholder', 'username');
    setI18n('#loginForm input[autocomplete="current-password"], #loginForm input[type="password"]', 'data-i18n-placeholder', 'password');
    setI18n('#loginForm .forgot-link', 'data-i18n', 'forgot_password');
    setI18n('#loginForm .submit-login, #loginForm button[type="submit"]', 'data-i18n', 'login');

    setI18n('#registerForm input[autocomplete="name"]', 'data-i18n-placeholder', 'full_name');
    setI18n('#registerForm input[autocomplete="tel"], #registerForm input[type="phone"], #registerForm input[type="tel"]', 'data-i18n-placeholder', 'mobile_no');
    setI18n('#registerForm input[autocomplete="new-password"], #registerForm input[type="password"]', 'data-i18n-placeholder', 'password_6_20');
    setI18n('#registerForm input[autocomplete="off"]', 'data-i18n-placeholder', 'referrer_code_optional');
    const registerTextInputs = Array.from(template.content.querySelectorAll('#registerForm input[type="text"]'));
    registerTextInputs.forEach(function (el) {
      if (el.hasAttribute('data-i18n-placeholder')) return;
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      if (ph.indexOf('verification') >= 0 || ph.indexOf('code') >= 0) el.setAttribute('data-i18n-placeholder', 'verification_code');
    });
    setI18n('#registerForm .verify-btn', 'data-i18n', 'get_code');
    setI18n('#registerForm .submit-login, #registerForm button[type="submit"]', 'data-i18n', 'register');

    // Defensive fallback for BO-authored markup that does not preserve our
    // standard classes/autocomplete attributes. Match familiar visible wording
    // and field order, but never change the BO structure/styling itself.
    function normText(value){ return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
    template.content.querySelectorAll('button,a').forEach(function(el){
      const text = normText(el.textContent);
      if ((text === 'login' || text === 'log in' || text === '登录') && !el.hasAttribute('data-i18n')) el.setAttribute('data-i18n','login');
      else if ((text === 'register' || text === 'sign up' || text === '注册') && !el.hasAttribute('data-i18n')) el.setAttribute('data-i18n','register');
      else if ((text.indexOf('forgot password') >= 0 || text.indexOf('忘记密码') >= 0) && !el.hasAttribute('data-i18n')) el.setAttribute('data-i18n','forgot_password');
      else if ((text === 'get code' || text.indexOf('获取验证码') >= 0) && !el.hasAttribute('data-i18n')) el.setAttribute('data-i18n','get_code');
    });

    const loginInputs = Array.from(template.content.querySelectorAll('#loginForm input'));
    if (loginInputs[0] && !loginInputs[0].hasAttribute('data-i18n-placeholder')) loginInputs[0].setAttribute('data-i18n-placeholder','username');
    if (loginInputs[1] && !loginInputs[1].hasAttribute('data-i18n-placeholder')) loginInputs[1].setAttribute('data-i18n-placeholder','password');

    const regInputs = Array.from(template.content.querySelectorAll('#registerForm input')).filter(function(el){ return (el.type || '').toLowerCase() !== 'hidden'; });
    const fallbackKeys = ['full_name','mobile_no','password_6_20','referrer_code_optional','verification_code'];
    regInputs.forEach(function(el,idx){
      if (idx < fallbackKeys.length && !el.hasAttribute('data-i18n-placeholder')) el.setAttribute('data-i18n-placeholder', fallbackKeys[idx]);
    });

    return template.innerHTML;
  }

  function isAuthMessageOnlyMutation(mutation) {
    if (!mutation) return false;
    if (mutation.target && mutation.target.nodeType === 1 && mutation.target.closest('.auth-message')) return true;
    if (mutation.target && mutation.target.nodeType === 3 && mutation.target.parentElement && mutation.target.parentElement.closest('.auth-message')) return true;
    if (mutation.type !== 'childList') return false;
    const nodes = Array.from(mutation.addedNodes || []).concat(Array.from(mutation.removedNodes || []));
    return nodes.length > 0 && nodes.every(function (node) {
      if (node.nodeType === 3) return node.parentElement && node.parentElement.closest('.auth-message');
      return node.nodeType === 1 && (node.matches('.auth-message') || node.closest('.auth-message'));
    });
  }

  function isAuthI18nMutation(mutation) {
    if (!mutation) return false;
    const el = mutation.target && mutation.target.nodeType === 1
      ? mutation.target
      : (mutation.target && mutation.target.parentElement);
    if (!el) return false;
    return !!(el.closest && el.closest('[data-i18n],[data-i18n-html],[data-i18n-placeholder],[data-i18n-alt],[data-i18n-title],[data-i18n-aria-label]'));
  }

  function keepSectionAuthoritative(target, sectionKey, html) {
    if (!target || !isAuthoritativePageSection(sectionKey) || !html.trim()) return;
    authoritativeSections.set(sectionKey, html);
    target.setAttribute('data-layout-authoritative', sectionKey);

    const previous = sectionObservers.get(target);
    if (previous) previous.disconnect();

    let restoring = false;
    const observer = new MutationObserver(function (mutations) {
      if (restoring) return;
      if (mutations && mutations.length && mutations.every(function (mutation) {
        return isAuthMessageOnlyMutation(mutation) || isAuthI18nMutation(mutation);
      })) return;
      const expected = authoritativeSections.get(sectionKey);
      if (!expected || target.innerHTML === expected) return;
      restoring = true;
      target.innerHTML = expected;
      target.setAttribute('data-layout-custom-applied', sectionKey);
      document.dispatchEvent(new CustomEvent('naga:layout-section-restored', {
        detail: { sectionKey: sectionKey }
      }));
      Promise.resolve().then(function () { restoring = false; });
    });

    observer.observe(target, { childList: true, subtree: true, characterData: true });
    sectionObservers.set(target, observer);
  }

  function applyHtml(target, html, sectionKey) {
    html = normalizeShellTextI18nHtml(html, sectionKey);
    html = normalizeSidebarItemRolesHtml(html, sectionKey);
    html = normalizeAuthImageHtml(html, sectionKey);
    html = normalizeAuthPageHtml(html, sectionKey);
    if (!target || !html.trim()) return false;
    if (target.innerHTML !== html) target.innerHTML = html;
    target.setAttribute('data-layout-custom-applied', sectionKey);
    keepSectionAuthoritative(target, sectionKey, html);
    // Important: a fresh/cached BO sidebar can arrive after lang.js has already
    // translated the page. Re-translate this subtree immediately so its visible
    // text always follows the persisted language instead of its English fallback.
    translateLayoutTarget(target, sectionKey);
    return true;
  }

  function applyJs(sectionKey, js) {
    if (!js.trim()) return;
    const old = document.querySelector('script[data-layout-section-js="' + sectionKey + '"]');
    if (old) old.remove();
    const script = document.createElement('script');
    script.setAttribute('data-layout-section-js', sectionKey);
    script.textContent = js + '\n//# sourceURL=layout-section-' + sectionKey + '.js';
    document.body.appendChild(script);
    executedJs.add(sectionKey);
  }

  function targetsFor(sectionKey) {
    if (sectionKey === 'frontend-header') {
      const header = document.querySelector('.top-header');
      return header ? [header] : [];
    }
    if (sectionKey === 'frontend-sidebar') {
      const panel = document.querySelector('#mobileSideMenu .mobile-menu-panel');
      return panel ? [panel] : [];
    }
    return Array.from(document.querySelectorAll('[data-layout-section="' + CSS.escape(sectionKey) + '"]'));
  }

  function applyCachedSection(sectionKey, targets) {
    const data = readCachedSection(sectionKey);
    if (!data) return false;
    applyCss(sectionKey, data.css, data);
    let htmlChanged = false;
    (targets || targetsFor(sectionKey)).forEach(function (target) {
      if (applyHtml(target, data.html, sectionKey)) htmlChanged = true;
    });
    if (data.js && data.js.trim()) applyJs(sectionKey, data.js);
    markCriticalPart(sectionKey, data);
    // A cached frontend header is already the last BO-confirmed header. Treat it
    // as display-ready immediately instead of hiding its logo until the network
    // revalidation finishes. The fresh request below can still replace it if BO
    // has changed, but the user never sees an empty header during refresh.
    if (sectionKey === 'frontend-header') {
      freshHeaderLoaded = true;
      markHeaderReady();
    }
    document.dispatchEvent(new CustomEvent('naga:layout-section-applied', {
      detail: { sectionKey: sectionKey, htmlChanged: htmlChanged, data: data, fromCache: true }
    }));
    return htmlChanged || !!(data.css && data.css.trim());
  }

  async function loadSection(sectionKey, targets, force) {
    const data = await fetchSection(sectionKey, !!force);
    // An empty critical response can be intentional. For the global `home`
    // section, actively remove any previously injected BO CSS/JS so deleting CSS
    // in BO immediately returns the site to bundled style.css. Header/sidebar
    // keep the bundled shell markup when their BO HTML is empty.
    if (isCriticalSection(sectionKey) && !criticalSectionHasContent(sectionKey, data)) {
      if (sectionKey === GLOBAL_CSS_SECTION) {
        applyCss(sectionKey, '');
        const oldScript = document.querySelector('script[data-layout-section-js="' + sectionKey + '"]');
        if (oldScript) oldScript.remove();
        executedJs.delete(sectionKey);
      }

      // `frontend-sidebar` is BO-authoritative. When BO successfully returns an
      // empty sidebar, the admin intentionally removed the sidebar layout/menu.
      // Older builds kept the bundled hard-coded menu as a fallback, so deleted
      // BO items appeared again. Clear the panel only for a successful response;
      // on a real network/API failure keep the bundled/last-known-good fallback.
      if (sectionKey === 'frontend-sidebar' && !data.__unavailable) {
        applyCss(sectionKey, '');
        const oldSidebarScript = document.querySelector('script[data-layout-section-js="frontend-sidebar"]');
        if (oldSidebarScript) oldSidebarScript.remove();
        executedJs.delete('frontend-sidebar');
        (targets || targetsFor(sectionKey)).forEach(function (target) {
          if (!target) return;
          target.innerHTML = '';
          target.setAttribute('data-layout-section', 'frontend-sidebar');
          target.setAttribute('data-bo-sidebar-empty', '1');
        });
      }

      markCriticalFallbackReady(sectionKey);
      document.dispatchEvent(new CustomEvent('naga:layout-section-fallback', {
        detail: { sectionKey: sectionKey, reason: data.__unavailable ? 'unavailable' : 'empty-authoritative' }
      }));
      return data;
    }
    applyCss(sectionKey, data.css, data);
    let htmlChanged = false;
    (targets || targetsFor(sectionKey)).forEach(function (target) {
      if (applyHtml(target, data.html, sectionKey)) htmlChanged = true;
    });
    applyJs(sectionKey, data.js);
    markCriticalPart(sectionKey, data);

    document.dispatchEvent(new CustomEvent('naga:layout-section-applied', {
      detail: { sectionKey: sectionKey, htmlChanged: htmlChanged, data: data, fromCache: false }
    }));
    if (isAuthoritativePageSection(sectionKey) && htmlChanged) {
      document.dispatchEvent(new CustomEvent('naga:auth-layout-ready', {
        detail: { sectionKey: sectionKey, fromCache: false }
      }));
    }

    if (htmlChanged && (sectionKey === 'frontend-header' || sectionKey === 'frontend-sidebar')) {
      // First let the shell reconnect login state, wallet and menu behavior.
      // The shell/i18n rehydration may rewrite text carrying data-i18n attributes,
      // so apply the BO-saved HTML once more afterwards. This makes the saved
      // layout the final source of truth (for example a custom LOGIN22 label).
      if (window.NAGA_SITE_SHELL && typeof window.NAGA_SITE_SHELL.rehydrate === 'function') {
        window.NAGA_SITE_SHELL.rehydrate();
      }

      (targets || targetsFor(sectionKey)).forEach(function (target) {
        applyHtml(target, data.html, sectionKey);
      });

      // Reconnect state-only behavior without running translation over the
      // freshly restored custom wording.
      if (window.NAGA_SITE_SHELL) {
        if (typeof window.NAGA_SITE_SHELL.refreshHeaderAuth === 'function') {
          window.NAGA_SITE_SHELL.refreshHeaderAuth();
        }
        if (typeof window.NAGA_SITE_SHELL.refreshBalance === 'function') {
          window.NAGA_SITE_SHELL.refreshBalance();
        }
        // The BO sidebar HTML is restored after rehydrate() so custom wording stays
        // authoritative. Re-apply only the dynamic next-language indicator afterwards.
        if (sectionKey === 'frontend-sidebar' && typeof window.NAGA_SITE_SHELL.refreshLanguageLabel === 'function') {
          window.NAGA_SITE_SHELL.refreshLanguageLabel();
        }
      }

      document.dispatchEvent(new CustomEvent('naga:site-shell-customized', { detail: { sectionKey: sectionKey } }));
    }
    if (sectionKey === 'frontend-header') {
      freshHeaderLoaded = true;
      markHeaderReady();
    }
    return data;
  }

  async function loadShellSections(force) {
    await Promise.all([
      loadSection('frontend-header', targetsFor('frontend-header'), force),
      loadSection('frontend-sidebar', targetsFor('frontend-sidebar'), force)
    ]);
  }

  async function initialize() {
    const grouped = new Map();
    document.querySelectorAll('[data-layout-section]').forEach(function (target) {
      const key = (target.getAttribute('data-layout-section') || '').trim();
      if (!key || key === 'frontend-header' || key === 'frontend-sidebar' || key === GLOBAL_CSS_SECTION) return;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(target);
    });

    // Restore the last-known-good BO shell immediately. A cached Header is much
    // safer than exposing the hardcoded fallback when a refresh lands during a
    // brief BO/API/network failure. The fresh request below still updates it when
    // BO has changed, but transient failures can no longer revert the site shell.
    applyCachedSection(GLOBAL_CSS_SECTION, []);
    applyCachedSection('frontend-header', targetsFor('frontend-header'));
    applyCachedSection('frontend-sidebar', targetsFor('frontend-sidebar'));
    grouped.forEach(function (targets, key) {
      const applied = applyCachedSection(key, targets);
      if (applied && isAuthoritativePageSection(key)) {
        document.dispatchEvent(new CustomEvent('naga:auth-layout-ready', {
          detail: { sectionKey: key, fromCache: true }
        }));
      }
    });

    // Refresh all sections in parallel. Auth pages no longer wait for home CSS
    // and shell requests to finish before their own BO layout is requested.
    initialized = true;
    const jobs = [
      loadSection(GLOBAL_CSS_SECTION, [], true),
      loadSection('frontend-header', targetsFor('frontend-header'), true),
      loadSection('frontend-sidebar', targetsFor('frontend-sidebar'), true)
    ];
    grouped.forEach(function (targets, key) {
      jobs.push(loadSection(key, targets, true));
    });
    await Promise.all(jobs);
    document.dispatchEvent(new CustomEvent('naga:layout-sections-loaded'));
  }


  document.addEventListener('i18n:changed', function () {
    ['frontend-header','frontend-sidebar','login-page','register-page'].forEach(function (sectionKey) {
      targetsFor(sectionKey).forEach(function (target) {
        translateLayoutTarget(target, sectionKey);
      });
    });
  });

  document.addEventListener('naga:custom-assets-ready', function () {
    customAssetsReady = true;
    markHeaderReady();
  });

  document.addEventListener('naga:site-shell-ready', function () {
    shellReadySeen = true;

    // site-shell.js creates #mobileSideMenu dynamically. On pages where this
    // loader runs first, the initial frontend-sidebar request can finish while
    // targetsFor('frontend-sidebar') is still empty. The BO HTML was therefore
    // fetched successfully but never applied, leaving site-shell's bundled menu
    // (Bonus/Spin/Live Chat/etc.) visible. As soon as the shell exists, re-apply
    // the BO sidebar to the real panel. Wait for any startup request to settle
    // first so a fast shell-ready event cannot race an in-flight request.
    const panel = document.querySelector('#mobileSideMenu .mobile-menu-panel');
    if (panel && panel.getAttribute('data-layout-custom-applied') !== 'frontend-sidebar' && panel.getAttribute('data-bo-sidebar-empty') !== '1') {
      const pending = sectionPromises.get('frontend-sidebar');
      Promise.resolve(pending).catch(function () {}).then(function () {
        const livePanel = document.querySelector('#mobileSideMenu .mobile-menu-panel');
        if (!livePanel || livePanel.getAttribute('data-layout-custom-applied') === 'frontend-sidebar' || livePanel.getAttribute('data-bo-sidebar-empty') === '1') return;
        sectionPromises.delete('frontend-sidebar');
        return loadSection('frontend-sidebar', [livePanel], true);
      }).catch(function (error) {
        console.warn('[Layout Section] unable to apply BO sidebar after shell creation:', error && error.message ? error.message : error);
      });
    }

    if (!initialized && document.readyState !== 'loading') loadShellSections(true);
  });

  // Do not unconditionally replace the header again at +100ms/+600ms: each
  // replacement rebuilt the logo/wallet markup and caused the visible flash.
  window.addEventListener('load', function () {
    const header = document.querySelector('.top-header');
    if (header && !header.getAttribute('data-layout-custom-applied')) {
      setTimeout(function () {
        if (!header.getAttribute('data-layout-custom-applied')) loadSection('frontend-header', [header], true);
      }, 500);
    }

    // Login/register page scripts, translations or cached restoration must never
    // replace the BO Layout Section after it has been applied. Refresh those
    // sections after all late scripts finish, then keep them authoritative.
    ['login-page', 'register-page'].forEach(function (sectionKey) {
      const targets = targetsFor(sectionKey);
      if (!targets.length) return;
      // keepSectionAuthoritative already restores BO markup if a late auth script
      // mutates it. Do not make two extra forced BO requests on every auth-page
      // load; only recover if the section was never applied at all.
      setTimeout(function () {
        const missing = targets.some(function (target) {
          return target.getAttribute('data-layout-custom-applied') !== sectionKey;
        });
        if (missing) loadSection(sectionKey, targetsFor(sectionKey), true);
      }, 180);
    });
  });

  window.loadCustomSection = async function (sectionKey, targetSelector) {
    const targets = targetSelector ? Array.from(document.querySelectorAll(targetSelector)) : targetsFor(sectionKey);
    sectionPromises.delete(sectionKey);
    return loadSection(sectionKey, targets, true);
  };

  // This file is intentionally loaded near the start of the closing-body script
  // sequence. At that point all layout targets above it are already parsed, so
  // start BO Layout immediately instead of waiting for DOMContentLoaded (which
  // would put app.js/Firebase/other synchronous assets ahead of the critical
  // Header/Home/Sidebar requests during a hard refresh).
  if (document.body && (document.querySelector('.top-header') || document.querySelector('[data-layout-section]'))) {
    initialize();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
