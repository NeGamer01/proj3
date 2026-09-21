'use strict';
// Whole-rupiah amounts: ShopeePay answers Indonesian grouped strings, NOT minor units.
//
// "409.662" means Rp409.662 — the dots are thousand separators. This is the
// opposite of GoPay (minor units / sen), so the two providers' money helpers
// must never be mixed. Ported from QrisMerchantID/shopee/money.py.

const _PLAIN = /^\d+$/;
const _GROUPED = /^\d{1,3}(?:\.\d{3})+$/;

/** Parse "409.662" -> 409662 (whole rupiah). null when malformed.
 *  Mirrors parseShopeeAmount in merchantid (transactionFeed.ts): plain digits
 *  or strict d{1,3}(.ddd)+ grouping only. Anything else (commas, decimals,
 *  signs, inner whitespace) is rejected instead of guessed, so a poll loop
 *  never matches money it cannot prove. */
function parseIdAmount(value) {
  const text = String(value == null ? '' : value).trim();
  if (!_PLAIN.test(text) && !_GROUPED.test(text)) return null;
  const amount = parseInt(text.replace(/\./g, ''), 10);
  return amount >= 0 ? amount : null;
}

module.exports = { parseIdAmount };
