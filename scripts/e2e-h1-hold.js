process.env.SESSION_SECRET = 'x'.repeat(48);
process.env.PROVIDER_MASTER_KEY = 'a'.repeat(64);
const db = require('../src/db');
const ledger = require('../src/services/ledger');
const users = require('../src/services/users');
const invoices = require('../src/services/invoices');
const payments = require('../src/services/payments');
const withdrawals = require('../src/services/withdrawals');

const STATIC = '00020101021126560011ID.DANA.WWW01189360091400123456780215ID12345678901235204599953033605802ID5914Toko Demo Test6007Jakarta6105123406221051ABC123456789016304A011D3A';

(async () => {
  // Clean any leftovers from previous runs so the script is re-runnable.
  await db.query("DELETE FROM users WHERE email = 'h1test@x.com'");
  // Install a valid static QR for both providers (operator accounts), as the
  // admin would via the dashboard. createInvoice requires it.
  await db.query(
    "INSERT INTO provider_accounts (name, display_name, qris_static, status) VALUES ('shopeepay','ShopeePay',?,'active'), ('gopay','GoPay',?,'active') ON DUPLICATE KEY UPDATE qris_static = VALUES(qris_static), status = 'active'",
    [STATIC, STATIC]
  );
  const u = await users.register({ email: 'h1test@x.com', password: 'password123', name: 'Test' });
  console.log('user id:', u.id);
  const data = await invoices.createInvoice(u.id, { amount: 10000, provider: 'shopeepay', reference: 'E2E', kind: 'test', staticQrisOverride: STATIC });
  console.log('invoice:', data.qris_id, 'provider:', data.provider, 'total:', data.amount);
  const inv = await db.one("SELECT * FROM invoices WHERE user_id=? AND reference='E2E'", [u.id]);
  const tx = { txId: 'TX-E2E-1', amount_idr: inv.total_amount, completed: true, create_time_ms: Date.now(), raw: {} };
  await payments.settle(invoices.rowToRecord(inv), tx);
  const b1 = await ledger.getBalance(u.id);
  console.log('AFTER SETTLE   -> balance:', b1.balance, 'held:', b1.held, 'available:', b1.available);

  // 1. Withdraw the held funds MUST fail (this is the whole point of the fix).
  try {
    await withdrawals.request(u.id, { amount: 10000, bank_detail: { bank_name: 'BCA', account_number: '1', account_name: 'Test' } });
    console.log('>>> WITHDRAW SUCCEEDED — BUG: held funds were withdrawable');
  } catch (e) { console.log('>>> withdraw BLOCKED (correct):', e.code, '-', e.message); }

  // 2. The scheduler must not release a hold that is not due yet.
  const r0 = await ledger.releaseDueHolds();
  console.log('release before due:', JSON.stringify(r0));

  // 3. Admin force-release works and is idempotent.
  const r1 = await ledger.releaseHoldNow(inv.id, { note: 'e2e test' });
  console.log('manual release:', JSON.stringify(r1));
  const r1b = await ledger.releaseHoldNow(inv.id, { note: 'second call' });
  console.log('manual release again (idempotent):', JSON.stringify(r1b));

  const b2 = await ledger.getBalance(u.id);
  console.log('AFTER RELEASE  -> balance:', b2.balance, 'held:', b2.held, 'available:', b2.available);

  // 4. Now the funds are withdrawable.
  const w = await withdrawals.request(u.id, { amount: 5000, bank_detail: { bank_name: 'BCA', account_number: '1', account_name: 'Test' } });
  console.log('withdraw after release OK:', w.id, 'amount', w.amount);
  const b3 = await ledger.getBalance(u.id);
  console.log('AFTER WITHDRAW -> balance:', b3.balance, 'held:', b3.held, 'available:', b3.available);

  // 5. creditHeld is idempotent per invoice.
  const dup = await ledger.creditHeld(u.id, 10000, { refType: 'invoice', refId: inv.id, releaseAt: new Date(Date.now() + 3600000) });
  console.log('duplicate creditHeld (idempotency):', JSON.stringify(dup));
  console.log('hold rows:', (await db.query('SELECT released, amount FROM settlement_holds WHERE invoice_id=?', [inv.id])).map((r) => `released=${r.released} amount=${r.amount}`).join(' | '));

  // 6. H+0 (gopay) invoice credits the balance directly with no hold.
  const g = await invoices.createInvoice(u.id, { amount: 10000, provider: 'gopay', reference: 'E2E-H0', kind: 'test', staticQrisOverride: STATIC });
  const ginv = await db.one("SELECT * FROM invoices WHERE reference='E2E-H0'", []);
  await payments.settle(invoices.rowToRecord(ginv), { txId: 'TX-E2E-2', amount_idr: ginv.total_amount, completed: true, create_time_ms: Date.now(), raw: {} });
  const b4 = await ledger.getBalance(u.id);
  console.log('AFTER GOPAY SETTLE -> balance:', b4.balance, 'held:', b4.held, '(no new hold expected)');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
