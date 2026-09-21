'use strict';
// Store discovery: cursor-paged get-store-list with an unfiltered retry.
// Ported from QrisMerchantID/shopee/stores.py (ShopeeMerchantClient.listStores).
//
// Page with the [1,10] service filter first, and when that yields zero stores
// retry with the filter key omitted entirely (not an empty array) so stores
// without a service still show up.
const C = require('./constants');
const { ShopeePayError } = require('./client');

class ShopeePayError2 extends ShopeePayError {}

/** List the merchant's stores (each has the numeric id the feed needs).
 *  Returns [{ id, name, status }, ...] across all pages. */
async function listStores(client, { maxPages = 10 } = {}) {
  const withFilter = await _fetch(client, maxPages, [...C.STORE_SERVICES]);
  if (withFilter.length) return withFilter;
  return _fetch(client, maxPages, null);
}

async function _fetch(client, maxPages, serviceList) {
  const pages = Math.max(1, maxPages);
  const stores = new Map(); // id -> store (dedupe)
  const seenCursors = new Set([0]);
  let lastStoreId = 0;
  for (let i = 0; i < pages; i++) {
    const inner = { storeName: '', lastStoreId, pageSize: C.STORE_PAGE_SIZE };
    if (serviceList !== null && serviceList !== undefined) inner.serviceList = serviceList;
    const data = await client.postPayment(C.ENDPOINT_STORES, inner);
    const rawBatch = Array.isArray(data?.list) ? data.list : [];
    for (const raw of rawBatch) {
      const store = _normalizeStore(raw);
      if (store) stores.set(store.id, store);
    }
    const total = data?.storeCount;
    const totalReached = Number.isInteger(total) && total >= 0 && stores.size >= total;
    if (!rawBatch.length || rawBatch.length < C.STORE_PAGE_SIZE || totalReached) {
      return Array.from(stores.values());
    }
    const nextCursor = _cursorOf(rawBatch[rawBatch.length - 1]);
    if (nextCursor === null || seenCursors.has(nextCursor)) {
      throw new ShopeePayError2('Shopee store cursor did not advance', 502, 'CURSOR_STUCK');
    }
    seenCursors.add(nextCursor);
    lastStoreId = nextCursor;
  }
  throw new ShopeePayError2('Shopee store pagination limit was reached', 502, 'PAGINATION_LIMIT');
}

function _normalizeStore(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { storeId } = raw;
  if (typeof storeId === 'boolean' || storeId === undefined || storeId === null) return null;
  const idStr = String(storeId);
  if (idStr === '') return null;
  const status = Number.isInteger(raw.status) ? raw.status : 0;
  return { id: idStr, name: String(raw.storeName || ''), status };
}

function _cursorOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { storeId } = raw;
  if (typeof storeId === 'boolean') return null;
  if (typeof storeId === 'number' && Number.isInteger(storeId)) return storeId;
  if (typeof storeId === 'string' && /^\d+$/.test(storeId)) return parseInt(storeId, 10);
  return null;
}

module.exports = { listStores };
