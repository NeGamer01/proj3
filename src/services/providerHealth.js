'use strict';
// Provider health: tracks failures per provider, auto-marks DOWN after repeated
// errors, and recovers automatically on success. Admin can also force a state.
// States: UP (normal) | DOWN (auto-detected outage) | DISABLED (admin forced off)
const { config } = require('../config');

const STATES = { UP: 'UP', DOWN: 'DOWN', DISABLED: 'DISABLED' };
const FAILURE_THRESHOLD = Number(process.env.PROVIDER_FAILURE_THRESHOLD || 3);
const RECOVERY_AFTER_MS = Number(process.env.PROVIDER_RECOVERY_MS || 5 * 60 * 1000);

const health = new Map(); // provider -> { state, failures, lastFailAt, manualSince }

function snapshot(name) {
  const h = health.get(name);
  if (!h) return { state: STATES.UP, failures: 0, since: null };
  return { state: h.state, failures: h.failures, since: h.manualSince || h.lastFailAt };
}

/** Is the provider currently usable? (UP, or DOWN but past recovery window) */
function isAvailable(name) {
  const h = health.get(name);
  if (!h || h.state === STATES.UP) return true;
  if (h.state === STATES.DISABLED) return false;
  // DOWN: allow a retry probe once the recovery window passes.
  if (h.state === STATES.DOWN && Date.now() - h.lastFailAt > RECOVERY_AFTER_MS) return true;
  return false;
}

/** Record a failure. Auto-marks DOWN past the threshold. */
function recordFailure(name, reason = '') {
  let h = health.get(name);
  if (!h) { h = { state: STATES.UP, failures: 0, lastFailAt: 0, manualSince: null }; health.set(name, h); }
  h.failures++;
  h.lastFailAt = Date.now();
  if (h.state === STATES.UP && h.failures >= FAILURE_THRESHOLD) {
    h.state = STATES.DOWN;
    console.log(`[Health] ${name} marked DOWN after ${h.failures} failures (${reason})`);
  }
}

/** Record a success — clears the failure counter and restores UP. */
function recordSuccess(name) {
  const h = health.get(name);
  if (!h) return;
  if (h.state === STATES.DOWN) console.log(`[Health] ${name} recovered -> UP`);
  h.failures = 0;
  if (h.state !== STATES.DISABLED) { h.state = STATES.UP; h.manualSince = null; }
}

/** Admin override: 'enable' | 'disable' | 'auto'. */
function setManual(name, action) {
  let h = health.get(name);
  if (!h) { h = { state: STATES.UP, failures: 0, lastFailAt: 0, manualSince: null }; health.set(name, h); }
  if (action === 'disable') { h.state = STATES.DISABLED; h.manualSince = Date.now(); }
  else if (action === 'enable') { h.state = STATES.UP; h.failures = 0; h.manualSince = null; }
  else if (action === 'auto') { h.state = h.failures >= FAILURE_THRESHOLD ? STATES.DOWN : STATES.UP; h.manualSince = null; }
  return snapshot(name);
}

/** Health summary for all known providers. */
function summary(providers) {
  return (providers || []).map((name) => {
    const s = snapshot(name);
    return {
      provider: name,
      state: s.state,
      available: isAvailable(name),
      failures: s.failures,
      since: s.since ? new Date(s.since).toISOString() : null,
      manual: s.state === STATES.DISABLED
    };
  });
}

/** Public status for one provider (admin UI / API). */
function getStatus(name) {
  const h = health.get(name);
  if (!h) return { state: 'UP', reason: null, failures: 0, downSince: null, lastErrorAt: null, manual: false, available: true };
  const s = snapshot(name);
  return {
    state: s.state === 'DISABLED' ? 'down' : s.state.toLowerCase(),
    raw: s.state,
    reason: h.reason || null,
    failures: s.failures,
    downSince: s.manualSince || (s.state === 'DOWN' ? s.since : null),
    lastErrorAt: h.lastFailAt ? new Date(h.lastFailAt).toISOString() : null,
    manual: s.state === STATES.DISABLED,
    available: isAvailable(name)
  };
}

/** Admin override: state 'up' | 'down' | 'auto'. A manual DOWN is DISABLED — it
 * stays down until the admin lifts it (never auto-recovers). */
function setOverride(name, state, reason = '') {
  let h = health.get(name);
  if (!h) { h = { state: STATES.UP, failures: 0, lastFailAt: 0, manualSince: null, reason: null }; health.set(name, h); }
  if (state === 'down') { h.state = STATES.DISABLED; h.manualSince = Date.now(); h.reason = reason || 'Dipaksa admin'; }
  else if (state === 'up') { h.state = STATES.UP; h.failures = 0; h.manualSince = null; h.reason = reason || 'Dipulihkan admin'; }
  else if (state === 'auto') { h.state = h.failures >= FAILURE_THRESHOLD ? STATES.DOWN : STATES.UP; h.manualSince = null; h.reason = null; }
  return getStatus(name);
}

module.exports = { STATES, isAvailable, recordFailure, recordSuccess, setManual, setOverride, snapshot, summary, getStatus };
