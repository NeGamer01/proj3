'use strict';
const crypto = require('crypto');
const db = require('../db');

const PREFIX = 'qp_';
const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');

async function list(userId) {
  return db.query('SELECT id, key_prefix, label, active, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY id DESC', [userId]);
}

/** Returns the plaintext key exactly once. */
async function create(userId, label = null) {
  const count = await db.one('SELECT COUNT(*) c FROM api_keys WHERE user_id = ? AND active = 1', [userId]);
  if (Number(count.c) >= 5) throw Object.assign(new Error('Maksimal 5 API key aktif'), { status: 400, code: 'KEY_LIMIT' });
  const key = PREFIX + crypto.randomBytes(24).toString('hex');
  const r = await db.query('INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES (?,?,?,?)', [userId, hash(key), key.slice(0, 10) + '…', label ? String(label).slice(0, 80) : null]);
  return { id: r.insertId, key, key_prefix: key.slice(0, 10) + '…', label };
}

async function revoke(userId, id) {
  const r = await db.query('UPDATE api_keys SET active = 0 WHERE id = ? AND user_id = ?', [id, userId]);
  return r.affectedRows > 0;
}

/** Resolves a key to its owner + subscription state. */
async function resolve(key) {
  if (!key || typeof key !== 'string' || !key.startsWith(PREFIX)) return null;
  const row = await db.one(
    `SELECT k.id key_id, u.id user_id, u.role, u.status,
            (SELECT MAX(ends_at) FROM subscriptions s WHERE s.user_id = u.id) sub_ends_at
     FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.active = 1`, [hash(key)]);
  if (!row) return null;
  db.query('UPDATE api_keys SET last_used_at = UTC_TIMESTAMP() WHERE id = ?', [row.key_id]).catch(() => {});
  const subActive = row.role === 'admin' || (row.sub_ends_at && new Date(row.sub_ends_at + 'Z').getTime() > Date.now());
  return { key_id: row.key_id, user_id: row.user_id, role: row.role, status: row.status, subscription_active: Boolean(subActive), sub_ends_at: row.sub_ends_at };
}

module.exports = { list, create, revoke, resolve };
