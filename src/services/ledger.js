'use strict';
// Ledger: race-safe running balance via FOR UPDATE inside db.tx.
// credit (payment settle), debit_hold (withdraw request), debit_settled (withdraw processed),
// credit_back (withdraw rejected). amount units = whole rupiah (int).
const db = require('../db');
const { logActivity } = require('./logs');

class LedgerError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

const toMysql = (d) => new Date(d).toISOString().slice(0, 23).replace('T', ' ');

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

/** Credit a payment into HELD (not yet withdrawable) and schedule its release.
 * Used for H+1 settlement: the money is recorded immediately so the balance
 * matches the provider, but stays locked until release_at.
 *
 * Locks the same FOR UPDATE rows as withdraw (user_balances) so a concurrent
 * withdraw can never claim funds that are still on hold. */
async function creditHeld(userId, amount, { refType = 'invoice', refId = null, releaseAt } = {}) {
  const amt = Math.trunc(Number(amount));
  if (!(amt > 0)) throw new LedgerError('amount harus > 0', 400, 'INVALID_AMOUNT');
  const rel = new Date(releaseAt);
  if (!(rel.getTime() > Date.now())) throw new LedgerError('releaseAt harus di masa depan', 400, 'INVALID_RELEASE_AT');
  return db.tx(async (q) => {
    await ensureRow(q, userId);
    const rows = await q('SELECT balance, held FROM user_balances WHERE user_id = ? FOR UPDATE', [userId]);
    const balance = Number(rows[0].balance); const held = Number(rows[0].held);
    // Idempotency: skip if this invoice was already held.
    if (refId) {
      const dup = await q('SELECT id FROM settlement_holds WHERE invoice_id = ? LIMIT 1', [String(refId)]);
      if (dup && dup.length) return { balance, held, available: balance - held, duplicated: true };
    }
    const newHeld = held + amt;
    await q('UPDATE user_balances SET held = ? WHERE user_id = ?', [newHeld, userId]);
    await q('INSERT INTO settlement_holds (user_id, invoice_id, amount, release_at) VALUES (?,?,?,?)',
      [userId, refId ? String(refId) : null, amt, toMysql(rel)]);
    await q('INSERT INTO ledger_entries (user_id, type, amount, ref_type, ref_id, balance_after) VALUES (?,?,?,?,?,?)',
      [userId, 'credit', amt, refType, refId ? String(refId) : null, balance]);
    logActivity(userId, 'SUCCESS', `Saldo +Rp ${amt} (${refType}${refId ? ' ' + refId : ''}) — HOLD H+1 sampai ${rel.toISOString()} -> held Rp ${newHeld}`);
    return { balance, held: newHeld, available: balance - newHeld, duplicated: false };
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

/**
 * Release settlement holds.
 *  - mode='due' (default): only holds whose release_at has passed (H+1 rule).
 *  - mode='all': release every unreleased hold regardless of age. Used by the
 *    daily 17:00 WIB sweep, so we instead delete the release_at gate entirely
 *    by treating all unreleased holds as eligible.
 *
 * Each hold is released inside its own FOR UPDATE transaction, so a concurrent
 * tick or a manual admin release cannot double-release a hold.
 */
async function releaseDueHolds({ limit = 200, mode = 'due' } = {}) {
  const lim = Math.min(1000, Math.max(1, Number(limit) || 200));
  const where = mode === 'all' ? 'released = 0' : 'released = 0 AND release_at <= UTC_TIMESTAMP(3)';
  const due = await db.query(
    `SELECT id, user_id, invoice_id, amount FROM settlement_holds WHERE ${where} ORDER BY release_at ASC LIMIT ?`,
    [lim]
  );
  if (!due.length) return { released_count: 0, total_amount: 0 };
  let releasedCount = 0; let totalAmount = 0;
  for (const h of due) {
    const amt = Number(h.amount);
    const ok = await db.tx(async (q) => {
      // Lock the hold row; re-check unreleased (guards concurrent ticks).
      const rows = await q('SELECT released FROM settlement_holds WHERE id = ? FOR UPDATE', [h.id]);
      if (!rows[0] || Number(rows[0].released) !== 0) return false;
      const ub = await q('SELECT balance, held FROM user_balances WHERE user_id = ? FOR UPDATE', [h.user_id]);
      const balance = Number(ub[0]?.balance || 0);
      const held = Number(ub[0]?.held || 0);
      // Never let held go negative (withdrawals can consume it in the meantime).
      const newHeld = Math.max(0, held - amt);
      const newBalance = balance + (held - newHeld);
      await q('UPDATE user_balances SET balance = ?, held = ? WHERE user_id = ?', [newBalance, newHeld, h.user_id]);
      await q('UPDATE settlement_holds SET released = 1 WHERE id = ?', [h.id]);
      await q('INSERT INTO ledger_entries (user_id, type, amount, ref_type, ref_id, balance_after) VALUES (?,?,?,?,?,?)',
        [h.user_id, 'credit', amt, 'hold_release', h.invoice_id, newBalance]);
      logActivity(h.user_id, 'SUCCESS', `Hold H+1 dirilis +Rp ${amt} (invoice ${h.invoice_id}) -> Rp ${newBalance}`);
      return true;
    }).catch(() => false);
    if (ok) { releasedCount++; totalAmount += amt; }
  }
  return { released_count: releasedCount, total_amount: totalAmount };
}

/** Amount currently locked in settlement holds (informational). */
async function totalHeldForUser(userId) {
  const row = await db.one("SELECT COALESCE(SUM(amount),0) total FROM settlement_holds WHERE user_id = ? AND released = 0", [userId]);
  return Number(row?.total || 0);
}

/** Release a hold immediately (admin override / resync). Idempotent. */
async function releaseHoldNow(invoiceId, { note = null } = {}) {
  const h = await db.one('SELECT id, user_id, amount, released FROM settlement_holds WHERE invoice_id = ?', [invoiceId]);
  if (!h) throw new LedgerError('Hold tidak ditemukan untuk invoice ini', 404, 'HOLD_NOT_FOUND');
  if (Number(h.released) === 1) return { released: false, message: 'Hold sudah dirilis sebelumnya' };
  await db.query('UPDATE settlement_holds SET released = 1 WHERE id = ?', [h.id]);
  // reuse the ledger path: the balance bump happens through releaseDueHolds-like tx
  await db.tx(async (q) => {
    await ensureRow(q, h.user_id);
    const rows = await q('SELECT balance, held FROM user_balances WHERE user_id = ? FOR UPDATE', [h.user_id]);
    const balance = Number(rows[0].balance); const held = Number(rows[0].held);
    const newHeld = Math.max(0, held - Number(h.amount));
    const newBalance = balance + (held - newHeld);
    await q('UPDATE user_balances SET balance = ?, held = ? WHERE user_id = ?', [newBalance, newHeld, h.user_id]);
    await q('INSERT INTO ledger_entries (user_id, type, amount, ref_type, ref_id, balance_after) VALUES (?,?,?,?,?,?)',
      [h.user_id, 'credit', Number(h.amount), 'hold_release', invoiceId, newBalance]);
    logActivity(h.user_id, 'SUCCESS', `Hold H+1 dirilis manual +Rp ${h.amount} (invoice ${invoiceId})${note ? ' — ' + note : ''}`);
  });
  return { released: true, message: 'Hold dirilis' };
}

module.exports = { LedgerError, getBalance, credit, creditHeld, hold, releaseHold, settleDebit, listEntries, releaseDueHolds, totalHeldForUser, releaseHoldNow };
