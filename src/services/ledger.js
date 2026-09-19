'use strict';
// Ledger: race-safe running balance via FOR UPDATE inside db.tx.
// credit (payment settle), debit_hold (withdraw request), debit_settled (withdraw processed),
// credit_back (withdraw rejected). amount units = whole rupiah (int).
const db = require('../db');
const { logActivity } = require('./logs');

class LedgerError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

/** Ensure a user has a balance row (balance=0, held=0). */
async function ensureRow(q, userId) {
  await q('INSERT IGNORE INTO user_balances (user_id, balance, held) VALUES (?,0,0)', [userId]);
}

/** Read current balance snapshot (available = balance - held). */
async function getBalance(userId) {
  const row = await db.one('SELECT balance, held, updated_at FROM user_balances WHERE user_id = ?', [userId]);
  if (!row) return { balance: 0, held: 0, available: 0, updated_at: null };
  return { balance: Number(row.balance), held: Number(row.held), available: Number(row.balance) - Number(row.held), updated_at: row.updated_at };
}

/** Credit a user on payment settle. Idempotent by ref (skips if a ledger entry with same ref_type+ref_id exists). */
async function credit(userId, amount, { refType = 'invoice', refId = null } = {}) {
  const amt = Math.trunc(Number(amount));
  if (!(amt > 0)) throw new LedgerError('amount harus > 0', 400, 'INVALID_AMOUNT');
  return db.tx(async (q) => {
    await ensureRow(q, userId);
    const rows = await q('SELECT balance, held FROM user_balances WHERE user_id = ? FOR UPDATE', [userId]);
    // Idempotency: skip if this invoice already credited.
    if (refId) {
      const dup = await q('SELECT id FROM ledger_entries WHERE user_id = ? AND type = ? AND ref_type = ? AND ref_id = ? LIMIT 1', [userId, 'credit', refType, String(refId)]);
      if (dup && dup.length) return { balance: Number(rows[0].balance), held: Number(rows[0].held), available: Number(rows[0].balance) - Number(rows[0].held), duplicated: true };
    }
    const newBalance = Number(rows[0].balance) + amt;
    await q('UPDATE user_balances SET balance = ? WHERE user_id = ?', [newBalance, userId]);
    await q('INSERT INTO ledger_entries (user_id, type, amount, ref_type, ref_id, balance_after) VALUES (?,?,?,?,?,?)',
      [userId, 'credit', amt, refType, refId ? String(refId) : null, newBalance]);
    logActivity(userId, 'SUCCESS', `Saldo +Rp ${amt} (${refType}${refId ? ' ' + refId : ''}) -> Rp ${newBalance}`);
    return { balance: newBalance, held: Number(rows[0].held), available: newBalance - Number(rows[0].held), duplicated: false };
  });
}

/** Hold amount for a withdrawal request (inside the withdraw transaction). Called by withdrawals.request. */
async function hold(userId, amount, { refType = 'withdrawal', refId = null } = {}) {
  const amt = Math.trunc(Number(amount));
  if (!(amt > 0)) throw new LedgerError('amount harus > 0', 400, 'INVALID_AMOUNT');
  return db.tx(async (q) => {
    await ensureRow(q, userId);
    const rows = await q('SELECT balance, held FROM user_balances WHERE user_id = ? FOR UPDATE', [userId]);
    const balance = Number(rows[0].balance); const held = Number(rows[0].held);
    const available = balance - held;
    if (available < amt) throw new LedgerError('Saldo tidak mencukupi', 400, 'INSUFFICIENT_BALANCE');
    const newHeld = held + amt;
    await q('UPDATE user_balances SET held = ? WHERE user_id = ?', [newHeld, userId]);
    await q('INSERT INTO ledger_entries (user_id, type, amount, ref_type, ref_id, balance_after) VALUES (?,?,?,?,?,?)',
      [userId, 'debit_hold', amt, refType, refId ? String(refId) : null, balance]);
    return { balance, held: newHeld, available: balance - newHeld };
  });
}

/** Release a hold back to balance (withdrawal rejected/cancelled). */
async function releaseHold(userId, amount, { refType = 'withdrawal', refId = null } = {}) {
  const amt = Math.trunc(Number(amount));
  if (!(amt > 0)) throw new LedgerError('amount harus > 0', 400, 'INVALID_AMOUNT');
  return db.tx(async (q) => {
    const rows = await q('SELECT balance, held FROM user_balances WHERE user_id = ? FOR UPDATE', [userId]);
    const balance = Number(rows[0].balance);
    const newHeld = Math.max(0, Number(rows[0].held) - amt);
    await q('UPDATE user_balances SET held = ? WHERE user_id = ?', [newHeld, userId]);
    await q('INSERT INTO ledger_entries (user_id, type, amount, ref_type, ref_id, balance_after) VALUES (?,?,?,?,?,?)',
      [userId, 'credit_back', amt, refType, refId ? String(refId) : null, balance]);
    return { balance, held: newHeld, available: balance - newHeld };
  });
}

/** Settle a held withdrawal: move from held to a real debit (balance drops). */
async function settleDebit(userId, amount, { refType = 'withdrawal', refId = null } = {}) {
  const amt = Math.trunc(Number(amount));
  if (!(amt > 0)) throw new LedgerError('amount harus > 0', 400, 'INVALID_AMOUNT');
  return db.tx(async (q) => {
    const rows = await q('SELECT balance, held FROM user_balances WHERE user_id = ? FOR UPDATE', [userId]);
    const balance = Number(rows[0].balance);
    const held = Number(rows[0].held);
    const newHeld = Math.max(0, held - amt);
    const newBalance = balance - amt;
    await q('UPDATE user_balances SET balance = ?, held = ? WHERE user_id = ?', [newBalance, newHeld, userId]);
    await q('INSERT INTO ledger_entries (user_id, type, amount, ref_type, ref_id, balance_after) VALUES (?,?,?,?,?,?)',
      [userId, 'debit_settled', amt, refType, refId ? String(refId) : null, newBalance]);
    logActivity(userId, 'SUCCESS', `Withdrawal diproses -Rp ${amt} -> Rp ${newBalance}`);
    return { balance: newBalance, held: newHeld, available: newBalance - newHeld };
  });
}

/** List ledger entries for a user (audit trail). */
async function listEntries(userId, { limit = 50 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 50));
  return db.query(`SELECT id, type, amount, ref_type, ref_id, balance_after, created_at FROM ledger_entries WHERE user_id = ? ORDER BY id DESC LIMIT ${lim}`, [userId]);
}

module.exports = { LedgerError, getBalance, credit, hold, releaseHold, settleDebit, listEntries };
