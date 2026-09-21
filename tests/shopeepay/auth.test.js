'use strict';
// ShopeePay B2 auth unit tests: phone parsing, password hashing, merchant helpers.
// These cover the pure functions of the 7-call OTP chain (the network calls are
// exercised against the live API by hand; here we lock the math).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseIdMobile, formatPhoneForVerification, hashShopeePassword,
  usableMerchants, resolveSingleMerchant, normalizeMerchant
} = require('../../src/providers/shopeepay/auth');

// ── phone parsing: accepts every Indonesian shape ──
test('parseIdMobile: 0812xxx -> e164 62812xxx', () => {
  assert.equal(parseIdMobile('08123456789').e164, '628123456789');
});
test('parseIdMobile: +62 form', () => {
  assert.equal(parseIdMobile('+62 812 345 6789').e164, '628123456789');
});
test('parseIdMobile: bare 8… form', () => {
  assert.equal(parseIdMobile('8123456789').e164, '628123456789');
});
test('parseIdMobile: 0062 form', () => {
  assert.equal(parseIdMobile('0062 8123456789').e164, '628123456789');
});
test('parseIdMobile: dots and dashes stripped', () => {
  assert.equal(parseIdMobile('0812-345.6789').e164, '628123456789');
});
test('parseIdMobile: national form prefixed 0', () => {
  assert.equal(parseIdMobile('08123456789').national, '08123456789');
});
test('parseIdMobile: rejects landline (does not start with 8)', () => {
  assert.throws(() => parseIdMobile('0211234567'), /HP Indonesia/);
});
test('parseIdMobile: rejects too-short mobile', () => {
  assert.throws(() => parseIdMobile('0812'), /HP Indonesia/);
});
test('parseIdMobile: rejects too-long mobile', () => {
  assert.throws(() => parseIdMobile('08123456789012345'), /HP Indonesia/);
});
test('parseIdMobile: rejects empty', () => {
  assert.throws(() => parseIdMobile(''), /HP Indonesia/);
});

// ── phone formatting for verify_otp: "(+62) 897 7110 640" ──
test('formatPhoneForVerification: e164 -> (+62) NNN NNNN NNNN', () => {
  assert.equal(formatPhoneForVerification('628977110640'), '(+62) 897 7110 640');
});
test('formatPhoneForVerification: short number still groups cleanly', () => {
  assert.equal(formatPhoneForVerification('628123456789'), '(+62) 812 3456 789');
});

// ── password wire transform: sha256Hex(md5Hex(password)) ──
test('hashShopeePassword: matches known sha256(md5()) composition', () => {
  const crypto = require('crypto');
  const pw = 'secret123';
  const expected = crypto.createHash('sha256').update(crypto.createHash('md5').update(pw, 'utf8').digest('hex'), 'utf8').digest('hex');
  assert.equal(hashShopeePassword(pw), expected);
});
test('hashShopeePassword: deterministic (same input same output)', () => {
  assert.equal(hashShopeePassword('abc'), hashShopeePassword('abc'));
});
test('hashShopeePassword: empty string hashes (never throws)', () => {
  assert.equal(typeof hashShopeePassword(''), 'string');
  assert.equal(hashShopeePassword('').length, 64);
});

// ── merchant helpers ──
const M = [
  { id: '1', name: 'A', is_active: true, is_banned: false, is_current_login_user: true },
  { id: '2', name: 'B', is_active: true, is_banned: false, is_current_login_user: false },
  { id: '3', name: 'C-banned', is_active: true, is_banned: true, is_current_login_user: false },
  { id: '4', name: 'D-inactive', is_active: false, is_banned: false, is_current_login_user: false }
];

test('usableMerchants: keeps active & not banned', () => {
  assert.deepEqual(usableMerchants(M).map((m) => m.id), ['1', '2']);
});

test('resolveSingleMerchant: prefers current-login user', () => {
  assert.equal(resolveSingleMerchant(M).id, '1');
});
test('resolveSingleMerchant: null when ambiguous (no current, >1 usable)', () => {
  const noCurrent = [
    { id: '2', name: 'B', is_active: true, is_banned: false, is_current_login_user: false },
    { id: '5', name: 'E', is_active: true, is_banned: false, is_current_login_user: false }
  ];
  assert.equal(resolveSingleMerchant(noCurrent), null);
});
test('resolveSingleMerchant: sole usable merchant picked without human', () => {
  assert.equal(resolveSingleMerchant([{ id: '9', name: 'solo', is_active: true, is_banned: false }]).id, '9');
});
test('resolveSingleMerchant: empty list -> null', () => {
  assert.equal(resolveSingleMerchant([]), null);
});

test('normalizeMerchant: maps wire names to session shape', () => {
  const raw = { merchantId: 456, staffTobUid: 789, merchantName: 'My Shop', isActive: true, isBanned: false, isCurrentLoginUser: false, merchantStatus: 1 };
  const m = normalizeMerchant(raw);
  assert.equal(m.id, '456');
  assert.equal(m.name, 'My Shop');
  assert.equal(m.staff_user_id, 789);
  assert.equal(m.is_active, true);
  assert.equal(m.is_banned, false);
});
test('normalizeMerchant: rejects non-numeric ids', () => {
  assert.equal(normalizeMerchant({ merchantId: '456', staffTobUid: 789 }), null);
});
test('normalizeMerchant: rejects missing staff id', () => {
  assert.equal(normalizeMerchant({ merchantId: 456 }), null);
});
test('normalizeMerchant: null for non-object', () => {
  assert.equal(normalizeMerchant(null), null);
});
