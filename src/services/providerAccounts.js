'use strict';
// Operator-owned provider account storage (encrypted with PROVIDER_MASTER_KEY) + auto refresh.
// Pooled: ONE row per provider in provider_accounts (not per-user like nikipayv2's gobiz_sessions).
const db = require('../db');
const { encryptPayload, decryptPayload } = require('../utils/crypto');
const { logger } = require('../utils/logger');

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const cache = new Map(); // provider name -> session

function isExpired(session) {
  if (!session?.access_token && !session?.token && !session?.cookies) return true;
  if (!session?.expires_at) return false; // unknown expiry -> treat as alive until provider says otherwise
  const t = new Date(session.expires_at).getTime();
  return isNaN(t) ? false : Date.now() >= t - EXPIRY_BUFFER_MS;
}

function toMysqlDate(iso) {
  if (!iso) return null;
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

/** Load the operator's session for a provider (decrypted). Returns null if none/dead. */
async function loadSession(provider) {
  if (cache.has(provider)) return cache.get(provider);
  const row = await db.one('SELECT token_encrypted, cookies_json, merchant_id, store_id, phone, outlet_name, expires_at, status FROM provider_accounts WHERE name = ?', [provider]);
  if (!row || row.status !== 'active' || !row.token_encrypted) return null;
  try {
    const session = decryptPayload(String(row.token_encrypted));
    // attach operator metadata (unencrypted) for provider use
    session.merchant_id = session.merchant_id || row.merchant_id || null;
    session.store_id = session.store_id || row.store_id || null;
    session.phone_number = session.phone_number || row.phone || null;
    session.outlet_name = session.outlet_name || row.outlet_name || null;
    session.expires_at = session.expires_at || (row.expires_at ? row.expires_at + 'Z' : null);
    cache.set(provider, session);
    return session;
  } catch (e) {
    logger.error(`[ProviderAccounts] Cannot decrypt session for ${provider}: ${e.message}`);
    return null;
  }
}

/** Persist a (possibly renewed) session. `extra` carries operator columns to store unencrypted. */
async function saveSession(provider, session, extra = {}) {
  cache.set(provider, session);
  const encrypted = encryptPayload(session);
  await db.query(
    `UPDATE provider_accounts SET token_encrypted = ?, cookies_json = ?, merchant_id = ?, store_id = ?, phone = ?, outlet_name = ?, expires_at = ?, status = 'active', last_checked_at = UTC_TIMESTAMP() WHERE name = ?`,
    [encrypted, session.cookies ? JSON.stringify(session.cookies) : (extra.cookies_json || null),
     session.merchant_id || extra.merchant_id || null,
     session.store_id || extra.store_id || null,
     session.phone_number || extra.phone || null,
     session.outlet_name || extra.outlet_name || null,
     toMysqlDate(session.expires_at), provider]
  );
  return session;
}

/** Mark a provider account as expired (e.g. ShopeePay dead-token codes 200020/2010000). */
async function markExpired(provider, reason = 'expired') {
  cache.delete(provider);
  await db.query("UPDATE provider_accounts SET status = 'expired', last_checked_at = UTC_TIMESTAMP() WHERE name = ?", [provider]);
  logger.warn(`[ProviderAccounts] ${provider} marked expired (${reason})`);
}

async function deleteSession(provider) {
  cache.delete(provider);
  await db.query("UPDATE provider_accounts SET token_encrypted = NULL, cookies_json = NULL, expires_at = NULL, status = 'unconfigured' WHERE name = ?", [provider]);
}

/** Returns a usable session (caller refreshes via provider when near-expiry). */
async function getActiveSession(provider) {
  const s = await loadSession(provider);
  if (!s) return null;
  return s; // providers own their refresh logic (GoPay refresh_token / ShopeePay B1 has none)
}

async function sessionSummary(provider) {
  const s = await loadSession(provider);
  const row = await db.one('SELECT status, qris_static, merchant_id, store_id, expires_at FROM provider_accounts WHERE name = ?', [provider]);
  return {
    connected: Boolean(s),
    status: row?.status || 'unconfigured',
    phone: s?.phone_number || null,
    outlet_name: s?.outlet_name || null,
    merchant_id: s?.merchant_id || row?.merchant_id || null,
    store_id: s?.store_id || row?.store_id || null,
    expires_at: s?.expires_at || null,
    qris_static_configured: Boolean(row?.qris_static)
  };
}

/** Persist operator-pasted static QR for a provider. */
async function setStaticQris(provider, qrisStatic) {
  await db.query("UPDATE provider_accounts SET qris_static = ? WHERE name = ?", [qrisStatic || null, provider]);
  cache.delete(provider); // invalidate cache so staticQris() re-reads
}

async function getStaticQris(provider) {
  const row = await db.one('SELECT qris_static FROM provider_accounts WHERE name = ?', [provider]);
  return row?.qris_static || null;
}

/** Background job: refresh all active GoBiz sessions expiring in the next 12h.
 *  Delegates to the gopay provider's refresh. ShopeePay B1 has no refresh (manual re-paste). */
async function refreshAllExpiring() {
  // implemented in poller/providers; here we just surface candidates.
  const rows = await db.query(
    `SELECT name FROM provider_accounts WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 HOUR)`
  );
  return rows.map((r) => r.name);
}

function clearCache() { cache.clear(); }
function clearProviderCache(provider) { cache.delete(provider); }

module.exports = {
  isExpired, loadSession, saveSession, markExpired, deleteSession,
  getActiveSession, sessionSummary, setStaticQris, getStaticQris,
  refreshAllExpiring, clearCache, clearProviderCache
};
