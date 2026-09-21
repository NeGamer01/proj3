'use strict';
// ShopeePay unit tests: money parsing, transaction normalization, client envelope.
// Ported logic from QrisMerchantID/shopee (money.py, transactions.py, client.py).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseIdAmount } = require('../../src/providers/shopeepay/money');
const { listRecent } = require('../../src/providers/shopeepay/transactions');
const { ShopeePayClient, ShopeePayError } = require('../../src/providers/shopeepay/client');

// ── money: grouped strings are WHOLE rupiah, not minor units ──
test('parseIdAmount: grouped string "409.662" -> 409662', () => {
  assert.equal(parseIdAmount('409.662'), 409662);
});
test('parseIdAmount: plain digits "1000" -> 1000', () => {
  assert.equal(parseIdAmount('1000'), 1000);
});
test('parseIdAmount: single digit "0" -> 0', () => {
  assert.equal(parseIdAmount('0'), 0);
});
test('parseIdAmount: Indonesian grouping max shape -> 1.234.567.890', () => {
  assert.equal(parseIdAmount('1.234.567.890'), 1234567890);
});
test('parseIdAmount: rejects comma decimals (would be wrong money)', () => {
  assert.equal(parseIdAmount('409,66'), null);
});
test('parseIdAmount: rejects decimal point as separator "409.5" (not .ddd grouping)', () => {
  assert.equal(parseIdAmount('409.5'), null);
});
test('parseIdAmount: rejects signs', () => {
  assert.equal(parseIdAmount('-1000'), null);
});
test('parseIdAmount: rejects letters', () => {
  assert.equal(parseIdAmount('Rp 1.000'), null);
});
test('parseIdAmount: rejects inner whitespace', () => {
  assert.equal(parseIdAmount('1 000'), null);
});
test('parseIdAmount: null/undefined/number input -> null or coerced', () => {
  assert.equal(parseIdAmount(null), null);
  assert.equal(parseIdAmount(undefined), null);
  assert.equal(parseIdAmount(409662), 409662); // numbers pass through _PLAIN
});

// ── transactions: normalization drops bad rows, never guesses ──
function fakeClient(responder) {
  const c = new ShopeePayClient({ token: 'B:fake' });
  c.postPayment = async (path, data) => responder(path, data);
  return c;
}

test('listRecent: normalizes a completed row to NormalizedTx', async () => {
  const client = fakeClient(() => ({
    list: [{
      transactionId: 'TX-1', amount: '5.000', createTime: 1700000000,
      storeId: 123, merchantId: 456, status: 3,
      externalTransactionId: 'ORD-1', service: 3
    }],
    next_position: ''
  }));
  const r = await listRecent(client, '123', { minutes: 60 });
  assert.equal(r.transactions.length, 1);
  const tx = r.transactions[0];
  assert.equal(tx.txId, 'TX-1');
  assert.equal(tx.amount_idr, 5000);
  assert.equal(tx.completed, true);
  assert.equal(tx.create_time_ms, 1700000000000);
  assert.equal(tx.raw._order_id, 'ORD-1');
});

test('listRecent: non-completed status is not completed', async () => {
  const client = fakeClient(() => ({
    list: [{ transactionId: 'TX-2', amount: '10.000', createTime: 1700000000, storeId: 1, status: 1 }],
    next_position: ''
  }));
  const r = await listRecent(client, '1', { minutes: 60 });
  assert.equal(r.transactions[0].completed, false);
});

test('listRecent: drops rows from other stores (scope check)', async () => {
  const client = fakeClient(() => ({
    list: [{ transactionId: 'TX-3', amount: '10.000', createTime: 1700000000, storeId: 999, status: 3 }],
    next_position: ''
  }));
  const r = await listRecent(client, '1', { minutes: 60 });
  assert.equal(r.transactions.length, 0);
});

test('listRecent: skips malformed amount (commas)', async () => {
  const client = fakeClient(() => ({
    list: [{ transactionId: 'TX-4', amount: '10,00', createTime: 1700000000, storeId: 1, status: 3 }],
    next_position: ''
  }));
  const r = await listRecent(client, '1', { minutes: 60 });
  assert.equal(r.transactions.length, 0);
});

test('listRecent: skips missing transactionId', async () => {
  const client = fakeClient(() => ({
    list: [{ amount: '10.000', createTime: 1700000000, storeId: 1, status: 3 }],
    next_position: ''
  }));
  const r = await listRecent(client, '1', { minutes: 60 });
  assert.equal(r.transactions.length, 0);
});

test('listRecent: rejects reversed time range', async () => {
  const client = fakeClient(() => ({ list: [], next_position: '' }));
  await assert.rejects(() => listRecent(client, '1', { startTime: 200, endTime: 100 }), ShopeePayError);
});

test('listRecent: cursor pagination stops at empty next_position', async () => {
  let calls = 0;
  const client = fakeClient(() => {
    calls++;
    return { list: [{ transactionId: 'TX-' + calls, amount: '1.000', createTime: 1700000000, storeId: 1, status: 3 }], next_position: '' };
  });
  const r = await listRecent(client, '1', { minutes: 60 });
  assert.equal(calls, 1);
  assert.equal(r.pagesFetched, 1);
  assert.equal(r.truncated, false);
});

test('listRecent: dedupes by transactionId across pages', async () => {
  const pages = [
    { list: [{ transactionId: 'DUP', amount: '1.000', createTime: 1700000000, storeId: 1, status: 3 }], next_position: 'p2' },
    { list: [{ transactionId: 'DUP', amount: '1.000', createTime: 1700000000, storeId: 1, status: 3 }], next_position: '' }
  ];
  let i = 0;
  const client = fakeClient(() => pages[i++]);
  const r = await listRecent(client, '1', { minutes: 60 });
  assert.equal(r.transactions.length, 1);
});

// ── client: payment envelope {code,msg,data}, token in body not header ──
test('client: paymentMetadata carries token, X-Token header empty', () => {
  const c = new ShopeePayClient({ token: 'B:abc' });
  assert.equal(c.paymentMetadata().token, 'B:abc');
  assert.equal(c.paymentHeaders()['X-Token'], '');
});
test('client: postPayment throws when no token set', async () => {
  const c = new ShopeePayClient({});
  await assert.rejects(() => c.postPayment('/x', {}), (e) => e.code === 'NO_TOKEN');
});
test('client: unwraps {code:0, msg, data} on success', async () => {
  const c = new ShopeePayClient({ token: 'B:abc' });
  c.postPayment = async () => {}; // not used
  const out = c._handleResponse(200, { code: 0, msg: 'ok', data: { list: [1, 2] } }, '/x');
  assert.deepEqual(out, { list: [1, 2] });
});
test('client: maps code!=0 to ShopeePayError with code string', () => {
  const c = new ShopeePayClient({ token: 'B:abc' });
  assert.throws(
    () => c._handleResponse(200, { code: 9, msg: 'bad', data: null }, '/x'),
    (e) => e instanceof ShopeePayError && e.code === '9' && /bad/.test(e.message)
  );
});
test('client: invalid-token code 200020 produces renew hint message', () => {
  const c = new ShopeePayClient({ token: 'B:abc' });
  assert.throws(
    () => c._handleResponse(200, { code: 200020, msg: 'not login', data: null }, '/x'),
    (e) => /fresh B: token/.test(e.message)
  );
});
test('client: invalid JSON body -> INVALID_JSON', () => {
  const c = new ShopeePayClient({ token: 'B:abc' });
  assert.throws(
    () => c._handleResponse(502, 'not json', '/x'),
    (e) => e.code === 'INVALID_JSON'
  );
});
