'use strict';
// ShopeePay provider stub (Phase 2). Throws NOT_IMPLEMENTED until ported from QrisMerchantID.
// Phase 2 will add: constants.js, client.js, transactions.js, stores.js, auth.js (OTP B2).
// Money note: ShopeePay amounts are WHOLE RUPIAH grouped strings ("409.662") parsed via parse_id_amount.
const accounts = require('../../services/providerAccounts');

class ShopeePayProvider {
  constructor() { this.name = 'shopeepay'; this.displayName = 'ShopeePay'; this.notImplemented = true; }

  async getActiveSession() {
    const s = await accounts.getActiveSession('shopeepay');
    return s || null;
  }
  async saveSession(session) { await accounts.saveSession('shopeepay', session); }
  async refresh() { return null; /* B1 manual token has no auto-refresh */ }

  async fetchRecentMutasi() {
    throw Object.assign(new Error('ShopeePay provider not yet implemented (Phase 2)'), { code: 'NOT_IMPLEMENTED', status: 501 });
  }

  async staticQris() { return accounts.getStaticQris('shopeepay'); }
  async requestOtp() { throw Object.assign(new Error('ShopeePay OTP login not yet implemented (Phase 2 B2)'), { code: 'NOT_IMPLEMENTED', status: 501 }); }
  async verifyOtp() { throw Object.assign(new Error('ShopeePay OTP login not yet implemented (Phase 2 B2)'), { code: 'NOT_IMPLEMENTED', status: 501 }); }
  async summary() { return accounts.sessionSummary('shopeepay'); }
}

module.exports = new ShopeePayProvider();
