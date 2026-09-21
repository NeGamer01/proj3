'use strict';
// Transaction feed: cursor-paged get-transaction-list + normalization.
// Ported from QrisMerchantID/shopee/transactions.py (ShopeeTransactionFeed.listRecent).
//
// Epoch-second filters, [1,3] services, createTime descending sort, and
// next_position cursoring with a non-advance guard. Rows are normalized to
// NormalizedTx { txId, amount_idr, create_time_ms, completed, raw } — the
// exact shape PayGateway's matcher expects (same as gopay/normalize.js).
// Only status === 3 counts as completed (the sole completed status observed).
const C = require('./constants');
const { parseIdAmount } = require('./money');
const { ShopeePayError } = require('./client');

/** Fetch recent transactions for a store.
 *  @param client  ShopeePayClient (token already set)
 *  @param storeId store to scope to (rows from other stores are dropped)
 *  @param opts    { merchantId?, minutes?, startTime?, endTime?, pageSize?, maxPages? } (epoch seconds)
 *  @returns { transactions: NormalizedTx[], pagesFetched, truncated } */
async function listRecent(client, storeId, {
  merchantId = null, minutes = 15, startTime = null, endTime = null,
  pageSize = C.TRANSACTION_PAGE_SIZE, maxPages = 20 } = {}
) {
  const end = endTime !== null && endTime !== undefined ? endTime : Math.floor(Date.now() / 1000);
  const start = startTime !== null && startTime !== undefined ? startTime : end - minutes * 60;
  if (start > end) throw new ShopeePayError('Shopee transaction time range is invalid', 400, 'BAD_RANGE');
  const size = Math.min(C.TRANSACTION_PAGE_SIZE, Math.max(1, pageSize));
  const pages = Math.max(1, maxPages);
  const wantStore = String(storeId);
  const wantMerchant = merchantId !== null && merchantId !== undefined ? String(merchantId) : null;

  const transactions = [];
  const seenIds = new Set();
  const cursors = new Set();
  let nextPosition = '';
  let pagesFetched = 0;
  for (let i = 0; i < pages; i++) {
    const data = await client.postPayment(C.ENDPOINT_TRANSACTIONS, {
      pageSize: size,
      filter: { startTime: start, endTime: end, serviceList: [...C.TRANSACTION_SERVICES] },
      sorter: { field: 'createTime', order: 'descend' },
      next_position: nextPosition
    });
    pagesFetched++;
    const rawList = Array.isArray(data?.list) ? data.list : [];
    for (const raw of rawList) {
      const tx = _normalize(raw, wantStore, wantMerchant);
      if (!tx || seenIds.has(tx.txId)) continue;
      seenIds.add(tx.txId);
      transactions.push(tx);
    }
    let cursor = data?.next_position;
    cursor = typeof cursor === 'string' ? cursor : '';
    if (!cursor) {
      return { transactions, pagesFetched, truncated: false };
    }
    if (cursor === nextPosition || cursors.has(cursor)) {
      throw new ShopeePayError('Shopee transaction cursor did not advance', 502, 'CURSOR_STUCK');
    }
    cursors.add(cursor);
    nextPosition = cursor;
  }
  return { transactions, pagesFetched, truncated: Boolean(nextPosition) };
}

/** Fetch one transaction's detail row — the only issuer source.
 *  order_sn is the row's displayTransactionId (falling back to transactionId);
 *  the answer lives at data.issuer (e.g. "SeaBank", "OVO"). */
async function transactionDetail(client, orderSn) {
  if (typeof orderSn !== 'string' || !orderSn.trim()) {
    throw new ShopeePayError('Shopee transaction_detail needs a non-blank order_sn', 400, 'BAD_ORDER_SN');
  }
  const data = await client.postPayment(C.ENDPOINT_TRANSACTION_DETAIL, { order_sn: orderSn });
  return { order_sn: orderSn, issuer: typeof data?.issuer === 'string' ? data.issuer : null, raw: data };
}

/** Normalize a raw Shopee tx row into NormalizedTx. Returns null if unusable. */
function _normalize(raw, wantStore, wantMerchant) {
  if (!raw || typeof raw !== 'object') return null;
  const txId = typeof raw.transactionId === 'string' ? raw.transactionId.trim() : '';
  const amountRaw = raw.amount;
  const amount = typeof amountRaw === 'string' ? parseIdAmount(amountRaw) : null;
  const created = raw.createTime;
  const moment = (typeof created === 'number' && Number.isFinite(created)) ? created : null;
  if (!txId || amount === null || moment === null) return null;
  const create_time_ms = Math.floor(moment * 1000);
  if (isNaN(create_time_ms)) return null;
  if (String(raw.storeId) !== wantStore) return null;
  const merchantId = String(raw.merchantId);
  if (wantMerchant !== null && merchantId !== wantMerchant) return null;
  const status = (typeof raw.status === 'number' && !Number.isNaN(raw.status)) ? raw.status : -1;
  const completed = status === C.COMPLETED_STATUS;
  const statusName = C.STATUS_NAMES[status] || `unknown_${status}`;
  const service = raw.service || raw.transactionType || 'unknown';
  const orderId = raw.externalTransactionId || raw.displayTransactionId || txId;
  return {
    txId,
    amount_idr: amount,
    create_time_ms,
    completed,
    raw: { ...raw, _status_name: statusName, _payment_type: `shopee:${service}`, _order_id: String(orderId), _store_id: wantStore, _merchant_id: merchantId }
  };
}

module.exports = { listRecent, transactionDetail };
