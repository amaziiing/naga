(function(){
  const API = window.NAGA_API || {};
  const API_BASE = (window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) || 'http://localhost:8080';
  const LAUNCH_API_URL = API.playerProviderLaunch || (API_BASE.replace(/\/+$/, '') + '/api/player/provider/launch');
  const WALLET_BALANCE_URL = API.playerMainWalletBalance || API.playerProviderWalletBalance || (API_BASE.replace(/\/+$/, '') + '/api/member/wallet/balance');
  const EXIT_API_URL = API.playerProviderExit || (API_BASE.replace(/\/+$/, '') + '/api/player/provider/exit');
  const HEARTBEAT_API_URL = API.playerProviderHeartbeat || (API_BASE.replace(/\/+$/, '') + '/api/player/provider/heartbeat');

  let pendingLaunch = null;
  let walletBalanceCache = null;
  let providerMonitorTimer = null;
  let providerCloseCheckTimer = null;
  let providerSettlementPromise = null;
  let activeProviderTab = null;
  let providerLaunchInProgress = false;
  // Session IDs currently being explicitly settled. Heartbeat must stop immediately
  // when Exit begins; an already in-flight request is also harmless because Spring
  // Boot now conditionally updates heartbeat only while DB status is OPEN.
  const providerClosingSessionIds = new Set();
  const PROVIDER_PAGE_INSTANCE_ID = 'provider-page-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const PENDING_LAUNCH_LOCK_KEY = 'naga_provider_launch_pending_lock';
  const PENDING_LAUNCH_LOCK_TTL_MS = 45000;
  const ACTIVE_GAME_MESSAGE = 'You already have a game open. Please exit the current game before starting another game.';
  const LAUNCHING_GAME_MESSAGE = 'A game is currently being opened. Please wait.';
  const SETTLING_GAME_MESSAGE = 'Your previous game is closing and the balance is being returned. Please wait a moment.';
  const DEFAULT_CONFIRM_TEXT = 'Confirm & Play';
  const TERMINAL_SESSION_STATES = ['CLOSED', 'SETTLED', 'COMPLETED', 'EXITED', 'EXPIRED', 'INACTIVE', 'CANCELLED'];
  const PENDING_SETTLEMENT_STATES = ['PENDING_WITHDRAW', 'PENDING_SETTLEMENT', 'SETTLING', 'CLOSING', 'WITHDRAW_PENDING', 'AUTO_SETTLING'];
  const PROVIDER_SESSION_STATE_KEY = 'naga_active_provider_session_state';
  const PROVIDER_GAME_WINDOW_NAME_PREFIX = 'naga_provider_game_';

  function getToken(){
    return localStorage.getItem('member_token') || localStorage.getItem('token') || localStorage.getItem('access_token') || '';
  }

  function getActiveProviderSessionId(){
    return localStorage.getItem('naga_active_provider_session_id') || '';
  }

  function getPendingLaunchLock(){
    const raw = localStorage.getItem(PENDING_LAUNCH_LOCK_KEY);
    if(!raw) return null;
    try{
      const lock = JSON.parse(raw);
      if(!lock || !lock.owner || Number(lock.expiresAt || 0) <= Date.now()){
        localStorage.removeItem(PENDING_LAUNCH_LOCK_KEY);
        return null;
      }
      return lock;
    }catch(e){
      localStorage.removeItem(PENDING_LAUNCH_LOCK_KEY);
      return null;
    }
  }

  function releasePendingLaunchLock(){
    const lock = getPendingLaunchLock();
    if(!lock || lock.owner === PROVIDER_PAGE_INSTANCE_ID){
      localStorage.removeItem(PENDING_LAUNCH_LOCK_KEY);
    }
  }

  function acquirePendingLaunchLock(){
    const currentLock = getPendingLaunchLock();
    if(currentLock && currentLock.owner !== PROVIDER_PAGE_INSTANCE_ID){
      throw new Error(LAUNCHING_GAME_MESSAGE);
    }

    const lock = {
      owner: PROVIDER_PAGE_INSTANCE_ID,
      createdAt: Date.now(),
      expiresAt: Date.now() + PENDING_LAUNCH_LOCK_TTL_MS
    };
    localStorage.setItem(PENDING_LAUNCH_LOCK_KEY, JSON.stringify(lock));

    // Read it back so two pages clicking at nearly the same time cannot both continue.
    const confirmedLock = getPendingLaunchLock();
    if(!confirmedLock || confirmedLock.owner !== PROVIDER_PAGE_INSTANCE_ID){
      throw new Error(LAUNCHING_GAME_MESSAGE);
    }
    return lock;
  }

  function syncLaunchAvailabilityUi(){
    const pendingLock = getPendingLaunchLock();
    const locked = Boolean(getActiveProviderSessionId()) || Boolean(pendingLock) || providerLaunchInProgress || Boolean(providerSettlementPromise);
    if(document.body){
      document.body.setAttribute('data-provider-game-locked', locked ? '1' : '0');
    }
    document.querySelectorAll('.provider-launch-card, .provider-launch-img, .provider-launch-btn, [data-provider-launch="1"]').forEach(function(el){
      el.setAttribute('aria-disabled', locked ? 'true' : 'false');
      el.classList.toggle('provider-session-locked', locked);
    });
  }

  function showProviderBusyMessage(message){
    const modal = document.getElementById('providerTransferModal');
    if(modal && !modal.classList.contains('hidden')){
      setError(message);
      return;
    }
    if(window.NAGA_MODAL) window.NAGA_MODAL.alert(message, 'Game Notice');
  }


  function promotionLaunchState(payload){
    const access=window.NAGA_PROMOTION_ACCESS;
    if(!access) return {allowed:true, loading:false, message:''};
    const loading=typeof access.isLoading==='function' && access.isLoading();
    const providerCode=payload && payload.providerCode || '';
    const gameCode=payload && payload.gameCode || '';
    const gameName=payload && payload._display && payload._display.gameName || payload && payload.gameName || '';
    const allowed=loading ? false : (typeof access.isLaunchAllowed==='function' ? access.isLaunchAllowed(providerCode, gameCode, gameName) : true);
    const message=loading ? 'Checking your active promotion game access. Please wait a moment.' :
      (typeof access.message==='function' ? access.message() : 'This game is not available while your active promotion is in progress. Complete the promotion to unlock all games.');
    return {allowed:allowed, loading:loading, message:message};
  }

  function applyPromotionConfirmState(){
    const modal=document.getElementById('providerTransferModal');
    if(!modal || !pendingLaunch) return;
    const btn=modal.querySelector('[data-provider-transfer-confirm]');
    if(!btn) return;
    const state=promotionLaunchState(pendingLaunch);
    btn.disabled=!state.allowed;
    btn.classList.toggle('promotion-confirm-disabled', !state.allowed);
    btn.textContent=state.loading ? 'Checking...' : DEFAULT_CONFIRM_TEXT;
    if(!state.allowed) setError(state.message);
    else clearError();
  }

  async function ensureProviderCanLaunch(showMessage){
    if(providerSettlementPromise){
      // A previous click/close is already returning the provider balance. Wait for
      // that single settlement operation instead of showing a blocking notice.
      try{ await providerSettlementPromise; }catch(e){}
      return !getActiveProviderSessionId();
    }
    if(providerLaunchInProgress){
      if(showMessage !== false) showProviderBusyMessage(LAUNCHING_GAME_MESSAGE);
      return false;
    }

    const pendingLock = getPendingLaunchLock();
    if(pendingLock && pendingLock.owner !== PROVIDER_PAGE_INSTANCE_ID){
      if(showMessage !== false) showProviderBusyMessage(LAUNCHING_GAME_MESSAGE);
      return false;
    }

    const sessionId = getActiveProviderSessionId();
    if(!sessionId) return true;

    // Preserve the original Naga flow: when the player comes back to the lobby and
    // chooses another game, first close/settle the previous provider session, then
    // continue the new launch. A previous safety change accidentally converted this
    // into a hard "Game Notice" block, leaving the user unable to continue.
    //
    // Heartbeat is used only to cheaply clear a session the backend has already closed.
    // OPEN/SETTLING sessions are actively resumed through /exit. The backend exit path
    // is idempotent, so this is safe even if a close/stale worker reached it first.
    try{
      const heartbeat = await sendProviderHeartbeat(sessionId);
      if(handleHeartbeatResult(heartbeat, sessionId)) return true;
    }catch(e){
      // Do not treat a failed heartbeat as proof that the session is gone. /exit is
      // the authoritative recovery path and can safely return an already-closed session.
    }

    const providerCode = localStorage.getItem('naga_active_provider_code') ||
                         localStorage.getItem('naga_last_provider_code') || '';
    providerSettlementPromise = (async function(){
      try{
        await exitProviderGame({ sessionId: sessionId, providerCode: providerCode, transferBackAll: true });
        return true;
      }catch(e){
        // Keep the old session lock if money has not been confirmed back. Never allow
        // the new game to launch on top of an unresolved provider wallet.
        startPendingSettlementWatch(sessionId);
        if(showMessage !== false) showProviderBusyMessage(SETTLING_GAME_MESSAGE);
        return false;
      }finally{
        providerSettlementPromise = null;
        syncLaunchAvailabilityUi();
      }
    })();
    return await providerSettlementPromise;
  }

  function goLogin(){
    const returnUrl = location.pathname.split('/').pop() + location.search;
    location.href = 'login.html?returnUrl=' + encodeURIComponent(returnUrl || 'index.html');
  }

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function money(value){
    const n = Number(value || 0);
    return isNaN(n) ? '0.00' : n.toFixed(2);
  }

  // Wallet amounts are MYR values with 2 decimal places. Always compare them
  // as integer cents so a backend decimal such as 67.659999... cannot display
  // as RM 67.66 but then fail the client-side `amount > balance` check.
  function moneyCents(value){
    const n = Number(value || 0);
    if(!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100);
  }

  function normalizedMoney(value){
    return moneyCents(value) / 100;
  }

  function firstValue(){
    for(let i=0;i<arguments.length;i++){
      const value = arguments[i];
      if(value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    return '';
  }

  function cleanProviderErrorMessage(value, fallback){
    const defaultMessage = fallback || 'Launch game failed.';
    if(value === undefined || value === null) return defaultMessage;

    if(typeof value === 'object'){
      const nested = firstValue(
        value.errMsg, value.errmsg, value.errorMessage, value.error_message,
        value.message, value.statusdesc, value.description,
        value.resp_msg && value.resp_msg.message,
        value.respMsg && value.respMsg.message,
        value.data && value.data.errMsg,
        value.data && value.data.errorMessage,
        value.data && value.data.message
      );
      if(nested) return cleanProviderErrorMessage(nested, defaultMessage);
    }

    let text = String(value).trim();
    if(!text) return defaultMessage;

    // Provider/backend debug messages may append the complete request context.
    // Only expose the provider's errMsg/error message to the player.
    const patterns = [
      /(?:^|[,;\s{])errMsg\s*[=:]\s*["']?([^,;}\r\n"']+)/i,
      /"errMsg"\s*:\s*"([^"]+)"/i,
      /(?:^|[,;\s{])errorMessage\s*[=:]\s*["']?([^,;}\r\n"']+)/i,
      /"errorMessage"\s*:\s*"([^"]+)"/i,
      /(?:^|[,;\s{])statusdesc\s*[=:]\s*["']?([^,;}\r\n"']+)/i
    ];
    for(let i=0;i<patterns.length;i++){
      const match = text.match(patterns[i]);
      if(match && match[1]){
        text = match[1].trim();
        break;
      }
    }

    // Never show internal request/signature/debug details in the member UI.
    const debugIndex = text.search(/(?:_debug|debugPayload|debugHttp|requestContext|secret[_ ]?key|signature=|operatorcode=)/i);
    if(debugIndex > 0) text = text.slice(0, debugIndex).trim();
    text = text.replace(/^["']+|["',;}]+$/g, '').trim();

    if(!text || text.length > 240) return defaultMessage;
    return text;
  }

  function readDataset(el){
    if(!el) return {};
    const d = el.dataset || {};
    return {
      gameId: d.gameId || '',
      providerCode: d.providerCode || '',
      gameCode: d.gameCode || '',
      launchCode: d.launchCode || '',
      launchType: d.launchType || '',
      transferAmount: d.transferAmount || '',
      gameName: d.gameName || ''
    };
  }

  function closestLaunchData(el){
    const target = el && el.closest ? el.closest('[data-game-id], [data-provider-code], [data-game-code], .provider-launch-card, .game-card') : null;
    return readDataset(target);
  }

  function readDomGameName(el){
    if(!el) return '';
    const direct = firstValue(
      el.dataset && el.dataset.gameName,
      el.getAttribute && el.getAttribute('alt'),
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('aria-label')
    );
    if(direct) return direct;

    const card = el.closest ? el.closest('.provider-launch-card, .game-card, .detail-game-card, [data-game-name]') : null;
    if(!card) return '';
    const img = card.querySelector ? card.querySelector('img[alt]') : null;
    const nameNode = card.querySelector ? card.querySelector('[data-game-name-text], .game-name, .game-title, .detail-game-name, h3, h4') : null;
    return firstValue(
      card.dataset && card.dataset.gameName,
      img && img.getAttribute('alt'),
      nameNode && nameNode.textContent
    );
  }

  function normalizePayload(game, options){
    const item = game || {};
    const opt = options || {};
    const dataset = opt.element ? readDataset(opt.element) : {};
    const closest = opt.element ? closestLaunchData(opt.element) : {};
    const provider = item.provider || {};
    const cfg = (window.NAGA_CONFIG && window.NAGA_CONFIG.providerLaunch) || {};

    const gameId = firstValue(dataset.gameId, closest.gameId, opt.gameId, item.gameId, item.game_id, item.id);
    const providerCode = firstValue(
      dataset.providerCode, closest.providerCode, opt.providerCode,
      item.providerCode, item.provider_code, item.provider_code_name,
      item.providerGameProviderCode, item.provider_game_provider_code,
      item.vendorCode, item.vendor_code,
      provider.providerCode, provider.provider_code, provider.code,
      provider.providerName, provider.provider_name,
      (typeof item.provider === 'string' ? item.provider : ''),
      cfg.defaultProviderCode
    );
    const gameCode = firstValue(
      dataset.gameCode, closest.gameCode, dataset.launchCode, closest.launchCode,
      opt.gameCode, item.gameCode, item.game_code, item.launchCode, item.launch_code,
      item.providerGameCode, item.provider_game_code, item.code,
      item.gameProviderCode, item.game_provider_code, cfg.defaultGameCode
    );
    const launchType = firstValue(dataset.launchType, closest.launchType, opt.launchType, item.launchType, item.launch_type, cfg.defaultLaunchType);
    const transferAmount = firstValue(dataset.transferAmount, closest.transferAmount, opt.transferAmount, item.transferAmount, item.transfer_amount, 0);
    const gameName = firstValue(dataset.gameName, closest.gameName, opt.gameName, item.name, item.gameName, item.game_name, item.nameEn, item.title, item.gameTitle, readDomGameName(opt.element));

    const payload = { transferAmount: Number(transferAmount || 0) };
    if(gameId) payload.gameId = Number(gameId) || gameId;
    if(providerCode) payload.providerCode = String(providerCode).trim();
    if(gameCode) payload.gameCode = String(gameCode).trim();
    if(launchType) payload.launchType = String(launchType).trim().toUpperCase();
    if(!payload.gameId && payload.providerCode && !payload.gameCode && !payload.launchType) payload.launchType = 'SPORTS';
    payload._display = { gameName: gameName || 'Selected Game', providerCode: payload.providerCode || '', gameCode: payload.gameCode || '', launchType: payload.launchType || '' };
    return payload;
  }

  function normalizeProviderUrl(value){
    if(value === undefined || value === null) return '';
    let text = String(value).trim();
    if(!text) return '';
    const directMatch = text.match(/https?:\/\/[^\s,}]+/i);
    if(directMatch) return directMatch[0];
    const urlPairMatch = text.match(/(?:^|[,{\s])url\s*=\s*([^,}\s]+)/i);
    if(urlPairMatch && urlPairMatch[1]){
      let url = urlPairMatch[1].trim();
      try{ url = decodeURIComponent(url); }catch(e){}
      const nestedMatch = url.match(/https?:\/\/[^\s,}]+/i);
      return nestedMatch ? nestedMatch[0] : url;
    }
    return text;
  }

  function extractLaunchUrl(json){
    const data = json && json.data ? json.data : json;
    const rawUrl = firstValue(
      data && data.launchUrl, data && data.launch_url, data && data.gameUrl, data && data.game_url,
      data && data.url, data && data.redirectUrl, data && data.redirect_url,
      json && json.launchUrl, json && json.url,
      typeof data === 'string' ? data : '', typeof json === 'string' ? json : ''
    );
    return normalizeProviderUrl(rawUrl);
  }

  function getCachedMainWalletBalance(){
    try{
      const raw = localStorage.getItem('member_main_wallet_balance');
      if(raw === null || raw === '') return null;
      const value = Number(raw);
      if(!Number.isFinite(value)) return null;
      const confirmedAt = Number(localStorage.getItem('member_main_wallet_balance_confirmed_at') || 0);
      // Legacy 0.00 values may have been written before the wallet API replied.
      if(!confirmedAt && value === 0) return null;
      return normalizedMoney(value);
    }catch(e){ return null; }
  }

  function rememberMainWalletBalance(balance){
    try{
      localStorage.setItem('member_main_wallet_balance', String(balance));
      localStorage.setItem('member_main_wallet_balance_confirmed_at', String(Date.now()));
    }catch(e){}
    document.querySelectorAll('[data-main-wallet-balance]').forEach(function(el){
      el.textContent = 'MYR ' + money(balance);
    });
    window.__NAGA_WALLET_READY__ = true;
    try{ document.dispatchEvent(new CustomEvent('naga:wallet-ready')); }catch(e){}
  }

  async function fetchMainWalletBalance(){
    const token = getToken();
    if(!token){ goLogin(); return 0; }
    const freshUrl = String(WALLET_BALANCE_URL) + (String(WALLET_BALANCE_URL).indexOf('?') >= 0 ? '&' : '?') + '_wallet_ts=' + Date.now();
    const res = await fetch(freshUrl, {
      cache: 'no-store',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache'
      }
    });
    const json = await res.json().catch(function(){ return {}; });
    if(!res.ok || json.status === 'error') throw new Error(json.message || 'Unable to load main wallet balance.');
    const data = json.data || {};
    const rawBalance = firstValue(
      data.balance, data.mainWalletBalance, data.main_wallet_balance,
      data.walletBalance, data.wallet_balance,
      data.mainWallet && data.mainWallet.balance,
      data.main_wallet && data.main_wallet.balance,
      data.wallet && data.wallet.balance
    );
    const balance = Number(rawBalance);
    if(!Number.isFinite(balance)) throw new Error('Unable to load main wallet balance.');
    // Keep the same 2-decimal value that is shown to the player. This avoids
    // the UI showing RM 67.66 while retaining a hidden 67.659999... cache.
    walletBalanceCache = normalizedMoney(balance);
    rememberMainWalletBalance(walletBalanceCache);
    return walletBalanceCache;
  }

  function ensureModal(){
    let modal = document.getElementById('providerTransferModal');
    if(modal) return modal;
    modal = document.createElement('div');
    modal.id = 'providerTransferModal';
    modal.className = 'provider-transfer-modal hidden';
    modal.innerHTML =
      '<div class="provider-transfer-backdrop" data-provider-transfer-close></div>' +
      '<div class="provider-transfer-panel" role="dialog" aria-modal="true">' +
        '<button type="button" class="provider-transfer-close" data-provider-transfer-close>&times;</button>' +
        '<div class="provider-transfer-title">Transfer to Game</div>' +
        '<div class="provider-transfer-subtitle">Choose amount to transfer from Main Wallet before entering provider.</div>' +
        '<div class="provider-transfer-game">' +
          '<div><span>Game</span><strong data-provider-transfer-game-name>-</strong></div>' +
          '<div><span>Provider</span><strong data-provider-transfer-provider>-</strong></div>' +
        '</div>' +
        '<div class="provider-transfer-balance">Main Wallet: <strong>RM <span data-provider-transfer-balance>0.00</span></strong></div>' +
        '<label class="provider-transfer-label">Transfer Amount</label>' +
        '<div class="provider-transfer-input-row"><span>RM</span><input type="number" min="0" step="0.01" inputmode="decimal" data-provider-transfer-amount placeholder="0.00"></div>' +
        '<div class="provider-transfer-quick">' +
          '<button type="button" data-provider-transfer-quick="10">10</button>' +
          '<button type="button" data-provider-transfer-quick="30">30</button>' +
          '<button type="button" data-provider-transfer-quick="50">50</button>' +
          '<button type="button" data-provider-transfer-quick="100">100</button>' +
          '<button type="button" data-provider-transfer-all>All</button>' +
        '</div>' +
        '<div class="provider-transfer-note">Amount will be deducted from Main Wallet and deposited to provider before launch. You can also enter 0 to launch without transfer.</div>' +
        '<div class="provider-transfer-error" data-provider-transfer-error></div>' +
        '<div class="provider-transfer-actions">' +
          '<button type="button" class="provider-transfer-cancel" data-provider-transfer-close>Cancel</button>' +
          '<button type="button" class="provider-transfer-confirm" data-provider-transfer-confirm>Confirm & Play</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', function(e){
      if(e.target.closest('[data-provider-transfer-close]')) closeModal();
      const quick = e.target.closest('[data-provider-transfer-quick]');
      if(quick){
        const input = modal.querySelector('[data-provider-transfer-amount]');
        input.value = quick.getAttribute('data-provider-transfer-quick') || '0';
        clearError();
      }
      if(e.target.closest('[data-provider-transfer-all]')){
        const input = modal.querySelector('[data-provider-transfer-amount]');
        input.value = money(walletBalanceCache || 0);
        clearError();
      }
      if(e.target.closest('[data-provider-transfer-confirm]')) confirmModalLaunch();
    });

    const amountInput = modal.querySelector('[data-provider-transfer-amount]');
    amountInput.addEventListener('input', clearError);
    return modal;
  }

  function clearError(){
    const modal = ensureModal();
    const err = modal.querySelector('[data-provider-transfer-error]');
    if(err) err.textContent = '';
  }

  function setError(msg){
    const modal = ensureModal();
    const err = modal.querySelector('[data-provider-transfer-error]');
    if(err) err.textContent = msg || '';
  }

  function resetTransferAction(){
    const modal = document.getElementById('providerTransferModal');
    if(!modal) return;
    const btn = modal.querySelector('[data-provider-transfer-confirm]');
    if(btn){
      btn.disabled = false;
      btn.textContent = DEFAULT_CONFIRM_TEXT;
    }
  }

  function closeModal(){
    const modal = ensureModal();
    modal.classList.add('hidden');
    pendingLaunch = null;
    resetTransferAction();
  }

  function clearStoredProviderSession(){
    localStorage.removeItem('naga_last_provider_session_id');
    localStorage.removeItem('naga_active_provider_session_id');
    localStorage.removeItem('naga_active_provider_code');
    localStorage.removeItem(PROVIDER_SESSION_STATE_KEY);
    localStorage.removeItem('naga_active_provider_wallet_flow');
    activeProviderTab = null;
    resetTransferAction();
    syncLaunchAvailabilityUi();
    try{
      document.dispatchEvent(new CustomEvent('naga:provider-session-cleared'));
    }catch(e){}
  }

  async function refreshWalletAfterProviderExit(){
    try{
      let balance;
      if(window.NAGA_MEMBER_AUTH && typeof window.NAGA_MEMBER_AUTH.refreshBalance === 'function'){
        balance = await window.NAGA_MEMBER_AUTH.refreshBalance();
      }else{
        balance = await fetchMainWalletBalance();
        localStorage.setItem('member_main_wallet_balance', String(balance));
        document.querySelectorAll('[data-main-wallet-balance]').forEach(function(el){
          el.textContent = 'MYR ' + money(balance);
        });
      }
      if(window.NAGA_SITE_SHELL && typeof window.NAGA_SITE_SHELL.refreshBalance === 'function'){
        try{ window.NAGA_SITE_SHELL.refreshBalance(); }catch(e){}
      }
      try{
        document.dispatchEvent(new CustomEvent('naga:provider-balance-returned', { detail: { balance: balance } }));
      }catch(e){}
    }catch(e){}
  }

  function getProviderSessionState(json){
    const data = json && json.data ? json.data : (json || {});
    const session = data && data.session ? data.session : {};
    const rawState = firstValue(
      // Heartbeat API returns the session state directly as data.status.
      // Include direct status/state fields so a BO-closed session immediately
      // clears the stale browser lock instead of showing the active-game alert.
      data.status, data.state,
      data.sessionStatus, data.session_status, data.sessionState, data.session_state,
      session.status, session.state,
      data.providerSessionStatus, data.provider_session_status,
      json && json.sessionStatus, json && json.session_status,
      json && json.providerSessionStatus, json && json.provider_session_status
    );
    const state = String(rawState || '').trim().toUpperCase();
    const explicitlyClosed = data.closed === true || data.active === false || data.open === false ||
      session.closed === true || session.active === false || session.open === false;
    return {
      state: state,
      terminal: explicitlyClosed || TERMINAL_SESSION_STATES.indexOf(state) !== -1
    };
  }

  function isTerminalSessionMessage(message){
    return /(already\s*(closed|settled|exited)|session\s*(is\s*)?(closed|settled|expired|inactive)|no\s*(active|open)\s*session|session\s*not\s*found|invalid\s*provider\s*session)/i.test(String(message || ''));
  }

  async function openTransferModal(payload){
    const token = getToken();
    if(!token){ goLogin(); return; }
    if(!payload.gameId && !payload.providerCode) throw new Error('Provider Code is required.');
    if(!(await ensureProviderCanLaunch(true))) return;

    const modal = ensureModal();
    resetTransferAction();
    pendingLaunch = payload;
    clearError();
    modal.querySelector('[data-provider-transfer-game-name]').textContent = payload._display.gameName || 'Selected Game';
    modal.querySelector('[data-provider-transfer-provider]').textContent = payload.providerCode || '-';
    modal.querySelector('[data-provider-transfer-amount]').value = '';

    // Never paint "Loading..." in the transfer dialog. The site shell already
    // keeps the latest API-confirmed main-wallet balance in localStorage, so use
    // that value immediately. If this is the first wallet read in the browser,
    // wait for the API before revealing the dialog instead of flashing a placeholder.
    const cachedBalance = getCachedMainWalletBalance();
    if(cachedBalance !== null){
      walletBalanceCache = cachedBalance;
      modal.querySelector('[data-provider-transfer-balance]').textContent = money(cachedBalance);
      modal.classList.remove('hidden');
      applyPromotionConfirmState();
    }

    try{
      const balance = await fetchMainWalletBalance();
      if(pendingLaunch === payload){
        modal.querySelector('[data-provider-transfer-balance]').textContent = money(balance);
        if(cachedBalance === null){
          modal.classList.remove('hidden');
          applyPromotionConfirmState();
        }
      }
    }catch(err){
      if(cachedBalance === null){
        walletBalanceCache = 0;
        modal.querySelector('[data-provider-transfer-balance]').textContent = '0.00';
        modal.classList.remove('hidden');
        applyPromotionConfirmState();
        setError(err.message || 'Unable to load main wallet balance.');
      }
      // When a confirmed cached balance is already visible, keep it on a
      // temporary network failure instead of replacing it with 0.00.
    }
  }

  async function confirmModalLaunch(){
    if(!pendingLaunch) return;
    const modal = ensureModal();
    const btn = modal.querySelector('[data-provider-transfer-confirm]');
    const promotionState = promotionLaunchState(pendingLaunch);
    if(!promotionState.allowed){
      btn.disabled = true;
      btn.classList.add('promotion-confirm-disabled');
      btn.textContent = promotionState.loading ? 'Checking...' : DEFAULT_CONFIRM_TEXT;
      setError(promotionState.message);
      return;
    }
    const amountValue = modal.querySelector('[data-provider-transfer-amount]').value;
    const amount = Number(amountValue || 0);
    if(isNaN(amount) || amount < 0){ setError('Please enter a valid amount.'); return; }
    // Compare MYR in cents, not raw floating-point numbers. Equal displayed
    // values (for example RM 67.66 balance and RM 67.66 transfer) must pass.
    if(moneyCents(amount) > moneyCents(walletBalanceCache)){ setError('Insufficient main wallet balance.'); return; }

    // Reserve the provider tab synchronously from the Confirm button click.
    // Waiting for ensure/launch/deposit HTTP requests before window.open() loses the
    // browser's user-activation permission on Chrome/Safari and the old fallback then
    // redirected the Naga lobby itself to the provider. Once the lobby disappeared,
    // heartbeat/close monitoring stopped and money only returned later via stale-session
    // recovery. Keeping this blank tab reserved preserves the lobby and its heartbeat.
    const reservedProviderTab = window.open('about:blank', '_blank');
    if(!reservedProviderTab){
      setError('Game window was blocked. Please allow pop-ups for this site and try again. No funds were transferred.');
      return;
    }
    try{ reservedProviderTab.opener = window; }catch(e){}

    // The popup has to be reserved synchronously while the Confirm click still owns
    // browser user activation. Do not leave that reserved tab as a blank white page
    // while the backend creates the provider session / transfers the wallet. Paint a
    // tiny self-contained loading screen immediately; directLaunch() replaces this
    // document with the real provider URL as soon as the launch response is ready.
    try{
      const loadingDoc = reservedProviderTab.document;
      loadingDoc.open();
      loadingDoc.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Launching Game...</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#071018;color:#fff;font-family:Arial,Helvetica,sans-serif}.naga-launch{width:min(86vw,420px);text-align:center}.naga-spinner{width:48px;height:48px;margin:0 auto 22px;border:4px solid rgba(255,255,255,.16);border-top-color:#18e4e8;border-radius:50%;animation:nagaSpin .8s linear infinite}.naga-title{font-size:20px;font-weight:700;letter-spacing:.2px}.naga-text{margin-top:10px;color:#aebbc5;font-size:14px;line-height:1.5}@keyframes nagaSpin{to{transform:rotate(360deg)}}</style></head><body><div class="naga-launch"><div class="naga-spinner"></div><div class="naga-title">Launching game...</div><div class="naga-text">Please wait while we connect you to the game provider.</div></div></body></html>');
      loadingDoc.close();
    }catch(e){}

    if(!(await ensureProviderCanLaunch(true))){
      try{ reservedProviderTab.close(); }catch(e){}
      return;
    }

    const payload = Object.assign({}, pendingLaunch);
    delete payload._display;
    payload.transferAmount = amount;
    if(!payload.returnUrl){
      try{ payload.returnUrl = new URL('provider-return.html', location.href).href; }catch(e){ payload.returnUrl = 'provider-return.html'; }
    }

    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = 'Transferring...';
    try{
      await directLaunch(payload, reservedProviderTab);
    }catch(err){
      try{ if(reservedProviderTab && !reservedProviderTab.closed) reservedProviderTab.close(); }catch(e){}
      btn.disabled = false;
      btn.textContent = oldText;
      const launchError = cleanProviderErrorMessage(err && err.message ? err.message : err, 'Launch game failed.');
      setError(launchError);
    }
  }


  function saveActiveProviderSession(data){
    const session = data && data.session ? data.session : {};
    const sessionId = firstValue(data && data.sessionId, data && data.session_id, data && data.providerSessionId, data && data.provider_session_id, data && data.playerProviderSessionId, data && data.player_provider_session_id, session.id, session.sessionId, session.session_id);
    const providerCode = firstValue(data && data.providerCode, data && data.provider_code, session.providerCode, session.provider_code);
    if(sessionId){
      localStorage.setItem('naga_last_provider_session_id', String(sessionId));
      localStorage.setItem('naga_active_provider_session_id', String(sessionId));
      if(providerCode){
        localStorage.setItem('naga_last_provider_code', String(providerCode));
        localStorage.setItem('naga_active_provider_code', String(providerCode));
      }
      syncLaunchAvailabilityUi();
    }
    return { sessionId: sessionId, providerCode: providerCode };
  }

  async function sendProviderHeartbeat(sessionId){
    const token = getToken();
    if(!token || !sessionId) return null;
    if(providerClosingSessionIds.has(String(sessionId))) return null;
    const res = await fetch(HEARTBEAT_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ sessionId: sessionId })
    });
    const json = await res.json().catch(function(){ return {}; });
    json.__httpOk = res.ok;
    json.__httpStatus = res.status;
    return json;
  }

  function handleHeartbeatResult(json, sessionId){
    if(!json) return false;
    const currentSessionId = localStorage.getItem('naga_active_provider_session_id');
    if(currentSessionId && sessionId && String(currentSessionId) !== String(sessionId)) return false;

    const statusInfo = getProviderSessionState(json);
    const message = firstValue(
      json.message, json.error,
      json.resp_msg && json.resp_msg.message,
      json.respMsg && json.respMsg.message,
      json.data && json.data.message,
      json.data && json.data.resp_msg && json.data.resp_msg.message
    );
    if(statusInfo.state){
      localStorage.setItem(PROVIDER_SESSION_STATE_KEY, statusInfo.state);
    }
    // Some providers/backend flows return HTTP 200 with a message such as
    // "session already closed" or "no active session". Treat those messages
    // as terminal too, otherwise the browser keeps a stale localStorage lock
    // until the user manually refreshes the page.
    const terminalByMessage = isTerminalSessionMessage(message);
    if(!statusInfo.terminal && !terminalByMessage) return false;

    stopProviderMonitor();
    clearStoredProviderSession();
    refreshWalletAfterProviderExit();
    return true;
  }

  function startPendingSettlementWatch(sessionId){
    stopProviderMonitor();
    if(!sessionId) return;
    localStorage.setItem(PROVIDER_SESSION_STATE_KEY, 'PENDING_SETTLEMENT');
    syncLaunchAvailabilityUi();

    const poll = function(){
      sendProviderHeartbeat(sessionId)
        .then(function(json){
          if(handleHeartbeatResult(json, sessionId)) return;
          const info = getProviderSessionState(json);
          if(info.state) localStorage.setItem(PROVIDER_SESSION_STATE_KEY, info.state);
        })
        .catch(function(){});
    };

    poll();
    providerMonitorTimer = setInterval(poll, 3000);
  }

  function stopProviderMonitor(){
    if(providerMonitorTimer){
      clearInterval(providerMonitorTimer);
      providerMonitorTimer = null;
    }
    if(providerCloseCheckTimer){
      clearInterval(providerCloseCheckTimer);
      providerCloseCheckTimer = null;
    }
  }

  function emitPromotionProgressFromHeartbeat(json){
    try{
      const data=json&&json.data&&typeof json.data==='object'?json.data:{};
      const progress=data&&data.promotionProgress&&typeof data.promotionProgress==='object'?data.promotionProgress:null;
      if(progress) document.dispatchEvent(new CustomEvent('naga:promotion-progress',{detail:progress}));
    }catch(e){}
  }

  function providerTabReturnedToNaga(){
    if(!activeProviderTab || activeProviderTab.closed) return false;
    try{
      // Access succeeds only after the provider tab has navigated back to our origin.
      // Cross-origin game pages throw here and are correctly treated as still active.
      if(!activeProviderTab.location || activeProviderTab.location.origin !== window.location.origin) return false;
      // The embedded game shell intentionally remains same-origin while its iframe is
      // cross-origin. Do not mistake the shell itself for a provider return navigation.
      const path = String(activeProviderTab.location.pathname || '');
      if(/\/provider-game\.html$/i.test(path)) return false;
      return true;
    }catch(e){ return false; }
  }

  function startProviderMonitor(sessionId, providerCode, popupWindow){
    stopProviderMonitor();
    if(!sessionId) return;
    activeProviderTab = popupWindow || null;
    localStorage.setItem('naga_active_provider_session_id', String(sessionId));
    if(providerCode) localStorage.setItem('naga_active_provider_code', String(providerCode));
    syncLaunchAvailabilityUi();

    async function closeAndSettle(){
      if(providerSettlementPromise) return providerSettlementPromise;
      stopProviderMonitor();
      providerSettlementPromise = (async function(){
        try{
          await exitProviderGame({ sessionId: sessionId, providerCode: providerCode, transferBackAll: true });
        }catch(e){
          // The backend heartbeat/scheduler may have settled it first. In that case,
          // clear the stale frontend session instead of keeping the Play button locked.
          if(isTerminalSessionMessage(e && e.message)){
            clearStoredProviderSession();
            refreshWalletAfterProviderExit();
          }else{
            // Some providers reject transfer-out while their game session is still
            // closing. Keep the member informed and poll the backend until its retry/
            // scheduler marks the session terminal, rather than leaving a silent lock.
            setError(SETTLING_GAME_MESSAGE);
            startPendingSettlementWatch(sessionId);
          }
        }finally{
          providerSettlementPromise = null;
          resetTransferAction();
          syncLaunchAvailabilityUi();
        }
      })();
      return providerSettlementPromise;
    }

    sendProviderHeartbeat(sessionId)
      .then(function(json){ emitPromotionProgressFromHeartbeat(json); handleHeartbeatResult(json, sessionId); })
      .catch(function(){});

    // Detect a manually closed provider tab almost immediately. The original lobby stays open;
    // only settle the provider wallet, refresh the wallet UI and unlock game launching.
    providerCloseCheckTimer = setInterval(function(){
      if(activeProviderTab && (activeProviderTab.closed || providerTabReturnedToNaga())){
        closeAndSettle();
      }
    }, 200);

    // Keep the backend session alive, but also consume a CLOSED/SETTLED heartbeat
    // response so the frontend unlocks without requiring a page refresh.
    providerMonitorTimer = setInterval(function(){
      if(activeProviderTab && (activeProviderTab.closed || providerTabReturnedToNaga())){
        closeAndSettle();
        return;
      }
      sendProviderHeartbeat(sessionId)
        .then(function(json){ emitPromotionProgressFromHeartbeat(json); handleHeartbeatResult(json, sessionId); })
        .catch(function(){});
    }, 5000);
  }

  async function directLaunch(payload, reservedProviderTab){
    const token = getToken();
    if(!token){ goLogin(); return null; }
    if(!(await ensureProviderCanLaunch(false))) throw new Error(getActiveProviderSessionId() ? ACTIVE_GAME_MESSAGE : LAUNCHING_GAME_MESSAGE);

    providerLaunchInProgress = true;
    try{
      acquirePendingLaunchLock();
      syncLaunchAvailabilityUi();

      if(window.NAGA_PROVIDER_LAUNCH_DEBUG) console.log('[NAGA launch] endpoint:', LAUNCH_API_URL, 'payload:', payload);

      const res = await fetch(LAUNCH_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify((function(){ const body = Object.assign({}, payload); delete body._display; return body; })())
      });
      const json = await res.json().catch(function(){ return {}; });
      if(window.NAGA_PROVIDER_LAUNCH_DEBUG) console.log('[NAGA launch] response:', res.status, json);
      if(!res.ok || json.status === 'error') throw new Error(cleanProviderErrorMessage(json, 'Launch game failed.'));

      const data = json.data || {};
      const resolvedWalletFlow = firstValue(data.walletFlow, data.wallet_flow, json.walletFlow, json.wallet_flow);
      if(resolvedWalletFlow){
        localStorage.setItem('naga_active_provider_wallet_flow', String(resolvedWalletFlow));
      }
      const activeSession = saveActiveProviderSession(data);

      const launchUrl = extractLaunchUrl(json);
      if(!launchUrl) throw new Error('Provider launch URL not returned. Please check BO provider response launch URL path.');
      closeModal();
      // Keep the provider inside a same-origin Naga game shell. The shell owns the
      // visible Home control while the original lobby remains alive for heartbeat,
      // close detection and settlement. Provider URLs are passed through localStorage
      // instead of the query string so long/signed launch URLs are never truncated.
      const providerWindowName = PROVIDER_GAME_WINDOW_NAME_PREFIX + String(activeSession.sessionId || Date.now());
      const gameTab = reservedProviderTab && !reservedProviderTab.closed ? reservedProviderTab : null;
      if(!gameTab){
        try{
          await exitProviderGame({ sessionId: activeSession.sessionId, providerCode: activeSession.providerCode || payload.providerCode || '', transferBackAll: true });
        }catch(e){}
        throw new Error('Game window was closed or blocked. Your provider balance has been returned. Please allow pop-ups and try again.');
      }
      try{ gameTab.name = providerWindowName; }catch(e){}
      const shellKey = 'naga_provider_shell_' + String(activeSession.sessionId || Date.now()) + '_' + Math.random().toString(36).slice(2);
      localStorage.setItem(shellKey, JSON.stringify({
        launchUrl: launchUrl,
        sessionId: activeSession.sessionId,
        providerCode: activeSession.providerCode || payload.providerCode || '',
        heartbeatUrl: HEARTBEAT_API_URL,
        gameName: payload._display && payload._display.gameName ? payload._display.gameName : ''
      }));
      const shellUrl = 'provider-game.html?k=' + encodeURIComponent(shellKey);
      try{ gameTab.location.replace(shellUrl); }catch(e){ gameTab.location.href = shellUrl; }
      try{ gameTab.focus(); }catch(e){}
      startProviderMonitor(activeSession.sessionId, activeSession.providerCode || payload.providerCode || '', gameTab);
      return launchUrl;
    }finally{
      providerLaunchInProgress = false;
      releasePendingLaunchLock();
      syncLaunchAvailabilityUi();
    }
  }

  async function launch(game, options){
    const payload = normalizePayload(game, options || {});
    const token = getToken();
    if(!token){ goLogin(); return null; }
    if(!payload.gameId && !payload.providerCode) throw new Error('Provider Code is required.');

    const promotionState = promotionLaunchState(payload);
    if(!promotionState.allowed){
      showProviderBusyMessage(promotionState.message);
      return null;
    }

    // Reserve the game shell synchronously from the player's click. This preserves
    // browser user activation while removing the old transfer-amount modal entirely.
    const reservedProviderTab = window.open('provider-game.html?loading=1', '_blank');
    if(!reservedProviderTab){
      throw new Error('Game window was blocked. Please allow pop-ups for this site and try again. No funds were transferred.');
    }
    try{ reservedProviderTab.opener = window; }catch(e){}

    if(!(await ensureProviderCanLaunch(true))){
      try{ reservedProviderTab.close(); }catch(e){}
      return null;
    }

    const launchPayload = Object.assign({}, payload);
    delete launchPayload._display;
    delete launchPayload.transferAmount;
    // Server resolves and locks the authoritative Main Wallet balance. A zero balance
    // intentionally launches with zero; the browser never sends a stale money amount.
    launchPayload.transferAllMainWallet = true;
    if(!launchPayload.returnUrl){
      try{ launchPayload.returnUrl = new URL('provider-return.html', location.href).href; }catch(e){ launchPayload.returnUrl = 'provider-return.html'; }
    }
    // Retain display metadata locally for the game shell only; it is never sent as money data.
    launchPayload._display = payload._display || {};
    try{
      return await directLaunch(launchPayload, reservedProviderTab);
    }catch(err){
      try{ if(reservedProviderTab && !reservedProviderTab.closed) reservedProviderTab.close(); }catch(e){}
      throw err;
    }
  }

  async function exitProviderGame(options){
    const token = getToken();
    if(!token){ goLogin(); return null; }
    const opt = options || {};
    const payload = {
      sessionId: opt.sessionId || localStorage.getItem('naga_last_provider_session_id') || null,
      providerCode: opt.providerCode || localStorage.getItem('naga_last_provider_code') || '',
      transferBackAll: opt.transferBackAll !== false
    };
    if(opt.amount != null) payload.amount = Number(opt.amount);

    // Stop provider heartbeat BEFORE starting settlement, not after the HTTP response.
    // This closes the browser-side race window that previously allowed a late heartbeat
    // to overlap LOGOUT/BALANCE/WITHDRAW and keep the local session looking active.
    stopProviderMonitor();
    if(payload.sessionId != null) providerClosingSessionIds.add(String(payload.sessionId));

    let res, json;
    try{
      res = await fetch(EXIT_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload)
      });
      json = await res.json().catch(function(){ return {}; });
      if(!res.ok || json.status === 'error') {
        // Never expose SQL/provider/internal exception text to players. Keep the detailed
        // error in server logs/BO and show a safe retry message in the game shell.
        throw new Error('We are still returning your game balance. Please keep this page open and try again in a moment.');
      }
      const exitState = getProviderSessionState(json);
      if(exitState.state && !exitState.terminal){
        if(opt.acceptPendingSettlement && payload.sessionId != null){
          // The provider game page has already been unloaded. Keep the backend session
          // lock in localStorage and let the opener poll until Spring marks it terminal.
          // Do not force the game shell to remain open; some providers only release
          // fishing/arcade wallet funds after that shell/iframe is gone.
          if(payload.sessionId != null) providerClosingSessionIds.delete(String(payload.sessionId));
          startPendingSettlementWatch(payload.sessionId);
          return json;
        }
        throw new Error('We are still returning your game balance. Please keep this page open and try again in a moment.');
      }
    }catch(e){
      // Allow an explicit retry if settlement really failed. The backend remains the
      // authority and will still reject heartbeat updates once the row is CLOSED.
      if(payload.sessionId != null) providerClosingSessionIds.delete(String(payload.sessionId));
      throw e;
    }

    clearStoredProviderSession();
    releasePendingLaunchLock();
    providerLaunchInProgress = false;
    if(payload.sessionId != null) providerClosingSessionIds.delete(String(payload.sessionId));
    syncLaunchAvailabilityUi();

    // The exit response now contains the already-committed main wallet balance.
    // Paint it immediately instead of waiting for another wallet HTTP round trip.
    const returnedWallet = json && json.data && json.data.mainWallet ? json.data.mainWallet : null;
    const returnedBalance = returnedWallet && returnedWallet.balance != null
      ? Number(returnedWallet.balance)
      : (returnedWallet && returnedWallet.mainWallet && returnedWallet.mainWallet.balance != null
          ? Number(returnedWallet.mainWallet.balance)
          : NaN);
    if(!isNaN(returnedBalance)){
      walletBalanceCache = returnedBalance;
      localStorage.setItem('member_main_wallet_balance', String(returnedBalance));
      document.querySelectorAll('[data-main-wallet-balance]').forEach(function(el){
        el.textContent = 'MYR ' + money(returnedBalance);
      });
      try{ document.dispatchEvent(new CustomEvent('naga:provider-balance-returned', { detail: { balance: returnedBalance } })); }catch(e){}
      if(window.NAGA_SITE_SHELL && typeof window.NAGA_SITE_SHELL.refreshBalance === 'function'){
        try{ window.NAGA_SITE_SHELL.refreshBalance(); }catch(e){}
      }
    }else{
      refreshWalletAfterProviderExit();
    }
    return json;
  }

  document.addEventListener('naga:promotion-access-changed', function(){ setTimeout(applyPromotionConfirmState, 50); });
  document.addEventListener('naga:promotion-access-ready', function(){ setTimeout(applyPromotionConfirmState, 0); });

  function bindElement(el, game, options){
    if(!el || el.dataset.providerLaunchBound === '1') return;
    el.dataset.providerLaunchBound = '1';
    el.style.cursor = el.style.cursor || 'pointer';
    el.addEventListener('click', async function(e){
      e.preventDefault();
      e.stopPropagation();
      if(el.disabled || el.classList.contains('is-launching')) return;
      try{ await launch(game, Object.assign({}, options || {}, { element: el })); }
      catch(err){ if(window.NAGA_MODAL) window.NAGA_MODAL.error(err.message || 'Launch game failed.', 'Launch Game'); }
    });
  }

  function bindButton(button, game, options){ bindElement(button, game, options); }

  function bindExisting(){
    document.querySelectorAll('.provider-launch-card, .provider-launch-img, .provider-launch-btn, [data-provider-launch="1"]').forEach(function(el){
      bindElement(el, {}, { element: el, transferAmount: 0 });
    });
  }

  let closeSettleSent = false;
  function trySettleOnPageClose(){
    if(closeSettleSent) return;
    const sessionId = localStorage.getItem('naga_active_provider_session_id');
    const providerCode = localStorage.getItem('naga_active_provider_code') || localStorage.getItem('naga_last_provider_code') || '';
    const token = getToken();
    if(!sessionId || !token) return;
    closeSettleSent = true;
    try{
      fetch(EXIT_API_URL, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ sessionId: sessionId, providerCode: providerCode, transferBackAll: true })
      }).catch(function(){});
    }catch(e){}
  }

  // Do NOT explicitly settle an active provider wallet just because the Naga
  // lobby document is unloading. Some providers (including GGSOFT) can cause
  // opener/lobby navigation as part of their launch flow while the separate
  // provider game tab is still alive. Treating pagehide/beforeunload as a real
  // game exit caused BALANCE -> WITHDRAW only seconds after a successful launch.
  //
  // Real exits are still handled by the provider-tab close/return monitor above,
  // and backend stale-session recovery remains the final safety net.
  // Do not settle on visibilitychange. Opening/focusing the provider tab makes the
  // lobby page hidden even though the game is still active, which previously caused
  // premature exit requests and inconsistent delayed balance refreshes.

  // A provider-return tab and the main page share localStorage. When either tab
  // clears the active session, immediately reset the main page launch controls.
  window.addEventListener('storage', function(e){
    if(e.key === 'naga_active_provider_session_id'){
      syncLaunchAvailabilityUi();
      if(!e.newValue){
        stopProviderMonitor();
        activeProviderTab = null;
        resetTransferAction();
        refreshWalletAfterProviderExit();
      }
    }
    if(e.key === PENDING_LAUNCH_LOCK_KEY){
      syncLaunchAvailabilityUi();
    }
  });



  let providerSessionReconcilePromise = null;
  async function reconcileActiveProviderSession(){
    const sessionId = getActiveProviderSessionId();
    if(!sessionId || providerSettlementPromise) return !sessionId;
    if(providerSessionReconcilePromise) return providerSessionReconcilePromise;

    providerSessionReconcilePromise = (async function(){
      try{
        const heartbeat = await sendProviderHeartbeat(sessionId);
        return handleHeartbeatResult(heartbeat, sessionId);
      }catch(e){
        // A stored session can belong to an older login/member on this device.
        // The backend correctly rejects that stale id as "Invalid provider session".
        // Treat terminal backend responses as authoritative and clear only the local
        // stale lock. Real network/temporary errors must keep the active-game lock.
        if(isTerminalSessionMessage(e && e.message)){
          clearStoredProviderSession();
          refreshWalletAfterProviderExit();
          return true;
        }
        return false;
      }finally{
        providerSessionReconcilePromise = null;
        syncLaunchAvailabilityUi();
      }
    })();
    return providerSessionReconcilePromise;
  }

  function settleClosedProviderTabNow(){
    if(!(activeProviderTab && activeProviderTab.closed)) return;
    const sessionId = localStorage.getItem('naga_active_provider_session_id');
    const providerCode = localStorage.getItem('naga_active_provider_code') || localStorage.getItem('naga_last_provider_code') || '';
    if(sessionId){
      exitProviderGame({ sessionId: sessionId, providerCode: providerCode, transferBackAll: true })
        .catch(function(e){
          if(isTerminalSessionMessage(e && e.message)) clearStoredProviderSession();
        });
    }else{
      resetTransferAction();
    }
  }

  window.addEventListener('focus', function(){
    settleClosedProviderTabNow();
    // The provider Lobby/Close button may navigate the game tab back to our site
    // without actually closing that tab. Recheck the backend immediately so a
    // CLOSED session unlocks the lobby without a manual refresh.
    reconcileActiveProviderSession();
  });
  window.addEventListener('pageshow', function(){ reconcileActiveProviderSession(); });
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible'){
      settleClosedProviderTabNow();
      reconcileActiveProviderSession();
    }
  });

  let returnedProviderSettlementPromise = null;
  function isReturnedProviderGameTab(){
    try{ return String(window.name || '').indexOf(PROVIDER_GAME_WINDOW_NAME_PREFIX) === 0; }catch(e){ return false; }
  }

  async function settleReturnedProviderGameTab(){
    if(!isReturnedProviderGameTab()) return false;
    const sessionId = getActiveProviderSessionId();
    if(!sessionId){
      try{ window.name = ''; }catch(e){}
      syncLaunchAvailabilityUi();
      return true;
    }
    if(returnedProviderSettlementPromise) return returnedProviderSettlementPromise;

    returnedProviderSettlementPromise = (async function(){
      try{
        await exitProviderGame({
          sessionId: sessionId,
          providerCode: localStorage.getItem('naga_active_provider_code') || localStorage.getItem('naga_last_provider_code') || '',
          transferBackAll: true
        });
        return true;
      }catch(e){
        // If BO/backend already closed it, clear the stale browser lock immediately.
        if(isTerminalSessionMessage(e && e.message)){
          clearStoredProviderSession();
          refreshWalletAfterProviderExit();
          return true;
        }
        return false;
      }finally{
        try{ window.name = ''; }catch(e){}
        returnedProviderSettlementPromise = null;
        resetTransferAction();
        syncLaunchAvailabilityUi();
      }
    })();
    return returnedProviderSettlementPromise;
  }

  window.NAGA_PROVIDER_LAUNCH = {
    launch: launch,
    directLaunch: directLaunch,
    exitProviderGame: exitProviderGame,
    bindButton: bindButton,
    bindElement: bindElement,
    bindExisting: bindExisting,
    endpoint: LAUNCH_API_URL,
    balanceEndpoint: WALLET_BALANCE_URL,
    exitEndpoint: EXIT_API_URL,
    heartbeatEndpoint: HEARTBEAT_API_URL,
    sendProviderHeartbeat: sendProviderHeartbeat,
    startProviderMonitor: startProviderMonitor,
    stopProviderMonitor: stopProviderMonitor,
    resetTransferAction: resetTransferAction,
    clearStoredProviderSession: clearStoredProviderSession,
    isGameActive: function(){ return Boolean(getActiveProviderSessionId()); },
    canLaunchAnotherGame: ensureProviderCanLaunch,
    reconcileActiveProviderSession: reconcileActiveProviderSession,
    settleReturnedProviderGameTab: settleReturnedProviderGameTab
  };

  document.addEventListener('DOMContentLoaded', function(){
    bindExisting();
    syncLaunchAvailabilityUi();
    if(isReturnedProviderGameTab()){
      // The provider navigated the game tab back to our index/lobby without closing
      // the tab. Settle first, then the shared localStorage event unlocks the original
      // lobby tab immediately—no refresh required.
      settleReturnedProviderGameTab();
    }else{
      reconcileActiveProviderSession();
    }
  });
})();
