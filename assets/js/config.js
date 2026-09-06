// Global frontend config for Naga site
// Update API base URL here only. Other JS files can read from window.NAGA_CONFIG and window.NAGA_API.
window.NAGA_CONFIG = {
  api: {
    // baseUrl: 'http://localhost:8080',
    baseUrl: 'https://bo.titanx7.com',
    // uploadBaseUrl: 'http://localhost:8080/uploads',
    uploadBaseUrl: 'https://static.titanx7.com/uploads'
  },

  // Website/template selector shown when the header logo is clicked.
  // Add/remove items here only; the popup is generated automatically from this list
  // on every brand/domain using this frontend (including t2.titanx7.com).
  websiteTemplates: [
    { name: 'Template 1', url: 'https://titanx7.com/index.html' },
    { name: 'Template 2', url: 'https://t2.titanx7.com/index.html' },
    { name: 'Template 3', url: 'https://t3.titanx7.com/index.html' },
    { name: 'Template 4', url: 'https://t4.titanx7.com/index.html' }
  ]
};

window.NAGA_API = {
  sliderList: window.NAGA_CONFIG.api.baseUrl + '/api/public/slider/list',

  bonusCategoryTitleList: window.NAGA_CONFIG.api.baseUrl + '/api/bonus-category-title',
  bonusCategoryItemList: window.NAGA_CONFIG.api.baseUrl + '/api/bonus-category-item',

  gameCategoryList: window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog',
  gameSubCategoryList: window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog',
  gameProviderList: window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog',
  gameList: window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog',
  publicGameCatalog: window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog',
  publicGameCatalogVersion: window.NAGA_CONFIG.api.baseUrl + '/api/public/game-catalog/version',

  // Frontend player launch API. Frontend calls this API only; provider secrets stay in Spring Boot/BO.
  playerProviderLaunch: window.NAGA_CONFIG.api.baseUrl + '/api/player/provider/launch',
  playerProviderWalletBalance: window.NAGA_CONFIG.api.baseUrl + '/api/player/provider/wallet-balance',
  // Main wallet balance shown in frontend member panel / balance box
  playerMainWalletBalance: window.NAGA_CONFIG.api.baseUrl + '/api/member/wallet/balance',
  playerProviderExit: window.NAGA_CONFIG.api.baseUrl + '/api/player/provider/exit',
  playerProviderHeartbeat: window.NAGA_CONFIG.api.baseUrl + '/api/player/provider/heartbeat',
  playerPromotionList: window.NAGA_CONFIG.api.baseUrl + '/api/player/promotion/list',
  playerPromotionClaim: window.NAGA_CONFIG.api.baseUrl + '/api/player/promotion/claim',
  playerPromotionClaims: window.NAGA_CONFIG.api.baseUrl + '/api/player/promotion/my-claims',
  playerPromotionComplete: window.NAGA_CONFIG.api.baseUrl + '/api/player/promotion/claim-completion',
  playerHistoryTransactions: window.NAGA_CONFIG.api.baseUrl + '/api/player/history/transactions',
  playerHistoryBets: window.NAGA_CONFIG.api.baseUrl + '/api/player/history/bets',
  playerVip: window.NAGA_CONFIG.api.baseUrl + '/api/player/vip',
  playerRebateSummary: window.NAGA_CONFIG.api.baseUrl + '/api/player/rebate/summary',
  playerRebateDaily: window.NAGA_CONFIG.api.baseUrl + '/api/player/rebate/daily',
  playerRebateHistory: window.NAGA_CONFIG.api.baseUrl + '/api/player/rebate/history',
  playerRebateClaim: window.NAGA_CONFIG.api.baseUrl + '/api/player/rebate/claim',
  playerSpin2: window.NAGA_CONFIG.api.baseUrl + '/api/player/spin2',

  memberDeposit: window.NAGA_CONFIG.api.baseUrl + '/api/member/deposit',
  memberWithdraw: window.NAGA_CONFIG.api.baseUrl + '/api/member/withdraw',
  memberWithdrawalPolicy: window.NAGA_CONFIG.api.baseUrl + '/api/member/withdrawal-policy',
  memberSetTransactionPassword: window.NAGA_CONFIG.api.baseUrl + '/api/member/transaction-password',
  memberChangeMobile: window.NAGA_CONFIG.api.baseUrl + '/api/auth/member/mobile/change',
  memberDownline: window.NAGA_CONFIG.api.baseUrl + '/api/member/downline',
  paymentMethodList: window.NAGA_CONFIG.api.baseUrl + '/api/payment-method/list',
  paymentGatewayChannels: window.NAGA_CONFIG.api.baseUrl + '/api/payment-gateway/channels',
  paymentGatewayDeposit: window.NAGA_CONFIG.api.baseUrl + '/api/payment-gateway/deposit',
  paymentGatewayTransaction: window.NAGA_CONFIG.api.baseUrl + '/api/payment-gateway/transaction',
  socialLinkList: window.NAGA_CONFIG.api.baseUrl + '/api/social/list',

  siteCustomizeTranslation: window.NAGA_CONFIG.api.baseUrl + '/api/public/translation',
  // BO Layout Section CSS/HTML/JS. CSS saved under the `home` key is loaded globally.
  layoutSection: window.NAGA_CONFIG.api.baseUrl + '/api/customize/section',
  mainLayoutCustomize: window.NAGA_CONFIG.api.baseUrl + '/api/customize/main-layout',
  compliancePolicyList: window.NAGA_CONFIG.api.baseUrl + '/api/compliance-policies',
  frontendDisplaySetting: window.NAGA_CONFIG.api.baseUrl + '/api/frontend/display-setting',
  installAppSetting: window.NAGA_CONFIG.api.baseUrl + '/api/frontend/install-app',
  advertisementPopup: window.NAGA_CONFIG.api.baseUrl + '/api/frontend/ad-popup',
  publicLeaderboard: window.NAGA_CONFIG.api.baseUrl + '/api/public/leaderboard',
  publicLiveTransactions: window.NAGA_CONFIG.api.baseUrl + '/api/public/live-transactions'
};
