'use strict';
// REPRO + regression: H+1 (free / unsubscribed) payments must be HELD, not
// immediately withdrawable. Verifies the root-cause fix:
//   1. settle() on a shopeepay (H+1) invoice credits HELD, not the balance.
//   2. settle() on a gopay (H+0) invoice still credits the balance directly.
//   3. ledger.releaseDueHolds() moves matured holds into the balance exactly once.
//
// Stubbed mysql2 pool so we can assert on the exact queries that run.

const path = require('path');

const txQueries = [];
const poolQueries = [];
const rows = new Map();
let nextId = 1;

function poolExecute(sql, params) {
  poolQueries.push({ sql, params });
  if (/FROM invoices WHERE id/.test(sql)) return [rows.has('inv') ? [rows.get('inv')] : []];
  if (/FROM settlement_holds WHERE released/.test(sql)) return [rows.has('due') ? rows.get('due') : []];
  if (/FROM settlement_holds WHERE invoice_id/.test(sql)) return [rows.has('holdRow') ? [rows.get('holdRow')] : []];
  if (/FROM user_balances/.test(sql)) return [[{ balance: 0, held: 0 }]];
  if (/FROM ledger_entries/.test(sql)) return [[]];
  return [[]];
}

const mysqlStub = {
  createPool: () => ({
    execute: async (sql, params) => {
      if (/UPDATE settlement_holds SET released/.test(sql)) { txQueries.push({ sql, params }); return [{ affectedRows: 1 }]; }
      if (/INSERT INTO settlement_holds/.test(sql)) { txQueries.push({ sql, params }); rows.set('holdRow', { id: nextId++, user_id: params[0], invoice_id: params[1], amount: params[2], released: 0 }); return [{ insertId: nextId }]; }
      return poolExecute(sql, params);
    },
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      execute: async (sql, params) => {
        txQueries.push({ sql, params });
        if (/SELECT released FROM settlement_holds/.test(sql)) return [[{ released: rows.get('holdRow')?.released ?? 0 }]];
        if (/SELECT balance, held FROM user_balances/.test(sql)) return [[{ balance: rows.get('bal') ?? 0, held: rows.get('held') ?? 0 }]];
        if (/SELECT id FROM settlement_holds WHERE invoice_id/.test(sql)) return rows.has('holdRow') ? [[{ id: 1 }]] : [[]];
        if (/SELECT id FROM ledger_entries/.test(sql)) return [[]];
        if (/UPDATE user_balances SET balance/.test(sql)) { rows.set('bal', params[0]); rows.set('held', params[1]); }
        if (/UPDATE user_balances SET held/.test(sql)) rows.set('held', params[0]);
        if (/UPDATE settlement_holds SET released/.test(sql)) rows.set('holdRow', { ...(rows.get('holdRow') || {}), released: 1 });
        return [[]];
      }
    }),
    end: async () => {}
  })
};
require.cache[require.resolve('mysql2/promise')] = {
  exports: mysqlStub, loaded: true, id: require.resolve('mysql2/promise'),
  filename: require.resolve('mysql2/promise'), paths: []
};

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const payments = require('../src/services/payments');
const ledger = require('../src/services/ledger');

function makeInvoice(provider) {
  return {
    id: 'abc123', user_id: 7, provider, trx_id: 'TRX-1',
    base_amount: 10000, unique_code: 77, total_amount: 10077,
    data: 'x', reference: 'TEST', attributes: null, callback_url: null,
    kind: 'test', status: 'PENDING', transaction_json: null,
    created_at: new Date('2026-09-21T08:00:00Z'), expires_at: new Date('2026-09-21T08:05:00Z'),
    paid_at: null
  };
}
const mutation = { txId: 'TX-1', amount_idr: 10077, completed: true, create_time_ms: Date.now(), raw: {} };

let failures = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; }

(async () => {
  // ── 1) H+1 (shopeepay) must go to HELD ──
  txQueries.length = 0; rows.clear(); rows.set('inv', makeInvoice('shopeepay'));
  await payments.settle({ id: 'abc123' }, mutation);

  const holdInsert = txQueries.find((q) => /INSERT INTO settlement_holds/.test(q.sql));
  const heldBump = txQueries.find((q) => /UPDATE user_balances SET held/.test(q.sql));
  const balanceBump = txQueries.find((q) => /UPDATE user_balances SET balance/.test(q.sql));
  check('H+1: settlement_holds row written', Boolean(holdInsert));
  check('H+1: held increased', Boolean(heldBump));
  check('H+1: balance NOT increased at settle time', !balanceBump);
  if (holdInsert) {
    // release_at is stored as a naive UTC string (toMysql strips the 'Z') — parse it as UTC.
    const [y, m, d, hh, mm, ss] = holdInsert.params[3].match(/\d+/g).map(Number);
    const rel = Date.UTC(y, m - 1, d, hh, mm, ss);
    check('H+1: release_at is ~24h from now', Math.abs(rel - (Date.now() + 24 * 3600000)) < 60000);
  }

  // ── 2) H+0 (gopay) still credits the balance directly ──
  txQueries.length = 0; rows.clear(); rows.set('inv', makeInvoice('gopay'));
  await payments.settle({ id: 'abc123' }, mutation);

  check('H+0: no settlement_holds row written', !txQueries.some((q) => /INSERT INTO settlement_holds/.test(q.sql)));
  check('H+0: balance increased directly', txQueries.some((q) => /UPDATE user_balances SET balance/.test(q.sql)));

  // ── 3) releaseDueHolds moves a matured hold into the balance exactly once ──
  txQueries.length = 0; rows.clear();
  rows.set('due', [{ id: 5, user_id: 7, invoice_id: 'abc123', amount: 10000 }]);
  rows.set('holdRow', { id: 5, user_id: 7, invoice_id: 'abc123', amount: 10000, released: 0 });
  rows.set('bal', 0); rows.set('held', 10000);
  const r1 = await ledger.releaseDueHolds();
  check('release: reports released_count 1', r1.released_count === 1);
  check('release: balance increased to 10000', rows.get('bal') === 10000);
  check('release: held decreased to 0', rows.get('held') === 0);

  // Second tick is a no-op (idempotent) — the hold is already released.
  const r2 = await ledger.releaseDueHolds();
  check('release: second tick releases nothing (exactly-once)', r2.released_count === 0);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('REPRO ERROR', e); process.exit(2); });
