'use strict';
// GoPay mutation normalization: minor units (sen) -> whole rupiah ints.
// GoPay mutasi returns gross_amount in SEN: 10600000 = Rp 106.000 (divide by 100).
// Output NormalizedTx { txId, amount_idr (INT rupiah), create_time_ms, completed, raw }.

/** Extract raw minor-unit amount from a GoPay tx row. Returns null when unparseable. */
function txAmountMinor(tx) {
  let raw;
  if (tx.gross_amount !== undefined) raw = tx.gross_amount;
  else if (tx.real_gross_amount !== undefined) raw = tx.real_gross_amount;
  else if (typeof tx.amount === 'object' && tx.amount?.value) raw = tx.amount.value;
  else raw = tx.amount;
  const n = parseInt(String(raw), 10);
  return isNaN(n) ? null : n;
}

/** Convert GoPay minor units to whole rupiah. 10600000 -> 106000. */
function minorToRupiah(minor) {
  return Math.round(minor / 100);
}

/** Normalize a raw GoPay tx row into NormalizedTx. Returns null if unusable. */
function normalizeTx(tx) {
  const minor = txAmountMinor(tx);
  if (minor === null) return null;
  const amount_idr = minorToRupiah(minor);
  const txId = String(tx.id || tx.order_id || tx.wallstreet_transaction_id || '');
  if (!txId) return null;
  const t = tx.transaction_time || tx.settlement_time || tx.created_at || tx.time;
  const create_time_ms = t ? new Date(String(t)).getTime() : Date.now();
  if (isNaN(create_time_ms)) return null;
  // GoPay statuses that count as completed/paid for our matching.
  const status = String(tx.status || tx.transaction_status || '').toUpperCase();
  const completed = ['SETTLEMENT', 'CAPTURE'].includes(status) || status === '';
  return {
    txId,
    amount_idr,
    create_time_ms,
    completed,
    raw: tx
  };
}

/** Normalize a batch of GoPay raw tx rows. Skips malformed rows (never guessed). */
function normalizeBatch(rows) {
  const out = [];
  for (const tx of Array.isArray(rows) ? rows : []) {
    const n = normalizeTx(tx);
    if (n) out.push(n);
  }
  return out;
}

module.exports = { txAmountMinor, minorToRupiah, normalizeTx, normalizeBatch };
