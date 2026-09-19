'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeBatch, normalizeTx, minorToRupiah, txAmountMinor } = require('../../src/providers/gopay/normalize');

test('minorToRupiah: 10600000 sen -> Rp 106000', () => {
  assert.strictEqual(minorToRupiah(10600000), 106000);
  assert.strictEqual(minorToRupiah(40966200), 409662);
});

test('normalize: gross_amount (minor units) -> whole rupiah int', () => {
  const tx = normalizeTx({ id: 'TX1', gross_amount: 1000000, transaction_time: '2026-09-19T10:00:00Z', status: 'SETTLEMENT' });
  assert.strictEqual(tx.amount_idr, 10000); // 1000000 sen = Rp 10.000
  assert.strictEqual(tx.txId, 'TX1');
  assert.strictEqual(tx.completed, true);
  assert.ok(tx.create_time_ms > 0);
});

test('normalize: real_gross_amount fallback', () => {
  const tx = normalizeTx({ id: 'TX2', real_gross_amount: 40966200, transaction_time: '2026-09-19T10:00:00Z', status: 'CAPTURE' });
  assert.strictEqual(tx.amount_idr, 409662);
});

test('normalize: amount.value object form', () => {
  const tx = normalizeTx({ id: 'TX3', amount: { value: 500000 }, transaction_time: '2026-09-19T10:00:00Z', status: 'SETTLEMENT' });
  assert.strictEqual(tx.amount_idr, 5000);
});

test('normalize: skips malformed rows (no id, no amount, bad time)', () => {
  assert.strictEqual(normalizeTx({ gross_amount: 1000 }), null); // no id
  assert.strictEqual(normalizeTx({ id: 'X', transaction_time: 'x' }), null); // no amount
  assert.strictEqual(normalizeTx({ id: 'X', gross_amount: 1000, transaction_time: 'not-a-date' }), null); // bad time
});

test('normalize: completed only for SETTLEMENT/CAPTURE (or empty status)', () => {
  assert.strictEqual(normalizeTx({ id: 'A', gross_amount: 100, transaction_time: '2026-09-19T10:00:00Z', status: 'SETTLEMENT' }).completed, true);
  assert.strictEqual(normalizeTx({ id: 'B', gross_amount: 100, transaction_time: '2026-09-19T10:00:00Z', status: 'REFUND' }).completed, false);
  assert.strictEqual(normalizeTx({ id: 'C', gross_amount: 100, transaction_time: '2026-09-19T10:00:00Z' }).completed, true); // empty status ok
});

test('normalizeBatch: skips malformed, keeps valid', () => {
  const out = normalizeBatch([
    { id: 'OK', gross_amount: 1000, transaction_time: '2026-09-19T10:00:00Z', status: 'SETTLEMENT' },
    { gross_amount: 999 }, // no id
    'not-an-object'
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].txId, 'OK');
  assert.strictEqual(out[0].amount_idr, 10);
});
