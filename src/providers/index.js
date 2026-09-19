'use strict';
// Provider registry: name -> singleton provider instance.
const gopay = require('./gopay');
const shopeepay = require('./shopeepay');

const REGISTRY = new Map([
  ['gopay', gopay],
  ['shopeepay', shopeepay]
]);

/** Get a provider instance by name. Throws if unknown. */
function getProvider(name) {
  const p = REGISTRY.get(String(name || '').toLowerCase());
  if (!p) {
    const err = new Error(`Unknown provider: ${name}`);
    err.status = 400; err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  return p;
}

/** List all registered provider names. */
function listProviders() {
  return Array.from(REGISTRY.keys());
}

/** True if the provider is implemented (not a Phase-2 stub). */
function isImplemented(name) {
  const p = REGISTRY.get(String(name || '').toLowerCase());
  return Boolean(p && !p.notImplemented);
}

module.exports = { getProvider, listProviders, isImplemented };
