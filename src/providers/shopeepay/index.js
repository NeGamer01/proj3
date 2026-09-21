'use strict';
// ShopeePay provider: implements the Provider interface (providers/base.js) for
// the ShopeePay Partner API. Ported from QrisMerchantID/shopee (FASE B1).
//
// B1 = manually-pasted B:... merchant token (see docs/shopee/token.md) + store
// selection. B2 (programmatic OTP login) comes later — requestOtp/verifyOtp
// stay NOT_IMPLEMENTED until then.
//
// Money note: ShopeePay amounts are WHOLE RUPIAH grouped strings ("409.662")
// parsed via money.parseIdAmount — never mix with GoPay's sen helper.
const C = require('./constants');
const { ShopeePayClient, ShopeePayError } = require('./client');
const { AuthService, ShopeeAuthError, resolveSingleMerchant, normalizeMerchant } = require('./auth');
const { listStores } = require('./stores');
const { listRecent } = require('./transactions');
const accounts = require('../../services/providerAccounts');
const { logger } = require('../../utils/logger');

// pending Shopee B2 handshakes: provider name -> { challenge, auth, verification?, expiresAt }
// The 7-call chain produces a challenge with cookies + device fingerprint; we hold
// it in-memory so the admin only ever types the OTP code (same UX as the GoPay flow).
const pendingShopeeOtps = new Map();

class ShopeePayProvider {
  constructor() {
    this.name = 'shopeepay';
    this.displayName = 'ShopeePay';
    this.notImplemented = false; // B1 + B2 implemented
    this._deviceReport = null; // fraud-SDK telemetry blob (see docs/shopee/device-risk.md)
  }

  /** Install a captured device-risk blob. Without it the issuer returns a
   *  degraded risk token and OTP delivery is silently suppressed. */
  setDeviceReport(blob) {
    if (typeof blob !== 'string' || blob.trim().length < 50) {
      throw Object.assign(new Error('Device report tidak valid'), { status: 400, code: 'BAD_REPORT' });
    }
    this._deviceReport = blob.trim();
    logger.info(`[ShopeePay] device-risk blob dipasang (${this._deviceReport.length} bytes)`);
  }

  /** The live client, token read from the stored session (token_encrypted). */
  async _client() {
    const session = await accounts.getActiveSession('shopeepay');
    const token = session?.access_token || session?.token || null;
    const client = new ShopeePayClient({ token });
    return { client, session };
  }

  /** Active session with a usable token. Auto-renew is not possible in B1
   *  (manual token has no refresh credential) — dead tokens surface as
   *  INVALID_TOKEN_CODES from postPayment and are marked expired by the caller. */
  async getActiveSession() {
    const s = await accounts.getActiveSession('shopeepay');
    if (!s) return null;
    const token = s?.access_token || s?.token;
    if (!token) return null;
    return s;
  }

  async saveSession(session) {
    await accounts.saveSession('shopeepay', session);
  }

  /** B1 tokens cannot be refreshed silently — returns null (caller marks expired). */
  async refresh() {
    return null;
  }

  /** Fetch recent mutations in the window, normalized to whole-rupiah ints.
   *  Retries once on dead-token (200020/2010000) by re-reading the stored token
   *  (admin may have pasted a fresh one mid-flight). */
  async fetchRecentMutasi({ startTimeMs } = {}) {
    let { client, session } = await this._client();
    if (!client.getToken()) {
      throw Object.assign(new Error('ShopeePay session not connected (paste a B: token first)'), { code: 'NO_SESSION', status: 503 });
    }
    const storeId = session?.store_id;
    const merchantId = session?.merchant_id;
    if (!storeId) {
      throw Object.assign(new Error('ShopeePay store not selected (choose a store in the provider page)'), { code: 'NO_STORE', status: 503 });
    }
    const startSec = startTimeMs ? Math.floor(new Date(startTimeMs).getTime() / 1000) : undefined;
    try {
      const res = await listRecent(client, storeId, { merchantId, startTime: startSec, minutes: 15 });
      return res.transactions;
    } catch (err) {
      if (err instanceof ShopeePayError && C.INVALID_TOKEN_CODES.has(String(err.code))) {
        logger.warn('[ShopeePay] token rejected (dead session) — marking expired, admin must re-paste');
        await accounts.markExpired('shopeepay', `invalid token code ${err.code}`);
        throw Object.assign(new Error('ShopeePay session expired, paste a fresh B: token'), { code: 'SESSION_EXPIRED', status: 503 });
      }
      throw err;
    }
  }

  async staticQris() {
    return accounts.getStaticQris('shopeepay');
  }

  /** Save a manually pasted B: token (B1) and (re)discover stores. */
  async setManualToken(token, { storeId = null } = {}) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw Object.assign(new Error('Token ShopeePay tidak boleh kosong'), { code: 'BAD_TOKEN', status: 400 });
    }
    const trimmed = token.trim();
    const client = new ShopeePayClient({ token: trimmed });
    const stores = await listStores(client);
    if (!stores.length) {
      throw Object.assign(new Error('Tidak ada store ditemukan untuk token ini — pastikan token dari partner.shopee.co.id yang benar'), { code: 'NO_STORES', status: 502 });
    }
    const chosen = storeId ? stores.find((s) => s.id === String(storeId)) : null;
    const finalStoreId = chosen ? chosen.id : stores[0].id;
    await this.saveSession({
      access_token: trimmed,
      token: trimmed,
      merchant_id: null, // unknown until B2 profile call
      store_id: finalStoreId,
      updated_at: new Date().toISOString(),
      expires_at: null // B1 manual tokens: expiry unknown, honored until rejected
    });
    logger.info(`[ShopeePay] B1 token installed (${stores.length} store(s) found, using ${finalStoreId})`);
    return { stores, store_id: finalStoreId };
  }

  /** List stores for the currently stored token (admin store picker). */
  async listStoresForCurrentToken() {
    const { client } = await this._client();
    if (!client.getToken()) return [];
    return listStores(client);
  }

  /** Point the session at another known store id. */
  async selectStore(storeId) {
    const session = await accounts.getActiveSession('shopeepay');
    if (!session) throw Object.assign(new Error('Belum ada session ShopeePay'), { code: 'NO_SESSION', status: 404 });
    await this.saveSession({ ...session, store_id: String(storeId), updated_at: new Date().toISOString() });
    logger.info(`[ShopeePay] store switched to ${storeId}`);
    return { store_id: String(storeId) };
  }

  /** B2 step 1 of 3: request OTP (7-call chain). Returns { phone, channel,
   *  has_password } — the full challenge is held server-side in pendingShopeeOtps
   *  (admin only ever types the SMS/WhatsApp code, exactly like the GoPay flow). */
  async requestOtp(phone, { password = null, channel = null, deviceReport = null } = {}) {
    const auth = new AuthService({ deviceReport });
    const challenge = await auth.requestOtp(phone, { password, channel, deviceReport: deviceReport || this._deviceReport });
    pendingShopeeOtps.set(this.name, {
      challenge,
      auth, // reuse the same instance (cookies in-memory) for verifyOtp
      expiresAt: Date.now() + 12 * 60 * 1000 // 12 min to type the code
    });
    return {
      phone: challenge.phone_number,
      channel: challenge.channel,
      available_channels: challenge.available_channels,
      has_password: challenge.has_password
    };
  }

  /** B2 step 2 of 3: verify the code. Returns merchants when a human must pick
   *  (multi-merchant), else completes the login directly. */
  async verifyOtp({ otp, merchantId = null, password = null }) {
    const pending = pendingShopeeOtps.get(this.name);
    if (!pending || Date.now() > pending.expiresAt) {
      pendingShopeeOtps.delete(this.name);
      throw Object.assign(new Error('Minta OTP Shopee dulu sebelum verifikasi (sesi OTP sudah habis)'), { code: 'OTP_NOT_REQUESTED', status: 400 });
    }
    const { challenge, auth } = pending;
    const verification = await auth.verifyOtp(challenge, otp);
    // auto-pick when unambiguous; else surface merchants for the admin to choose
    const chosen = merchantId || (resolveSingleMerchant(verification.merchants)?.id || null);
    if (!chosen) {
      pending.verification = verification; // keep for completeOtpLogin
      pending.expiresAt = Date.now() + 10 * 60 * 1000;
      return {
        merchant_selection_required: true,
        merchants: verification.merchants.map((m) => ({ id: m.id, name: m.name, is_active: m.is_active }))
      };
    }
    const session = await this._completeOtpLogin(auth, verification, chosen);
    pendingShopeeOtps.delete(this.name);
    return { merchant_selection_required: false, session, merchant_id: chosen };
  }

  /** B2 step 3 of 3 (only when merchant selection was required): finish with the
   *  admin-chosen merchant id. No second OTP. */
  async completeOtpLogin({ merchantId, storeId = null }) {
    const pending = pendingShopeeOtps.get(this.name);
    if (!pending || !pending.verification) {
      throw Object.assign(new Error('Tidak ada verifikasi OTP Shopee yang menunggu'), { code: 'NO_PENDING_VERIFY', status: 400 });
    }
    const { auth, verification } = pending;
    const session = await this._completeOtpLogin(auth, verification, merchantId, storeId);
    pendingShopeeOtps.delete(this.name);
    return { session, merchant_id: merchantId };
  }

  async _completeOtpLogin(auth, verification, merchantId, storeId = null) {
    const session = await auth.completeLogin(verification, {
      merchantId,
      storeId,
      onStores: async (token) => {
        const client = new ShopeePayClient({ token });
        return listStores(client);
      }
    });
    await this.saveSession(session);
    logger.info(`[ShopeePay] B2 login complete (merchant ${session.merchant_id}, store ${session.store_id || '-'})`);
    return session;
  }

  /** Silent renewal (no OTP) while the account session lives. */
  async refresh(session) {
    try {
      const auth = new AuthService();
      const updated = await auth.refreshSession(session || (await accounts.getActiveSession('shopeepay')));
      if (!updated) return null;
      await this.saveSession(updated);
      logger.info('[ShopeePay] B2 token refreshed (silent)');
      return updated;
    } catch (e) {
      if (e.code === String(C.NOT_LOGIN_CODE) || e.status === 401) {
        logger.warn('[ShopeePay] account session dead — re-login with OTP required');
        await accounts.markExpired('shopeepay', 'account session dead');
        return null;
      }
      logger.error(`[ShopeePay] refresh failed: ${e.message}`);
      return null;
    }
  }

  async summary() {
    const s = await accounts.sessionSummary('shopeepay');
    return { ...s, device_report: this._deviceReport ? `${this._deviceReport.length} bytes` : null };
  }
}

module.exports = new ShopeePayProvider();
