'use strict';
// Per-user dashboard preferences. Backed by the `user_prefs` table.
// The provider toggle maps the public "QRIS / QRIS Realtime" switch to the
// internal provider names — shopeepay = H+1 (default), gopay = H0 (realtime).
const db = require('../db');

const CHOICES = ['shopeepay', 'gopay'];
const DEFAULT_CHOICE = 'shopeepay';

class PreferenceError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

function isValidChoice(v) { return CHOICES.includes(String(v || '').toLowerCase()); }

/** Current provider choice, or the default if unset. Never throws. */
async function getProviderChoice(userId) {
  if (!userId) return DEFAULT_CHOICE;
  try {
    const row = await db.one('SELECT provider_choice FROM user_prefs WHERE user_id = ?', [userId]);
    return row?.provider_choice || DEFAULT_CHOICE;
  } catch { return DEFAULT_CHOICE; }
}

/** Upsert the choice. Validates the value; throws PreferenceError on invalid input. */
async function setProviderChoice(userId, choice) {
  if (!userId) throw new PreferenceError('User wajib diisi', 400, 'BAD_REQUEST');
  const value = String(choice || '').toLowerCase();
  if (!isValidChoice(value)) throw new PreferenceError('Pilihan provider tidak valid', 400, 'INVALID_PROVIDER_CHOICE');
  await db.query(
    'INSERT INTO user_prefs (user_id, provider_choice) VALUES (?, ?) ON DUPLICATE KEY UPDATE provider_choice = VALUES(provider_choice)',
    [userId, value]
  );
  return value;
}

module.exports = { CHOICES, DEFAULT_CHOICE, PreferenceError, isValidChoice, getProviderChoice, setProviderChoice };
