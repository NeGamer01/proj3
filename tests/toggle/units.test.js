'use strict';
// Provider toggle tests: preference storage, realtime gating, and the public
// display-name layer (internal gopay/shopeepay must never reach the dashboard).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { providerLabel, providerLabelShort } = require('../../src/utils/displayNames');

// ── display names: internal names never leak to the UI ──
test('providerLabel: shopeepay -> QRIS', () => {
  assert.equal(providerLabel('shopeepay'), 'QRIS');
});
test('providerLabel: gopay -> QRIS Realtime', () => {
  assert.equal(providerLabel('gopay'), 'QRIS Realtime');
});
test('providerLabel: unknown name passes through unchanged', () => {
  assert.equal(providerLabel('ovo'), 'ovo');
});
test('providerLabel: nullish input does not throw', () => {
  assert.equal(providerLabel(null), '');
  assert.equal(providerLabel(undefined), '');
});
test('providerLabel: case-insensitive', () => {
  assert.equal(providerLabel('GoPay'), 'QRIS Realtime');
  assert.equal(providerLabel('SHOPEEPAY'), 'QRIS');
});
test('providerLabelShort: gopay -> Realtime', () => {
  assert.equal(providerLabelShort('gopay'), 'Realtime');
  assert.equal(providerLabelShort('shopeepay'), 'QRIS');
});

// ── channel alias resolution (public API accepts "qris"/"realtime") ──
test('CHANNEL aliases map public names to internal providers', () => {
  const { CHANNEL_ALIASES } = require('../../src/utils/displayNames');
  assert.equal(CHANNEL_ALIASES.qris, 'shopeepay');
  assert.equal(CHANNEL_ALIASES.realtime, 'gopay');
});
test('resolveChannelAlias: public names + legacy names both resolve', () => {
  const { resolveChannelAlias } = require('../../src/utils/displayNames');
  assert.equal(resolveChannelAlias('qris'), 'shopeepay');
  assert.equal(resolveChannelAlias('realtime'), 'gopay');
  assert.equal(resolveChannelAlias('gopay'), 'gopay');
  assert.equal(resolveChannelAlias('shopeepay'), 'shopeepay');
  assert.equal(resolveChannelAlias(''), '');
});
