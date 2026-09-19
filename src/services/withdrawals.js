'use strict';
// Withdrawal requests: user requests (amount held), admin processes (settled) or rejects (released).
const crypto = require('crypto');
const db = require('../db');
const ledger = require('./ledger');
const { logActivity } = require('./logs');

class WithdrawalError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

function toMysql(d) { return new Date(d).toISOString().slice(0, 19).replace('T', ' '); }

/** User requests a withdrawal. Holds the amount atomically. Returns the request. */
async function request(userId, { amount, bank_detail, note = null } = {}) {
  const amt = Math.trunc(Number(amount));
  if (!(amt > 0)) throw new WithdrawalError('amount harus > 0', 400, 'INVALID_AMOUNT');
  if (amt > 50000000) throw new WithdrawalError('amount melebihi batas withdraw (Rp 50.000.000)', 400, 'AMOUNT_TOO_LARGE');
  if (!bank_detail || typeof bank_detail !== 'object') throw new WithdrawalError('bank_detail wajib diisi', 400, 'MISSING_BANK_DETAIL');
  const bank = {
    method: String(bank_detail.method || 'bank').slice(0, 24),
    bank_name: String(bank_detail.bank_name || '').slice(0, 120),
    account_number: String(bank_detail.account_number || '').slice(0, 64),
    account_name: String(bank_detail.account_name || '').slice(0, 120)
  };
  if (!bank.account_number || !bank.account_name) throw new WithdrawalError('account_number & account_name wajib diisi', 400, 'MISSING_BANK_DETAIL');

  const id = 'wd_' + crypto.randomBytes(5).toString('hex');
  // Hold amount (throws INSUFFICIENT_BALANCE if not enough).
  const after = await ledger.hold(userId, amt, { refType: 'withdrawal', refId: id });
  await db.query('INSERT INTO withdrawals (id, user_id, amount, bank_detail, status, note) VALUES (?,?,?,?,?,?)',
    [id, userId, amt, JSON.stringify(bank), 'requested', note ? String(note).slice(0, 255) : null]);
  logActivity(userId, 'INFO', `Withdrawal ${id} diminta Rp ${amt} (held Rp ${after.held})`);
  return { id, amount: amt, bank_detail: bank, status: 'requested', created_at: new Date().toISOString() };
}

async function listForUser(userId, { limit = 20 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 20));
  return db.query(`SELECT id, amount, bank_detail, status, note, created_at, processed_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT ${lim}`, [userId]);
}

async function listAll({ limit = 100, status = null } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  if (status) {
    return db.query(`SELECT w.id, w.user_id, u.email, w.amount, w.bank_detail, w.status, w.note, w.created_at, w.processed_at FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status = ? ORDER BY w.created_at DESC LIMIT ${lim}`, [status]);
  }
  return db.query(`SELECT w.id, w.user_id, u.email, w.amount, w.bank_detail, w.status, w.note, w.created_at, w.processed_at FROM withdrawals w JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC LIMIT ${lim}`);
}

async function getById(id) {
  return db.one('SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?', [id]);
}

/** Admin processes a withdrawal: settle the held debit. Idempotent on status. */
async function process(id, adminEmail = null) {
  return db.tx(async (q) => {
    const rows = await q('SELECT * FROM withdrawals WHERE id = ? FOR UPDATE', [id]);
    const w = rows[0];
    if (!w) throw new WithdrawalError('Withdrawal tidak ditemukan', 404, 'NOT_FOUND');
    if (w.status !== 'requested') return w;
    await ledger.settleDebit(w.user_id, Number(w.amount), { refType: 'withdrawal', refId: id });
    await q("UPDATE withdrawals SET status = 'processed', processed_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
    logActivity(w.user_id, 'SUCCESS', `Withdrawal ${id} diproses${adminEmail ? ' oleh ' + adminEmail : ''}`);
    return getById(id);
  });
}

/** Admin rejects a withdrawal: release the hold back to balance. Idempotent on status. */
async function reject(id, reason = null, adminEmail = null) {
  return db.tx(async (q) => {
    const rows = await q('SELECT * FROM withdrawals WHERE id = ? FOR UPDATE', [id]);
    const w = rows[0];
    if (!w) throw new WithdrawalError('Withdrawal tidak ditemukan', 404, 'NOT_FOUND');
    if (w.status !== 'requested') return w;
    await ledger.releaseHold(w.user_id, Number(w.amount), { refType: 'withdrawal', refId: id });
    await q("UPDATE withdrawals SET status = 'rejected', note = ? WHERE id = ?", [reason ? String(reason).slice(0, 255) : `ditolak${adminEmail ? ' oleh ' + adminEmail : ''}`, id]);
    logActivity(w.user_id, 'WARNING', `Withdrawal ${id} ditolak${reason ? ': ' + reason : ''}`);
    return getById(id);
  });
}

/** User cancels their own pending withdrawal. */
async function cancel(userId, id) {
  return db.tx(async (q) => {
    const rows = await q('SELECT * FROM withdrawals WHERE id = ? AND user_id = ? FOR UPDATE', [id, userId]);
    const w = rows[0];
    if (!w) throw new WithdrawalError('Withdrawal tidak ditemukan', 404, 'NOT_FOUND');
    if (w.status !== 'requested') return w;
    await ledger.releaseHold(userId, Number(w.amount), { refType: 'withdrawal', refId: id });
    await q("UPDATE withdrawals SET status = 'cancelled' WHERE id = ?", [id]);
    logActivity(userId, 'INFO', `Withdrawal ${id} dibatalkan user`);
    return getById(id);
  });
}

module.exports = { WithdrawalError, request, listForUser, listAll, getById, process, reject, cancel };
