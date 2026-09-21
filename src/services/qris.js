'use strict';
// QRIS service: status polling + public view — thin wrapper over invoices + payments.
// checkStatus(invoiceId): if PAID return; if EXPIRED return; else fetch provider mutasi and try settle.
const db = require('../db');
const invoices = require('./invoices');
const payments = require('./payments');
const subscriptions = require('./subscriptions');
const { logActivity } = require('./logs');

class QrisError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

const { providerLabel } = require('../utils/displayNames');

/** Poll status; checks provider mutasi when pending. Returns API-shaped object. */
async function checkStatus(id) {
  const rec = await invoices.getRecord(id);
  if (!rec) throw new QrisError('Invoice tidak ditemukan', 404, 'NOT_FOUND');
  const base = { qris_id: rec.id, reference: rec.reference, attributes: rec.attributes, amount: rec.total_amount, provider: rec.provider, provider_label: providerLabel(rec.provider) };

  if (rec.status === 'PAID') return { ...base, paid: true, status: 'PAID', transaction: rec.transaction };

  if (rec.status === 'EXPIRED' || Date.now() > rec.expires_at.getTime()) {
    if (rec.status !== 'EXPIRED') await invoices.setStatus(id, 'EXPIRED');
    // Grace window: still try to match a late payment.
    const graceMs = require('../config').config.unmatchedGraceMinutes * 60 * 1000;
    if (Date.now() > rec.expires_at.getTime() + graceMs) {
      return { ...base, paid: false, status: 'EXPIRED', message: 'Invoice kadaluarsa' };
    }
  }

  try {
    const settled = await payments.verifyInvoicePayment(rec);
    if (settled) { return { ...base, paid: true, status: 'PAID', transaction: settled }; }
    return { ...base, paid: false, status: 'PENDING', message: 'Belum ada pembayaran' };
  } catch (e) {
    logActivity(rec.user_id, 'WARNING', `Cek status ${id} gagal: ${e.message}`);
    if (e.code === 'NO_SESSION' || e.code === 'SESSION_EXPIRED') {
      return { ...base, paid: false, status: 'PENDING', verification_mode: 'manual', message: 'Provider belum terhubung admin' };
    }
    return { ...base, paid: false, status: 'PENDING', message: 'Verifikasi tertunda (provider tidak merespons)' };
  }
}

module.exports = { QrisError, checkStatus };
