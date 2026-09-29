// Normalize root home URL so / and /index.html run exactly the same home initialization.
(function(){
  try{
    var path = window.location.pathname || '';
    if(path === '/' || /\/$/.test(path)){
      var normalized = path.replace(/\/$/, '/') + 'index.html' + (window.location.search || '') + (window.location.hash || '');
      window.history.replaceState(window.history.state, document.title, normalized);
    }
  }catch(e){}
})();

const API = window.NAGA_API || {};
const GAME_CATEGORY_API_URL =
  API.publicGameCatalog || ((window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) ? window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog' : 'https://bo.titanx7.com/api/public/game-catalog');
const GAME_SUB_CATEGORY_API_URL =
  API.publicGameCatalog || ((window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) ? window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog' : 'https://bo.titanx7.com/api/public/game-catalog');
const GAME_API_URL =
  API.publicGameCatalog || ((window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) ? window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog' : 'https://bo.titanx7.com/api/public/game-catalog');
const GAME_PROVIDER_API_URL =
  API.publicGameCatalog || ((window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) ? window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog' : 'https://bo.titanx7.com/api/public/game-catalog');
const PUBLIC_GAME_CATALOG_API_URL =
  API.publicGameCatalog || ((window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) ? window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog' : 'https://bo.titanx7.com/api/public/game-catalog');
const PUBLIC_GAME_CATALOG_VERSION_URL =
  API.publicGameCatalogVersion || PUBLIC_GAME_CATALOG_API_URL + '/version';

let categories = [];
let subCategories = [];
let providers = [];
let activeCategoryId = null;
let activeSubCategoryId = null;
let activeProviderCode = null;
let currentGameList = [];
let allSubCategories = [];
let catalogGames = [];
let gameCatalogReady = false;
let catalogRefreshPromise = null;
let showingProviderList = true;
let gameLoadSequence = 0;
let subCategoryLoadSequence = 0;
const DEFAULT_GAME_SECTION_KEYWORD = 'slot';
const ALL_PROVIDER_CODE = '__ALL__';
let subCategoryAutoTriedIds = new Set();

// Active promotion game/provider lock. When BO Allowed Game / Provider is
// populated, only matching providers/games are clickable until the promotion
// lifecycle is completed/settled/forfeited.
let activePromotionAllowedTokens = null;
let promotionRestrictionLoading = !!localStorage.getItem('member_token');

function normalizePromotionAccessToken(value){
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase();
}

function parsePromotionAllowedTokens(raw){
  const tokens = new Set();
  String(raw == null ? '' : raw).split(/[,;\n\r|]+/).forEach(part => {
    const token = normalizePromotionAccessToken(part);
    if(token) tokens.add(token);
  });
  return tokens;
}

function isPromotionLifecycleActive(status){
  return ['ACTIVE','PENDING_COMPLETION','READY_TO_COMPLETE'].includes(String(status || '').toUpperCase());
}

function promotionGameAllowed(game){
  if(promotionRestrictionLoading) return false;
  if(!activePromotionAllowedTokens || !activePromotionAllowedTokens.size) return true;
  const provider = normalizePromotionAccessToken(providerCodeOf(game));
  const code = normalizePromotionAccessToken(game && (game.gameCode || game.game_code || game.code));
  const name = normalizePromotionAccessToken(game && (game.name || game.gameName || game.game_name));
  return (!!provider && activePromotionAllowedTokens.has(provider)) ||
         (!!code && activePromotionAllowedTokens.has(code)) ||
         (!!name && activePromotionAllowedTokens.has(name));
}

function promotionProviderAllowed(providerCode){
  if(promotionRestrictionLoading) return false;
  if(!activePromotionAllowedTokens || !activePromotionAllowedTokens.size) return true;
  const provider = normalizePromotionAccessToken(providerCode);
  if(provider && activePromotionAllowedTokens.has(provider)) return true;
  return (Array.isArray(catalogGames) ? catalogGames : []).some(game =>
    providerCodeOf(game) === provider && promotionGameAllowed(game));
}

function promotionDisabledMessage(){
  return 'This game/provider is disabled while your active promotion is in progress. Complete the promotion to unlock all games.';
}

function markPromotionDisabled(el, disabled){
  if(!el) return;
  el.classList.toggle('promotion-access-disabled', !!disabled);
  el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  if(disabled) el.setAttribute('title', promotionDisabledMessage());
  else if(el.getAttribute('title') === promotionDisabledMessage()) el.removeAttribute('title');
}

async function loadPromotionGameRestriction(){
  const memberToken = localStorage.getItem('member_token') || '';
  if(!memberToken){
    promotionRestrictionLoading = false;
    activePromotionAllowedTokens = null;
    return;
  }
  try{
    const base = (window.NAGA_CONFIG && window.NAGA_CONFIG.api && window.NAGA_CONFIG.api.baseUrl) || '';
    const url = (window.NAGA_API && window.NAGA_API.playerPromotionClaims) || (base.replace(/\/+$/, '') + '/api/player/promotion/my-claims');
    const res = await fetch(url, {headers:{'Authorization':'Bearer ' + memberToken}, cache:'no-store'});
    const json = await res.json().catch(()=>({}));
    if(!res.ok || json.status === 'error') throw new Error(json.message || 'Unable to load promotion access rule');
    const claims = Array.isArray(json.data) ? json.data : [];
    const active = claims.filter(c => isPromotionLifecycleActive(c && c.status)).sort((a,b) => Number(b.id || 0) - Number(a.id || 0))[0];
    activePromotionAllowedTokens = active && String(active.allowedGames || '').trim() ? parsePromotionAllowedTokens(active.allowedGames) : null;
  }catch(err){
    console.warn('Promotion game restriction unavailable:', err && err.message ? err.message : err);
    // Fail closed for a logged-in member until the restriction endpoint can be read.
    activePromotionAllowedTokens = new Set(['__PROMOTION_RULE_UNAVAILABLE__']);
  }finally{
    promotionRestrictionLoading = false;
    if(gameCatalogReady && typeof loadGames === 'function') loadGames();
    try{ document.dispatchEvent(new CustomEvent('naga:promotion-access-ready')); }catch(e){}
  }
}

loadPromotionGameRestriction();
window.NAGA_PROMOTION_ACCESS = {
  refresh: loadPromotionGameRestriction,
  isGameAllowed: function(game){ return promotionGameAllowed(game || {}); },
  isLaunchAllowed: function(providerCode, gameCode, gameName){
    return promotionGameAllowed({providerCode: providerCode, gameCode: gameCode, name: gameName});
  },
  isLoading: function(){ return promotionRestrictionLoading; },
  message: promotionDisabledMessage
};
document.addEventListener('naga:promotion-access-changed', loadPromotionGameRestriction);

function isAllProviderCode(code){
  return String(code || '') === ALL_PROVIDER_CODE;
}


function tr(key, fallback){
  return (window.I18N && window.I18N.t && window.I18N.t(key) !== key) ? window.I18N.t(key) : (fallback || key);
}

function currentLangCode(){
  return (window.I18N && window.I18N.current) || localStorage.getItem('site_lang') || localStorage.getItem('lang') || document.documentElement.lang || 'en';
}

function isZhLang(){
  const lang = currentLangCode();
  return String(lang).toLowerCase().startsWith('zh') || String(lang).toLowerCase().startsWith('cn');
}

function transValue(item, field){
  const lang = currentLangCode();
  if(!item || !item.translations) return '';
  const direct = item.translations[lang] || item.translations[String(lang).toLowerCase()];
  if(direct && direct[field]) return direct[field];
  const shortLang = String(lang).toLowerCase().split('-')[0];
  return item.translations[shortLang] && item.translations[shortLang][field] ? item.translations[shortLang][field] : '';
}

function langText(item, field, fallback){
  const dynamicValue = transValue(item, field);
  if(dynamicValue) return dynamicValue;
  return item?.[field] || fallback || '';
}

function uploadBaseUrl(){
  const cfg = window.NAGA_CONFIG && window.NAGA_CONFIG.api;
  return ((cfg && cfg.uploadBaseUrl) || 'https://static.titanx7.com/uploads').replace(/\/+$/, '');
}

function isFullImageUrl(value){
  return /^(https?:)?\/\//i.test(String(value || '')) || String(value || '').startsWith('data:') || String(value || '').startsWith('assets/');
}

function resolveUploadImage(value, folder, fallback){
  const img = String(value || '').trim();
  if(!img) return fallback || '';
  if(isFullImageUrl(img) || img.startsWith('/')) return img;
  return uploadBaseUrl() + '/' + folder + '/' + img.replace(/^\/+/, '');
}

const categoryRow=document.getElementById('categoryRow');
const gameGrid=document.getElementById('gameGrid');
const subTabRow=document.getElementById('subTabRow');

const catPrev=document.querySelector('.cat-prev');
const catNext=document.querySelector('.cat-next');
if(catPrev && catNext && categoryRow){
  function scrollCategoryPage(direction){
    const firstCat = categoryRow.querySelector('.cat');
    const gap = parseFloat(getComputedStyle(categoryRow).gap) || 0;
    const step = firstCat ? (firstCat.offsetWidth + gap) * 3 : categoryRow.clientWidth;
    categoryRow.scrollBy({left: direction * step, behavior:'smooth'});
  }
  catPrev.addEventListener('click',()=>scrollCategoryPage(-1));
  catNext.addEventListener('click',()=>scrollCategoryPage(1));
}

function normalizeApiList(response){
  if(Array.isArray(response)) return response;
  if(response && Array.isArray(response.data)) return response.data;
  if(response && response.data && Array.isArray(response.data.data)) return response.data.data;
  return [];
}

function isActiveItem(item){
  if(!item || typeof item !== 'object') return false;

  const raw = item.status ?? item.active ?? item.isActive ?? item.is_active ?? item.enabled ?? item.isEnabled;
  if(raw == null || raw === '') return true;
  if(typeof raw === 'boolean') return raw;
  if(typeof raw === 'number') return raw === 1;

  const value = String(raw).trim().toUpperCase();
  if(['1', 'TRUE', 'ACTIVE', 'ENABLED', 'ENABLE', 'YES', 'Y'].includes(value)) return true;
  if(['0', 'FALSE', 'INACTIVE', 'DISABLED', 'DISABLE', 'NO', 'N', 'DELETED'].includes(value)) return false;

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric === 1 : false;
}

function sortByOrder(a, b){
  return (Number(a.sortOrder || a.sort_order || 0) - Number(b.sortOrder || b.sort_order || 0))
      || (Number(a.id || 0) - Number(b.id || 0));
}


function safeLower(value){
  return String(value == null ? '' : value).toLowerCase();
}

function getItemNameForMatch(item){
  return [
    item && item.name,
    item && item.title,
    item && item.code,
    item && item.categoryCode,
    item && item.category_code,
    item && item.type,
    transValue(item, 'name'),
    transValue(item, 'title')
  ].map(safeLower).join(' ');
}

function normalizeKey(value){
  return String(value == null ? '' : value).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function categoryTypeKey(cat){
  const raw = cat?.code || cat?.categoryCode || cat?.type || cat?.name || transValue(cat, 'name') || '';
  const key = normalizeKey(raw);
  if(key.includes('SLOT')) return 'SLOT';
  if(key.includes('LIVE')) return 'LIVE';
  if(key.includes('SPORT')) return 'SPORT';
  if(key.includes('FISH')) return 'FISHING';
  if(key.includes('OTHER')) return 'OTHER';
  if(key.includes('HOT')) return 'HOT';
  return key;
}

function activeCategoryTypeKey(){
  const cat = categories.find(c => String(c.id) === String(activeCategoryId));
  return categoryTypeKey(cat);
}

function activeCategory(){
  return categories.find(c => String(c.id) === String(activeCategoryId));
}

function activeCategoryDisplayMode(){
  const cat = activeCategory();
  const mode = String(cat?.displayMode || cat?.display_mode || '').trim().toUpperCase();

  // Every category follows the Frontend Display Mode saved in BO.
  // PROVIDER_FIRST / PROVIDER uses its category-specific provider layout,
  // while DIRECT_GAME opens the game grid directly without a provider rail.
  return mode === 'DIRECT_GAME' ? 'DIRECT_GAME' : 'PROVIDER';
}

function isDirectGameCategory(){
  return activeCategoryDisplayMode() === 'DIRECT_GAME';
}

// HOT GAME uses provider cards as its first screen when more than one provider
// is configured. After a provider is chosen, show only that provider's games;
// do not repeat the normal left-side provider rail inside the game view.
function isHotMultiProviderGameView(){
  return activeCategoryTypeKey() === 'HOT'
    && categoryProviderRules().length > 1
    && activeProviderCode
    && !isAllProviderCode(activeProviderCode);
}

function providerTypesOf(provider){
  const raw = provider?.providerTypes || provider?.provider_types || provider?.providerType || provider?.provider_type || provider?.type || '';
  const values = Array.isArray(raw) ? raw : String(raw).split(/[,|]/);
  return [...new Set(values.map(value => normalizeKey(value)).filter(Boolean))];
}

function providerTypeOf(provider){
  return providerTypesOf(provider)[0] || '';
}

function providerCategoryIdsOf(provider){
  const raw = provider?.categoryIds || provider?.category_ids || '';
  const values = Array.isArray(raw) ? raw : String(raw).split(/[,|]/);
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
}

function categoryProviderRules(cat = activeCategory()){
  try{
    const raw = cat?.providerRules || cat?.provider_rules || '{"providers":[]}';
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed?.providers) ? parsed.providers : [];
  }catch(e){ return []; }
}

function providerRuleForCode(code){
  const clean = String(code || '').trim().toUpperCase();
  return categoryProviderRules().find(r => String(r.providerCode || '').trim().toUpperCase() === clean) || null;
}

function providersForActiveCategory(){
  const activeId = String(activeCategoryId || '').trim();
  if(!activeId) return providers;

  const configuredCodes = categoryProviderRules()
    .map(r => String(r.providerCode || '').trim().toUpperCase())
    .filter(Boolean);

  // HOT GAME is a curated landing and must follow its explicit BO provider
  // selection exactly. Normal categories are different: Provider Management's
  // "Provider Categories" assignment is also authoritative. Merge both sources
  // so a provider-level integration with no GAME_LIST rows (WBET/other sports
  // providers) appears immediately after it is assigned to SPORT/LIVE/OTHER,
  // without requiring the category to be opened and re-saved afterwards.
  if(activeCategoryTypeKey() === 'HOT' && configuredCodes.length){
    return providers.filter(p => configuredCodes.includes(providerCodeOf(p)));
  }

  const configuredSet = new Set(configuredCodes);
  const byIds = providers.filter(p => providerCategoryIdsOf(p).includes(activeId));
  byIds.forEach(p => configuredSet.add(providerCodeOf(p)));
  if(configuredSet.size) return providers.filter(p => configuredSet.has(providerCodeOf(p)));

  const key = activeCategoryTypeKey();
  return key ? providers.filter(p => providerTypesOf(p).includes(key)) : providers;
}

function pickDefaultCategoryId(list){
  if(!Array.isArray(list) || !list.length) return null;
  // Home page must open HOT GAME first. Fall back to the first configured
  // category only when BO has no active hot category.
  const hot = list.find(item => categoryTypeKey(item) === 'HOT' || getItemNameForMatch(item).includes('hot'));
  return (hot || list[0]).id;
}

function pickDefaultSubCategoryId(list){
  if(!Array.isArray(list) || !list.length) return null;
  const slot = list.find(item => getItemNameForMatch(item).includes(DEFAULT_GAME_SECTION_KEYWORD));
  return (slot || list[0]).id;
}

function setGamesLoading(){
  if(!gameGrid) return;

  // Once the VPBet-style local catalog is available, category/provider changes
  // are client-side filters and should never flash the API spinner again.
  if(gameCatalogReady) return;

  // Keep the provider rail mounted while only the selected provider's games reload.
  // This preserves its scroll position and avoids the sidebar flashing/rebuilding.
  const existingLobby = gameGrid.querySelector('.provider-lobby-shell');
  const existingPanel = existingLobby && existingLobby.querySelector('.provider-games-panel');
  const keepProviderRail = existingPanel && activeProviderCode && !isDirectGameCategory() && !isHotMultiProviderGameView();

  if(keepProviderRail){
    existingPanel.innerHTML = '<div class="games-loading-indicator" role="status" aria-label="Loading games"><span class="games-loading-spinner" aria-hidden="true"></span></div>';
    existingPanel.scrollTop = 0;
    return;
  }

  gameGrid.innerHTML = '<div class="games-loading-indicator" role="status" aria-label="Loading games"><span class="games-loading-spinner" aria-hidden="true"></span></div>';
}

function syncProviderRailActiveState(rail){
  if(!rail) return;
  rail.querySelectorAll('.provider-rail-card').forEach(btn => {
    const code = btn.dataset.providerCode || '';
    const active = isAllProviderCode(activeProviderCode)
      ? isAllProviderCode(code)
      : String(code) === String(activeProviderCode || '');
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function getImageUrl(item, fallback, folder){
  let value;
  const dynamicImageUrl = transValue(item, 'imageUrl') || transValue(item, 'imageImageUrl');
  const dynamicImage = transValue(item, 'image') || transValue(item, 'imageImage');
  if(dynamicImageUrl || dynamicImage){
    value = dynamicImageUrl || dynamicImage;
  }else{
    value = item.imageUrl || item.image_url || item.image;
  }
  if(!folder) return value || fallback || '';
  return resolveUploadImage(value, folder, fallback);
}


function centerActiveMobileCategory(){
  if(!categoryRow || !window.matchMedia || !window.matchMedia('(max-width: 768px)').matches) return;
  const active = categoryRow.querySelector('.cat.active') || categoryRow.querySelector('.cat');
  if(!active || typeof active.scrollIntoView !== 'function') return;
  window.requestAnimationFrame(() => {
    active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  });
}



function centerActiveMobileSubCategory(){
  if(!subTabRow || !window.matchMedia || !window.matchMedia('(max-width: 768px)').matches) return;
  const active = subTabRow.querySelector('button.active') || subTabRow.querySelector('button');
  if(!active || typeof active.scrollIntoView !== 'function') return;
  window.requestAnimationFrame(() => {
    active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  });
}

function renderCategories(){
  if(!categoryRow) return;
  categoryRow.classList.remove('is-initial-loading');
  categoryRow.setAttribute('aria-busy','false');
  categoryRow.innerHTML='';

  if(!categories.length){
    categoryRow.innerHTML = '<div class="empty-state">No category available</div>';
    return;
  }

  const allEl=document.createElement('button');
  allEl.className=`cat mobile-all-cat ${!activeCategoryId?'active':''}`;
  allEl.type='button';
  allEl.dataset.id='';
  allEl.innerHTML='<span class="mobile-cat-emoji">🏠</span><span>All</span>';
  categoryRow.appendChild(allEl);

  categories.forEach(cat=>{
    const el=document.createElement('button');
    el.className=`cat ${String(cat.id)===String(activeCategoryId)?'active':''}`;
    el.type='button';
    el.dataset.id=cat.id;
    el.dataset.categoryId=cat.id;
    const icon = getImageUrl(cat, 'assets/images/nav1.png', 'game-category');
    const catName = langText(cat, 'name', 'Category');
    el.innerHTML=`<img src="${icon}" class="cat-icon" alt="${catName}"><span>${catName}</span>`;
    categoryRow.appendChild(el);
  });
  centerActiveMobileCategory();
}

function renderSubTabs(){
  if(!subTabRow) return;
  subTabRow.innerHTML = '';

  if(!activeProviderCode || isAllProviderCode(activeProviderCode) || !subCategories.length){
    subTabRow.style.display = 'none';
    if(!activeProviderCode) activeSubCategoryId = null;
    return;
  }

  subTabRow.style.display = '';

  subCategories.forEach((sub, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.id = sub.id;
    btn.textContent = langText(sub, 'name', 'Sub Category');

    if(String(sub.id) === String(activeSubCategoryId) || (!activeSubCategoryId && index === 0)){
      btn.classList.add('active');
      activeSubCategoryId = sub.id;
    }

    subTabRow.appendChild(btn);
  });
  centerActiveMobileSubCategory();
}

function providerCodeOf(item){
  return String(item?.providerCode || item?.provider_code || item?.code || '').trim().toUpperCase();
}

function providerNameOf(provider){
  return provider?.name || provider?.title || providerCodeOf(provider) || 'Provider';
}

function providerForCode(code){
  const clean = String(code || '').trim().toUpperCase();
  return providers.find(p => providerCodeOf(p) === clean) || { code: clean, name: clean };
}

function providerInitials(name){
  const words = String(name || 'P').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'P';
}

function providerImageOf(provider){
  const value = provider?.imageUrl || provider?.image_url || provider?.providerImageUrl || provider?.provider_image_url || provider?.logoUrl || provider?.logo_url || provider?.logo || provider?.image;
  return resolveUploadImage(value, 'provider', '');
}

function providerBrandImageOf(provider){
  const value = provider?.providerBrandImageUrl || provider?.provider_brand_image_url || provider?.brandImageUrl || provider?.brand_image_url || '';
  // Keep existing provider image as a backward-compatible fallback until a
  // dedicated second brand image is configured in BO.
  return resolveUploadImage(value, 'provider', '') || providerImageOf(provider);
}

function frontendGameFallbackImageOf(game){
  const provider = providerForCode(providerCodeOf(game));
  const configured = provider?.frontendGameFallbackImageUrl || provider?.frontend_game_fallback_image_url || '';
  return resolveUploadImage(configured, 'game', 'assets/images/game.png');
}

function bindGameImageFallback(img, game){
  if(!img) return;
  const fallbackUrl = frontendGameFallbackImageOf(game);
  img.dataset.fallbackSrc = fallbackUrl;
  img.addEventListener('error', function handleBrokenGameImage(){
    if(this.dataset.fallbackApplied === '1') return;
    this.dataset.fallbackApplied = '1';
    this.src = fallbackUrl;
  }, { once: false });
}



function categoryIdForProviderCode(providerCode){
  const provider = providerForCode(providerCode);
  const categoryIds = providerCategoryIdsOf(provider);
  if(categoryIds.length){
    const matched = categories.find(cat => categoryIds.includes(String(cat.id)));
    if(matched && matched.id != null) return matched.id;
  }
  const providerTypes = providerTypesOf(provider);
  if(providerTypes.length){
    const matched = categories.find(cat => providerTypes.includes(categoryTypeKey(cat)));
    if(matched && matched.id != null) return matched.id;
  }
  const slot = categories.find(cat => categoryTypeKey(cat) === 'SLOT');
  return slot && slot.id != null ? slot.id : (categories[0] && categories[0].id != null ? categories[0].id : null);
}

function ensureCategoryForSelectedProvider(){
  if(activeCategoryId || !activeProviderCode || isAllProviderCode(activeProviderCode)) return false;
  const inferredId = categoryIdForProviderCode(activeProviderCode);
  if(inferredId == null) return false;
  activeCategoryId = inferredId;
  renderCategories();
  return true;
}

function categoryIdForProviderNavigation(providerCode){
  const cleanCode = String(providerCode || '').trim().toUpperCase();
  if(!cleanCode) return null;
  const currentId = String(activeCategoryId || '');
  const provider = providerForCode(cleanCode);
  const usable = cat => cat && cat.id != null && String(cat.id) !== currentId && categoryTypeKey(cat) !== 'HOT';

  // Prefer the provider/category relationship configured in BO, excluding the
  // Hot Game landing category itself. This stays generic for every provider.
  const configuredIds = providerCategoryIdsOf(provider);
  const configuredMatches = categories.filter(cat => usable(cat) && configuredIds.includes(String(cat.id)));
  if(configuredMatches.length === 1) return configuredMatches[0].id;

  // Provider type is the next strongest signal (SPORT/LIVE/SLOT/etc.).
  const types = providerTypesOf(provider);
  const typeMatches = categories.filter(cat => usable(cat) && types.includes(categoryTypeKey(cat)));
  if(typeMatches.length === 1) return typeMatches[0].id;

  // Fall back to the actual game assignments for this provider and choose the
  // most frequently assigned non-Hot category. No provider code is hardcoded.
  const counts = new Map();
  (Array.isArray(catalogGames) ? catalogGames : []).forEach(game => {
    if(providerCodeOf(game) !== cleanCode) return;
    gameCategoryIdsOf(game).forEach(id => {
      const cat = categories.find(c => String(c.id) === String(id));
      if(!usable(cat)) return;
      counts.set(String(id), (counts.get(String(id)) || 0) + 1);
    });
  });
  if(counts.size){
    const bestId = [...counts.entries()].sort((a,b) => b[1] - a[1])[0][0];
    const best = categories.find(cat => String(cat.id) === String(bestId));
    if(best) return best.id;
  }

  if(configuredMatches.length) return configuredMatches[0].id;
  if(typeMatches.length) return typeMatches[0].id;
  return null;
}

function providerRowsForActiveCategory(games, configuredOnly = false){
  const sourceGames = Array.isArray(games) ? games : currentGameList;
  const countByProvider = new Map();
  sourceGames.forEach(game => {
    const code = providerCodeOf(game);
    if(code) countByProvider.set(code, (countByProvider.get(code) || 0) + 1);
  });

  // The category game response is the most reliable source of truth for the
  // normal provider rail. Some providers do not expose categoryIds/providerType
  // metadata, so relying only on provider metadata can incorrectly return an
  // empty list. Build the rail from provider codes that actually exist in the
  // selected category's game response, then use provider metadata for logos/name.
  const metadataByCode = new Map(providers.map(provider => [providerCodeOf(provider), provider]));
  const configuredProviders = providersForActiveCategory();
  const configuredByCode = new Map(configuredProviders.map(provider => [providerCodeOf(provider), provider]));

  // Always keep every provider selected in BO visible in the category rail.
  // Previously the rail was built only from providers that already had at least
  // one matching game in the filtered result, so configured providers silently
  // disappeared whenever their game rows were temporarily empty, uncategorised,
  // disabled, or still waiting for import/sync.
  const orderedCodes = [];
  configuredProviders.forEach(provider => {
    const code = providerCodeOf(provider);
    if(code && !orderedCodes.includes(code)) orderedCodes.push(code);
  });
  // Normal category rails may also include provider codes found in the game
  // response as a fallback for incomplete provider metadata. HOT GAME landing,
  // however, must follow the BO selection exactly, otherwise unselected
  // providers reappear simply because their games exist in the catalog.
  if(!configuredOnly || !configuredProviders.length){
    countByProvider.forEach((count, code) => {
      if(code && !orderedCodes.includes(code)) orderedCodes.push(code);
    });
  }

  const providerSource = orderedCodes.map(code =>
    configuredByCode.get(code) || metadataByCode.get(code) || {
      providerCode: code,
      providerName: code,
      name: code,
      sortOrder: 9999
    }
  );

  return providerSource.sort((a, b) => {
    const ao = Number(a.sortOrder || a.sort_order || 0);
    const bo = Number(b.sortOrder || b.sort_order || 0);
    return (ao - bo) || providerNameOf(a).localeCompare(providerNameOf(b));
  }).map(provider => ({
    code: providerCodeOf(provider),
    provider,
    count: countByProvider.get(providerCodeOf(provider)) || 0
  })).filter(row => row.code);
}


function providerAllImageUrl(){
  const assets = window.NAGA_CUSTOM_ASSETS || {};
  const value = assets.providerAll || assets.providerAllUrl || '';
  return String(value || '').trim();
}

function buildProviderRail(rows){
  const rail = document.createElement('div');
  rail.className = 'provider-side-rail';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'provider-rail-card provider-rail-all' + (isAllProviderCode(activeProviderCode) ? ' active' : '');
  allBtn.dataset.providerCode = ALL_PROVIDER_CODE;
  const allImageUrl = providerAllImageUrl();
  allBtn.innerHTML = allImageUrl
    ? `<img src="${allImageUrl}" alt="All Providers" loading="eager">`
    : '<div class="provider-rail-all-icon">All</div>';
  allBtn.addEventListener('click', () => {
    if(isAllProviderCode(activeProviderCode)) return;
    activeProviderCode = ALL_PROVIDER_CODE;
    activeSubCategoryId = null;
    subCategories = [];
    renderSubTabs();
    setGamesLoading();
    loadGames();
  });
  rail.appendChild(allBtn);

  rows.forEach((row, rowIndex) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-rail-card' + (String(row.code) === String(activeProviderCode) ? ' active' : '');
    btn.dataset.providerCode = row.code;
    if(activeCategoryId != null) btn.dataset.categoryId = activeCategoryId;
    const name = providerNameOf(row.provider);
    const imageUrl = providerImageOf(row.provider);
    btn.innerHTML = imageUrl
      ? `<img src="${imageUrl}" alt="${name}" loading="${rowIndex < 8 ? 'eager' : 'lazy'}" decoding="async" fetchpriority="${rowIndex < 6 ? 'high' : 'auto'}">`
      : `<div class="provider-rail-initial">${providerInitials(name)}</div>`;
    btn.addEventListener('click', () => {
      if(String(activeProviderCode) === String(row.code)) return;
      activeProviderCode = row.code;
      activeSubCategoryId = null;
      subCategoryAutoTriedIds = new Set();
      // Keep the currently selected top category when filtering by provider.
      // Previously this helper could switch Slot/Live/Sport/Other back to Hot,
      // which caused the normal left provider rail to disappear.
      setGamesLoading();
      loadSubCategories();
    });
    rail.appendChild(btn);
  });
  return rail;
}

function gamesForProviderFromCategoryList(games, providerCode){
  const cleanCode = String(providerCode || '').trim().toUpperCase();
  let providerGames = (Array.isArray(games) ? games : []).filter(game => providerCodeOf(game) === cleanCode);
  const rule = providerRuleForCode(cleanCode);
  if(rule && String(rule.gameMode || 'ALL').toUpperCase() === 'SELECTED'){
    const allowed = new Set((rule.gameIds || []).map(String));
    providerGames = providerGames.filter(game => allowed.has(String(game.id)));
  }
  return providerGames;
}

function allCatalogGamesForProvider(providerCode){
  const cleanCode = String(providerCode || '').trim().toUpperCase();
  if(!cleanCode) return [];

  // IMPORTANT: direct-launch detection must count the provider's TOTAL active
  // games across the whole catalog, across ALL categories. Do NOT apply the
  // selected category's provider rule here. That rule is category-specific and
  // can make a multi-game provider (for example FACHAI) look like it has only
  // one game inside LIVE GAME, causing an incorrect immediate launch.
  // catalogGames is already filtered to active games + active providers.
  return (Array.isArray(catalogGames) ? catalogGames : [])
    .filter(game => providerCodeOf(game) === cleanCode);
}

function openProviderFromLanding(providerCode, games){
  const cleanCode = String(providerCode || '').trim().toUpperCase();
  if(!cleanCode) return;
  const providerGames = gamesForProviderFromCategoryList(games, cleanCode);
  const allProviderGames = allCatalogGamesForProvider(cleanCode);

  // A provider can be launchable without exposing a game-list API at all.
  // WBET is one example: the backend already supports provider-level SPORTS
  // launch using only providerCode. Treat every zero-game provider generically
  // the same way instead of drilling into an empty game screen.
  if(allProviderGames.length === 0){
    const provider = providerForCode(cleanCode);
    const providerName = providerNameOf(provider);
    if(window.NAGA_PROVIDER_LAUNCH && typeof window.NAGA_PROVIDER_LAUNCH.launch === 'function'){
      Promise.resolve(window.NAGA_PROVIDER_LAUNCH.launch(
        { providerCode: cleanCode, name: providerName },
        { providerCode: cleanCode, transferAmount: 0, gameName: providerName }
      )).catch(err => {
        if(window.NAGA_MODAL) window.NAGA_MODAL.error((err && err.message) || 'Launch provider failed.', 'Launch Game');
      });
      return;
    }
  }

  // Direct launch only when the WHOLE provider has exactly one active game.
  // Do not use the selected category count for this decision.
  if(allProviderGames.length === 1){
    const game = allProviderGames[0];
    const gameName = langText(game, 'name', 'Game');
    if(window.NAGA_PROVIDER_LAUNCH && typeof window.NAGA_PROVIDER_LAUNCH.launch === 'function'){
      Promise.resolve(window.NAGA_PROVIDER_LAUNCH.launch(game, { transferAmount: 0, gameName: gameName }))
        .catch(err => { if(window.NAGA_MODAL) window.NAGA_MODAL.error((err && err.message) || 'Launch game failed.', 'Launch Game'); });
      return;
    }
    const targetUrl = game.gameUrl || game.game_url || '';
    window.location.href = targetUrl || ('game-detail.html?id=' + encodeURIComponent(game.id || ''));
    return;
  }

  activeProviderCode = cleanCode;
  activeSubCategoryId = null;
  subCategoryAutoTriedIds = new Set();
  setGamesLoading();
  loadSubCategories();
}

function renderMixedCategoryLanding(games){
  if(!gameGrid) return;
  showingProviderList = true;
  activeProviderCode = null;
  currentGameList = Array.isArray(games) ? games : [];
  gameGrid.innerHTML = '';
  gameGrid.classList.remove('provider-with-rail', 'provider-grid');
  gameGrid.classList.add('provider-first-grid');

  // HOT GAME provider cards must contain only providers selected in BO.
  const providerRows = providerRowsForActiveCategory(currentGameList, true);
  const selectedCodes = new Set(providerRows.map(row => row.code));
  const activeId = String(activeCategoryId || '');
  // Keep only genuinely direct category assignments beneath the provider cards.
  // Games from unselected providers must not leak into HOT GAME merely because
  // they exist in the global catalog.
  const directGames = currentGameList.filter(game => {
    const code = providerCodeOf(game);
    const directlyAssigned = gameCategoryIdsOf(game).includes(activeId);
    return directlyAssigned && (!code || !selectedCodes.has(code));
  });

  const shell = document.createElement('div');
  shell.className = 'category-mixed-shell';

  if(providerRows.length){
    const providerSection = document.createElement('section');
    providerSection.className = 'category-provider-section';
    // providerSection.innerHTML = '<div class="category-section-title">Providers</div>';
    const cards = document.createElement('div');
    cards.className = 'category-provider-cards';
    providerRows.forEach((row, rowIndex) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'category-provider-card';
      btn.dataset.providerCode = row.code;
      if(activeCategoryId != null) btn.dataset.categoryId = activeCategoryId;
        const image = providerBrandImageOf(row.provider);
      btn.innerHTML = image
        ? `<img src="${image}" alt="${providerNameOf(row.provider)}" loading="${rowIndex < 8 ? 'eager' : 'lazy'}" decoding="async" fetchpriority="${rowIndex < 6 ? 'high' : 'auto'}">`
        : `<span class="provider-letter">${providerInitials(providerNameOf(row.provider))}</span>`;
      btn.addEventListener('click', () => {
        // Provider First is a single drill-down only: keep the selected top
        // category (including HOT GAME), then show this provider's games
        // directly without rendering the provider rail a second time.
        openProviderFromLanding(row.code, currentGameList);
      });
      cards.appendChild(btn);
    });
    providerSection.appendChild(cards);
    shell.appendChild(providerSection);
  }

  if(directGames.length){
    const gamesSection = document.createElement('section');
    gamesSection.className = 'category-direct-section';
    gamesSection.innerHTML = '<div class="category-section-title">Games</div>';
    const list = document.createElement('div');
    list.className = 'direct-games-list';
    directGames.forEach(game => list.appendChild(createGameCard(game)));
    gamesSection.appendChild(list);
    shell.appendChild(gamesSection);
  }

  if(!providerRows.length && !directGames.length){
    shell.innerHTML = '<div class="empty-state">No provider or game available for this category</div>';
  }
  gameGrid.appendChild(shell);
}

function renderProviderCards(games){
  if(!gameGrid) return;
  showingProviderList = true;
  currentGameList = Array.isArray(games) ? games : [];
  if(subTabRow){
    subTabRow.innerHTML = '';
    subTabRow.style.display = 'none';
  }
  gameGrid.innerHTML = '';
  gameGrid.classList.remove('provider-grid', 'provider-first-grid');
  gameGrid.classList.add('provider-with-rail');

  const rows = providerRowsForActiveCategory(currentGameList);
  if(!rows.length){
    activeProviderCode = null;
    gameGrid.innerHTML = '<div class="empty-state">No provider available for this category</div>';
    try{ document.dispatchEvent(new CustomEvent('naga:scroll-target-changed')); }catch(_e){}
    return;
  }

  // SLOT GAME only: open the first configured provider by default so the
  // highlighted provider on the left always matches the games on the right.
  // Users can still select All or any other provider from the existing rail.
  const firstProviderCode = rows[0].code;
  activeProviderCode = firstProviderCode;
  activeSubCategoryId = null;
  subCategoryAutoTriedIds = new Set();

  let firstProviderGames = currentGameList.filter(game => providerCodeOf(game) === firstProviderCode);
  const rule = providerRuleForCode(firstProviderCode);
  if(rule && String(rule.gameMode || 'ALL').toUpperCase() === 'SELECTED'){
    const allowed = new Set((rule.gameIds || []).map(String));
    firstProviderGames = firstProviderGames.filter(game => allowed.has(String(game.id)));
  }

  renderGames(firstProviderGames);
}

const GAME_INITIAL_RENDER_DESKTOP = 40;
const GAME_INITIAL_RENDER_MOBILE = 24;
const GAME_SCROLL_BATCH_DESKTOP = 24;
const GAME_SCROLL_BATCH_MOBILE = 18;
const GAME_FRAME_CHUNK_DESKTOP = 40;
const GAME_FRAME_CHUNK_MOBILE = 12;
const GAME_SKELETON_DESKTOP = 40;
const GAME_SKELETON_MOBILE = 24;
const GAME_IMAGE_CACHE = new Map();
let gameBatchObserver = null;
let gameBatchScrollCleanup = null;
let gameBatchToken = 0;
let gameIdleHandle = null;

function disconnectGameBatchObserver(){
  if(gameBatchObserver){
    gameBatchObserver.disconnect();
    gameBatchObserver = null;
  }
  if(gameBatchScrollCleanup){
    try{ gameBatchScrollCleanup(); }catch(_e){}
    gameBatchScrollCleanup = null;
  }
  if(gameIdleHandle != null){
    if('cancelIdleCallback' in window) window.cancelIdleCallback(gameIdleHandle);
    else clearTimeout(gameIdleHandle);
    gameIdleHandle = null;
  }
}

function isGameMobile(){
  return !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
}

function gameInitialRenderSize(){
  return isGameMobile() ? GAME_INITIAL_RENDER_MOBILE : GAME_INITIAL_RENDER_DESKTOP;
}

function gameScrollBatchSize(){
  return isGameMobile() ? GAME_SCROLL_BATCH_MOBILE : GAME_SCROLL_BATCH_DESKTOP;
}

function gameSkeletonSize(){
  return isGameMobile() ? GAME_SKELETON_MOBILE : GAME_SKELETON_DESKTOP;
}

function gameImageUrl(item){
  return getImageUrl(item, frontendGameFallbackImageOf(item), 'game');
}

function warmGameImages(list, fromIndex = 0, count = 16, priority = 'low'){
  if(!Array.isArray(list)) return;
  list.slice(fromIndex, fromIndex + count).forEach(item => {
    const src = gameImageUrl(item);
    if(!src || GAME_IMAGE_CACHE.has(src)) return;
    const img = new Image();
    img.decoding = 'async';
    try{ img.fetchPriority = priority; }catch(e){}
    img.src = src;
    GAME_IMAGE_CACHE.set(src, img);
  });
}

function scheduleWarmNextImages(list, fromIndex){
  const run = () => {
    gameIdleHandle = null;
    warmGameImages(list, fromIndex, gameScrollBatchSize() + 12, 'low');
  };
  if('requestIdleCallback' in window) gameIdleHandle = window.requestIdleCallback(run, {timeout: 900});
  else gameIdleHandle = window.setTimeout(run, 120);
}

function createGameSkeleton(){
  const card = document.createElement('div');
  card.className = 'game-card game-card-skeleton';
  card.setAttribute('aria-hidden', 'true');
  card.innerHTML = '<div class="game-card-img-wrap game-grid-skeleton"><span class="game-skeleton-shimmer"></span></div>';
  return card;
}

function fillGameSkeletons(grid, count){
  const fragment = document.createDocumentFragment();
  for(let i = 0; i < count; i++) fragment.appendChild(createGameSkeleton());
  grid.appendChild(fragment);
}

function createGameCard(item, renderIndex = 0){
  const card=document.createElement('div');
  card.className='game-card provider-launch-card';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');

  const imageUrl = gameImageUrl(item);
  const gameName = langText(item, 'name', 'Game');
  const targetUrl = item.gameUrl || item.game_url || '';

  const launchGameId = item.gameId || item.game_id || item.id || '';
  const launchProviderCode = item.providerCode || item.provider_code || item.provider_code_name || item.vendorCode || item.vendor_code || (item.provider && (item.provider.providerCode || item.provider.provider_code || item.provider.code)) || '';
  const launchGameCode = item.gameCode || item.game_code || item.launchCode || item.launch_code || item.providerGameCode || item.provider_game_code || item.code || '';

  if(launchGameId) card.dataset.gameId = launchGameId;
  if(launchProviderCode) card.dataset.providerCode = launchProviderCode;
  if(launchGameCode) card.dataset.gameCode = launchGameCode;
  if(gameName) card.dataset.gameName = gameName;
  try{
    const ids = gameCategoryIdsOf(item);
    if(ids && ids.length) card.dataset.categoryIds = ids.join(',');
    else if(item.categoryId || item.category_id) card.dataset.categoryIds = String(item.categoryId || item.category_id);
  }catch(_){ if(item.categoryId || item.category_id) card.dataset.categoryIds = String(item.categoryId || item.category_id); }

  card.innerHTML=`
    <div class="game-card-img-wrap game-image-loading">
      <div class="game-image-skeleton" aria-hidden="true"><span class="game-skeleton-shimmer"></span></div>
      <img loading="${renderIndex < 12 ? 'eager' : 'lazy'}" decoding="async" fetchpriority="${renderIndex < 8 ? 'high' : 'low'}" class="provider-launch-img"
           src="${imageUrl}"
           alt="${gameName}"
           data-game-id="${launchGameId}"
           data-provider-code="${launchProviderCode}"
           data-game-code="${launchGameCode}"
           data-game-name="${gameName}">
    </div>
    <button class="play-btn provider-launch-btn"
            type="button"
            data-game-id="${launchGameId}"
            data-provider-code="${launchProviderCode}"
            data-game-code="${launchGameCode}"
            data-game-name="${gameName}">${tr('play','PLAY')}</button>`;

  const playBtn = card.querySelector('.play-btn');
  const img = card.querySelector('.provider-launch-img');
  bindGameImageFallback(img, item);
  const revealLoadedImage = () => {
    card.classList.add('game-card-ready');
    const wrap = card.querySelector('.game-card-img-wrap');
    if(wrap) wrap.classList.remove('game-image-loading');
  };
  img.addEventListener('load', revealLoadedImage, {once:true});
  img.addEventListener('error', revealLoadedImage, {once:true});
  if(img.complete) revealLoadedImage();

  function fallbackOpen(){
    if(targetUrl){
      window.location.href = targetUrl;
    }else{
      window.location.href = 'game-detail.html?id=' + encodeURIComponent(item.id || '');
    }
  }

  if(window.NAGA_PROVIDER_LAUNCH && typeof window.NAGA_PROVIDER_LAUNCH.bindElement === 'function'){
    window.NAGA_PROVIDER_LAUNCH.bindElement(card, item, { transferAmount: 0, gameName: gameName });
    window.NAGA_PROVIDER_LAUNCH.bindElement(img, item, { transferAmount: 0, gameName: gameName });
    window.NAGA_PROVIDER_LAUNCH.bindButton(playBtn, item, { transferAmount: 0, gameName: gameName });
  }else{
    card.addEventListener('click', fallbackOpen);
    playBtn.addEventListener('click', e=>{ e.stopPropagation(); fallbackOpen(); });
  }

  card.addEventListener('keydown', e=>{
    if(e.key === 'Enter' || e.key === ' '){
      e.preventDefault();
      card.click();
    }
  });

  return card;
}

function updateMobileDirectGameViewport(){
  if(!gameGrid || !gameGrid.classList.contains('mobile-direct-game-scroll')) return;
  if(!window.matchMedia('(max-width: 768px)').matches){
    gameGrid.classList.remove('mobile-direct-game-scroll');
    gameGrid.style.removeProperty('--mobile-direct-game-height');
    return;
  }
  const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const top = Math.max(0, gameGrid.getBoundingClientRect().top);
  const bottomNav = document.querySelector('.bottom-nav');
  const bottomHeight = bottomNav ? Math.max(57, bottomNav.getBoundingClientRect().height || 0) : 57;
  const available = Math.max(220, Math.floor(viewportHeight - top - bottomHeight - 6));
  gameGrid.style.setProperty('--mobile-direct-game-height', available + 'px');
}

window.addEventListener('resize', updateMobileDirectGameViewport, { passive:true });
if(window.visualViewport){
  window.visualViewport.addEventListener('resize', updateMobileDirectGameViewport, { passive:true });
}

function renderGames(list){
  if(!gameGrid) return;
  gameGrid.classList.remove('initial-game-loading');
  gameGrid.setAttribute('aria-busy','false');
  disconnectGameBatchObserver();
  const renderToken = ++gameBatchToken;
  showingProviderList = false;
  gameGrid.classList.remove('provider-grid', 'provider-first-grid');

  const gameList = Array.isArray(list) ? list : [];
  const isHotCategory = activeCategoryTypeKey() === 'HOT';

  if(!isHotCategory && !isDirectGameCategory() && !activeProviderCode){
    activeProviderCode = ALL_PROVIDER_CODE;
  }
  // SLOT GAME keeps the classic provider rail on the left. Other Provider
  // First categories (HOT/LIVE/SPORT/OTHER) drill directly into a full-width
  // game grid after the provider card is selected.
  const shouldShowProviderRail = activeCategoryTypeKey() === 'SLOT';
  const targetGrid = document.createElement('div');
  targetGrid.className = shouldShowProviderRail ? 'provider-games-list' : 'direct-games-list';

  let scrollRoot = null;
  if(shouldShowProviderRail){
    gameGrid.classList.add('provider-with-rail');
    let lobby = gameGrid.querySelector('.provider-lobby-shell');
    let rail = lobby && lobby.querySelector('.provider-side-rail');
    let panel = lobby && lobby.querySelector('.provider-games-panel');

    if(!lobby || !rail || !panel){
      gameGrid.innerHTML = '';
      const rows = providerRowsForActiveCategory(currentGameList);
      lobby = document.createElement('div');
      lobby.className = 'provider-lobby-shell';
      rail = buildProviderRail(rows);
      lobby.appendChild(rail);
      panel = document.createElement('div');
      panel.className = 'provider-games-panel';
      lobby.appendChild(panel);
      gameGrid.appendChild(lobby);
    }

    syncProviderRailActiveState(rail);
    panel.innerHTML = '';
    panel.appendChild(targetGrid);
    panel.scrollTop = 0;
    // On mobile SLOT the CSS intentionally makes .provider-games-panel part of
    // the normal flow and .main-layout owns the vertical scroll. Using the
    // non-scrolling panel as IntersectionObserver root can leave the sentinel
    // outside the effective viewport, so progressive rendering stops after the
    // first batch and the user cannot reach all games. Always observe the real
    // scroll container.
    scrollRoot = (isGameMobile() && activeCategoryTypeKey() === 'SLOT')
      ? (document.querySelector('.main-layout') || null)
      : panel;
  }else{
    gameGrid.innerHTML = '';
    gameGrid.classList.remove('provider-with-rail', 'mobile-direct-game-scroll');
    gameGrid.style.removeProperty('--mobile-direct-game-height');
    gameGrid.appendChild(targetGrid);

    // Direct provider game lists use the normal document flow on mobile.
    // Games wrap row-by-row instead of creating a second/internal scroll area.
    scrollRoot = null;
  }

  try{ document.dispatchEvent(new CustomEvent('naga:scroll-target-changed')); }catch(_e){}

  if(!gameList.length){
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No game available';
    targetGrid.appendChild(empty);
    return;
  }

  // Warm only the visible rows at high priority. Everything after that is
  // prepared while the browser is idle, avoiding a burst of 40 image decodes.
  warmGameImages(gameList, 0, Math.min(12, gameList.length), 'high');
  fillGameSkeletons(targetGrid, Math.min(gameSkeletonSize(), gameList.length));

  let renderedCount = 0;
  const initialTarget = Math.min(gameInitialRenderSize(), gameList.length);
  const sentinel = document.createElement('div');
  sentinel.className = 'game-load-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');

  function removeSkeletonChunk(count){
    const skeletons = targetGrid.querySelectorAll('.game-card-skeleton');
    for(let i = 0; i < Math.min(count, skeletons.length); i++) skeletons[i].remove();
  }

  function appendFrameUntil(targetCount, done){
    if(renderToken !== gameBatchToken) return;
    const frameChunk = isGameMobile() ? GAME_FRAME_CHUNK_MOBILE : GAME_FRAME_CHUNK_DESKTOP;
    const frameEnd = Math.min(renderedCount + frameChunk, targetCount, gameList.length);
    const fragment = document.createDocumentFragment();
    const added = frameEnd - renderedCount;
    for(; renderedCount < frameEnd; renderedCount++){
      fragment.appendChild(createGameCard(gameList[renderedCount], renderedCount));
    }
    removeSkeletonChunk(added);
    targetGrid.insertBefore(fragment, sentinel);
    if(renderedCount < targetCount && renderedCount < gameList.length){
      if(isGameMobile()) requestAnimationFrame(() => appendFrameUntil(targetCount, done));
      else appendFrameUntil(targetCount, done);
    }else if(typeof done === 'function'){
      done();
    }
  }

  let batchAppending = false;
  function appendScrollBatch(){
    if(batchAppending || renderToken !== gameBatchToken || renderedCount >= gameList.length) return;
    batchAppending = true;
    const target = Math.min(renderedCount + gameScrollBatchSize(), gameList.length);
    appendFrameUntil(target, () => {
      batchAppending = false;
      scheduleWarmNextImages(gameList, renderedCount);
      if(renderedCount >= gameList.length){
        disconnectGameBatchObserver();
        sentinel.remove();
      }else{
        // Re-check after DOM growth. This covers mobile browsers that do not
        // immediately emit a second IntersectionObserver callback while a
        // sticky/contained scroll viewport is moving.
        requestAnimationFrame(maybeLoadNearEnd);
      }
    });
  }

  function maybeLoadNearEnd(){
    if(renderToken !== gameBatchToken || renderedCount >= gameList.length || !sentinel.isConnected) return;
    const rect = sentinel.getBoundingClientRect();
    let viewportBottom;
    if(scrollRoot && scrollRoot.getBoundingClientRect){
      const rootRect = scrollRoot.getBoundingClientRect();
      viewportBottom = Math.min(rootRect.bottom, window.innerHeight || rootRect.bottom);
    }else{
      viewportBottom = window.innerHeight || document.documentElement.clientHeight || 0;
    }
    if(rect.top <= viewportBottom + 900) appendScrollBatch();
  }

  targetGrid.appendChild(sentinel);
  appendFrameUntil(initialTarget, () => {
    targetGrid.querySelectorAll('.game-card-skeleton').forEach(node => node.remove());
    scheduleWarmNextImages(gameList, renderedCount);
    if(renderedCount >= gameList.length){
      sentinel.remove();
      return;
    }
    gameBatchObserver = new IntersectionObserver(entries => {
      if(entries.some(entry => entry.isIntersecting)) appendScrollBatch();
    }, {
      root: scrollRoot,
      // Start preparing well before the user reaches the last visible row.
      rootMargin: '900px 0px',
      threshold: 0.01
    });
    gameBatchObserver.observe(sentinel);

    // IntersectionObserver is the primary trigger. A lightweight passive scroll
    // fallback makes progressive loading reliable on iOS/Android WebViews where
    // sticky parents + a changing visual viewport can occasionally suppress an
    // observer transition. It only performs one rectangle check per animation
    // frame and is removed whenever the game list is re-rendered.
    const fallbackTarget = scrollRoot || window;
    let fallbackRaf = 0;
    const onProgressiveScroll = () => {
      if(fallbackRaf) return;
      fallbackRaf = requestAnimationFrame(() => {
        fallbackRaf = 0;
        maybeLoadNearEnd();
      });
    };
    fallbackTarget.addEventListener('scroll', onProgressiveScroll, {passive:true});
    gameBatchScrollCleanup = () => {
      fallbackTarget.removeEventListener('scroll', onProgressiveScroll);
      if(fallbackRaf) cancelAnimationFrame(fallbackRaf);
    };
    requestAnimationFrame(maybeLoadNearEnd);
  });
}

// VPBet-style catalog architecture:
// - fetch the complete game catalog once instead of calling the slow game API
//   again for every category/provider/subcategory click;
// - keep a compact sessionStorage copy so a normal refresh paints immediately;
// - refresh stale data silently in the background (stale-while-revalidate).
const API_MEMORY_CACHE = new Map();
const API_IN_FLIGHT = new Map();
const API_CACHE_TTL_MS = 3 * 60 * 1000;
const GAME_CATALOG_CACHE_VERSION = 'v13-language-aware-catalog';
const GAME_CATALOG_FRESH_MS = 2 * 60 * 1000;
const GAME_CATALOG_MAX_STALE_MS = 24 * 60 * 60 * 1000;
function gameCatalogStorageKey(){
  return 'naga_game_catalog_' + GAME_CATALOG_CACHE_VERSION + ':' + String(currentLangCode() || 'en').toLowerCase();
}
const SLOT_IMAGE_PRELOAD_HOLD = [];
const EARLY_API_REQUESTS = window.__NAGA_EARLY_API__ || {};
const BOOTSTRAP_CATALOG = window.__NAGA_CATALOG_BOOTSTRAP__ || null;

function apiCacheKey(url){
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.delete('_t');
  return parsed.toString();
}

function readApiSessionCache(key){
  try{
    const cached = JSON.parse(sessionStorage.getItem('naga_api_cache:' + key) || 'null');
    if(cached && cached.expiresAt > Date.now() && cached.data) return cached.data;
  }catch(e){}
  return null;
}

function writeApiSessionCache(key, data, ttl = API_CACHE_TTL_MS){
  try{
    sessionStorage.setItem('naga_api_cache:' + key, JSON.stringify({
      expiresAt: Date.now() + ttl,
      data: data
    }));
  }catch(e){}
}

function fetchJson(url, options = {}){
  const key = apiCacheKey(url);
  const forceRefresh = options && (options.forceRefresh === true || options.bypassCache === true);
  const ttl = Number(options.ttl || API_CACHE_TTL_MS);
  const now = Date.now();

  const memoryHit = API_MEMORY_CACHE.get(key);
  if(!forceRefresh && memoryHit && now - memoryHit.time < ttl){
    return Promise.resolve(memoryHit.data);
  }

  if(!forceRefresh){
    const sessionHit = readApiSessionCache(key);
    if(sessionHit){
      API_MEMORY_CACHE.set(key, { time: now, data: sessionHit });
      return Promise.resolve(sessionHit);
    }
  }

  // The cold-load bootstrap begins these requests in <head>. Reuse them instead
  // of issuing duplicate game-list requests after app.js is parsed.
  if(EARLY_API_REQUESTS[key]){
    const earlyRequest = EARLY_API_REQUESTS[key];
    delete EARLY_API_REQUESTS[key];
    return earlyRequest.then(data => {
      API_MEMORY_CACHE.set(key, { time: Date.now(), data });
      if(!forceRefresh) writeApiSessionCache(key, data, ttl);
      return data;
    });
  }

  if(!forceRefresh && API_IN_FLIGHT.has(key)) return API_IN_FLIGHT.get(key);

  const request = fetch(key, { cache: forceRefresh ? 'no-store' : 'default' }).then(res => {
    if(!res.ok) throw new Error('API error: ' + url);
    return res.json();
  }).then(data => {
    API_MEMORY_CACHE.set(key, { time: Date.now(), data: data });
    if(!forceRefresh) writeApiSessionCache(key, data, ttl);
    return data;
  }).finally(() => {
    if(API_IN_FLIGHT.get(key) === request) API_IN_FLIGHT.delete(key);
  });

  if(!forceRefresh) API_IN_FLIGHT.set(key, request);
  return request;
}

function buildUrl(url, params){
  const fullUrl = new URL(url, window.location.href);
  Object.keys(params || {}).forEach(key => {
    if(params[key] !== null && params[key] !== undefined && params[key] !== ''){
      fullUrl.searchParams.set(key, params[key]);
    }
  });
  return fullUrl.toString();
}

function currentLang(){
  return currentLangCode();
}

function normalizeStoredCatalog(value){
  if(!value || typeof value !== 'object') return null;
  const catalog = value.catalog && typeof value.catalog === 'object' ? value.catalog : value;
  const normalized = {
    savedAt: Number(value.savedAt || catalog.savedAt || 0),
    serverVersion: String(value.serverVersion || catalog.serverVersion || catalog.version || ''),
    categories: Array.isArray(catalog.categories) ? catalog.categories : [],
    providers: Array.isArray(catalog.providers) ? catalog.providers : [],
    subCategories: Array.isArray(catalog.subCategories) ? catalog.subCategories : [],
    games: Array.isArray(catalog.games) ? catalog.games : []
  };
  if(!normalized.categories.length && !normalized.games.length) return null;
  return normalized;
}

function readGameCatalogCache(){
  try{
    const cached = normalizeStoredCatalog(JSON.parse(localStorage.getItem(gameCatalogStorageKey()) || 'null'));
    if(!cached) return null;
    if(!cached.savedAt || Date.now() - cached.savedAt > GAME_CATALOG_MAX_STALE_MS){
      localStorage.removeItem(gameCatalogStorageKey());
      return null;
    }
    return cached;
  }catch(e){
    return null;
  }
}

function writeGameCatalogCache(catalog){
  try{
    localStorage.setItem(gameCatalogStorageKey(), JSON.stringify({
      savedAt: Date.now(),
      catalog: {
        serverVersion: String(catalog.serverVersion || catalog.version || ''),
        categories: catalog.categories || [],
        providers: catalog.providers || [],
        subCategories: catalog.subCategories || [],
        games: catalog.games || []
      }
    }));
  }catch(e){
    // Storage can be unavailable in private mode; memory/API rendering still works.
  }
}

function catalogList(response){
  return normalizeApiList(response).filter(isActiveItem).sort(sortByOrder);
}

function publicCatalogData(response){
  if(!response || typeof response !== 'object') return null;
  const data = response.data && typeof response.data === 'object' ? response.data : response;
  if(!Array.isArray(data.games) && !Array.isArray(data.categories)) return null;
  return {
    savedAt: Date.now(),
    serverVersion: String(data.version || ''),
    categories: Array.isArray(data.categories) ? data.categories : [],
    providers: Array.isArray(data.providers) ? data.providers : [],
    subCategories: Array.isArray(data.subCategories) ? data.subCategories : [],
    games: Array.isArray(data.games) ? data.games : []
  };
}

function fetchCatalogVersion(){
  const key = apiCacheKey(PUBLIC_GAME_CATALOG_VERSION_URL);
  const early = EARLY_API_REQUESTS[key];
  if(early){
    delete EARLY_API_REQUESTS[key];
    return early.then(response => String(response?.data?.version || response?.version || ''));
  }
  return fetch(PUBLIC_GAME_CATALOG_VERSION_URL, { cache:'no-store' })
    .then(res => { if(!res.ok) throw new Error('Catalog version API error'); return res.json(); })
    .then(response => String(response?.data?.version || response?.version || ''));
}

function fetchLegacyGameCatalog(forceRefresh = false){
  const requestOptions = { forceRefresh: forceRefresh, ttl: API_CACHE_TTL_MS };
  const urls = {
    categories: GAME_CATEGORY_API_URL,
    providers: GAME_PROVIDER_API_URL,
    subCategories: buildUrl(GAME_SUB_CATEGORY_API_URL, { lang: currentLang() }),
    games: buildUrl(GAME_API_URL, { lang: currentLang() })
  };
  return Promise.allSettled([
    fetchJson(urls.categories, requestOptions),
    fetchJson(urls.providers, requestOptions),
    fetchJson(urls.subCategories, requestOptions),
    fetchJson(urls.games, requestOptions)
  ]).then(results => ({
    savedAt: Date.now(),
    serverVersion: '',
    categories: results[0].status === 'fulfilled' ? catalogList(results[0].value) : [],
    providers: results[1].status === 'fulfilled' ? catalogList(results[1].value) : [],
    subCategories: results[2].status === 'fulfilled' ? catalogList(results[2].value) : [],
    games: results[3].status === 'fulfilled' ? catalogList(results[3].value) : []
  }));
}

function fetchFullGameCatalog(forceRefresh = false){
  if(catalogRefreshPromise && !forceRefresh) return catalogRefreshPromise;

  const url = buildUrl(PUBLIC_GAME_CATALOG_API_URL, { lang: currentLang() });
  const request = fetch(url, { cache: forceRefresh ? 'no-store' : 'default' })
    .then(res => {
      if(!res.ok) throw new Error('Public game catalog API error');
      return res.json();
    })
    .then(response => {
      const catalog = publicCatalogData(response);
      if(!catalog || (!catalog.categories.length && !catalog.games.length)) {
        throw new Error('Public game catalog returned no usable data');
      }
      writeGameCatalogCache(catalog);
      return catalog;
    })
    .catch(publicError => {
      // Do not fall back to protected /api/admin endpoints. Brand security intentionally
      // rejects those calls from the public frontend; keep the last BO-confirmed catalog instead.
      const cached = readGameCatalogCache();
      if(cached) return cached;
      throw publicError;
    })
    .finally(() => {
      if(catalogRefreshPromise === request) catalogRefreshPromise = null;
    });

  catalogRefreshPromise = request;
  return request;
}

function applyGameCatalog(catalog){
  categories = (catalog.categories || []).filter(isActiveItem).sort(sortByOrder);
  providers = (catalog.providers || []).filter(isActiveItem).sort(sortByOrder);
  allSubCategories = (catalog.subCategories || []).filter(isActiveItem).sort(sortByOrder);

  // A game can remain individually ACTIVE in BO while its parent provider is
  // disabled. The public frontend must treat the provider status as the master
  // switch, otherwise active game rows from an inactive provider can re-create
  // the provider rail through the game-response fallback logic.
  const activeProviderCodes = new Set(
    providers.map(providerCodeOf).filter(Boolean)
  );

  catalogGames = (catalog.games || [])
    .filter(isActiveItem)
    .filter(game => {
      const code = providerCodeOf(game);
      // Provider-less/manual games remain backward compatible. Every game with
      // a provider code must belong to a currently active provider.
      return !code || activeProviderCodes.has(code);
    })
    .sort(sortByOrder);

  gameCatalogReady = categories.length > 0 || catalogGames.length > 0;
}

function scalarIds(value){
  if(value == null || value === '') return [];
  if(Array.isArray(value)) return value.flatMap(scalarIds);
  if(typeof value === 'object'){
    const candidate = value.id ?? value.categoryId ?? value.category_id ?? value.subCategoryId ?? value.sub_category_id;
    return candidate == null ? [] : scalarIds(candidate);
  }
  return String(value).split(/[,|]/).map(v => String(v).trim()).filter(Boolean);
}

function idsFromFields(item, fields){
  const ids = [];
  fields.forEach(field => {
    if(item && Object.prototype.hasOwnProperty.call(item, field)) ids.push(...scalarIds(item[field]));
  });
  return [...new Set(ids)];
}

function gameCategoryIdsOf(game){
  return idsFromFields(game, [
    'categoryId','category_id','gameCategoryId','game_category_id','categoryIds','category_ids','gameCategoryIds','game_category_ids','categories'
  ]);
}

function gameSubCategoryIdsOf(game){
  return idsFromFields(game, [
    'subCategoryId','sub_category_id','gameSubCategoryId','game_sub_category_id','subCategoryIds','sub_category_ids','gameSubCategoryIds','game_sub_category_ids','subCategories'
  ]);
}

function subCategoryCategoryIdsOf(sub){
  return idsFromFields(sub, ['categoryId','category_id','gameCategoryId','game_category_id','categoryIds','category_ids','categories']);
}

function subCategoryProviderCodesOf(sub){
  const raw = [sub?.providerCode, sub?.provider_code, sub?.providerCodes, sub?.provider_codes, sub?.providers];
  return [...new Set(raw.flatMap(value => {
    if(value == null) return [];
    if(Array.isArray(value)) return value.flatMap(v => typeof v === 'object' ? [providerCodeOf(v)] : String(v).split(/[,|]/));
    if(typeof value === 'object') return [providerCodeOf(value)];
    return String(value).split(/[,|]/);
  }).map(value => String(value || '').trim().toUpperCase()).filter(Boolean))];
}

function gameMatchesActiveCategory(game){
  if(!activeCategoryId) return true;
  const activeId = String(activeCategoryId);
  const directIds = gameCategoryIdsOf(game);

  // Keep HOT GAME behaviour unchanged because it is a curated/aggregated
  // category and may intentionally include games assigned to other database
  // categories. For every normal category, the database category assignment
  // is authoritative so Slot games cannot leak into Live/Sport/Other.
  const isHotCategory = activeCategoryTypeKey() === 'HOT';
  if(directIds.includes(activeId)) return true;

  const gameProviderCode = providerCodeOf(game);
  if(directIds.length && !isHotCategory){
    // Imported rows can carry an old category_id even though the provider is
    // now configured for only one frontend category. In that single-category
    // case, use the current BO/provider configuration so providers such as
    // EPICWIN do not become empty. Multi-category providers remain strict,
    // preventing Slot games from leaking into Live/Sport/Other.
    const configuredProvider = providerForCode(gameProviderCode);
    const configuredIds = providerCategoryIdsOf(configuredProvider);
    const configuredTypes = providerTypesOf(configuredProvider);
    const activeKey = activeCategoryTypeKey();
    const singleCategoryMatch =
      (configuredIds.length === 1 && configuredIds[0] === activeId) ||
      (!configuredIds.length && configuredTypes.length === 1 && configuredTypes[0] === activeKey);
    if(!singleCategoryMatch) return false;
  }

  const rule = providerRuleForCode(gameProviderCode);
  if(rule){
    const mode = String(rule.gameMode || 'ALL').toUpperCase();
    if(mode === 'SELECTED'){
      const allowed = new Set((rule.gameIds || []).map(String));
      return allowed.has(String(game.id));
    }
    return true;
  }

  const provider = providerForCode(gameProviderCode);
  if(providerCategoryIdsOf(provider).includes(activeId)) return true;

  const catKey = activeCategoryTypeKey();
  const gameCategoryText = normalizeKey([
    game?.categoryCode, game?.category_code, game?.categoryName, game?.category_name,
    game?.gameType, game?.game_type, game?.type
  ].filter(Boolean).join(' '));
  return !!catKey && gameCategoryText.includes(catKey);
}

function gameMatchesActiveSubCategory(game){
  if(!activeSubCategoryId) return true;
  const ids = gameSubCategoryIdsOf(game);
  // Some provider feeds do not include subcategory metadata in the all-game
  // response. Keep those games visible rather than producing a false empty list.
  return !ids.length || ids.includes(String(activeSubCategoryId));
}

function categoryGamesFromCatalog(){
  return catalogGames.filter(gameMatchesActiveCategory);
}

function filteredSubCategoriesFromCatalog(){
  if(!activeCategoryId || !activeProviderCode || isAllProviderCode(activeProviderCode)) return [];
  const categoryId = String(activeCategoryId);
  const providerCode = String(activeProviderCode).toUpperCase();

  // HOT GAME is a curated provider landing. Keep the HOT top tab selected after
  // a provider is clicked, but still allow that provider's real category
  // subcategories (Slot/Live/Sport/etc.) to appear above its game list.
  const categoryContextIds = new Set([categoryId]);
  if(activeCategoryTypeKey() === 'HOT'){
    const inferredCategoryId = categoryIdForProviderNavigation(providerCode);
    if(inferredCategoryId != null) categoryContextIds.add(String(inferredCategoryId));
  }

  return allSubCategories.filter(sub => {
    const categoryIds = subCategoryCategoryIdsOf(sub);
    const providerCodes = subCategoryProviderCodesOf(sub);
    const categoryMatch = !categoryIds.length || categoryIds.some(id => categoryContextIds.has(String(id)));
    const providerMatch = !providerCodes.length || providerCodes.includes(providerCode);
    return categoryMatch && providerMatch;
  });
}

function preloadSlotGameImages(list, limit = 40){
  if(!Array.isArray(list) || !list.length) return;
  SLOT_IMAGE_PRELOAD_HOLD.length = 0;
  list.slice(0, limit).forEach(item => {
    const src = getImageUrl(item, frontendGameFallbackImageOf(item), 'game');
    if(!src) return;
    const img = new Image();
    img.decoding = 'async';
    img.fetchPriority = 'low';
    img.src = src;
    SLOT_IMAGE_PRELOAD_HOLD.push(img);
  });
}

function scheduleSlotCategoryPrefetch(){
  const slotCategory = categories.find(category => categoryTypeKey(category) === 'SLOT');
  if(!slotCategory) return;
  const originalId = activeCategoryId;
  activeCategoryId = slotCategory.id;
  const slotGames = categoryGamesFromCatalog();
  activeCategoryId = originalId;
  const run = () => preloadSlotGameImages(slotGames);
  if('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 1200 });
  else window.setTimeout(run, 300);
}

function renderCatalogState(){
  const list = categoryGamesFromCatalog();

  if(isDirectGameCategory()){
    currentGameList = list;
    activeProviderCode = null;
    if(subTabRow){ subTabRow.innerHTML = ''; subTabRow.style.display = 'none'; }
    renderGames(list);
    return;
  }

  if(activeProviderCode){
    if(isAllProviderCode(activeProviderCode)){
      currentGameList = list;
      renderGames(list);
      return;
    }

    // Provider First: after choosing a provider, render only its games. Never
    // re-create the left provider rail; the provider card itself is the first
    // level and the game grid is the second/final level.
    currentGameList = list;
    let providerList = gamesForProviderFromCategoryList(list, activeProviderCode)
      .filter(gameMatchesActiveSubCategory);

    if(!providerList.length && activeSubCategoryId && subCategories.length){
      subCategoryAutoTriedIds.add(String(activeSubCategoryId));
      const nextSub = subCategories.find(sub => !subCategoryAutoTriedIds.has(String(sub.id)));
      if(nextSub){
        activeSubCategoryId = nextSub.id;
        renderSubTabs();
        renderCatalogState();
        return;
      }
    }
    renderGames(providerList);
    return;
  }

  currentGameList = list;

  // SLOT GAME is the exception: keep the provider rail on the left exactly as
  // before. HOT/LIVE/SPORT/OTHER continue to use provider cards and then open
  // the selected provider's games directly.
  if(activeCategoryTypeKey() === 'SLOT'){
    renderProviderCards(list);
    return;
  }

  renderMixedCategoryLanding(list);
}

let lobbyReadyImageWaitStarted = false;
function signalLobbyReady(){
  if(document.documentElement.classList.contains('lobby-ready') || lobbyReadyImageWaitStarted) return;
  lobbyReadyImageWaitStarted = true;

  // Do not reveal the lobby while its first visible BO/catalog artwork is still blank.
  // Only wait for the above-fold subset and cap the wait, preserving performance.
  const critical = Array.from(document.querySelectorAll(
    '.cat img, .category-provider-card img, .provider-side-rail img, .game-grid .provider-launch-img, .side-slider .slide.active'
  )).filter(img => !img.complete).slice(0, 18);

  const finish = () => {
    if(document.documentElement.classList.contains('lobby-ready')) return;
    document.documentElement.classList.add('lobby-ready');
    document.dispatchEvent(new CustomEvent('naga:lobby-ready'));
  };

  if(!critical.length){ finish(); return; }
  let pending = critical.length;
  let settled = false;
  const done = () => {
    if(settled) return;
    pending -= 1;
    if(pending <= 0){ settled = true; finish(); }
  };
  critical.forEach(img => {
    try{ if(!img.loading || img.loading === 'lazy') img.loading = 'eager'; }catch(_){}
    img.addEventListener('load', done, {once:true});
    img.addEventListener('error', done, {once:true});
  });
  setTimeout(() => { if(!settled){ settled = true; finish(); } }, 450);
}

function paintInitialCatalog(catalog){
  applyGameCatalog(catalog);
  activeCategoryId = pickDefaultCategoryId(categories);
  activeSubCategoryId = null;
  activeProviderCode = null;
  renderCategories();
  renderSubTabs();
  renderCatalogState();
  scheduleSlotCategoryPrefetch();
}

function loadCategories(){
  if(!categoryRow || !subTabRow || !gameGrid){
    signalLobbyReady();
    return Promise.resolve();
  }

  // Instant paint for returning visitors. Only the tiny version endpoint is
  // checked first; the full catalogue is downloaded again only when BO data changed.
  const cachedCatalog = readGameCatalogCache();
  let paintedFromCache = false;
  if(cachedCatalog){
    paintInitialCatalog(cachedCatalog);
    paintedFromCache = true;
    requestAnimationFrame(() => requestAnimationFrame(signalLobbyReady));
  }else{
    setGamesLoading();
  }

  const refresh = cachedCatalog
    ? fetchCatalogVersion().then(serverVersion => {
        if(serverVersion && cachedCatalog.serverVersion && serverVersion === cachedCatalog.serverVersion){
          return cachedCatalog;
        }
        return fetchFullGameCatalog(true);
      }).catch(() => fetchFullGameCatalog(true))
    : fetchFullGameCatalog(true);

  return refresh.then(catalog => {
    // Do not repaint an identical cached catalogue and cause avoidable DOM work.
    if(!paintedFromCache || String(catalog.serverVersion || '') !== String(cachedCatalog?.serverVersion || '')){
      paintInitialCatalog(catalog);
    }
  }).catch(err => {
    console.warn('Game catalog API failed:', err.message);
    if(paintedFromCache) return;
    categories = [];
    providers = [];
    allSubCategories = [];
    catalogGames = [];
    subCategories = [];
    gameCatalogReady = false;
    renderCategories();
    renderSubTabs();
    renderGames([]);
  }).finally(() => {
    if(!paintedFromCache){
      requestAnimationFrame(() => requestAnimationFrame(signalLobbyReady));
    }
  });
}

function loadSubCategories(){
  ++subCategoryLoadSequence;

  if(!activeCategoryId) ensureCategoryForSelectedProvider();

  if(!activeCategoryId || !activeProviderCode || isAllProviderCode(activeProviderCode) || (isDirectGameCategory() && activeCategoryTypeKey() === 'HOT')){
    subCategories = [];
    activeSubCategoryId = null;
    renderSubTabs();
    return loadGames();
  }

  subCategories = filteredSubCategoriesFromCatalog();
  activeSubCategoryId = pickDefaultSubCategoryId(subCategories);
  subCategoryAutoTriedIds = new Set();
  renderSubTabs();
  return loadGames();
}

function loadGames(){
  ++gameLoadSequence;
  if(!gameCatalogReady){
    setGamesLoading();
    return Promise.resolve();
  }
  renderCatalogState();
  return Promise.resolve();
}

if(categoryRow){
  categoryRow.addEventListener('click',e=>{
    const btn=e.target.closest('.cat');
    if(!btn)return;
    activeCategoryId=btn.dataset.id;
    activeSubCategoryId=null;
    activeProviderCode=null;
    subCategoryAutoTriedIds = new Set();
    renderCategories();
    setGamesLoading();
    loadSubCategories();
  });
}

if(subTabRow){
  subTabRow.addEventListener('click',e=>{
    const btn=e.target.closest('button[data-id]');
    if(!btn)return;
    activeSubCategoryId=btn.dataset.id || null;
    subTabRow.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b===btn));
    centerActiveMobileSubCategory();
    loadGames();
  });
}

loadCategories();
let languageCatalogReloadSequence = 0;
document.addEventListener('i18n:changed', () => {
  const reloadSequence = ++languageCatalogReloadSequence;
  const previousCategoryId = activeCategoryId;
  const previousSubCategoryId = activeSubCategoryId;
  const previousProviderCode = activeProviderCode;

  // Category/game images and names are BO-created content. They are localized by
  // /api/public/game-catalog?lang=XX, so re-rendering the old in-memory catalogue
  // is not enough after a language switch. Fetch the catalogue for the newly
  // selected language and repaint it without losing the user's current selection.
  fetchFullGameCatalog(true).then(catalog => {
    if(reloadSequence !== languageCatalogReloadSequence) return;
    applyGameCatalog(catalog);

    if(previousCategoryId && categories.some(item => String(item.id) === String(previousCategoryId))){
      activeCategoryId = previousCategoryId;
    }else{
      activeCategoryId = pickDefaultCategoryId(categories);
    }

    activeProviderCode = previousProviderCode;
    subCategories = filteredSubCategoriesFromCatalog();
    if(previousSubCategoryId && subCategories.some(item => String(item.id) === String(previousSubCategoryId))){
      activeSubCategoryId = previousSubCategoryId;
    }else{
      activeSubCategoryId = pickDefaultSubCategoryId(subCategories);
    }

    renderCategories();
    renderSubTabs();
    renderCatalogState();
  }).catch(err => {
    console.warn('Unable to reload translated game catalogue:', err.message);
    // Keep the current catalogue usable even if the language-specific refresh fails.
    renderCategories();
    renderSubTabs();
    document.querySelectorAll('.provider-launch-btn').forEach(btn => {
      btn.textContent = tr('play','PLAY');
    });
  });

  if(sliderBannerCache.length){
    document.querySelectorAll('.side-slider').forEach(slider => renderSliderBanners(slider, sliderBannerCache));
    document.querySelectorAll('.side-slider').forEach(initSlider);
  }
});

function initSlider(slider){
  if(typeof slider._nagaSliderCleanup === 'function') slider._nagaSliderCleanup();
  const sliderAbort = new AbortController();
  const sliderEventOptions = { signal: sliderAbort.signal };

  let slideIndex=0;
  let slideTimer;
  let startX=0;
  let currentX=0;
  let isDragging=false;
  let pointerId=null;
  let suppressClick=false;
  const slideDuration=4000;
  const slides=[...slider.querySelectorAll('.slide')];
  const dots=slider.querySelectorAll('.dots span');
  const timerBar=slider.querySelector('.slider-timer span');
  if(!slides.length)return;

  let track=slider.querySelector('.slider-track');
  if(!track){
    track=document.createElement('div');
    track.className='slider-track';
    slider.insertBefore(track, slides[0]);
    slides.forEach(slide=>track.appendChild(slide));
  }

  function resetTimerBar(){
    if(!timerBar)return;
    timerBar.style.animation='none';
    timerBar.offsetHeight;
    timerBar.style.animation=`sliderTimer ${slideDuration}ms linear forwards`;
  }

  function setTrack(offsetPx=0){
    track.style.transform=`translate3d(calc(${-slideIndex * 100}% + ${offsetPx}px),0,0)`;
  }

  function showSlide(index){
    slides[slideIndex].classList.remove('active');
    if(dots[slideIndex])dots[slideIndex].classList.remove('active');
    slideIndex=(index+slides.length)%slides.length;
    slides[slideIndex].classList.add('active');
    if(dots[slideIndex])dots[slideIndex].classList.add('active');
    setTrack(0);
    resetTimerBar();
  }

  function nextSlide(){
    showSlide(slideIndex+1);
  }

  function prevSlide(){
    showSlide(slideIndex-1);
  }

  function startSlider(){
    clearInterval(slideTimer);
    resetTimerBar();
    slideTimer=setInterval(nextSlide,slideDuration);
  }

  dots.forEach((dot,index)=>{
    dot.addEventListener('click',e=>{
      e.stopPropagation();
      showSlide(index);
      startSlider();
    }, sliderEventOptions);
  });

  slider.addEventListener('pointerdown',e=>{
    if(e.target.closest('.dots'))return;
    isDragging=true;
    pointerId=e.pointerId;
    startX=e.clientX;
    currentX=e.clientX;
    suppressClick=false;
    clearInterval(slideTimer);
    if(timerBar)timerBar.style.animationPlayState='paused';
    slider.classList.add('is-dragging');
    try{ slider.setPointerCapture(pointerId); }catch(err){}
  }, sliderEventOptions);

  slider.addEventListener('pointermove',e=>{
    if(!isDragging || e.pointerId!==pointerId)return;
    currentX=e.clientX;
    const diff=currentX-startX;
    if(Math.abs(diff)>8)suppressClick=true;
    setTrack(diff);
  }, sliderEventOptions);

  function finishDrag(e){
    if(!isDragging || (e && e.pointerId!==pointerId))return;
    isDragging=false;
    slider.classList.remove('is-dragging');
    try{ slider.releasePointerCapture(pointerId); }catch(err){}
    const diff=currentX-startX;
    const changeDistance=slider.clientWidth * 0.45;

    if(Math.abs(diff)>=changeDistance){
      diff>0 ? prevSlide() : nextSlide();
    }else{
      setTrack(0);
      if(timerBar)timerBar.style.animationPlayState='running';
    }
    startSlider();
    setTimeout(()=>{ suppressClick=false; },0);
  }

  slider.addEventListener('pointerup',finishDrag, sliderEventOptions);
  slider.addEventListener('pointercancel',finishDrag, sliderEventOptions);
  slider.addEventListener('lostpointercapture',finishDrag, sliderEventOptions);

  slider.addEventListener('click',e=>{
    if(e.target.closest('.dots'))return;
    if(suppressClick){
      e.preventDefault();
      return;
    }
    nextSlide();
    startSlider();
  }, sliderEventOptions);

  setTrack(0);
  startSlider();
  slider._nagaSliderCleanup = () => {
    clearInterval(slideTimer);
    sliderAbort.abort();
  };
}


// app.js
const SLIDER_API_URL =
  (window.NAGA_API && window.NAGA_API.sliderList)
  || 'https://bo.titanx7.com/api/public/slider/list';
function normalizeSliderResponse(response){
  if(Array.isArray(response)) return response;
  if(response && Array.isArray(response.data)) return response.data;
  if(response && response.data && Array.isArray(response.data.data)) return response.data.data;
  return [];
}

let sliderBannerCache = [];
const SLIDER_STORAGE_KEY = 'naga_slider_banners_v3:' + String((location.hostname || 'default').toLowerCase());

function readSliderBannerCache(){
  try{
    const raw = localStorage.getItem(SLIDER_STORAGE_KEY);
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed && parsed.data) ? parsed.data : [];
  }catch(_){ return []; }
}

function writeSliderBannerCache(banners){
  try{
    localStorage.setItem(SLIDER_STORAGE_KEY, JSON.stringify({savedAt:Date.now(), data:banners}));
  }catch(_){}
}

function usableSliderBanners(data){
  return normalizeSliderResponse(data)
    .filter(item => Number(item.status || 1) === 1)
    .filter(item => item.imageUrl || item.image_url || item.image)
    .sort((a, b) => (Number(a.sortOrder || a.sort_order || 0) - Number(b.sortOrder || b.sort_order || 0)) || (Number(b.id || 0) - Number(a.id || 0)));
}

function renderSliderBanners(slider, banners){
  if(!slider || !Array.isArray(banners) || !banners.length) return;

  const fragment = document.createDocumentFragment();
  const track = document.createElement('div');
  const dots = document.createElement('div');
  const timer = document.createElement('div');
  const timerSpan = document.createElement('span');

  track.className = 'slider-track';
  dots.className = 'dots';
  timer.className = 'slider-timer';
  timer.appendChild(timerSpan);

  banners.forEach((item, index) => {
    const img = document.createElement('img');
    img.className = 'slide' + (index === 0 ? ' active' : '');
    img.src = getImageUrl(item, '', 'slider');
    img.alt = langText(item, 'title', 'Slider Banner');
    img.decoding = 'async';
    img.loading = index === 0 ? 'eager' : 'lazy';
    if(index === 0) img.fetchPriority = 'high';
    if(item.linkUrl || item.link_url){
      img.dataset.linkUrl = item.linkUrl || item.link_url;
    }
    track.appendChild(img);

    const dot = document.createElement('span');
    if(index === 0) dot.className = 'active';
    dots.appendChild(dot);
  });

  fragment.appendChild(track);
  fragment.appendChild(dots);
  fragment.appendChild(timer);
  slider.replaceChildren(fragment);
  slider.classList.add('slider-ready');
  slider.setAttribute('aria-busy', 'false');
}

function mountSliderBanners(banners){
  if(!Array.isArray(banners) || !banners.length) return;
  sliderBannerCache = banners;
  document.querySelectorAll('.side-slider').forEach(slider => {
    renderSliderBanners(slider, banners);
    initSlider(slider);
  });
}

function preloadSliderBanners(banners){
  return Promise.all(banners.map(item => new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const finish = ok => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 2600);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = getImageUrl(item, '', 'slider');
    if(image.decode) image.decode().then(() => finish(true)).catch(() => {});
  })));
}

function fetchSliderJson(url){
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try{ controller.abort(); }catch(_){} }, 2800) : 0;
  return fetch(url, {cache:'no-store', signal:controller ? controller.signal : undefined})
    .then(res => {
      if(!res.ok) throw new Error('Slider API error');
      return res.json();
    })
    .finally(() => { if(timer) clearTimeout(timer); });
}

async function fetchSliderWithRetry(url){
  let lastError = null;
  for(let attempt=0; attempt<3; attempt+=1){
    try{ return await fetchSliderJson(url); }
    catch(err){
      lastError = err;
      if(attempt < 2) await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 180 : 520));
    }
  }
  throw lastError || new Error('Slider API unavailable');
}

async function loadSliderBanners(){
  // Performance-first: paint the last BO-confirmed slider immediately. This is
  // still BO data (never hardcoded HTML), so a hard refresh does not wait for a
  // network round trip before the banner area becomes useful. Fresh BO data is
  // fetched below and replaces it only when it actually changed.
  const cached = usableSliderBanners(readSliderBannerCache());
  if(cached.length) mountSliderBanners(cached);

  const earlyKey = new URL(SLIDER_API_URL, location.href).toString();
  const earlyRequest = window.__NAGA_EARLY_API__ && window.__NAGA_EARLY_API__[earlyKey];

  try{
    // Reuse an existing early request only if one actually exists; otherwise use
    // the bounded retry path. A rejected early promise gets one normal retry path.
    let data;
    if(earlyRequest){
      try{ data = await Promise.resolve(earlyRequest); }
      catch(_){ data = await fetchSliderWithRetry(earlyKey); }
    }else{
      data = await fetchSliderWithRetry(earlyKey);
    }

    const banners = usableSliderBanners(data);
    if(!banners.length) return;

    // Avoid rebuilding the slider if the fresh BO response is identical to the
    // BO-confirmed cache already on screen. This saves image decoding + DOM work.
    const signature = list => (list || []).map(item => [
      item.id || '', item.updatedAt || item.updated_at || '',
      item.imageUrl || item.image_url || item.image || '',
      item.linkUrl || item.link_url || '', item.sortOrder || item.sort_order || 0
    ].join('|')).join('||');
    const unchanged = cached.length && signature(cached) === signature(banners);
    writeSliderBannerCache(banners);
    if(unchanged) return;

    // Only the first slide is critical for first paint. Remaining slides already
    // use loading=lazy and can decode after the slider is mounted.
    const firstReady = await preloadSliderBanners(banners.slice(0, 1));
    if(firstReady.length && firstReady[0] === false && !cached.length) return;
    mountSliderBanners(banners);
  }catch(err){
    // Only use the last BO-confirmed slider if the live BO read is temporarily unavailable.
    if(cached.length) mountSliderBanners(cached);
    console.warn('Slider banners fresh refresh unavailable; using last BO-confirmed slider:', err && err.message ? err.message : err);
  }
}

loadSliderBanners();

// Referral sharing is handled by assets/js/referral-share.js.

// Final scroll container and back-to-top behaviour
(function(){
  function q(sel){ return document.querySelector(sel); }
  function getScrollTarget(){
    if (window.matchMedia('(min-width: 769px)').matches) {
      return q('.provider-games-panel') || q('.game-grid') || document.scrollingElement || document.documentElement;
    }
    if (document.body.classList.contains('mobile-slot-natural-scroll')) {
      return q('.main-layout') || document.scrollingElement || document.documentElement;
    }
    return q('.provider-games-panel') || document.scrollingElement || document.documentElement;
  }
  function ensureBtn(){
    var btn = document.getElementById('nagaScrollTopBtn');
    if(!btn){
      btn = document.createElement('button');
      btn.id = 'nagaScrollTopBtn';
      btn.className = 'naga-scroll-top-btn';
      btn.type = 'button';
      btn.setAttribute('aria-label','Back to top');
      btn.innerHTML = '<i class="fa-solid fa-arrow-up"></i>';
      document.body.appendChild(btn);
    }
    return btn;
  }
  function bind(){
    var btn = ensureBtn();
    var currentTarget = null;
    function update(){
      var t = getScrollTarget();
      var st = t === document.scrollingElement || t === document.documentElement ? (window.pageYOffset || document.documentElement.scrollTop || 0) : t.scrollTop;
      btn.classList.toggle('show', st > 160);
      if(t !== currentTarget){
        if(currentTarget && currentTarget.removeEventListener) currentTarget.removeEventListener('scroll', update);
        currentTarget = t;
        if(currentTarget && currentTarget.addEventListener) currentTarget.addEventListener('scroll', update, {passive:true});
      }
    }
    btn.onclick = function(){
      var t = getScrollTarget();
      if(t === document.scrollingElement || t === document.documentElement){ window.scrollTo({top:0, behavior:'smooth'}); }
      else { t.scrollTo({top:0, behavior:'smooth'}); }
    };
    var resizeTick=0;
    window.addEventListener('resize', function(){
      clearTimeout(resizeTick);
      resizeTick=setTimeout(update, 100);
    }, {passive:true});
    window.addEventListener('scroll', update, {passive:true});
    // Mobile SLOT uses .main-layout as its bounded scroll viewport. Bind it
    // directly as well so the back-to-top state keeps updating even when the
    // user changes from ALL/HOT into SLOT after this handler was initialized.
    var mainLayout = q('.main-layout');
    if(mainLayout && mainLayout.addEventListener){
      mainLayout.addEventListener('scroll', update, {passive:true});
    }
    document.addEventListener('naga:scroll-target-changed', function(){ requestAnimationFrame(update); });
    setTimeout(update, 300);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();

// Independent provider/game scrolling with a stable viewport height.
// This removes content auto-height jumps when game images finish loading.
(function(){
  var resizeTimer = 0;
  var observedShell = null;
  var stableSlotViewportHeight = 0;
  var stableSlotViewportWidth = 0;

  function viewportHeight(){
    return window.visualViewport ? window.visualViewport.height : window.innerHeight;
  }

  function setLobbyHeight(){
    var shell = document.querySelector('.provider-lobby-shell');
    if(!shell){
      document.body.classList.remove('provider-lobby-active');
      observedShell = null;
      return;
    }

    document.body.classList.add('provider-lobby-active');
    var rect = shell.getBoundingClientRect();
    var bottomNav = document.querySelector('.bottom-nav');
    var navTop = bottomNav ? bottomNav.getBoundingClientRect().top : viewportHeight();
    var viewportBottom = Math.min(viewportHeight(), navTop > 0 ? navTop : viewportHeight());
    var isMobileSlot = window.matchMedia('(max-width: 768px)').matches && activeCategoryTypeKey() === 'SLOT';
    var available;

    if(isMobileSlot){
      // Mobile SLOT now uses one natural document scroll. The banner, category,
      // subcategory and game list travel in the same scroll flow, so scrolling
      // the games naturally pushes the banner completely off-screen. Category
      // and subcategory become sticky only after they reach the top.
      var header = document.querySelector('.top-header');
      var marquee = document.getElementById('nagaGlobalMarquee');
      var category = document.querySelector('.category-slider');
      var subTabs = document.getElementById('subTabRow');
      var headerHeight = header ? Math.max(0, header.getBoundingClientRect().height || 0) : 69;
      if(marquee && getComputedStyle(marquee).display !== 'none') headerHeight += Math.max(0, marquee.getBoundingClientRect().height || 0);
      var categoryHeight = category ? Math.max(0, category.getBoundingClientRect().height || 0) : 58;
      var subTabHeight = (subTabs && getComputedStyle(subTabs).display !== 'none') ? Math.max(0, subTabs.getBoundingClientRect().height || 0) : 0;

      // Mobile browsers resize visualViewport/dvh while their address/tool bars
      // animate. If the bounded SLOT scroller follows those tiny height changes,
      // the sticky category/subcategory threshold moves back and forth at the
      // end of the list. Freeze the viewport height for the current orientation
      // and only recalculate when the layout width actually changes.
      var layoutWidth = Math.round(document.documentElement.clientWidth || window.innerWidth || 0);
      if(!stableSlotViewportHeight || Math.abs(layoutWidth - stableSlotViewportWidth) > 2){
        stableSlotViewportWidth = layoutWidth;
        stableSlotViewportHeight = Math.round(document.documentElement.clientHeight || window.innerHeight || viewportHeight());
      }

      // Whole-pixel sticky offsets avoid fractional-pixel oscillation.
      headerHeight = Math.round(headerHeight);
      categoryHeight = Math.round(categoryHeight);
      subTabHeight = Math.round(subTabHeight);
      document.body.style.setProperty('--slot-mobile-viewport-height', stableSlotViewportHeight + 'px');
      document.body.style.setProperty('--slot-header-height', headerHeight + 'px');
      document.body.style.setProperty('--slot-category-height', categoryHeight + 'px');
      document.body.style.setProperty('--slot-subtab-height', subTabHeight + 'px');
      document.body.classList.add('mobile-slot-natural-scroll');
      document.body.classList.remove('mobile-slot-scroll-handoff', 'slot-banner-passed');
      shell.style.removeProperty('--provider-lobby-height');
      try{ document.dispatchEvent(new CustomEvent('naga:scroll-target-changed')); }catch(_e){}
    }else{
      available = Math.floor(viewportBottom - rect.top);
      document.body.classList.remove('mobile-slot-natural-scroll', 'mobile-slot-scroll-handoff', 'slot-banner-passed');
      document.body.style.removeProperty('--slot-mobile-viewport-height');
      stableSlotViewportHeight = 0;
      stableSlotViewportWidth = 0;
      var minimum = window.matchMedia('(max-width: 768px)').matches ? 260 : 280;
      shell.style.setProperty('--provider-lobby-height', Math.max(minimum, available) + 'px');
    }

    if(observedShell !== shell){
      observedShell = shell;
      // Desktop keeps independent provider/game scrolling. Mobile SLOT must not
      // intercept wheel/touch events because the whole document owns scrolling.
      if(!isMobileSlot){
        bindScrollArea(shell.querySelector('.provider-side-rail'));
        bindScrollArea(shell.querySelector('.provider-games-panel'));
      }
    }
  }

  function revealSlotBanner(){
    if(!document.body.classList.contains('mobile-slot-scroll-handoff')) return;
    if(!document.body.classList.contains('slot-banner-passed')) return;
    document.body.classList.remove('slot-banner-passed');
    // The hidden banner is inserted back above the lobby. Return the document to
    // the top so the next upward movement naturally reveals the full banner.
    requestAnimationFrame(function(){ window.scrollTo(0, 0); });
  }

  function bindScrollArea(el){
    if(!el || el.dataset.independentScrollBound === '1') return;
    el.dataset.independentScrollBound = '1';
    var touchStartY = null;

    // Keep wheel/trackpad input inside the hovered column. Once mobile SLOT has
    // taken over the viewport, an upward gesture at scrollTop=0 explicitly
    // restores the banner instead of leaving a partial banner strip on screen.
    el.addEventListener('wheel', function(e){
      if(el.scrollHeight <= el.clientHeight) return;
      var atTop = el.scrollTop <= 0;
      var atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;
      var handoff = document.body.classList.contains('mobile-slot-scroll-handoff');
      if(handoff && e.deltaY < 0 && atTop){
        revealSlotBanner();
        return;
      }
      if(handoff && e.deltaY > 0 && atBottom) return;
      if((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)){
        e.preventDefault();
      }
      e.stopPropagation();
    }, {passive:false});

    el.addEventListener('touchstart', function(e){
      if(document.body.classList.contains('mobile-slot-scroll-handoff')){
        touchStartY = e.touches && e.touches[0] ? e.touches[0].clientY : null;
        return;
      }
      e.stopPropagation();
    }, {passive:true});
    el.addEventListener('touchmove', function(e){
      if(document.body.classList.contains('mobile-slot-scroll-handoff')){
        if(el.scrollTop <= 0 && touchStartY != null && e.touches && e.touches[0]){
          var dy = e.touches[0].clientY - touchStartY;
          if(dy > 18){
            revealSlotBanner();
            touchStartY = e.touches[0].clientY;
          }
        }
        return;
      }
      e.stopPropagation();
    }, {passive:true});
    el.addEventListener('touchend', function(){ touchStartY = null; }, {passive:true});
  }

  function updateSlotBannerState(){
    if(!document.body.classList.contains('mobile-slot-scroll-handoff')) return;
    // While the lobby owns the viewport, keep that state until the user scrolls
    // back to the top of the provider/game column and explicitly reveals banner.
    if(document.body.classList.contains('slot-banner-passed')) return;
    var bannerArea = document.querySelector('.mobile-top-area');
    var header = document.querySelector('.top-header');
    var headerBottom = header ? header.getBoundingClientRect().bottom : 69;
    var passed = !!bannerArea && bannerArea.getBoundingClientRect().bottom <= headerBottom + 2;
    if(passed){
      document.body.classList.add('slot-banner-passed');
      requestAnimationFrame(function(){
        setLobbyHeight();
        window.scrollTo(0, 0);
      });
    }
  }

  function schedule(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){ requestAnimationFrame(function(){ setLobbyHeight(); updateSlotBannerState(); }); }, 40);
  }

  var observer = new MutationObserver(schedule);
  function start(){
    var grid=document.getElementById('gameGrid');
    if(grid) observer.observe(grid, {childList:true, subtree:false});
    setLobbyHeight();
    updateSlotBannerState();
    window.addEventListener('scroll', updateSlotBannerState, {passive:true});
    var categoryRowEl=document.getElementById('categoryRow');
    var subTabRowEl=document.getElementById('subTabRow');
    if(categoryRowEl) categoryRowEl.addEventListener('click', schedule, {passive:true});
    if(subTabRowEl) subTabRowEl.addEventListener('click', schedule, {passive:true});
    window.addEventListener('resize', function(){
      // Ignore height-only mobile browser chrome changes while SLOT is active.
      // Width/orientation changes still rebuild the frozen viewport normally.
      var isMobileSlot = window.matchMedia('(max-width: 768px)').matches && activeCategoryTypeKey() === 'SLOT';
      var currentWidth = Math.round(document.documentElement.clientWidth || window.innerWidth || 0);
      if(isMobileSlot && stableSlotViewportWidth && Math.abs(currentWidth - stableSlotViewportWidth) <= 2) return;
      schedule();
    }, {passive:true});
    window.addEventListener('orientationchange', function(){
      stableSlotViewportHeight = 0;
      stableSlotViewportWidth = 0;
      schedule();
    }, {passive:true});
    if(window.visualViewport){
      window.visualViewport.addEventListener('resize', function(){
        // visualViewport resize fires repeatedly as mobile browser chrome moves.
        // Do not let that move an already-sticky SLOT subcategory row.
        if(window.matchMedia('(max-width: 768px)').matches && activeCategoryTypeKey() === 'SLOT') return;
        schedule();
      }, {passive:true});
    }
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();


document.addEventListener('DOMContentLoaded',function(){
  document.querySelectorAll('img').forEach(function(img){
    if(!img.loading) img.loading='lazy';
  });
});


document.addEventListener('naga:custom-assets-ready', function(){
  const btn = document.querySelector('.provider-side-rail .provider-rail-all');
  if(!btn) return;
  const imageUrl = providerAllImageUrl();
  btn.innerHTML = imageUrl
    ? `<img src="${imageUrl}" alt="All Providers" loading="eager">`
    : '<div class="provider-rail-all-icon">All</div>';
});
