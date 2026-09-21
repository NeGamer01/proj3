'use strict';
// ShopeePay Partner HTTP client: payment envelope, retries, error mapping.
// Ported from QrisMerchantID/shopee/client.py.
//
// B1 covers the payment envelope ({code, msg, data}) used by the store and
// transaction feeds: the B: token travels in the BODY (data.metadata.token)
// while the X-Token header stays intentionally empty — exactly as the partner
// web client does (merchantid api.ts). Attaching cookies to the pay host
// makes the server reject calls with 200020.
const axios = require('axios');
const C = require('./constants');

const _AUTH_WORDS = /token|auth|login|session/i;

class ShopeePayError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

class ShopeePayClient {
  /** token: manual B:... merchant token (see docs/shopee/token.md). null until set. */
  constructor({ token = null, timeout = 30000, maxRetries = 2, backoffBase = 0.5,
    language = C.DEFAULT_LANGUAGE, timezone = C.DEFAULT_TIMEZONE, userAgent = C.USER_AGENT } = {}) {
    this._token = token;
    this._timeout = timeout;
    this._maxRetries = maxRetries;
    this._backoffBase = backoffBase;
    this._language = language;
    this._timezone = timezone;
    this._userAgent = userAgent;
  }

  /** Set (or clear) the B:... token used by subsequent calls. */
  setToken(token) { this._token = token; }
  getToken() { return this._token; }

  /** Headers the partner web client sends on payment-envelope calls. */
  paymentHeaders() {
    return {
      Accept: C.ACCEPT,
      'Accept-Language': C.ACCEPT_LANGUAGE,
      'Content-Type': 'application/json',
      Origin: C.PARTNER_ORIGIN,
      Referer: C.PARTNER_REFERER,
      'User-Agent': this._userAgent,
      'X-Timestamp-Ms': String(Date.now()),
      'X-Token': ''
    };
  }

  /** data.metadata for payment-envelope bodies (carries the token). */
  paymentMetadata() {
    if (!this._token) {
      throw Object.assign(new Error('No ShopeePay token set — pass token="B:..." (see docs/shopee/token.md).'), { code: 'NO_TOKEN' });
    }
    return { token: this._token, language: this._language, timezone: this._timezone };
  }

  /** POST {data: {metadata, ...data}}; return the unwrapped data.
   *  Throws ShopeePayError on envelope failure. Invalid-token codes
   *  (200020/2010000) mean the session is dead — renew, don't retry. */
  async postPayment(path, data) {
    const body = { data: { metadata: this.paymentMetadata(), ...data } };
    const url = C.PAY_BASE_URL + path;
    const headers = this.paymentHeaders();
    let attempt = 0;
    while (true) {
      let res;
      try {
        res = await axios.post(url, body, { headers, timeout: this._timeout });
      } catch (e) {
        // Transport-level errors only (connect/DNS/timeout) are retried.
        if (this._isTransportError(e) && attempt < this._maxRetries) {
          await this._sleep(this._backoffBase * 2 ** attempt);
          attempt++;
          continue;
        }
        throw this._networkError(e, path);
      }
      return this._handleResponse(res.status, res.data, path);
    }
  }

  _isTransportError(e) {
    return e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND' ||
      e.code === 'ECONNRESET' || e.code === 'EAI_AGAIN' || e.message?.includes('network');
  }

  _networkError(e, path) {
    if (e.response) {
      // HTTP error status: try to read the envelope anyway, then map.
      return this._handleResponse(e.response.status, e.response.data, path);
    }
    const code = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' ? 'SHOPEEPAY_TIMEOUT' : 'SHOPEEPAY_NETWORK';
    const msg = code === 'SHOPEEPAY_TIMEOUT' ? 'ShopeePay tidak merespons. Coba lagi.' : `ShopeePay ${path} gagal: ${e.message}`;
    return new ShopeePayError(msg, 504, code);
  }

  _handleResponse(status, body, path) {
    if (body == null || typeof body !== 'object') {
      throw new ShopeePayError(`ShopeePay ${path} answered HTTP ${status} with invalid JSON`, status, 'INVALID_JSON');
    }
    const codeRaw = body.code;
    const code = codeRaw !== undefined && codeRaw !== null ? String(codeRaw) : null;
    const reason = String(body.msg || '') || `HTTP ${status}`;
    if (status >= 200 && status < 300 && (codeRaw === 0 || codeRaw === '0') && body.data != null) {
      if (typeof body.data !== 'object') {
        throw new ShopeePayError(`ShopeePay ${path} answered with non-object data`, code, body);
      }
      return body.data;
    }
    let message = `ShopeePay ${path} failed (error ${code}): ${reason}`;
    if ((code && C.INVALID_TOKEN_CODES.has(code)) || _AUTH_WORDS.test(reason)) {
      message = `Shopee rejected the saved session on ${path} (error ${code}); paste a fresh B: token — retrying the dead one never helps`;
    }
    throw new ShopeePayError(message, status, code);
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

module.exports = { ShopeePayClient, ShopeePayError };
