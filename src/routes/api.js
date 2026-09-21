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
const prefs = require('../services/preferences');
const providers = require('../providers');
const channelRouter = require('../services/channelRouter');
const router_ = channelRouter;

const { providerLabel, CHANNEL_ALIASES, resolveChannelAlias, settlementInfo } = require('../utils/displayNames');

const router = Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  res.status(e.status || 500).json({ success: false, code: e.code || 'INTERNAL_ERROR', message: e.message || 'Internal error' });
});
const pid = (p) => (Array.isArray(p) ? p[0] : p) || '';

router.get('/api/v1/healthz', (_req, res) => res.json({ status: 'healthy', service: 'qrispay', time: new Date().toISOString() }));

// Create QRIS. Provider choice is internal — clients may request a settlement
// speed ("qris" / "realtime") but never a specific provider; routing picks a
// healthy provider automatically. Settlement speed follows the subscription.
router.post('/api/v1/qris', requireApiKey, wrap(async (req, res) => {
  const b = req.body || {};
  const wantRealtime = resolveChannelAlias(b.provider ? String(b.provider) : '') === 'gopay'
    || String(b.speed || '').toLowerCase() === 'realtime';

  const { provider } = await router_.pickProvider({
    wantRealtime,
    allowed: req.apiUser.allowed_providers
  });
  const data = await invoices.createInvoice(req.apiUser.user_id, {
    amount: b.amount ?? req.query.amount,
    provider,
    reference: b.reference ?? req.query.reference,
    attributes: b.attributes,
    callback_url: b.callback_url ?? req.query.callback_url
  });
  // Public view: hide the provider entirely; expose only settlement speed.
  const { settlementInfo } = require('../utils/displayNames');
  const tier = req.apiUser.tier || (req.apiUser.allowed_providers?.includes('gopay') ? 'H0' : 'H1');
  const publicData = { ...data };
  delete publicData.provider; delete publicData.provider_label;
  publicData.settlement = settlementInfo(tier);
  publicData.channel = publicData.settlement.speed === 'H+0' ? 'realtime' : 'qris';
  res.status(201).json({ success: true, data: publicData });
}));

// Account info for the key owner (subscription + allowed providers + balance)
router.get('/api/v1/me', requireApiKey, wrap(async (req, res) => {
  const [sub, bal, choice] = await Promise.all([
    subs.subscriptionStatus(req.apiUser.user_id, req.apiUser.role),
    ledger.getBalance(req.apiUser.user_id),
    prefs.getProviderChoice(req.apiUser.user_id)
  ]);
  res.json({
    success: true,
    data: {
      subscription: sub,
      allowed_providers: req.apiUser.allowed_providers,
      allowed_channels: req.apiUser.allowed_providers.map((p) => ({ provider: p, label: providerLabel(p) })),
      provider_choice: choice,
      provider_label: providerLabel(choice),
      balance: bal
    }
  });
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
// Strip the internal provider name from anything a client sees.
function publicView(rec, data = {}) {
  const v = { ...data };
  delete v.provider; delete v.provider_label;
  const tier = rec.tier || null;
  if (tier) v.settlement = settlementInfo(tier);
  return v;
}

router.get('/api/v1/qris/:id/status', wrap(async (req, res) => {
  const data = await qris.checkStatus(pid(req.params.id));
  const v = { ...data };
  delete v.provider; delete v.provider_label;
  if (v.transaction) { const t = { ...v.transaction }; delete t.provider; v.transaction = t; }
  res.status(data.status === 'EXPIRED' ? 410 : 200).json({ success: data.status !== 'EXPIRED', ...v });
}));

router.get('/api/v1/qris/:id', wrap(async (req, res) => {
  const rec = await invoices.getRecord(pid(req.params.id));
  if (!rec) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Invoice tidak ditemukan' });
  const v = invoices.publicView(rec);
  delete v.provider; delete v.provider_label;
  res.json({ success: true, data: { ...v, formatted_amount: new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(rec.total_amount),
    qr_image_url: `/qr/${rec.id}?format=raw`,
    expires_at: rec.expires_at.getTime(), duration_ms: rec.expires_at.getTime() - rec.created_at.getTime() } });
}));

router.get('/qr/:id', wrap(async (req, res) => {
  const rec = await invoices.getRecord(pid(req.params.id));
  if (!rec) return res.status(404).send('<h3 style="font-family:sans-serif;color:#94a3b8;text-align:center;margin-top:40vh;">Invoice tidak ditemukan</h3>');
  const expired = Date.now() > rec.expires_at.getTime() && rec.status !== 'PAID';
  if (req.query.format === 'raw' || req.query.raw === '1') {
    if (expired) return res.status(410).send('QRIS Expired');
    // Proxy the QR image so the browser never depends on a third-party host
    // (mobile networks often block api.qrserver.com, which made QR blank).
    try {
      const r = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(rec.data)}`);
      if (r.ok) {
        res.set({ 'Content-Type': r.headers.get('content-type') || 'image/png', 'Cache-Control': 'private, no-store' });
        return res.send(Buffer.from(await r.arrayBuffer()));
      }
    } catch (e) { /* fall through to redirect */ }
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
