'use strict';
// Public API used by bots / websites of clients (x-api-key). Mirrors nikipayv2 + pooled additions.
const { Router } = require('express');
const path = require('path');
const { requireApiKey } = require('../middlewares/auth');
const invoices = require('../services/invoices');
const qris = require('../services/qris');
const webhooks = require('../services/webhooks');
const ledger = require('../services/ledger');
const withdrawals = require('../services/withdrawals');
const subs = require('../services/subscriptions');
const providers = require('../providers');

const router = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  res.status(e.status || 500).json({ success: false, code: e.code || 'INTERNAL_ERROR', message: e.message || 'Internal error' });
});
const pid = (p) => (Array.isArray(p) ? p[0] : p) || '';

router.get('/api/v1/healthz', (_req, res) => res.json({ status: 'healthy', service: 'qrispay', time: new Date().toISOString() }));

// Create QRIS (with provider + tier gating)
router.post('/api/v1/qris', requireApiKey, wrap(async (req, res) => {
  const b = req.body || {};
  const requestedProvider = (b.provider ? String(b.provider) : '').toLowerCase() || null;
  // Resolve provider: explicit, or auto-pick by tier (first allowed + implemented).
  let provider = requestedProvider;
  if (!provider) {
    provider = req.apiUser.allowed_providers.find((p) => providers.isImplemented(p)) || null;
    if (!provider) {
      return res.status(503).json({ success: false, code: 'PROVIDER_UNAVAILABLE', message: 'Belum ada provider yang aktif. Hubungi admin.' });
    }
  }
  // Tier gating.
  if (!req.apiUser.allowed_providers.includes(provider)) {
    return res.status(403).json({ success: false, code: 'PROVIDER_NOT_PERMITTED', message: `Provider ${provider} tidak tersedia di paket Anda. Upgrade langganan.` });
  }
  if (!providers.isImplemented(provider)) {
    return res.status(503).json({ success: false, code: 'PROVIDER_UNAVAILABLE', message: `Provider ${provider} belum tersedia.` });
  }
  // Check provider is connected (has active session + static QR).
  const prov = providers.getProvider(provider);
  const sess = await prov.getActiveSession();
  if (!sess) {
    return res.status(503).json({ success: false, code: 'PROVIDER_UNAVAILABLE', message: `Akun ${provider} operator belum terhubung.` });
  }
  const data = await invoices.createInvoice(req.apiUser.user_id, {
    amount: b.amount ?? req.query.amount,
    provider,
    reference: b.reference ?? req.query.reference,
    attributes: b.attributes,
    callback_url: b.callback_url ?? req.query.callback_url
  });
  res.status(201).json({ success: true, data });
}));

// Account info for the key owner (subscription + allowed providers + balance)
router.get('/api/v1/me', requireApiKey, wrap(async (req, res) => {
  const [sub, bal] = await Promise.all([
    subs.subscriptionStatus(req.apiUser.user_id, req.apiUser.role),
    ledger.getBalance(req.apiUser.user_id)
  ]);
  res.json({ success: true, data: { subscription: sub, allowed_providers: req.apiUser.allowed_providers, balance: bal } });
}));

router.get('/api/v1/balance', requireApiKey, wrap(async (req, res) => {
  res.json({ success: true, data: await ledger.getBalance(req.apiUser.user_id) });
}));

router.post('/api/v1/withdraw', requireApiKey, wrap(async (req, res) => {
  const w = await withdrawals.request(req.apiUser.user_id, { amount: req.body?.amount, bank_detail: req.body?.bank_detail, note: req.body?.note });
  res.status(201).json({ success: true, data: w });
}));

router.get('/api/v1/withdrawals', requireApiKey, wrap(async (req, res) => {
  res.json({ success: true, data: await withdrawals.listForUser(req.apiUser.user_id, { limit: req.query.limit }) });
}));

router.post('/api/v1/withdrawals/:id/cancel', requireApiKey, wrap(async (req, res) => {
  const w = await withdrawals.cancel(req.apiUser.user_id, pid(req.params.id));
  res.json({ success: true, data: w });
}));

router.get('/api/v1/transactions', requireApiKey, wrap(async (req, res) => {
  res.json({ success: true, data: await invoices.listForUser(req.apiUser.user_id, { limit: req.query.limit, status: req.query.status }) });
}));

router.get('/api/v1/ledger', requireApiKey, wrap(async (req, res) => {
  res.json({ success: true, data: await ledger.listEntries(req.apiUser.user_id, { limit: req.query.limit }) });
}));

// Webhooks (per tenant)
router.get('/api/v1/webhooks', requireApiKey, wrap(async (req, res) => {
  res.json({ success: true, data: (await webhooks.list(req.apiUser.user_id)).map(({ secret, ...w }) => w) });
}));
router.post('/api/v1/webhooks', requireApiKey, wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim(); const secret = req.body?.secret ? String(req.body.secret) : undefined;
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) throw 0; } catch { return res.status(400).json({ success: false, code: 'INVALID_URL', message: 'URL webhook harus http/https' }); }
  try { await webhooks.ping(url, secret); } catch (e) { return res.status(400).json({ success: false, code: 'WEBHOOK_UNREACHABLE', message: `Webhook tidak bisa dihubungi (${e.response ? 'HTTP ' + e.response.status : e.message})` }); }
  res.status(201).json({ success: true, data: await webhooks.register(req.apiUser.user_id, url, secret, Array.isArray(req.body?.events) ? req.body.events : undefined) });
}));
router.delete('/api/v1/webhooks/:id', requireApiKey, wrap(async (req, res) => {
  const ok = await webhooks.remove(req.apiUser.user_id, pid(req.params.id));
  res.status(ok ? 200 : 404).json({ success: ok, message: ok ? 'Webhook dihapus' : 'Webhook tidak ditemukan' });
}));

// ── Public (no key): status polling + payment page. IDs are unguessable. ──
router.get('/api/v1/qris/:id/status', wrap(async (req, res) => {
  const data = await qris.checkStatus(pid(req.params.id));
  res.status(data.status === 'EXPIRED' ? 410 : 200).json({ success: data.status !== 'EXPIRED', ...data });
}));

router.get('/api/v1/qris/:id', wrap(async (req, res) => {
  const rec = await invoices.getRecord(pid(req.params.id));
  if (!rec) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Invoice tidak ditemukan' });
  const v = invoices.publicView(rec);
  res.json({ success: true, data: { ...v, formatted_amount: new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(rec.total_amount),
    qr_image_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(rec.data)}`,
    expires_at: rec.expires_at.getTime(), duration_ms: rec.expires_at.getTime() - rec.created_at.getTime() } });
}));

router.get('/qr/:id', wrap(async (req, res) => {
  const rec = await invoices.getRecord(pid(req.params.id));
  if (!rec) return res.status(404).send('<h3 style="font-family:sans-serif;color:#94a3b8;text-align:center;margin-top:40vh;">Invoice tidak ditemukan</h3>');
  const expired = Date.now() > rec.expires_at.getTime() && rec.status !== 'PAID';
  if (req.query.format === 'raw' || req.query.raw === '1') {
    if (expired) return res.status(410).send('QRIS Expired');
    return res.redirect(302, `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(rec.data)}`);
  }
  if (req.query.download === '1') {
    if (expired) return res.status(410).send('QRIS Expired');
    const r = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&format=png&data=${encodeURIComponent(rec.data)}`);
    if (!r.ok) return res.status(502).send('Gagal membuat gambar QR');
    res.set({ 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="qris-${rec.id}.png"`, 'Cache-Control': 'private, no-store' });
    return res.send(Buffer.from(await r.arrayBuffer()));
  }
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'qris.html'));
}));

module.exports = router;
