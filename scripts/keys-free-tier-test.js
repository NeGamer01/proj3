'use strict';
// Verifies the free-tier API-key contract: key creation requires no subscription,
// the key works immediately at H+1, and realtime degrades to H+1 by tier.
const http = require('http');
const { spawn } = require('child_process');

const APP_PORT = 3223;
const MOCK_PORT = 3334;
const results = [];
const check = (l, got, want) => { const ok = got === want; results.push({ l, ok }); console.log((ok ? 'PASS  ' : 'FAIL  ') + l + ' [got ' + got + ', want ' + want + ']'); };
const checkTrue = (l, c, extra) => { results.push({ l, ok: !!c }); console.log((c ? 'PASS  ' : 'FAIL  ') + l + (extra ? '  ' + extra : '')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, path, body, apiKey, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;
    if (apiKey) headers['x-api-key'] = apiKey;
    const u = new URL('http://127.0.0.1:' + APP_PORT + path);
    const r = http.request({ method, host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        let json = null; try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, body: json, raw, cookie: sc ? sc.map((c) => c.split(';')[0]).join('; ') : null });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const mock = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ transactions: [] })); });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const child = spawn(process.execPath, ['app.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(APP_PORT), GOBIZ_TX_URL: 'http://127.0.0.1:' + MOCK_PORT + '/merchant-analytics/v2/merchants/transactions' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  child.stdout.on('data', (c) => (boot += c));
  child.stderr.on('data', (c) => (boot += c));
  for (let i = 0; i < 40; i++) { try { const r = await req('GET', '/api/v1/healthz'); if (r.status === 200) break; } catch (e) {} await wait(250); }
  if (!/QRISPay running/.test(boot)) { console.log('BOOT LOG:\n' + boot); }
  checkTrue('app booted', /QRISPay running|running on port/.test(boot), boot.split('\n').filter(Boolean).pop());

  const email = 'free' + Date.now() + '@example.com';
  const ADMIN_MAIL = 'admin@example.com';
  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'TestAdmin123';

  try {
    const STATIC_QR = '00020101021126570014ID.CO.QRIS.WWW011693600914001234560215ID123456789012351440014ID.CO.QRIS.WWW0115ID12345678901230203UMI5204452053033605802ID5912TESTMERCHANT6007JAKARTA61051234062070503123630400EF';
    let r = await req('POST', '/app/api/auth/login', { email: ADMIN_MAIL, password: ADMIN_PW });
    check('admin login', r.status, 200);
    const adminCookie = r.cookie;
    await req('PUT', '/admin/api/providers/gopay/static-qris', { qris_static: STATIC_QR }, null, adminCookie);
    const accounts = require('../src/services/providerAccounts');
    await accounts.saveSession('gopay', { access_token: 'T', refresh_token: 'R', merchant_id: 'M', expires_at: new Date(Date.now() + 3600e3).toISOString().slice(0, 19).replace('T', ' ') });

    r = await req('POST', '/app/api/auth/register', { email, password: 'UserPass123', name: 'Free User' });
    check('free user register', r.status, 201);
    r = await req('POST', '/app/api/auth/login', { email, password: 'UserPass123' });
    check('free user login', r.status, 200);
    const userCookie = r.cookie;

    // 1) create key WITHOUT any subscription
    r = await req('POST', '/app/api/keys', { label: 'my-bot' }, null, userCookie);
    check('free user POST /keys -> 201', r.status, 201);
    checkTrue('key has qp_ prefix', r.body && r.body.data && typeof r.body.data.key === 'string' && r.body.data.key.startsWith('qp_'), JSON.stringify(r.body).slice(0, 80));
    const apiKey = r.body && r.body.data ? r.body.data.key : null;

    // 2) the key is usable right away on the public API
    r = await req('GET', '/api/v1/me', null, apiKey);
    check('GET /api/v1/me with free key -> 200', r.status, 200);
    checkTrue('allowed providers = shopeepay only (H+1)', r.body && r.body.data && JSON.stringify(r.body.data.allowed_providers) === '["shopeepay"]', JSON.stringify(r.body.data && r.body.data.allowed_providers));

    // 3) realtime explicitly requested by a free-tier key must degrade to H+1
    r = await req('POST', '/api/v1/qris', { amount: 10000, provider: 'realtime', reference: 'FREE-TEST' }, apiKey);
    check('POST /api/v1/qris realtime (free) -> 201', r.status, 201);
    checkTrue('settlement H+1 (not realtime)', r.body && r.body.data && r.body.data.settlement && r.body.data.settlement.speed === 'H+1', JSON.stringify(r.body.data && r.body.data.settlement));
    checkTrue('public data hides provider name', r.body && r.body.data && !('provider' in r.body.data), JSON.stringify(r.body.data));
    checkTrue('channel label = qris', r.body && r.body.data && r.body.data.channel === 'qris', String(r.body.data && r.body.data.channel));

    // 3b) same call without realtime (plain H+1 path)
    r = await req('POST', '/api/v1/qris', { amount: 10000, provider: 'qris', reference: 'FREE-TEST-2' }, apiKey);
    check('POST /api/v1/qris qris (free) -> 201', r.status, 201, JSON.stringify(r.body).slice(0, 120));

    // 4) the old SUBSCRIPTION_EXPIRED gate is gone even after a grant+expiry
    const db = require('../src/db');
    const u = await db.one('SELECT id FROM users WHERE email = ?', [email]);
    await db.query("INSERT INTO subscriptions (user_id, starts_at, ends_at, source) VALUES (?, UTC_TIMESTAMP() - INTERVAL 2 DAY, UTC_TIMESTAMP() - INTERVAL 1 DAY, 'manual')", [u.id]);
    r = await req('GET', '/api/v1/me', null, apiKey);
    check('expired subscription does not break the key', r.status, 200);
    checkTrue('still shopeepay after expiry', r.body && r.body.data && JSON.stringify(r.body.data.allowed_providers) === '["shopeepay"]', JSON.stringify(r.body.data && r.body.data.allowed_providers));

    // 5) dashboard key list works
    r = await req('GET', '/app/api/keys', null, null, userCookie);
    check('dashboard GET /keys -> 200', r.status, 200);
    checkTrue('list shows our key prefix', r.body && r.body.data && r.body.data.some((k) => k.label === 'my-bot'), JSON.stringify(r.body.data));
  } finally {
    child.kill('SIGINT');
    mock.close();
    await require('../src/db').close();
  }

  const failed = results.filter((x) => !x.ok);
  console.log('\n=== ' + (results.length - failed.length) + '/' + results.length + ' checks passed ===');
  if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.l).join(' | ')); process.exit(1); }
  console.log('ALL CHECKS PASSED');
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
