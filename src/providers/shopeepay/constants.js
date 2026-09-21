'use strict';
// ShopeePay Partner wire constants — ported from QrisMerchantID/shopee/constants.py.
// Every value observed from the partner web clients (alhifnywahid/merchantid + ahmadzakiyox gateway).
// NOTE: runtime re-verification against a live partner account is still TODO-S1.

const PAY_BASE_URL = 'https://shopeepay.shopee.co.id';
const PARTNER_BASE_URL = 'https://partner.shopee.co.id';
const PARTNER_ORIGIN = 'https://partner.shopee.co.id';
const PARTNER_REFERER = 'https://partner.shopee.co.id/';

const ENDPOINT_STORES = '/merchant/v1/partner-web/get-store-list';
const ENDPOINT_TRANSACTIONS = '/merchant/v1/partner-web/get-transaction-list';
const ENDPOINT_TRANSACTION_DETAIL = '/merchant/v1/partner-web/get-transaction-detail';

// Verified caps: transaction pages larger than 10 are clamped by the client.
const TRANSACTION_PAGE_SIZE = 10;
const STORE_PAGE_SIZE = 30;
const TRANSACTION_SERVICES = [1, 3];
const STORE_SERVICES = [1, 10];

// The only completed status observed in the wild (merchantid + zaki gateway).
const COMPLETED_STATUS = 3;
// Full status map from the deobfuscated server.js display functions
// (pending/failed/success/refunded/expired) — needs live re-verification (TODO-S1).
const STATUS_NAMES = { 1: 'pending', 2: 'failed', 3: 'success', 4: 'refunded', 5: 'expired' };

// Payment-envelope codes meaning "this session is dead, renew it" (terminal —
// never retry; the caller needs a fresh B: token or a new login).
const INVALID_TOKEN_CODES = new Set(['200020', '2010000']);

const DEFAULT_LANGUAGE = 'id';
const DEFAULT_TIMEZONE = 'Asia/Jakarta';

// Desktop-browser identity the reference client presents on every call.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';
const ACCEPT = 'application/json';
const ACCEPT_LANGUAGE = 'id,en-US;q=0.9,en;q=0.8';

// ── B2: programmatic OTP login (authClient.ts / shopeeProvider.ts) ──

const ACCOUNT_BASE_URL = 'https://partner.business.accounts.shopee.co.id';
const PARTNER_API_BASE_URL = 'https://api.partner.shopee.co.id';
const DEVICE_FINGERPRINT_REPORT_URL = 'https://df.infra.sz.shopee.co.id/v2/shpsec/web/report';
const SZ_SDK_VERSION = '1.12.26-user.1';

const ACCOUNT_CLIENT_ID = '5';
const BUSINESS_CLIENT_ID = '1';
const PARTNER_LOGIN_FROM = '12';

const ENDPOINT_CHECK_PASSWORD_MIGRATE = '/api/v4/account/business/check_password_migrate';
const ENDPOINT_CHECK_ACCOUNT_EXISTS = '/api/v4/account/business/check_account_exist_by_password';
const ENDPOINT_AUTHENTICATE_BY_PASSWORD = '/api/v4/account/business/authenticate_toc_by_password';
const ENDPOINT_OTP_SETTINGS = '/api/v4/account/business/get_otp_settings';
const ENDPOINT_SEND_OTP = '/api/v4/account/business/send_otp';
const ENDPOINT_VERIFY_OTP = '/api/v4/account/business/verify_otp';
const ENDPOINT_AUTHENTICATE_BY_OTP = '/api/v4/account/business/authenticate_toc_by_otp';
const ENDPOINT_LOGIN_TOC = '/api/v4/account/business/login_toc';
const ENDPOINT_LOGIN_STATUS = '/api/v4/account/business/login_status';
const ENDPOINT_MERCHANT_DETECT = '/nb/mss/mer-detect-api/PartnerMerchantDetectServer/MerchantDetect';
const ENDPOINT_USER_INFO = '/nb/mss/web-api/PartnerAccountServer/GetUserInfo';
const ENDPOINT_ACCOUNT_LOGIN = '/account/login/auth';
const ENDPOINT_ACCOUNT_LOGIN_TOKEN = '/authenticate/login/token/';
const ENDPOINT_ACCOUNT_TOB_AUTH = '/account/login/tob/auth';
const ENDPOINT_PARTNER_LOGIN_AUTH = '/login/auth';
const ENDPOINT_AUTHENTICATE_LOGIN = '/authenticate/login/';

const OTP_OPERATION = 50001;
const OTP_CHANNELS = [1, 2, 3, 5];        // SMS, voice, WhatsApp, Zalo
const SEND_OTP_CHANNELS = [1, 2, 3, 5, 4]; // ... + email
const DEFAULT_OTP_CHANNEL = 3;             // WhatsApp (reference capture default)

const NEED_OTP_CODE = 48401102;  // password accepted — OTP second factor required
const NOT_LOGIN_CODE = 48500102; // account session dead — fresh OTP required

const LIVE_TOKEN_COOKIE = '__shopee_partner_website_x_token_live';
const CLIENT_ID_COOKIE = 'SPC_CLIENTID';
const CSRF_COOKIE = 'csrftoken';

module.exports = {
  PAY_BASE_URL, PARTNER_BASE_URL, PARTNER_ORIGIN, PARTNER_REFERER,
  ENDPOINT_STORES, ENDPOINT_TRANSACTIONS, ENDPOINT_TRANSACTION_DETAIL,
  TRANSACTION_PAGE_SIZE, STORE_PAGE_SIZE, TRANSACTION_SERVICES, STORE_SERVICES,
  COMPLETED_STATUS, STATUS_NAMES, INVALID_TOKEN_CODES,
  DEFAULT_LANGUAGE, DEFAULT_TIMEZONE, USER_AGENT, ACCEPT, ACCEPT_LANGUAGE,
  ACCOUNT_BASE_URL, PARTNER_API_BASE_URL, DEVICE_FINGERPRINT_REPORT_URL, SZ_SDK_VERSION,
  ACCOUNT_CLIENT_ID, BUSINESS_CLIENT_ID, PARTNER_LOGIN_FROM,
  ENDPOINT_CHECK_PASSWORD_MIGRATE, ENDPOINT_CHECK_ACCOUNT_EXISTS, ENDPOINT_AUTHENTICATE_BY_PASSWORD,
  ENDPOINT_OTP_SETTINGS, ENDPOINT_SEND_OTP, ENDPOINT_VERIFY_OTP, ENDPOINT_AUTHENTICATE_BY_OTP,
  ENDPOINT_LOGIN_TOC, ENDPOINT_LOGIN_STATUS, ENDPOINT_MERCHANT_DETECT, ENDPOINT_USER_INFO,
  ENDPOINT_ACCOUNT_LOGIN, ENDPOINT_ACCOUNT_LOGIN_TOKEN, ENDPOINT_ACCOUNT_TOB_AUTH,
  ENDPOINT_PARTNER_LOGIN_AUTH, ENDPOINT_AUTHENTICATE_LOGIN,
  OTP_OPERATION, OTP_CHANNELS, SEND_OTP_CHANNELS, DEFAULT_OTP_CHANNEL,
  NEED_OTP_CODE, NOT_LOGIN_CODE,
  LIVE_TOKEN_COOKIE, CLIENT_ID_COOKIE, CSRF_COOKIE
};
