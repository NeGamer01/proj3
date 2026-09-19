'use strict';
// Integration test (needs MySQL): spawns its own app instance + mock GoBiz server and
// exercises the full runtime stack: auth, tier gating, invoice creation, QRIS generation,
// pooled amount-only matching, settlement, ledger, idempotency claims, withdrawals.
//
// Usage:  npm run test:integration
// Requires: MySQL reachable per .env (DB_*), .env with valid secrets.
// The app is spawned with GOBIZ_TX_URL pointing at the mock, so no real GoBiz traffic occurs.
const http = require('http');
const { spawn } = require('child_process');

const APP_PORT = Number(process.env.INTEST_APP_PORT || 3222);
const MOCK_PORT = Number(process.env.INTEST_MOCK_PORT || 3333);
const results = [];

function check(label, got, expect) {
  const ok = got === expect;
  results.push({ label, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  [got ' + got + ', want ' + expect + ']');
}
function checkTrue(label, cond, extra) {
  results.push({ label, ok: !!cond });
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  ' + extra : ''));
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function req(method, path, body, apiKey, cookie, port) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;
    if (apiKey) headers['x-api-key'] = apiKey;
    const u = new URL('http://127.0.0.1:' + (port || APP_PORT) + path);
    const r = http.request({ method, host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        const got = sc ? sc.map((c) => c.split(';')[0]).join('; ') : null;
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, body: json, raw, cookie: got });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// A structurally valid static QRIS (EMVCo) used as the operator's GoBiz static QR.
const STATIC_QR = '00020101021126570014ID.CO.QRIS.WWW011693600914001234560215ID123456789012351440014ID.CO.QRIS.WWW0115ID12345678901230203UMI5204452053033605802ID5912TESTMERCHANT6007JAKARTA61051234062070503123630400EF';

(async () => {
  // ── mock GoBiz transaction feed (returns minor units / SEN) ──
  const mutasi = [];
  const mock = http.createServer((req, res) => {
    const u = new URL('http://x' + req.url);
    if (req.method === 'POST' && u.pathname === '/mutasi') {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => {
        const b = JSON.parse(d || '{}');
        mutasi.push({ id: b.tx_id || ('MOCK-' + Date.now()), gross_amount: Number(b.amount_idr) * 100, transaction_time: new Date().toISOString(), status: 'SETTLEMENT' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (req.method === 'GET' && u.pathname.indexOf('/merchant-analytics') === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transactions: mutasi }));
      return;
    }
    res.writeHead(404); res.end('nf');
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  // ── app instance with transactions URL redirected to the mock ──
  const child = spawn(process.execPath, ['app.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(APP_PORT), GOBIZ_TX_URL: 'http://127.0.0.1:' + MOCK_PORT + '/merchant-analytics/v2/merchants/transactions' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  child.stdout.on('data', (c) => (bootLog += c));
  child.stderr.on('data', (c) => (bootLog += c));

  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/api/v1/healthz'); if (r.status === 200) break; } catch (e) {}
    await wait(250);
  }
  if (!/QRISPay running/.test(bootLog)) console.log('BOOT LOG:\n' + bootLog);
  checkTrue('app booted on ' + APP_PORT, /QRISPay running/.test(bootLog), bootLog.split('\n').filter(Boolean).pop());

  const ADMIN_MAIL = 'admin@example.com';
  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'TestAdmin123';
  let apiKey, userId, adminCookie, userCookie;

  try {
    // clean residual data from previous runs (claims are global & persistent by design)
    const db0 = require('../src/db');
    await db0.query('DELETE FROM claimed_transactions');
    await db0.query('DELETE FROM unmatched_payments');
    await db0.query('DELETE FROM ledger_entries');
    await db0.query('DELETE FROM invoices');
    await db0.query('DELETE FROM user_balances');

    // ── auth + provider config ──
    let r = await req('POST', '/app/api/auth/login', { email: ADMIN_MAIL, password: ADMIN_PW });
    check('admin login', r.status, 200);
    adminCookie = r.cookie;

    r = await req('PUT', '/admin/api/providers/gopay/static-qris', { qris_static: STATIC_QR }, null, adminCookie);
    check('admin set static qris', r.status, 200, JSON.stringify(r.body).slice(0, 80));

    // inject a fake-but-active gopay session (encrypted by the app's own crypto)
    const accounts = require('../src/services/providerAccounts');
    await accounts.saveSession('gopay', {
      access_token: 'TESTTOKEN', refresh_token: 'TESTREFRESH', merchant_id: 'M123',
      expires_at: new Date(Date.now() + 3600e3).toISOString().slice(0, 19).replace('T', ' '),
    });
    const prov = (await req('GET', '/admin/api/providers', null, null, adminCookie)).body.data.find((p) => p.name === 'gopay');
    checkTrue('gopay connected', !!(prov.summary && (prov.summary.status === 'active' || prov.summary.connected)), JSON.stringify(prov.summary).slice(0, 80));

    // shopeepay is stubbed (Fase 2)
    const sp = (await req('GET', '/admin/api/providers', null, null, adminCookie)).body.data.find((p) => p.name === 'shopeepay');
    checkTrue('shopeepay stubbed (not implemented)', sp && sp.implemented === false, JSON.stringify(sp).slice(0, 60));

    // ── user + tier gating ──
    const email = 'm' + Date.now() + '@example.com';
    r = await req('POST', '/app/api/auth/register', { email, password: 'UserPass123', name: 'Integration Test' });
    check('user register', r.status, 201);
    r = await req('POST', '/app/api/auth/login', { email, password: 'UserPass123' });
    check('user login', r.status, 200);
    userCookie = r.cookie;

    // free user cannot create API key (needs subscription) — by design
    r = await req('POST', '/app/api/keys', { label: 'int' }, null, userCookie);
    check('free user POST /keys -> 403', r.status, 403);
    checkTrue('code SUBSCRIPTION_REQUIRED', r.body && r.body.code === 'SUBSCRIPTION_REQUIRED', JSON.stringify(r.body).slice(0, 70));

    // grant H0 plan
    const us = await req('GET', '/admin/api/users?q=' + encodeURIComponent(email), null, null, adminCookie);
    userId = us.body.data[0].id;
    await req('POST', '/admin/api/users/' + userId + '/subscription', { days: 30, plan_id: 2 }, null, adminCookie);
    r = await req('POST', '/app/api/keys', { label: 'int' }, null, userCookie);
    check('user POST /keys (with sub)', r.status, 201);
    apiKey = r.body.data.key;
    checkTrue('api key qp_ prefix', typeof apiKey === 'string' && apiKey.startsWith('qp_'));

    // ── invoice + QRIS ──
    r = await req('POST', '/api/v1/qris', { amount: 10000, provider: 'gopay', reference: 'MATCH-TEST' }, apiKey);
    check('create invoice gopay', r.status, 201, JSON.stringify(r.body).slice(0, 80));
    const inv = r.body.data;
    const total = inv.amount;
    checkTrue('total = base + unique_code', total > 10000 && total <= 10200, 'total=' + total);

    // QR string is well-formed dynamic QRIS: tag 01 flipped to 12, tag 54 injected with the total, tag 63 CRC valid
    {
      const { parseEMVCoTags, generateDynamicQRIS } = require('../src/utils/qris');
      const tags = parseEMVCoTags(String(inv.qris_code));
      const t01 = tags.find((t) => t.tag === '01');
      const t54 = tags.find((t) => t.tag === '54');
      const crcOk = /6304../.test(String(inv.qris_code)) && generateDynamicQRIS(STATIC_QR, total).slice(-4) === String(inv.qris_code).slice(-4);
      checkTrue('dynamic qris: 01=12, tag54=total, valid CRC', t01 && t01.val === '12' && t54 && Number(t54.val) === total && crcOk,
        '01=' + (t01 && t01.val) + ' 54=' + (t54 && t54.val));
    }

    // ── matching + settle via real HTTP to the mock ──
    const txId = 'MOCK-' + Date.now();
    await req('POST', '/mutasi', { tx_id: txId, amount_idr: total }, null, null, MOCK_PORT);

    let paid = false;
    for (let i = 0; i < 10; i++) {
      r = await req('GET', '/api/v1/qris/' + inv.qris_id + '/status');
      if (r.body && r.body.paid) { paid = true; break; }
      await wait(300);
    }
    check('lazy status poll settles invoice (PAID)', paid, true);

    r = await req('GET', '/api/v1/balance', null, apiKey);
    check('ledger credited base_amount', (r.body.data || {}).balance, 10000, JSON.stringify(r.body).slice(0, 80));

    // idempotency: same tx re-injected must not credit again
    await req('POST', '/mutasi', { tx_id: txId, amount_idr: total }, null, null, MOCK_PORT);
    await req('GET', '/api/v1/qris/' + inv.qris_id + '/status');
    r = await req('GET', '/api/v1/balance', null, apiKey);
    check('idempotency: balance unchanged', (r.body.data || {}).balance, 10000);

    const dbc = require('../src/db');
    const c = await dbc.query('SELECT * FROM claimed_transactions WHERE provider = ? AND tx_id = ?', ['gopay', txId]);
    check('exactly 1 claim row (provider,tx_id)', c.length, 1);

    // ── unique-code allocation ──
    const a = await req('POST', '/api/v1/qris', { amount: 5000, provider: 'gopay' }, apiKey);
    const b = await req('POST', '/api/v1/qris', { amount: 5000, provider: 'gopay' }, apiKey);
    checkTrue('same-base invoices get different totals', a.body.data && b.body.data && a.body.data.amount !== b.body.data.amount,
      (a.body.data && a.body.data.amount) + ' vs ' + (b.body.data && b.body.data.amount));

    // ── orphan payment -> unmatched_payments (no auto-credit) ──
    await req('POST', '/mutasi', { tx_id: 'ORPHAN-' + Date.now(), amount_idr: 77777 }, null, null, MOCK_PORT);
    await wait(11000); // let the background poller tick (fetches because pending invoices exist)
    const un = await dbc.query("SELECT * FROM unmatched_payments WHERE amount_idr = 77777 AND status = 'pending'");
    checkTrue('orphan recorded as unmatched', un.length >= 1, 'count=' + un.length);

    // ── withdrawals: hold -> process ──
    r = await req('POST', '/api/v1/withdraw', { amount: 4000, bank_detail: { bank_name: 'BCA', account_number: '1234567890', account_name: 'TEST' } }, apiKey);
    check('withdraw requested', r.status, 201, JSON.stringify(r.body).slice(0, 80));
    const wdId = r.body.data && r.body.data.id;
    checkTrue('withdrawal id returned', !!wdId, String(wdId));

    r = await req('GET', '/api/v1/balance', null, apiKey);
    check('held 4000 after request', (r.body.data || {}).held, 4000, JSON.stringify(r.body).slice(0, 80));

    r = await req('POST', '/api/v1/withdraw', { amount: 99999, bank_detail: { bank_name: 'BCA', account_number: '1', account_name: 'T' } }, apiKey);
    checkTrue('over-withdraw rejected INSUFFICIENT_BALANCE', r.status >= 400 && r.body && r.body.code === 'INSUFFICIENT_BALANCE', JSON.stringify(r.body).slice(0, 70));

    r = await req('POST', '/admin/api/withdrawals/' + wdId + '/process', {}, null, adminCookie);
    check('admin process withdrawal', r.status, 200, JSON.stringify(r.body).slice(0, 80));
    r = await req('GET', '/api/v1/balance', null, apiKey);
    check('balance 6000 after process', (r.body.data || {}).balance, 6000);
    check('held 0 after process', (r.body.data || {}).held, 0);

    r = await req('GET', '/api/v1/ledger', null, apiKey);
    const types = (r.body.data || []).map((e) => e.type).join(',');
    checkTrue('ledger audit: credit+debit_hold+debit_settled', ['credit', 'debit_hold', 'debit_settled'].every((t) => types.indexOf(t) !== -1), types);
  } finally {
    child.kill('SIGINT');
    mock.close();
    const db = require('../src/db');
    await db.close();
  }

  const failed = results.filter((x) => !x.ok);
  console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' checks passed ===');
  if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.label).join(' | ')); process.exit(1); }
  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
