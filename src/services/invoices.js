'use strict';
// Invoices (was qris in nikipayv2). Pooled model: total_amount = base_amount + unique_code,
// unique code globally unique among PENDING invoices (amount-only matching needs it).
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { generateDynamicQRIS, parseEMVCoTags } = require('../utils/qris');
const { calculateCRC16 } = require('../utils/crc16');
const { providerLabel } = require('../utils/displayNames');
const { logActivity } = require('./logs');

class InvoiceError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

const toMysql = (d) => new Date(d).toISOString().slice(0, 23).replace('T', ' ');
const fromMysql = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);

function isValidStaticQris(payload) {
  try {
    if (!/^\d{4}/.test(payload) || payload.length < 40) return false;
    if (calculateCRC16(payload.slice(0, -4)).toUpperCase() !== payload.slice(-4).toUpperCase()) return false;
    const tags = parseEMVCoTags(payload);
    return tags.some(({ tag, val }) => tag === '00' && val === '01')
      && tags.some(({ tag, val }) => tag === '01' && val === '11')
      && tags.some(({ tag, val }) => tag === '58' && val === 'ID')
      && tags.some(({ tag }) => Number(tag) >= 26 && Number(tag) <= 51)
      && Boolean(generateDynamicQRIS(payload, 1000));
  } catch { return false; }
}

// ── records ──
function rowToRecord(r) {
  return {
    id: r.id, user_id: r.user_id, provider: r.provider, trx_id: r.trx_id,
    base_amount: Number(r.base_amount), unique_code: Number(r.unique_code), total_amount: Number(r.total_amount),
    data: r.data, reference: r.reference, attributes: r.attributes ? JSON.parse(r.attributes) : null,
    callback_url: r.callback_url, kind: r.kind, status: r.status,
    transaction: r.transaction_json ? JSON.parse(r.transaction_json) : null,
    created_at: fromMysql(r.created_at), expires_at: fromMysql(r.expires_at), paid_at: fromMysql(r.paid_at)
  };
}

async function getRecord(id) {
  const r = await db.one('SELECT * FROM invoices WHERE id = ?', [id]);
  return r ? rowToRecord(r) : null;
}

async function setStatus(id, status, transaction = null) {
  await db.query('UPDATE invoices SET status = ?, transaction_json = COALESCE(?, transaction_json), paid_at = CASE WHEN ? = ? THEN UTC_TIMESTAMP(3) ELSE paid_at END WHERE id = ?',
    [status, transaction ? JSON.stringify(transaction) : null, status, 'PAID', id]);
}

function publicView(rec) {
  return {
    qris_id: rec.id, trx_id: rec.trx_id, provider: rec.provider, provider_label: providerLabel(rec.provider), reference: rec.reference,
    attributes: rec.attributes, callback_url: rec.callback_url,
    base_amount: rec.base_amount, unique_code: rec.unique_code, amount: rec.total_amount,
    qris_code: rec.data,
    qris_url: `/qr/${rec.id}`,
    qr_image_url: `/qr/${rec.id}?format=raw`,
    status: rec.status, created_at: rec.created_at.toISOString(), expires_at: rec.expires_at.toISOString(), transaction: rec.transaction
  };
}

/** Allocate a unique code (21-200) so base+code is globally unique among pending invoices of that provider. */
async function allocateUniqueCode(baseAmount, provider) {
  const { min, max } = config.uniqueCode;
  const range = max - min + 1;
  // Gather pending totals for this base amount (any provider) so amount stays globally unique.
  const rows = await db.query('SELECT total_amount FROM invoices WHERE status = ? AND base_amount = ?', ['PENDING', baseAmount]);
  const taken = new Set(rows.map((r) => Number(r.total_amount)));
  // Also consider recently-expired invoices within grace window (to avoid orphan-collision).
  const graceMs = config.unmatchedGraceMinutes * 60 * 1000;
  const graceRows = await db.query('SELECT total_amount FROM invoices WHERE status = ? AND expires_at >= ?', ['EXPIRED', toMysql(new Date(Date.now() - graceMs))]);
  for (const r of graceRows) taken.add(Number(r.total_amount));

  // Random retry to avoid predictable pattern.
  const tried = new Set();
  for (let i = 0; i < Math.min(range, 2 * range); i++) {
    const code = min + crypto.randomInt(range);
    if (tried.has(code)) continue;
    tried.add(code);
    const total = baseAmount + code;
    if (!taken.has(total)) return code;
  }
  // Fallback: scan the whole range linearly.
  for (let code = min; code <= max; code++) {
    const total = baseAmount + code;
    if (!taken.has(total)) return code;
  }
  throw new InvoiceError('Slot kode unik penuh, coba lagi sebentar', 503, 'UNIQUE_CODE_EXHAUSTED');
}

/** Creates a dynamic QRIS invoice for `userId`. Pooled: uses the operator's static QR for the provider. */
async function createInvoice(userId, { amount, provider = 'gopay', reference, attributes, callback_url, kind = 'api', expiryMs = config.qrisExpiryMs, staticQrisOverride = null }) {
  const base = Math.trunc(Number(amount));
  if (!(base > 0)) throw new InvoiceError('amount harus angka lebih dari 0', 400, 'INVALID_AMOUNT');
  if (base > 10000000) throw new InvoiceError('amount melebihi batas QRIS (Rp 10.000.000)', 400, 'AMOUNT_TOO_LARGE');
  let cb = null;
  if (callback_url) {
    try { const u = new URL(String(callback_url)); if (!['http:', 'https:'].includes(u.protocol)) throw 0; cb = u.toString(); } catch { throw new InvoiceError('callback_url harus URL http/https absolut', 400, 'INVALID_CALLBACK'); }
  }
  // Static QR: operator-owned (providerAccounts), unless override (e.g. subscription test).
  const { getStaticQris } = require('./providerAccounts');
  const staticQris = staticQrisOverride || await getStaticQris(provider);
  if (!staticQris || !isValidStaticQris(staticQris)) throw new InvoiceError(`QRIS statis operator untuk ${provider} belum dipasang`, 409, 'STATIC_QRIS_NOT_SET');

  const uniqueCode = await allocateUniqueCode(base, provider);
  const total = base + uniqueCode;
  const code = generateDynamicQRIS(staticQris, total);
  if (!code) throw new InvoiceError('Gagal membuat QRIS dinamis', 500, 'GENERATION_FAILED');

  const id = crypto.randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
  const trxId = 'TRX-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const now = new Date(); const exp = new Date(now.getTime() + expiryMs);
  const attrs = attributes && typeof attributes === 'object' ? JSON.stringify(attributes) : null;
  await db.query(
    'INSERT INTO invoices (id, user_id, provider, trx_id, base_amount, unique_code, total_amount, data, reference, attributes, callback_url, kind, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, userId, provider, trxId, base, uniqueCode, total, code, reference ? String(reference).slice(0, 255) : null, attrs, cb, kind, 'PENDING', toMysql(now), toMysql(exp)]);
  logActivity(userId, 'INFO', `Invoice ${id} dibuat | ${trxId} | ${provider} | Rp ${total} (base ${base}+${uniqueCode})${reference ? ' | ref ' + reference : ''}`);
  const rec = await getRecord(id);
  return { ...publicView(rec), expires_in_seconds: Math.round(expiryMs / 1000) };
}

async function listForUser(userId, { limit = 20, status } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 20));
  const rows = status
    ? await db.query(`SELECT * FROM invoices WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ${lim}`, [userId, status])
    : await db.query(`SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT ${lim}`, [userId]);
  return rows.map((r) => publicView(rowToRecord(r)));
}

/** All pending invoices for a provider (for the background poller). */
async function listPendingForProvider(provider, { includeGraceExpired = true } = {}) {
  if (includeGraceExpired) {
    const graceMs = config.unmatchedGraceMinutes * 60 * 1000;
    const graceFrom = toMysql(new Date(Date.now() - graceMs));
    return db.query(
      `SELECT * FROM invoices WHERE provider = ? AND (status = 'PENDING' OR (status = 'EXPIRED' AND expires_at >= ?)) ORDER BY created_at ASC`,
      [provider, graceFrom]
    ).then((rows) => rows.map(rowToRecord));
  }
  return db.query("SELECT * FROM invoices WHERE provider = ? AND status = 'PENDING' ORDER BY created_at ASC", [provider]).then((rows) => rows.map(rowToRecord));
}

async function countPendingForProvider(provider) {
  const row = await db.one("SELECT COUNT(*) c FROM invoices WHERE provider = ? AND status = 'PENDING'", [provider]);
  return Number(row?.c || 0);
}

async function stats(userId, days = 30) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const scope = userId ? 'AND user_id = ?' : '';
  const args = userId ? [d, userId] : [d];
  const row = await db.one(
    `SELECT COUNT(*) total, SUM(status='PAID') paid, SUM(status='PENDING' AND expires_at > UTC_TIMESTAMP(3)) pending,
            COALESCE(SUM(CASE WHEN status='PAID' THEN base_amount END),0) paid_volume
     FROM invoices WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY) ${scope}`, args);
  const daily = await db.query(
    `SELECT DATE(created_at) day, COUNT(*) total, SUM(status='PAID') paid, COALESCE(SUM(CASE WHEN status='PAID' THEN base_amount END),0) amount
     FROM invoices WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY) ${scope} GROUP BY day ORDER BY day`, args);
  const total = Number(row.total || 0); const paid = Number(row.paid || 0);
  return { range_days: d, total, paid, pending: Number(row.pending || 0), paid_volume: Number(row.paid_volume || 0), conversion_rate: total ? Math.round(paid / total * 1000) / 10 : 0, daily };
}

async function expireStale() {
  const r = await db.query("UPDATE invoices SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < UTC_TIMESTAMP(3)");
  await db.query("UPDATE subscription_orders o JOIN invoices i ON i.id = o.qris_id SET o.status = 'EXPIRED' WHERE o.status = 'PENDING' AND i.status = 'EXPIRED'");
  return r.affectedRows || 0;
}

module.exports = {
  InvoiceError, isValidStaticQris, getRecord, setStatus, publicView,
  createInvoice, listForUser, listPendingForProvider, countPendingForProvider, stats, expireStale, rowToRecord
};
