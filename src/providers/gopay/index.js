'use strict';
// GoPay provider: implements the Provider interface (providers/base.js) for GoBiz.
// Wraps client.js (HTTP) + normalize.js (sen->rupiah) + providerAccounts (session store).
// 401 during fetch -> refresh token once -> retry (ported from nikipayv2 payments.verifyPayment).
const client = require('./client');
const normalize = require('./normalize');
const accounts = require('../../services/providerAccounts');
const { logger } = require('../../utils/logger');

class GoPayProvider {
  constructor() { this.name = 'gopay'; this.displayName = 'GoPay / GoBiz'; }

  async getActiveSession() {
    const s = await accounts.getActiveSession('gopay');
    if (!s?.access_token) return null;
    // Auto-refresh when near expiry (refresh_token flow works for GoPay).
    if (accounts.isExpired(s) && s.refresh_token) {
      const refreshed = await this.refresh(s);
      if (refreshed) return refreshed;
    }
    return s?.access_token ? s : null;
  }

  async saveSession(session) {
    await accounts.saveSession('gopay', session);
  }

  async refresh(session) {
    try {
      const updated = await client.refreshToken(session);
      if (!updated) return null;
      await this.saveSession(updated);
      logger.info(`[GoPay] Token refreshed (operator)`);
      return updated;
    } catch (e) {
      logger.error(`[GoPay] Refresh failed: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
      return null;
    }
  }

  /** Fetch recent mutations in the window; normalize to whole-rupiah ints. Retries once on 401. */
  async fetchRecentMutasi({ startTimeMs } = {}) {
    let session = await this.getActiveSession();
    if (!session) throw Object.assign(new Error('GoBiz session not connected'), { code: 'NO_SESSION', status: 503 });
    const startIso = startTimeMs ? new Date(startTimeMs).toISOString() : undefined;
    let rows;
    try {
      rows = await client.fetchTransactions(session, { merchantId: session.merchant_id, startTime: startIso });
    } catch (err) {
      if (err.response?.status === 401) {
        logger.warn('[GoPay] session 401, refreshing token');
        session = await this.refresh(session);
        if (!session) throw Object.assign(new Error('GoBiz session expired, please login again'), { code: 'SESSION_EXPIRED', status: 503 });
        rows = await client.fetchTransactions(session, { merchantId: session.merchant_id, startTime: startIso });
      } else {
        throw err;
      }
    }
    return normalize.normalizeBatch(rows);
  }

  async staticQris() {
    return accounts.getStaticQris('gopay');
  }

  async requestOtp(phone) {
    return client.requestOtp(phone);
  }

  async verifyOtp(challenge) {
    const session = await client.verifyOtp(challenge);
    await this.saveSession(session);
    return session;
  }

  async summary() {
    return accounts.sessionSummary('gopay');
  }
}

module.exports = new GoPayProvider();
