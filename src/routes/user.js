'use strict';
// Dashboard API for logged-in clients (cookie session). Mounted at /app/api.
const { Router } = require('express');
const { config } = require('../config');
const { requireUser, setSessionCookie, clearSessionCookie } = require('../middlewares/auth');
const users = require('../services/users');
const invoices = require('../services/invoices');
const qris = require('../services/qris');
const apikeys = require('../services/apikeys');
const subs = require('../services/subscriptions');
const webhooks = require('../services/webhooks');
const ledger = require('../services/ledger');
const withdrawals = require('../services/withdrawals');
const providers = require('../providers');
const { listLogs } = require('../services/logs');
const { logActivity } = require('../services/logs');

const router = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  res.status(e.status || 500).json({ success: false, code: e.code || 'INTERNAL_ERROR', message: e.message || 'Internal error' });
});
const pid = (p) => (Array.isArray(p) ? p[0] : p) || '';

// simple login throttle per IP
const attempts = new Map();
function throttle(ip) {
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
  a.n++; attempts.set(ip, a);
  return a.n > 20;
}

// ── auth ──
router.post('/auth/register', wrap(async (req, res) => {
  if (!config.registrationOpen) return res.status(403).json({ success: false, code: 'REGISTRATION_CLOSED', message: 'Pendaftaran ditutup' });
  if (throttle(req.ip)) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Terlalu banyak percobaan, coba lagi nanti' });
  const user = await users.register({ email: req.body?.email, password: req.body?.password, name: req.body?.name });
  setSessionCookie(res, user);
  logActivity(user.id, 'INFO', `Akun baru: ${user.email}`);
  res.status(201).json({ success: true, data: user });
}));

router.post('/auth/login', wrap(async (req, res) => {
  if (throttle(req.ip)) return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Terlalu banyak percobaan, coba lagi 15 menit lagi' });
  const user = await users.login({ email: req.body?.email, password: req.body?.password });
  setSessionCookie(res, user);
  res.json({ success: true, data: user });
}));

router.post('/auth/logout', (_req, res) => { clearSessionCookie(res); res.json({ success: true }); });

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, code: 'UNAUTHORIZED' });
  res.json({ success: true, data: req.user });
});

router.use(requireUser);

router.post('/auth/password', wrap(async (req, res) => {
  await users.changePassword(req.user.id, req.body?.old_password, req.body?.new_password);
  res.json({ success: true });
}));

// ── overview ──
router.get('/overview', wrap(async (req, res) => {
  const [sub, st, keys, bal, provList] = await Promise.all([
    subs.subscriptionStatus(req.user.id, req.user.role),
    invoices.stats(req.user.id, req.query.days || 30),
    apikeys.list(req.user.id),
    ledger.getBalance(req.user.id),
    Promise.all(providers.listProviders().map(async (n) => ({ name: n, implemented: providers.isImplemented(n), summary: await providers.getProvider(n).summary() })))
  ]);
  res.json({ success: true, data: { user: req.user, subscription: sub, allowed_providers: sub.providers, stats: st, api_keys: keys, balance: bal, providers: provList, public_url: config.publicUrl } });
}));

// ── balance / ledger / withdrawals ──
router.get('/balance', wrap(async (req, res) => res.json({ success: true, data: await ledger.getBalance(req.user.id) })));
router.get('/ledger', wrap(async (req, res) => res.json({ success: true, data: await ledger.listEntries(req.user.id, { limit: req.query.limit || 50 }) })));
router.post('/withdraw', wrap(async (req, res) => {
  const w = await withdrawals.request(req.user.id, { amount: req.body?.amount, bank_detail: req.body?.bank_detail, note: req.body?.note });
  logActivity(req.user.id, 'INFO', `Withdrawal ${w.id} diminta Rp ${w.amount}`);
  res.status(201).json({ success: true, data: w });
}));
router.get('/withdrawals', wrap(async (req, res) => res.json({ success: true, data: await withdrawals.listForUser(req.user.id, { limit: req.query.limit || 20 }) })));
router.post('/withdrawals/:id/cancel', wrap(async (req, res) => res.json({ success: true, data: await withdrawals.cancel(req.user.id, pid(req.params.id)) })));

// ── API keys ──
router.get('/keys', wrap(async (req, res) => res.json({ success: true, data: await apikeys.list(req.user.id) })));
router.post('/keys', wrap(async (req, res) => {
  const sub = await subs.subscriptionStatus(req.user.id, req.user.role);
  if (!sub.active) return res.status(403).json({ success: false, code: 'SUBSCRIPTION_REQUIRED', message: 'Aktifkan langganan dulu untuk membuat API key' });
  const k = await apikeys.create(req.user.id, req.body?.label);
  logActivity(req.user.id, 'INFO', `API key dibuat (${k.key_prefix})`);
  res.status(201).json({ success: true, data: k });
}));
router.delete('/keys/:id', wrap(async (req, res) => {
  const ok = await apikeys.revoke(req.user.id, Number(pid(req.params.id)));
  res.status(ok ? 200 : 404).json({ success: ok });
}));

// ── subscription ──
router.get('/plans', wrap(async (_req, res) => res.json({ success: true, data: await subs.listPlans() })));
router.get('/subscription', wrap(async (req, res) => res.json({ success: true, data: { status: await subs.subscriptionStatus(req.user.id, req.user.role), history: await subs.listSubscriptions(req.user.id), orders: await subs.listOrders({ userId: req.user.id, limit: 20 }) } })));
router.post('/subscription/orders', wrap(async (req, res) => {
  const order = await subs.createOrder(req.user.id, Number(req.body?.plan_id), (adminId, opts) => invoices.createInvoice(adminId, opts));
  res.status(201).json({ success: true, data: order });
}));
router.get('/subscription/orders/:id', wrap(async (req, res) => {
  const order = await subs.getOrder(req.user.id, pid(req.params.id));
  if (order.status === 'PENDING' && order.qris_id) {
    const st = await qris.checkStatus(order.qris_id); // settles the order when PAID
    if (st.status !== 'PENDING') return res.json({ success: true, data: await subs.getOrder(req.user.id, order.id) });
  }
  res.json({ success: true, data: order });
}));

// ── QRIS test + list ──
router.post('/qris', wrap(async (req, res) => {
  const allowed = await subs.allowedProviders(req.user.id, req.user.role);
  const provider = req.body?.provider && allowed.includes(req.body.provider) ? req.body.provider : allowed[0];
  const data = await invoices.createInvoice(req.user.id, { amount: req.body?.amount, provider, reference: req.body?.reference || 'TEST', kind: 'test' });
  res.status(201).json({ success: true, data });
}));
router.get('/qris', wrap(async (req, res) => res.json({ success: true, data: await invoices.listForUser(req.user.id, { limit: req.query.limit || 20 }) })));
router.get('/qris/:id/status', wrap(async (req, res) => {
  const rec = await invoices.getRecord(pid(req.params.id));
  if (!rec || rec.user_id !== req.user.id) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
  res.json({ success: true, data: await qris.checkStatus(rec.id) });
}));
router.post('/qris/:id/mark-paid', wrap(async (req, res) => res.json({ success: true, data: await require('../services/payments').manualMarkPaid(req.user.id, pid(req.params.id), req.user.role, 'user') })));

// ── webhooks ──
router.get('/webhooks', wrap(async (req, res) => res.json({ success: true, data: (await webhooks.list(req.user.id)).map(({ secret, ...w }) => w) })));
router.post('/webhooks', wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim(); const secret = req.body?.secret ? String(req.body.secret) : undefined;
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) throw 0; } catch { return res.status(400).json({ success: false, message: 'URL harus http/https' }); }
  try { await webhooks.ping(url, secret); } catch (e) { return res.status(400).json({ success: false, message: `Webhook tidak bisa dihubungi (${e.response ? 'HTTP ' + e.response.status : e.message})` }); }
  res.status(201).json({ success: true, data: await webhooks.register(req.user.id, url, secret) });
}));
router.delete('/webhooks/:id', wrap(async (req, res) => { const ok = await webhooks.remove(req.user.id, pid(req.params.id)); res.status(ok ? 200 : 404).json({ success: ok }); }));

router.get('/logs', wrap(async (req, res) => res.json({ success: true, data: await listLogs({ userId: req.user.id, limit: req.query.limit || 50 }) })));

module.exports = router;
