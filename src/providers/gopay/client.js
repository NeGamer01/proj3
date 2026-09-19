'use strict';
// Thin client for the (unofficial) GoBiz merchant APIs. Stateless — operator session handled in providerAccounts.js.
// Ported verbatim from nikipayv2/src/services/gobiz.js.
const axios = require('axios');
const crypto = require('crypto');
const { withRetry } = require('../../utils/retry');

const URLS = {
  requestOtp: 'https://api.gobiz.co.id/goid/login/request',
  token: 'https://api.gobiz.co.id/goid/token',
  userConfig: 'https://api.gobiz.co.id/goresto/v5/public/users/config',
  transactions: 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions'
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

class GoBizError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

function standardHeaders(uniqueId = crypto.randomUUID()) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'id',
    'authentication-type': 'go-id',
    'content-type': 'application/json',
    'gojek-country-code': 'ID',
    'gojek-timezone': 'Asia/Jakarta',
    origin: 'https://portal.gofoodmerchant.co.id',
    referer: 'https://portal.gofoodmerchant.co.id/',
    'user-agent': UA,
    'x-appid': 'go-biz-web-dashboard',
    'x-appversion': 'platform-v3.111.0-1708bc9a',
    'x-deviceos': 'Web',
    'x-phonemake': 'Windows 10 64-bit',
    'x-phonemodel': 'Chrome 150.0.0.0 on Windows 10 64-bit',
    'x-platform': 'Web',
    'x-uniqueid': uniqueId,
    'x-user-locale': 'en-GB',
    'x-user-type': 'merchant'
  };
}

function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.access_token}`,
    Cookie: session.cookie || `access_token=${session.access_token}; refresh_token=${session.refresh_token || ''}; auth_method=goid`,
    'authentication-type': 'go-id',
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://portal.gofoodmerchant.co.id',
    Referer: 'https://portal.gofoodmerchant.co.id/',
    'User-Agent': UA
  };
}

function parsePhone(raw) {
  let d = String(raw || '').trim().replace(/\D/g, '');
  if (d.startsWith('62')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

function mapAxiosError(error, fallbackMsg, fallbackCode) {
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return new GoBizError('GoBiz tidak merespons. Coba lagi.', 504, 'GOBIZ_TIMEOUT');
  }
  if (error.response?.status === 429) {
    return new GoBizError('GoBiz membatasi permintaan (rate limit). Tunggu beberapa menit.', 429, 'GOBIZ_RATE_LIMITED');
  }
  return new GoBizError(fallbackMsg, 502, fallbackCode);
}

async function requestOtp(rawPhone) {
  const phone = parsePhone(rawPhone);
  if (!/^8\d{7,13}$/.test(phone)) {
    throw new GoBizError('Masukkan nomor HP yang terdaftar di GoBiz, contoh 08xxxxxxxxxx', 400, 'INVALID_PHONE');
  }
  const deviceId = crypto.randomUUID();
  let res;
  try {
    res = await axios.post(URLS.requestOtp,
      { client_id: 'go-biz-web-new', phone_number: phone, country_code: '62' },
      { headers: standardHeaders(deviceId), timeout: 15000 });
  } catch (e) {
    throw mapAxiosError(e, 'GoBiz menolak permintaan OTP. Pastikan nomor terdaftar di GoBiz.', 'GOBIZ_OTP_REJECTED');
  }
  const data = res.data?.data || res.data || {};
  const otpToken = data.otp_token || data.login_token;
  if (!otpToken) throw new GoBizError('Respons OTP GoBiz tidak valid.', 502, 'GOBIZ_INVALID_RESPONSE');
  return { phone, otpToken, expiresIn: Number(data.expires_in || 720), deviceId };
}

async function verifyOtp({ phone, otpToken, otp, deviceId }) {
  const cleanPhone = parsePhone(phone);
  if (!/^\d{4,8}$/.test(String(otp || '')) || !otpToken || !deviceId || cleanPhone.length < 8) {
    throw new GoBizError('Data verifikasi OTP tidak lengkap', 400, 'INVALID_OTP_REQUEST');
  }
  const headers = standardHeaders(deviceId);
  let res;
  try {
    res = await axios.post(URLS.token,
      { client_id: 'go-biz-web-new', grant_type: 'otp', data: { otp: String(otp), otp_token: otpToken } },
      { headers, timeout: 15000 });
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 400) {
      throw new GoBizError('OTP salah atau kadaluarsa. Minta OTP baru.', 401, 'INVALID_OR_EXPIRED_OTP');
    }
    throw mapAxiosError(e, 'GoBiz gagal memverifikasi OTP.', 'GOBIZ_VERIFY_FAILED');
  }
  const t = res.data?.data || res.data || {};
  if (!t.access_token) throw new GoBizError('GoBiz tidak mengembalikan access token', 502, 'GOBIZ_NO_TOKEN');

  let merchantId = null;
  let outletName = 'GoPay Merchant';
  try {
    const cfg = await axios.get(URLS.userConfig, {
      headers: { Authorization: `Bearer ${t.access_token}`, 'authentication-type': 'go-id',
        Origin: 'https://portal.gofoodmerchant.co.id', Referer: 'https://portal.gofoodmerchant.co.id/', 'User-Agent': UA },
      timeout: 10000
    });
    const d = cfg.data?.data || cfg.data || {};
    const m = d.merchant || d.merchants?.[0] || d.restaurants?.[0];
    merchantId = m?.id ? String(m.id) : null;
    outletName = m?.name || m?.brand_name || outletName;
  } catch { /* optional */ }

  const expiresIn = Number(t.expires_in || 86400);
  return {
    phone_number: `+62${cleanPhone}`,
    merchant_id: merchantId,
    outlet_name: outletName,
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    cookie: `access_token=${t.access_token}; refresh_token=${t.refresh_token || ''}; auth_method=goid`,
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
}

async function refreshToken(session) {
  if (!session?.refresh_token) return null;
  const body = {
    client_id: 'go-biz-web-new',
    grant_type: 'refresh_token',
    data: { refresh_token: session.refresh_token, phone_number: parsePhone(session.phone_number) || null, country_code: '62' }
  };
  const res = await withRetry(() => axios.post(URLS.token, body, { headers: standardHeaders(), timeout: 10000 }));
  const t = res.data?.data || res.data || {};
  if (!t.access_token) return null;
  const refresh = t.refresh_token || session.refresh_token;
  return {
    ...session,
    access_token: t.access_token,
    refresh_token: refresh,
    cookie: `access_token=${t.access_token}; refresh_token=${refresh}; auth_method=goid`,
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + Number(t.expires_in || 86400) * 1000).toISOString()
  };
}

async function fetchTransactions(session, { merchantId, startTime } = {}) {
  const now = new Date();
  const start = startTime ? new Date(startTime) : new Date(now.getTime() - 24 * 3600 * 1000);
  const res = await axios.get(URLS.transactions, {
    headers: authHeaders(session),
    params: {
      from: 0,
      size: 20,
      statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
      payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
      start_time: new Date(start.getTime() - 5 * 60 * 1000).toISOString(),
      end_time: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
      merchant_ids: merchantId || ''
    },
    timeout: 10000
  });
  const d = res.data;
  return d?.transactions || (Array.isArray(d?.data) ? d.data : d?.data?.transactions) || [];
}

module.exports = { GoBizError, requestOtp, verifyOtp, refreshToken, fetchTransactions, parsePhone, URLS };
