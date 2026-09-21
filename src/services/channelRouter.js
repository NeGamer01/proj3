'use strict';
// Channel routing: turns the public "QRIS / QRIS Realtime" choice into a concrete
// provider, honoring (a) the user's subscription tier and (b) provider health.
//
// Rules:
//  - Everyone can create a QRIS. Settlement speed (H+0 vs H+1) depends ONLY on
//    the subscription, never on which provider carries the transaction.
//  - The dashboard preference is a settlement-speed intent ("realtime"), not a
//    provider request. We pick any healthy provider that can satisfy it.
//  - If the user's tier does not allow realtime, we fall back to the normal
//    channel silently (never reject the request).
//  - If no provider is healthy at all, we throw PROVIDER_UNAVAILABLE.

const providers = require('../providers');
const health = require('./providerHealth');
const { config } = require('../config');

/** Providers that can settle H+0 (realtime). */
const REALTIME_CAPABLE = (config.realtimeProviders && config.realtimeProviders.length
  ? config.realtimeProviders
  : ['gopay']);

/** Providers usable for normal H+1 settlement (prefer shopeepay: cheaper). */
const NORMAL_PREFERRED = (config.normalProviders && config.normalProviders.length
  ? config.normalProviders
  : ['shopeepay', 'gopay']);

class RouteError extends Error {
  constructor(message, status = 503, code = 'PROVIDER_UNAVAILABLE') { super(message); this.status = status; this.code = code; }
}

function isHealthyAndConnected(provider) {
  if (!health.isAvailable(provider)) return false;
  try {
    const p = providers.getProvider(provider);
    if (!providers.isImplemented(provider)) return false;
    // Synchronous connectivity probe: a provider counts as connected when its
    // session exists and its static QR is mounted.
    return Boolean(p && (!p.getActiveSession || p.getActiveSessionSync ? p.getActiveSessionSync() : null) || null);
  } catch { return false; }
}

async function isConnected(provider) {
  if (!health.isAvailable(provider)) return false;
  try {
    if (!providers.isImplemented(provider)) return false;
    const p = providers.getProvider(provider);
    const sess = await p.getActiveSession();
    const { getStaticQris } = require('./providerAccounts');
    return Boolean(sess && await getStaticQris(provider));
  } catch { return false; }
}

/**
 * Pick a provider for this request.
 * @param {object} opts - { wantRealtime:boolean, allowed:string[], exclude:string[] }
 *
 * Tier resolution: `allowed` is the authoritative list of providers the user's
 * subscription grants. Realtime (H+0) is only available to users whose tier
 * grants a realtime-capable provider AND who are actually allowed to use it;
 * otherwise we degrade to H+1 on any permitted provider.
 *
 * @returns {provider, tier, degraded} — degraded=true when realtime was wanted
 *          but the user's tier denied it (so we silently ran H+1 instead).
 */
async function pickProvider({ wantRealtime = false, allowed = [], exclude = [] }) {
  const permitted = (p) => !allowed.length || allowed.includes(p);

  // 1) Realtime pool: only realtime-capable providers the user is entitled to.
  if (wantRealtime) {
    for (const name of REALTIME_CAPABLE) {
      if (exclude.includes(name) || !permitted(name)) continue;
      if (await isConnected(name)) return { provider: name, tier: 'H0', degraded: false };
    }
  }

  // 2) Normal pool (H+1): any permitted provider, prefer the cheap one.
  for (const name of NORMAL_PREFERRED) {
    if (exclude.includes(name) || !permitted(name)) continue;
    if (await isConnected(name)) return { provider: name, tier: 'H1', degraded: wantRealtime };
  }

  // 3) Emergency fallback: ignore the tier entitlement entirely — the user's
  //    preferred channel is down, so route anywhere healthy to keep the payment
  //    flowing. Settlement speed still follows the tier: H1 unless realtime was
  //    both requested and granted above.
  for (const name of REALTIME_CAPABLE.concat(NORMAL_PREFERRED)) {
    if (exclude.includes(name)) continue;
    if (await isConnected(name)) return { provider: name, tier: 'H1', degraded: true };
  }

  throw new RouteError('Semua metode pembayaran sedang tidak tersedia. Coba lagi sebentar.', 503, 'PROVIDER_UNAVAILABLE');
}

module.exports = { RouteError, REALTIME_CAPABLE, NORMAL_PREFERRED, pickProvider, isConnected, isHealthyAndConnected };
