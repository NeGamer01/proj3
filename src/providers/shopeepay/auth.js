'use strict';
// ShopeePay B2: programmatic OTP login — ported from QrisMerchantID/shopee/auth.py.
// 7-call request chain: bootstrap -> device-risk -> check_password_migrate ->
// check_account_exists -> authenticate_by_password -> get_otp_settings -> send_otp.
//
// Two HTTP clients (deliberate, ported faithfully):
//  - web client: keeps cookies for the passport/partner hosts
//  - api client: cookie-free — the partner API host authenticates header-only;
//    attaching cookies there makes the server reject calls with 200020.
//
// Cookie jar: axios has none built-in, so we keep a manual Map name->value and
// replay it as a Cookie header. The secure flag is not restorable (same as the
// httpx limitation upstream) — sessions are revalidated via login_status anyway.
const axios = require('axios');
const crypto = require('crypto');
const C = require('./constants');

const _OTP_RE = /^\d{4,10}$/;
const _AUTH_WORDS = /token|auth|login|session/i;
const _CAPTCHA_WORDS = /captcha/i;
const _PASSWORD_REQUIRED = 'Akun Shopee ini dilindungi password; masukkan password untuk menerima OTP';
const _MAX_REDIRECTS = 5;

class ShopeeAuthError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

// ── phone helpers ──

/** Parse free-form input into Indonesian mobile forms.
 *  Accepts 62…, +62…, 08…, bare 8… with spaces/dashes/dots. */
function parseIdMobile(number) {
  const digits = String(number || '').replace(/\D+/g, '');
  let d = digits;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('62')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  if (!d.startsWith('8') || d.length < 9 || d.length > 13) {
    throw new ShopeeAuthError('Masukkan nomor HP Indonesia yang valid (08…)', 400, 'INVALID_PHONE');
  }
  return { country_code: '62', subscriber: d, national: `0${d}`, e164: `62${d}` };
}

/** Render e164 the way verify_otp wants it: "(+62) 897 7110 640".
 *  The endpoint rejects the compact e164 form. */
function formatPhoneForVerification(e164) {
  const sub = e164.startsWith('62') ? e164.slice(2) : e164;
  const groups = [sub.slice(0, 3), sub.slice(3, 7), sub.slice(7)];
  return `(+62) ${groups.filter(Boolean).join(' ')}`;
}

/** sha256Hex(md5Hex(password)) — wire transform for account passwords. */
function hashShopeePassword(password) {
  const md5 = crypto.createHash('md5').update(String(password || ''), 'utf8').digest('hex');
  return crypto.createHash('sha256').update(md5, 'utf8').digest('hex');
}

// ── merchant helpers ──

function usableMerchants(merchants) {
  return (merchants || []).filter((m) => m.is_active === true && m.is_banned !== true);
}

/** The one merchant a login can pick without a human (null if ambiguous).
 *  Prefers the current-login merchant, else the sole usable one. */
function resolveSingleMerchant(merchants) {
  const usable = usableMerchants(merchants);
  const current = usable.filter((m) => m.is_current_login_user === true);
  if (current.length === 1) return current[0];
  if (usable.length === 1) return usable[0];
  return null;
}

function normalizeMerchant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.merchantId;
  const staffUid = raw.staffTobUid;
  if (typeof id !== 'number' || typeof staffUid !== 'number') return null;
  return {
    id: String(id),
    name: String(raw.merchantName || ''),
    status: Number.isInteger(raw.merchantStatus) ? raw.merchantStatus : 0,
    staff_user_id: staffUid,
    staff_role: Number.isInteger(raw.staffRole) ? raw.staffRole : 0,
    staff_status: Number.isInteger(raw.staffStatus) ? raw.staffStatus : 0,
    is_active: raw.isActive === true,
    is_banned: raw.isBanned === true,
    is_current_login_user: raw.isCurrentLoginUser === true
  };
}

/** Extract the inner merchant token from the signed dashboard JWT cookie.
 *  Returns { token, account_id, business_id?, expires_at? }. */
function readMerchantCredential(cookies) {
  const jwt = (cookies || []).find((c) => c.name === C.LIVE_TOKEN_COOKIE)?.value || '';
  if (!jwt) throw new ShopeeAuthError('Login Shopee tidak mengembalikan merchant session token', 502, 'NO_TOKEN_COOKIE');
  try {
    const segs = jwt.split('.');
    if (segs.length !== 3 || !segs[1]) throw new Error('bad jwt');
    const payload = JSON.parse(Buffer.from(segs[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload.token !== 'string') throw new Error('missing token');
    const accountId = payload.userid !== undefined ? String(payload.userid) : '';
    if (!accountId || !payload.token) throw new Error('missing account id');
    const out = { token: payload.token, account_id: accountId };
    if (payload.businessId !== undefined) out.business_id = String(payload.businessId);
    if (typeof payload.exp === 'number') out.expires_at = payload.exp * 1000;
    return out;
  } catch (e) {
    throw new ShopeeAuthError('Shopee mengembalikan session token yang tidak terbaca', 502, 'BAD_TOKEN_COOKIE');
  }
}

// ── state params ──

function partnerState() {
  const loginAuth = encodeURIComponent(C.PARTNER_BASE_URL + C.ENDPOINT_PARTNER_LOGIN_AUTH);
  const base = encodeURIComponent(C.PARTNER_BASE_URL);
  return `${C.PARTNER_BASE_URL}/?business_next=${loginAuth}&business_state=${base}&business_client_id=${C.BUSINESS_CLIENT_ID}`;
}

function loginReferer() {
  const state = encodeURIComponent(partnerState());
  const auth = encodeURIComponent(C.PARTNER_BASE_URL + C.ENDPOINT_ACCOUNT_LOGIN);
  return `${C.ACCOUNT_BASE_URL}${C.ENDPOINT_AUTHENTICATE_LOGIN}?lang=${C.DEFAULT_LANGUAGE}&should_hide_back=true&state=${state}&client_id=${C.ACCOUNT_CLIENT_ID}&next=${auth}`;
}

// ── auth service (stateless between calls; state travels in the dicts) ──

class AuthService {
  constructor({ timeout = 30000, maxRetries = 2, backoffBase = 0.5,
    language = C.DEFAULT_LANGUAGE, timezone = C.DEFAULT_TIMEZONE,
    userAgent = C.USER_AGENT, deviceReport = null } = {}) {
    this._timeout = timeout;
    this._maxRetries = maxRetries;
    this._backoffBase = backoffBase;
    this._language = language;
    this._timezone = timezone;
    this._userAgent = userAgent;
    this._deviceReport = deviceReport;
    this._cookies = new Map(); // name -> value (web jar)
  }

  // ── cookie jar ──
  _snapshot() { return Array.from(this._cookies.entries()).map(([name, value]) => ({ name, value })); }
  _restore(cookies) {
    this._cookies.clear();
    for (const c of cookies || []) {
      if (c && c.name) this._cookies.set(String(c.name), String(c.value || ''));
    }
  }
  _cookieHeader() {
    return Array.from(this._cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  _getCookie(name) { return this._cookies.get(name) || null; }

  // ── transport ──
  async _send(client, method, url, headers, data) {
    let attempt = 0;
    while (true) {
      try {
        return await client.request({ method, url, headers, data, timeout: this._timeout, maxRedirects: 0, validateStatus: () => true });
      } catch (e) {
        const transport = !e.response && (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND' || e.code === 'ECONNRESET' || e.code === 'EAI_AGAIN');
        if (transport && attempt < this._maxRetries) {
          await this._sleep(this._backoffBase * 2 ** attempt);
          attempt++;
          continue;
        }
        throw this._mapNetwork(e, url);
      }
    }
  }

  _mapNetwork(e, url) {
    if (e.response) return this._parseResponse(e.response, url);
    const code = (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') ? 'SHOPEEPAY_TIMEOUT' : 'SHOPEEPAY_NETWORK';
    return new ShopeeAuthError(code === 'SHOPEEPAY_TIMEOUT' ? 'Shopee tidak merespons. Coba lagi.' : `Shopee ${url} gagal: ${e.message}`, 504, code);
  }

  _parseResponse(res, url) {
    const status = res.status;
    const body = res.data;
    if (body === undefined || body === null || typeof body !== 'object') {
      throw new ShopeeAuthError(`Shopee ${url} menjawab HTTP ${status} dengan JSON tidak valid`, status, 'INVALID_JSON');
    }
    return { status, body };
  }

  async _postJson(client, url, body, headers) {
    const res = await this._send(client, 'POST', url, { ...headers, 'Content-Type': 'application/json' }, JSON.stringify(body));
    const { status, body: data } = this._parseResponse(res, url);
    return { status, data };
  }

  async _getJson(client, url, headers) {
    const res = await this._send(client, 'GET', url, headers, undefined);
    return this._parseResponse(res, url);
  }

  // ── account endpoint (envelope {error, error_msg, data}) ──
  async _account(path, body, riskToken) {
    const headers = this._accountHeaders(riskToken);
    const { status, data } = await this._postJson(this._webClient(), C.ACCOUNT_BASE_URL + path, body, headers);
    const maybeCaptcha = data.data;
    if ((maybeCaptcha && typeof maybeCaptcha === 'object' && maybeCaptcha.captcha_required === true) || _CAPTCHA_WORDS.test(String(data.error_msg || ''))) {
      throw new ShopeeAuthError(`Shopee ${path} meminta captcha — selesaikan di browser lalu coba lagi`, status, 'CAPTCHA_REQUIRED');
    }
    if (data.error !== 0 || data.data === undefined || data.data === null) {
      throw new ShopeeAuthError(`Shopee auth gagal di ${path} (error ${data.error}) - ${data.error_msg || ''}`, status, data.error !== undefined ? String(data.error) : null);
    }
    if (typeof data.data !== 'object') {
      throw new ShopeeAuthError(`Shopee ${path} menjawab dengan data non-object`, status, String(data.error));
    }
    return data.data;
  }

  // ── partner endpoint (envelope {errorCode, errorMsg, data}) header-only auth ──
  async _partner(path, body, { token = '', tocNonce = null } = {}) {
    const client = axios.create({}); // fresh cookie-free client
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': this._userAgent,
      'Accept-Language': C.ACCEPT_LANGUAGE,
      Origin: C.PARTNER_ORIGIN,
      Referer: C.PARTNER_REFERER,
      'X-Merchant-ToB-Clientid': 'undefined',
      'X-Merchant-Login-From': C.PARTNER_LOGIN_FROM,
      'X-Merchant-From': C.PARTNER_LOGIN_FROM,
      'X-Merchant-Language': this._language,
      'X-Merchant-Timezone': this._timezone,
      'X-Merchant-RequestId': crypto.randomUUID(),
      'shopee-baggage': 'PFB=undefined',
      'X-Merchant-Token': token
    };
    if (tocNonce !== null && tocNonce !== undefined) headers['X-Merchant-ToC-Nonce'] = String(tocNonce);
    const { status, data } = await this._postJson(client, C.PARTNER_API_BASE_URL + path, body, headers);
    const code = data.errorCode !== undefined && data.errorCode !== null ? String(data.errorCode) : null;
    if (data.errorCode !== 0 || data.data === undefined || data.data === null) {
      const reason = String(data.errorMsg || '');
      if ((code && C.INVALID_TOKEN_CODES.has(code)) || _AUTH_WORDS.test(reason)) {
        throw new ShopeeAuthError(`Shopee menolak session tersimpan; login ulang di ${path} (error ${code}) - ${reason}`, status, code);
      }
      throw new ShopeeAuthError(`Shopee partner API gagal di ${path} (error ${code}) - ${reason}`, status, code);
    }
    if (typeof data.data !== 'object') {
      throw new ShopeeAuthError(`Shopee ${path} menjawab dengan data non-object`, status, code);
    }
    return data.data;
  }

  _webClient() {
    // one client; cookies replayed manually via header (jar above)
    if (!this._web) this._web = axios.create({});
    return this._web;
  }

  _baseHeaders() {
    return {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': this._userAgent,
      'Accept-Language': C.ACCEPT_LANGUAGE,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site'
    };
  }

  _accountHeaders(riskToken) {
    const headers = {
      ...this._baseHeaders(),
      Origin: C.ACCOUNT_BASE_URL,
      Referer: loginReferer(),
      'X-App-Type': '2',
      'Sec-Fetch-Site': 'same-origin',
      Priority: 'u=0'
    };
    if (riskToken) {
      headers['af-ac-enc-sz-token'] = riskToken;
      headers['x-sz-sdk-version'] = C.SZ_SDK_VERSION;
    }
    const csrf = this._getCookie(C.CSRF_COOKIE);
    if (csrf) headers['X-CSRFToken'] = csrf;
    if (this._cookieHeader()) headers.Cookie = this._cookieHeader();
    return headers;
  }

  async _followGet(url) {
    let current = url;
    for (let i = 0; i < _MAX_REDIRECTS + 1; i++) {
      const res = await this._send(this._webClient(), 'GET', current, this._baseHeaders(), undefined);
      if (res.status < 300 || res.status >= 400) return;
      const location = res.headers?.location;
      if (!location) throw new ShopeeAuthError('Redirect Shopee tidak menyertakan location', 508, 'NO_LOCATION');
      current = new URL(location, current).toString();
    }
    throw new ShopeeAuthError('Batas redirect Shopee terlampaui', 508, 'TOO_MANY_REDIRECTS');
  }

  async _bootstrap() {
    await this._send(this._webClient(), 'GET', `${C.ACCOUNT_BASE_URL}/login?lang=${this._language}`, { ...this._baseHeaders(), Accept: 'text/html' }, undefined);
  }

  async _deviceFingerprint(deviceReport) {
    const headers = { ...this._baseHeaders(), Origin: C.ACCOUNT_BASE_URL, Referer: `${C.ACCOUNT_BASE_URL}/` };
    let content;
    if (deviceReport) {
      headers['Content-Type'] = 'text/plain;charset=UTF-8';
      headers.szdet = String(Date.now());
      content = deviceReport;
    } else {
      headers['Content-Type'] = 'application/json';
      content = '{}';
    }
    const res = await this._send(this._webClient(), 'POST', C.DEVICE_FINGERPRINT_REPORT_URL, headers, content);
    const { body: data } = this._parseResponse(res, '/v2/shpsec/web/report');
    const inner = data.data || {};
    const riskToken = inner.riskToken;
    if (data.code !== 0 || !riskToken) {
      throw new ShopeeAuthError('Layanan device-risk Shopee tidak mengembalikan risk token', 502, 'NO_RISK_TOKEN');
    }
    return String(riskToken);
  }

  async _checkAccountExists(phone, password, riskToken) {
    // Pure lookup: envelope deliberately NOT validated (reference behaves same).
    const body = { phone, password: password ? hashShopeePassword(password) : '' };
    const headers = { ...this._accountHeaders(riskToken), 'Content-Type': 'application/json' };
    await this._send(this._webClient(), 'POST', C.ACCOUNT_BASE_URL + C.ENDPOINT_CHECK_ACCOUNT_EXISTS, headers, JSON.stringify(body));
  }

  async _authenticateByPassword(phone, password, riskToken) {
    const { status, data } = await this._postJson(
      this._webClient(),
      C.ACCOUNT_BASE_URL + C.ENDPOINT_AUTHENTICATE_BY_PASSWORD,
      { phone, password: password ? hashShopeePassword(password) : '', security_device_fingerprint: riskToken },
      this._accountHeaders(riskToken)
    );
    if (data.error === C.NEED_OTP_CODE) {
      if (!password) throw new ShopeeAuthError(_PASSWORD_REQUIRED, 400, 'PASSWORD_REQUIRED');
      return true;
    }
    if (data.error === 0) return false;
    const inner = data.data || {};
    if (inner.toc_account?.has_password === true) throw new ShopeeAuthError(_PASSWORD_REQUIRED, 400, 'PASSWORD_REQUIRED');
    throw new ShopeeAuthError(`Shopee menolak password sebelum OTP dikirim (error ${data.error})`, status, data.error !== undefined ? String(data.error) : null);
  }

  async _loginStatus() {
    const { data } = await this._postJson(this._webClient(), C.ACCOUNT_BASE_URL + C.ENDPOINT_LOGIN_STATUS, {}, this._accountHeaders());
    return { alive: data.error === 0, data };
  }

  async _ssoExchange(tocNonce, spcClientid, fingerprint, staffUserId) {
    const tokenPage = `${C.ACCOUNT_BASE_URL}${C.ENDPOINT_ACCOUNT_LOGIN_TOKEN}?lang=${this._language}` +
      `&spc_clientid=${encodeURIComponent(spcClientid)}` +
      `&state=${encodeURIComponent(partnerState())}` +
      `&tob_userid=${staffUserId}` +
      `&next=${encodeURIComponent(C.PARTNER_BASE_URL + C.ENDPOINT_ACCOUNT_TOB_AUTH)}` +
      `&client_id=${C.ACCOUNT_CLIENT_ID}&toc_nonce=${encodeURIComponent(String(tocNonce))}`;
    await this._followGet(tokenPage);
    const login = await this._account(C.ENDPOINT_LOGIN_TOC, { toc_nonce: tocNonce, tob_userid: staffUserId, security_device_fingerprint: fingerprint }, fingerprint);
    if (!login.nonce) throw new ShopeeAuthError('Merchant login Shopee tidak mengembalikan authorization code', 502, 'NO_AUTH_CODE');
    const exchangeUrl = `${C.PARTNER_BASE_URL}${C.ENDPOINT_ACCOUNT_TOB_AUTH}?code=${encodeURIComponent(String(login.nonce))}&lang=${this._language}` +
      `&spc_clientid=${encodeURIComponent(spcClientid)}&state=${encodeURIComponent(partnerState())}`;
    await this._followGet(exchangeUrl);
  }

  async _getProfile(token, merchantId) {
    const raw = await this._partner(C.ENDPOINT_USER_INFO, {}, { token });
    const found = raw.merchantId;
    const foundId = (typeof found === 'number' || typeof found === 'string') ? String(found) : '';
    if (!foundId || foundId !== merchantId) {
      throw new ShopeeAuthError('Shopee mengembalikan profile untuk merchant yang berbeda', 502, 'MERCHANT_MISMATCH');
    }
    return {
      merchant_id: foundId,
      merchant_name: String(raw.merchantName || ''),
      store_id: (typeof raw.store_id === 'number' || typeof raw.store_id === 'string') ? String(raw.store_id) : null,
      account_id: String(raw.tocUid || ''),
      user_id: String(raw.tobUserId || ''),
      user_name: String(raw.userName || raw.tocUserName || '')
    };
  }

  async _completeBase(verification, merchantId) {
    const merchants = verification.merchants || [];
    let merchant;
    if (merchantId) {
      merchant = merchants.find((m) => m.id === String(merchantId));
      if (!merchant) throw new ShopeeAuthError('merchantId yang dikonfigurasi tidak dapat diakses', 400, 'MERCHANT_INACCESSIBLE');
    } else {
      merchant = resolveSingleMerchant(merchants);
      if (!merchant) throw new ShopeeAuthError('merchantId wajib jika beberapa merchant Shopee dapat diakses', 400, 'MERCHANT_REQUIRED');
    }
    if (merchant.is_active !== true || merchant.is_banned === true) {
      throw new ShopeeAuthError('Merchant Shopee yang dipilih tidak aktif atau dibanned', 502, 'MERCHANT_INACTIVE');
    }
    await this._ssoExchange(String(verification.toc_nonce), String(verification.spc_clientid), String(verification.device_fingerprint), Number(merchant.staff_user_id));
    const credential = readMerchantCredential(this._snapshot());
    if (credential.account_id !== String(merchant.staff_user_id)) {
      throw new ShopeeAuthError('Shopee mengembalikan token untuk merchant yang berbeda', 502, 'TOKEN_MERCHANT_MISMATCH');
    }
    return { merchant, credential };
  }

  // ── public API ──

  /** Run the 7-call OTP request chain; return the serializable challenge. */
  async requestOtp(phoneNumber, { password = null, channel = null, deviceReport = null } = {}) {
    const phone = parseIdMobile(phoneNumber).e164;
    this._cookies.clear();
    await this._bootstrap();
    const fingerprint = await this._deviceFingerprint(deviceReport || this._deviceReport);
    await this._account(C.ENDPOINT_CHECK_PASSWORD_MIGRATE, { phone }, fingerprint);
    await this._checkAccountExists(phone, password, fingerprint);
    const hasPassword = await this._authenticateByPassword(phone, password, fingerprint);
    const settings = await this._account(C.ENDPOINT_OTP_SETTINGS, {
      operation: C.OTP_OPERATION,
      phone,
      security_device_fingerprint: fingerprint,
      support_session: false,
      supported_channels: [...C.OTP_CHANNELS]
    }, fingerprint);
    const available = (settings.available_channel_list || []).filter((c) => Number.isInteger(c));
    const resolved = channel !== null && channel !== undefined ? channel : (Number.isInteger(settings.default_channel) ? settings.default_channel : C.DEFAULT_OTP_CHANNEL);
    if (available.length && !available.includes(resolved)) {
      throw new ShopeeAuthError('Channel OTP Shopee yang diminta tidak tersedia', 400, 'CHANNEL_UNAVAILABLE');
    }
    await this._account(C.ENDPOINT_SEND_OTP, {
      operation: C.OTP_OPERATION,
      phone,
      security_device_fingerprint: fingerprint,
      support_session: false,
      supported_channels: [...C.SEND_OTP_CHANNELS],
      channel: resolved,
      captcha_signature: ''
    }, fingerprint);
    return {
      version: 1,
      phone_number: phone,
      channel: resolved,
      available_channels: available,
      device_fingerprint: fingerprint,
      risk_token: fingerprint,
      has_password: hasPassword,
      cookies: this._snapshot(),
      requested_at: Date.now()
    };
  }

  /** Verify the code; return the serializable verification (merchant-aware). */
  async verifyOtp(challenge, otp) {
    if (challenge.version !== 1) throw new ShopeeAuthError('Versi challenge OTP Shopee tidak didukung', 400, 'BAD_VERSION');
    const code = String(otp || '').trim();
    if (!_OTP_RE.test(code)) throw new ShopeeAuthError('OTP Shopee harus 4 sampai 10 digit', 400, 'BAD_OTP_SHAPE');
    const fingerprint = String(challenge.device_fingerprint);
    this._restore(challenge.cookies);
    const verified = await this._account(C.ENDPOINT_VERIFY_OTP, {
      operation: C.OTP_OPERATION,
      otp: code,
      phone: formatPhoneForVerification(String(challenge.phone_number)),
      security_device_fingerprint: fingerprint,
      support_session: false
    }, fingerprint);
    const otpToken = verified.otp_token;
    if (!otpToken) throw new ShopeeAuthError('Verifikasi OTP Shopee tidak mengembalikan token', 502, 'NO_OTP_TOKEN');
    const authenticated = await this._account(C.ENDPOINT_AUTHENTICATE_BY_OTP, {
      otp_token: otpToken,
      security_device_fingerprint: fingerprint,
      is_signup: false
    }, fingerprint);
    const tocNonce = authenticated.toc_nonce;
    const tocAccount = authenticated.toc_account || {};
    const tocUserid = tocAccount.userid;
    if (!tocNonce || typeof tocUserid !== 'number') {
      throw new ShopeeAuthError('Otentikasi OTP Shopee mengembalikan sesi akun yang tidak lengkap', 502, 'INCOMPLETE_SESSION');
    }
    const spcClientid = this._getCookie(C.CLIENT_ID_COOKIE);
    if (!spcClientid) throw new ShopeeAuthError('Otentikasi Shopee tidak mengembalikan client session id', 502, 'NO_CLIENT_ID');
    const loginUrl = `${C.PARTNER_BASE_URL}${C.ENDPOINT_ACCOUNT_LOGIN}?lang=${this._language}` +
      `&spc_clientid=${encodeURIComponent(spcClientid)}` +
      `&state=${encodeURIComponent(partnerState())}` +
      `&toc_nonce=${encodeURIComponent(String(tocNonce))}`;
    await this._followGet(loginUrl);
    const detected = await this._partner(C.ENDPOINT_MERCHANT_DETECT, {}, { tocNonce: String(tocNonce) });
    const select = detected.selectMerchant || {};
    const rawList = Array.isArray(select.merchantList) ? select.merchantList : [];
    const merchants = rawList.map(normalizeMerchant).filter(Boolean);
    if (!merchants.length) throw new ShopeeAuthError('Akun Shopee tidak memiliki merchant yang dapat diakses', 502, 'NO_MERCHANT');
    return {
      version: 1,
      toc_nonce: tocNonce,
      toc_userid: tocUserid,
      spc_clientid: spcClientid,
      device_fingerprint: fingerprint,
      cookies: this._snapshot(),
      merchants,
      verified_at: Date.now()
    };
  }

  /** Finish the login: SSO exchange -> token -> profile. Returns the persistable session. */
  async completeLogin(verification, { merchantId = null, storeId = null, onStores = null } = {}) {
    if (verification.version !== 1) throw new ShopeeAuthError('Versi verifikasi Shopee tidak didukung', 400, 'BAD_VERSION');
    this._restore(verification.cookies);
    const { merchant, credential } = await this._completeBase(verification, merchantId);
    const profile = await this._getProfile(credential.token, merchant.id);
    let stores = [];
    if (typeof onStores === 'function') {
      stores = await onStores(credential.token);
    }
    return {
      version: 1,
      cookies: this._snapshot(),
      token: credential.token,
      access_token: credential.token, // alias for providerAccounts (token_encrypted)
      account_id: credential.account_id,
      merchant_id: merchant.id,
      merchant: { ...merchant, name: merchant.name || profile.merchant_name },
      merchants: (verification.merchants || []).map((m) => ({ ...m })),
      switch_credential: {
        toc_nonce: verification.toc_nonce,
        spc_clientid: verification.spc_clientid,
        device_fingerprint: verification.device_fingerprint
      },
      store_id: storeId || profile.store_id || null,
      profile,
      created_at: Date.now(),
      expires_at: credential.expires_at || null
    };
  }

  /** Re-mint the merchant token without a new OTP (while the account lives). */
  async refreshSession(session) {
    if (session.version !== 1) throw new ShopeeAuthError('Versi sesi Shopee tidak didukung', 400, 'BAD_VERSION');
    const credential = session.switch_credential;
    if (!credential || typeof credential !== 'object') {
      throw new ShopeeAuthError('Sesi Shopee ini tidak bisa diperbarui tanpa OTP; login lagi', 502, 'NO_SWITCH_CREDENTIAL');
    }
    this._restore(session.cookies);
    const { alive } = await this._loginStatus();
    if (!alive) {
      throw new ShopeeAuthError('Sesi akun Shopee telah kedaluwarsa; login lagi dengan OTP', 401, String(C.NOT_LOGIN_CODE));
    }
    const verification = {
      version: 1,
      toc_nonce: credential.toc_nonce,
      toc_userid: 0,
      spc_clientid: credential.spc_clientid,
      device_fingerprint: credential.device_fingerprint,
      cookies: session.cookies || [],
      merchants: session.merchants || []
    };
    const { credential: minted } = await this._completeBase(verification, session.merchant?.id);
    return {
      ...session,
      cookies: this._snapshot(),
      token: minted.token,
      access_token: minted.token,
      expires_at: minted.expires_at || session.expires_at
    };
  }

  /** Probe login_status — the only honest liveness signal (exp lies). */
  async accountSessionAlive(session) {
    if (session.version !== 1) throw new ShopeeAuthError('Versi sesi Shopee tidak didukung', 400, 'BAD_VERSION');
    this._restore(session.cookies);
    const { alive } = await this._loginStatus();
    return alive;
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

module.exports = {
  AuthService,
  ShopeeAuthError,
  parseIdMobile,
  formatPhoneForVerification,
  hashShopeePassword,
  usableMerchants,
  resolveSingleMerchant,
  normalizeMerchant,
  readMerchantCredential
};
