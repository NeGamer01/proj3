'use strict';
// Payment settlement: matches a mutation to an invoice, settles it, and runs side effects
// (ledger credit for kind=api, subscription settle for kind=subscription, webhook dispatch).
const db = require('../db');
const invoices = require('./invoices');
const ledger = require('./ledger');
const matching = require('./matching');
const subscriptions = require('./subscriptions');
const webhooks = require('./webhooks');
const providers = require('../providers');
const { logActivity } = require('./logs');
const { config } = require('../config');

class PaymentError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

/** H+1 hold duration in hours (a paid H1 settlement becomes withdrawable after this). */
const H1_HOLD_HOURS = 24;

/**
 * Is this invoice's settlement H+1 (must be held)? Settlement speed follows the
 * user's tier at the time of settlement, not the provider that carried it:
 * an unsubscribed user always gets H+1 even when the QR was drawn from gopay.
 */
async function isInvoiceH1(rec) {
  // The invoice's own provider is the strongest signal: it was routed by the
  // user's tier at creation time (channelRouter.pickProvider only hands out
  // gopay to realtime-entitled users).
  if (rec.provider === 'gopay') return false;
  // shopeepay is H+1 for everyone, including admins (the operator settles it
  // next business day regardless).
  if (rec.provider === 'shopeepay') return true;
  // Unknown / future providers: hold them too. Safe default — an unknown
  // channel has no realtime guarantee, so the funds should not be withdrawable
  // until an operator reviews them.
  return true;
}

/** Build a normalized transaction record for storage/display. */
function toTransaction(tx, provider, totalAmount) {
  return {
    transaction_id: String(tx.txId),
    provider,
    amount: totalAmount,
    create_time: new Date(tx.create_time_ms).toISOString(),
    completed: Boolean(tx.completed),
    raw: tx.raw || {}
  };
}

/** Settle a matched invoice: mark PAID, credit ledger / settle subscription, fire webhook. Idempotent. */
async function settle(invoice, tx) {
  const rec = await invoices.getRecord(invoice.id);
  if (!rec) return null;
  if (rec.status === 'PAID') return rec.transaction;

  const transaction = toTransaction(tx, rec.provider, rec.total_amount);
  await invoices.setStatus(rec.id, 'PAID', transaction);
  logActivity(rec.user_id, 'SUCCESS', `Invoice ${rec.id} LUNAS Rp ${rec.total_amount} (${rec.provider})`);

  // Side effects by kind.
  if (rec.kind === 'subscription' && rec.reference) {
    await subscriptions.settleOrder(rec.reference).catch((e) => logActivity(rec.user_id, 'ERROR', `Settle order ${rec.reference} gagal: ${e.message}`));
  } else {
    // kind = 'api' | 'test': credit the base_amount to the user's ledger
    // (unique code stays as operator fee). Settlement speed follows the tier:
    // H0 (realtime) lands directly in the balance; H1 (free) goes into HELD
    // and only becomes withdrawable after the H+1 delay (see ledger.releaseDueHolds).
    const isH1 = await isInvoiceH1(rec);
    if (isH1) {
      const releaseAt = new Date(Date.now() + H1_HOLD_HOURS * 3600000);
      await ledger.creditHeld(rec.user_id, rec.base_amount, { refType: 'invoice', refId: rec.id, releaseAt })
        .catch((e) => logActivity(rec.user_id, 'ERROR', `Hold credit ${rec.id} gagal: ${e.message}`));
    } else {
      await ledger.credit(rec.user_id, rec.base_amount, { refType: 'invoice', refId: rec.id }).catch((e) => logActivity(rec.user_id, 'ERROR', `Ledger credit ${rec.id} gagal: ${e.message}`));
    }
  }

  // Webhook + callback (best-effort).
  // Public webhook payload must never leak the internal provider name — bots
  // integrate against "QRIS" / settlement speed, not gopay/shopeepay.
  const publicData = { transaction, qris_id: rec.id, amount: rec.total_amount, base_amount: rec.base_amount };
  webhooks.dispatchWebhookEvent(rec.user_id, 'payment.success', publicData).catch(() => {});
  if (rec.callback_url) {
    const axios = require('axios');
    axios.post(rec.callback_url, { event: 'payment.success', qris_id: rec.id, reference: rec.reference, amount: rec.total_amount, transaction }, { timeout: 8000 }).catch(() => {});
  }
  return transaction;
}

/** Mark an invoice paid manually (admin). No provider mutation involved. */
async function manualMarkPaid(userId, id, role, by = 'manual') {
  const rec = await invoices.getRecord(id);
  if (!rec || (rec.user_id !== userId && role !== 'admin')) throw new PaymentError('Invoice tidak ditemukan', 404, 'NOT_FOUND');
  if (rec.status === 'PAID') return rec.transaction;
  const trx = { transaction_id: 'MANUAL-' + Date.now(), provider: rec.provider, amount: rec.total_amount, create_time: new Date().toISOString(), completed: true, raw: { by, source: 'manual' } };
  await invoices.setStatus(rec.id, 'PAID', trx);
  logActivity(rec.user_id, 'SUCCESS', `Invoice ${rec.id} ditandai lunas manual oleh ${by}`);
  if (rec.kind === 'subscription' && rec.reference) {
    await subscriptions.settleOrder(rec.reference).catch((e) => logActivity(rec.user_id, 'ERROR', `Settle order ${rec.reference} gagal: ${e.message}`));
  } else {
    // Same tier rule as settle(): H1 lands in HELD, H0 in the balance.
    if (await isInvoiceH1(rec)) {
      const releaseAt = new Date(Date.now() + H1_HOLD_HOURS * 3600000);
      await ledger.creditHeld(rec.user_id, rec.base_amount, { refType: 'invoice', refId: rec.id, releaseAt }).catch((e) => logActivity(rec.user_id, 'ERROR', `Hold credit ${rec.id} gagal: ${e.message}`));
    } else {
      await ledger.credit(rec.user_id, rec.base_amount, { refType: 'invoice', refId: rec.id }).catch((e) => logActivity(rec.user_id, 'ERROR', `Ledger credit ${rec.id} gagal: ${e.message}`));
    }
  }
  return trx;
}

/** Lazy verify: fetch provider mutasi for one invoice's provider and try to settle it.
 *  Triggered by GET /qris/:id/status. Returns the settle result or null. */
async function verifyInvoicePayment(invoice) {
  const provider = providers.getProvider(invoice.provider);
  if (!providers.isImplemented(invoice.provider)) return null;
  const startMs = invoice.created_at.getTime() - config.mutasiLookbackMinutes * 60 * 1000;
  const mutations = await provider.fetchRecentMutasi({ startTimeMs: startMs });
  const pending = [invoice];
  const matches = await matching.matchMutations(invoice.provider, mutations, pending);
  if (matches.length) {
    return settle(invoice, matches[0].tx);
  }
  return null;
}

/** Release a pending H+1 hold immediately (admin override). */
async function listPendingHolds({ limit = 100 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  return db.query(
    `SELECT h.id, h.user_id, u.email, h.invoice_id, h.amount, h.release_at, h.created_at
     FROM settlement_holds h JOIN users u ON u.id = h.user_id
     WHERE h.released = 0 ORDER BY h.release_at ASC LIMIT ?`, [lim]
  );
}

module.exports = { PaymentError, settle, manualMarkPaid, verifyInvoicePayment, toTransaction, isInvoiceH1, listPendingHolds };
