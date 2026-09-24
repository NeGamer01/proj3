'use strict';
const { verifyToken, signToken } = require('../services/users');
const apikeys = require('../services/apikeys');
const subs = require('../services/subscriptions');
const { config } = require('../config');

const COOKIE = 'qrispay_session';
const TTL = 7 * 24 * 3600 * 1000;

function setSessionCookie(res, user) {
  res.cookie(COOKIE, signToken({ uid: user.id, role: user.role }, TTL), {
    httpOnly: true, sameSite: 'lax', secure: config.env === 'production', maxAge: TTL, path: '/'
  });
}
function clearSessionCookie(res) { res.clearCookie(COOKIE, { path: '/' }); }

/** Loads req.user from cookie if present (never fails). */
async function attachUser(req, _res, next) {
  const payload = verifyToken(req.cookies?.[COOKIE]);
  if (payload?.uid) {
    const { findById } = require('../services/users');
    const user = await findById(payload.uid).catch(() => null);
    if (user && user.status === 'active') req.user = user;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Silakan login' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Silakan login' });
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Khusus admin' });
  next();
}

// ── API key auth with subscription check + per-key rate limit + allowed providers ──
const buckets = new Map();
function rateLimited(keyId) {
  const now = Date.now(); const minute = Math.floor(now / 60000);
  const b = buckets.get(keyId);
  if (!b || b.minute !== minute) { buckets.set(keyId, { minute, count: 1 }); return false; }
  b.count++;
  return b.count > config.rateLimitPerMinute;
}
setInterval(() => { const m = Math.floor(Date.now() / 60000); for (const [k, b] of buckets) if (b.minute !== m) buckets.delete(k); }, 120000).unref();

async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key || (String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  const info = await apikeys.resolve(String(key || ''));
  if (!info) return res.status(401).json({ success: false, code: 'INVALID_API_KEY', message: 'API key tidak valid' });
  if (info.status !== 'active') return res.status(403).json({ success: false, code: 'ACCOUNT_BLOCKED', message: 'Akun diblokir' });
  // Note: an expired/absent subscription does NOT invalidate a key. It only
  // degrades the tier (QRIS H+1 only); see subs.allowedProviders below.
  if (rateLimited(info.key_id)) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: `Maksimal ${config.rateLimitPerMinute} request/menit` });
  // Resolve allowed providers from subscription tier (free = shopeepay only, paid = plan providers).
  const allowed = await subs.allowedProviders(info.user_id, info.role);
  req.apiUser = { ...info, allowed_providers: allowed };
  next();
}

module.exports = { COOKIE, setSessionCookie, clearSessionCookie, attachUser, requireUser, requireAdmin, requireApiKey };
