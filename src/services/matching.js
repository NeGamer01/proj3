'use strict';
// Provider-agnostic matcher: match normalized mutations to pending invoices by amount_idr.
// Idempotency via claimed_transactions PK (provider, tx_id) — prevents a mutation settling two invoices.
// Pooled: amount must be globally unique (guaranteed by invoices.allocateUniqueCode).
const db = require('../db');
const { logActivity } = require('./logs');
const { config } = require('../config');

/**
 * Try to claim a (provider, txId) for an invoice idempotently.
 * Returns true if this tx may settle the invoice (no prior claim, or prior claim is the same invoice).
 * Returns false if the tx was already claimed by a different invoice.
 */
async function tryClaim(provider, txId, qrisId) {
  const existing = await db.one('SELECT qris_id FROM claimed_transactions WHERE provider = ? AND tx_id = ?', [provider, String(txId)]);
  if (!existing) {
    await db.query('INSERT INTO claimed_transactions (provider, tx_id, qris_id, claimed_at) VALUES (?,?,?,?)', [provider, String(txId), qrisId, Date.now()]);
    return true;
  }
  return existing.qris_id === null || existing.qris_id === qrisId;
}

/**
 * Match a batch of normalized mutations against pending invoices of a provider.
 * Returns the list of matches [{ invoice, tx }]. Does NOT settle (caller settles via payments.settle).
 *
 * @param {string} provider
 * @param {NormalizedTx[]} mutations
 * @param {InvoiceRecord[]} pendingInvoices
 */
async function matchMutations(provider, mutations, pendingInvoices) {
  const matches = [];
  if (!mutations.length || !pendingInvoices.length) return matches;

  // Build a map: total_amount -> invoice(s). Use first-match (amounts are globally unique while PENDING).
  const byAmount = new Map();
  for (const inv of pendingInvoices) {
    if (inv.status === 'PAID') continue;
    const totals = byAmount.get(inv.total_amount) || [];
    totals.push(inv);
    byAmount.set(inv.total_amount, totals);
  }

  for (const tx of mutations) {
    if (!tx.completed) continue; // only completed txs match
    const candidates = byAmount.get(tx.amount_idr);
    if (!candidates || !candidates.length) continue;

    for (const inv of candidates) {
      // Time gate: tx must be at or after invoice creation (minus small skew).
      const invCreatedMs = inv.created_at.getTime();
      if (tx.create_time_ms < invCreatedMs - 60 * 1000) continue; // tx predates invoice
      // Grace window: tx may arrive shortly after expiry.
      const expiredAtMs = inv.expires_at.getTime();
      const graceMs = config.unmatchedGraceMinutes * 60 * 1000;
      if (inv.status === 'EXPIRED' && tx.create_time_ms > expiredAtMs + graceMs) continue;

      // Idempotency claim.
      const ok = await tryClaim(provider, tx.txId, inv.id);
      if (!ok) continue; // already claimed by another invoice

      matches.push({ invoice: inv, tx });
      // Remove this invoice from candidates so it isn't matched twice.
      const rest = candidates.filter((c) => c.id !== inv.id);
      if (rest.length) byAmount.set(inv.total_amount, rest); else byAmount.delete(inv.total_amount);
      break;
    }
  }
  return matches;
}

/** Insert an unmatched mutation for admin reconciliation (called when no invoice matched). */
async function recordUnmatched(provider, tx) {
  if (!tx || !tx.completed) return;
  // Skip if there's actually a pending invoice with this amount (race) — caller only calls after a miss.
  const exists = await db.one('SELECT provider FROM unmatched_payments WHERE provider = ? AND tx_id = ?', [provider, String(tx.txId)]);
  if (exists) return;
  await db.query(
    'INSERT IGNORE INTO unmatched_payments (provider, tx_id, amount_idr, create_time, raw_json) VALUES (?,?,?,?,?)',
    [provider, String(tx.txId), tx.amount_idr, tx.create_time_ms ? new Date(tx.create_time_ms).toISOString().slice(0, 23).replace('T', ' ') : null, JSON.stringify(tx.raw || {})]
  );
}

/** Clean claims older than 24h. */
async function cleanOldClaims() {
  const r = await db.query('DELETE FROM claimed_transactions WHERE claimed_at < ?', [Date.now() - 24 * 3600 * 1000]);
  return r.affectedRows || 0;
}

module.exports = { tryClaim, matchMutations, recordUnmatched, cleanOldClaims };
