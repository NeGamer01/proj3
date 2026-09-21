'use strict';
// Owner/admin API. Mounted at /admin/api. Requires admin cookie session.
const { Router } = require('express');
const db = require('../db');
const { requireAdmin } = require('../middlewares/auth');
const subs = require('../services/subscriptions');
const invoices = require('../services/invoices');
const payments = require('../services/payments');
const accounts = require('../services/providerAccounts');
const providers = require('../providers');
const withdrawals = require('../services/withdrawals');
const ledger = require('../services/ledger');
const { listLogs, logActivity } = require('../services/logs');
const { providerLabel } = require('../utils/displayNames');
const { hashPassword } = require('../services/users');

const router = Router();
router.use(requireAdmin);
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  res.status(e.status || 500).json({ success: false, code: e.code || 'INTERNAL_ERROR', message: e.message || 'Internal error' });
});
const pid = (p) => (Array.isArray(p) ? p[0] : p);
const strid = (p) => (Array.isArray(p) ? p[0] : p) || '';

router.get('/overview', wrap(async (req, res) => {
  const [counts, st, revenue, recentOrders, provs, recentWithdrawals] = await Promise.all([
    db.one(`SELECT (SELECT COUNT(*) FROM users WHERE role='user') users,
                   (SELECT COUNT(DISTINCT user_id) FROM subscriptions WHERE ends_at > UTC_TIMESTAMP()) active_subs,
                   (SELECT COUNT(*) FROM api_keys WHERE active=1) api_keys,
                   (SELECT COUNT(*) FROM invoices WHERE status='PENDING') pending_invoices,
                   (SELECT COUNT(*) FROM withdrawals WHERE status='requested') pending_withdrawals`),
    invoices.stats(null, req.query.days || 30),
    db.one("SELECT COALESCE(SUM(amount),0) total, COUNT(*) orders FROM subscription_orders WHERE status='PAID' AND paid_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)"),
    subs.listOrders({ limit: 15 }),
    Promise.all(providers.listProviders().map(async (n) => ({ name: n, implemented: providers.isImplemented(n), summary: await providers.getProvider(n).summary() }))),
    withdrawals.listAll({ limit: 10, status: 'requested' })
  ]);
  res.json({ success: true, data: { counts, stats: st, revenue_30d: revenue, recent_orders: recentOrders, providers: provs, pending_withdrawals: recentWithdrawals } });
}));

// ── users ──
router.get('/users', wrap(async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at,
            (SELECT MAX(ends_at) FROM subscriptions s WHERE s.user_id = u.id) sub_ends_at,
            (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.active = 1) api_keys,
            (SELECT COUNT(*) FROM invoices x WHERE x.user_id = u.id AND x.status = 'PAID') paid_invoices,
            (SELECT balance FROM user_balances b WHERE b.user_id = u.id) balance,
            (SELECT held FROM user_balances b WHERE b.user_id = u.id) held
     FROM users u WHERE u.email LIKE ? OR u.name LIKE ? ORDER BY u.id DESC LIMIT 200`, [q, q]);
  res.json({ success: true, data: rows.map((r) => ({ ...r, subscription_active: Boolean(r.sub_ends_at && new Date(r.sub_ends_at + 'Z') > new Date()) })) });
}));

router.get('/users/:id', wrap(async (req, res) => {
  const id = pid(req.params.id);
  const user = await db.one('SELECT id, email, name, role, status, created_at, last_login_at FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
  const [subscription, history, orders, keys, recent, logs, bal, ledgerEntries] = await Promise.all([
    subs.subscriptionStatus(id, user.role), subs.listSubscriptions(id), subs.listOrders({ userId: id, limit: 20 }),
    db.query('SELECT id, key_prefix, label, active, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY id DESC', [id]),
    invoices.listForUser(id, { limit: 20 }), listLogs({ userId: id, limit: 50 }),
    ledger.getBalance(id), ledger.listEntries(id, { limit: 50 })
  ]);
  res.json({ success: true, data: { user, subscription, history, orders, api_keys: keys, recent_invoices: recent, balance: bal, ledger: ledgerEntries, logs } });
}));

router.post('/users/:id/status', wrap(async (req, res) => {
  const id = pid(req.params.id); const status = req.body?.status === 'blocked' ? 'blocked' : 'active';
  if (id === req.user.id) return res.status(400).json({ success: false, message: 'Tidak bisa memblokir diri sendiri' });
  await db.query("UPDATE users SET status = ? WHERE id = ? AND role = 'user'", [status, id]);
  logActivity(id, 'WARNING', `Status akun diubah admin: ${status}`);
  res.json({ success: true });
}));

router.post('/users/:id/subscription', wrap(async (req, res) => {
  const id = pid(req.params.id); const days = Number(req.body?.days);
  if (!(days > 0 && days <= 3650)) return res.status(400).json({ success: false, message: 'days harus 1–3650' });
  const planId = req.body?.plan_id != null && req.body?.plan_id !== '' ? pid(req.body.plan_id) : null;
  const r = await subs.grant(id, { planId, days, source: 'manual', note: req.body?.note ? String(req.body.note).slice(0, 255) : `oleh admin ${req.user.email}` });
  res.json({ success: true, data: r });
}));

router.post('/users/:id/password', wrap(async (req, res) => {
  const pw = String(req.body?.password || '');
  if (pw.length < 8) return res.status(400).json({ success: false, message: 'Password minimal 8 karakter' });
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(pw), pid(req.params.id)]);
  res.json({ success: true });
}));

router.delete('/users/:id', wrap(async (req, res) => {
  const id = pid(req.params.id);
  if (id === req.user.id) return res.status(400).json({ success: false, message: 'Tidak bisa menghapus diri sendiri' });
  const r = await db.query("DELETE FROM users WHERE id = ? AND role = 'user'", [id]);
  res.status(r.affectedRows ? 200 : 404).json({ success: Boolean(r.affectedRows) });
}));

// ── plans (with providers + tier) ──
router.get('/plans', wrap(async (_req, res) => res.json({ success: true, data: await subs.listPlans(true) })));
router.post('/plans', wrap(async (req, res) => res.status(201).json({ success: true, data: await subs.upsertPlan(req.body || {}) })));
router.put('/plans/:id', wrap(async (req, res) => res.json({ success: true, data: await subs.upsertPlan({ ...(req.body || {}), id: pid(req.params.id) }) })));
router.delete('/plans/:id', wrap(async (req, res) => {
  const r = await subs.deletePlan(pid(req.params.id));
  logActivity(req.user.id, 'INFO', `Paket #${pid(req.params.id)} dihapus oleh admin ${req.user.email}`);
  res.json({ success: true, data: r });
}));

// ── providers (operator accounts: configure static QR, OTP login, health) ──
router.get('/providers', wrap(async (_req, res) => {
  const channelRouter = require('../services/channelRouter');
  const health = require('../services/providerHealth');
  const data = await Promise.all(providers.listProviders().map(async (n) => {
    const h = health.getStatus(n);
    const connected = await channelRouter.isConnected(n).catch(() => false);
    return {
      name: n,
      label: providerLabel(n),
      implemented: providers.isImplemented(n),
      health: h,                 // { state, reason, lastErrorAt, downSince }
      connected,                 // session + static QR mounted?
      realtime_capable: channelRouter.REALTIME_CAPABLE.includes(n),
      summary: await providers.getProvider(n).summary()
    };
  }));
  res.json({ success: true, data });
}));

// Admin manual override: force a provider UP/DOWN (bypassing auto detection).
// POST /admin/api/providers/:name/health { state: 'up'|'down'|'auto', reason? }
router.post('/providers/:name/health', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (!providers.listProviders().includes(name)) return res.status(400).json({ success: false, message: 'Provider tidak dikenal' });
  const health = require('../services/providerHealth');
  const state = String(req.body?.state || '').toLowerCase();
  if (!['up', 'down', 'auto'].includes(state)) return res.status(400).json({ success: false, message: "state harus 'up', 'down', atau 'auto'" });
  health.setOverride(name, state === 'auto' ? null : state, req.body?.reason || (state === 'down' ? 'Dipaksa admin' : 'Dipulihkan admin'));
  logActivity(req.user.id, 'INFO', `Status ${providerLabel(name)} diatur admin = ${state}`);
  res.json({ success: true, data: health.getStatus(name) });
}));

router.put('/providers/:name/static-qris', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (!providers.listProviders().includes(name)) return res.status(400).json({ success: false, message: 'Provider tidak dikenal' });
  const qrisStatic = String(req.body?.qris_static || '').trim();
  if (qrisStatic && !invoices.isValidStaticQris(qrisStatic)) return res.status(400).json({ success: false, code: 'INVALID_STATIC_QRIS', message: 'QRIS statis tidak valid' });
  await accounts.setStaticQris(name, qrisStatic || null);
  logActivity(req.user.id, 'INFO', `QRIS statis ${name} ${qrisStatic ? 'dipasang' : 'dicabut'} oleh admin`);
  res.json({ success: true, data: { qris_configured: Boolean(qrisStatic) } });
}));

// pending OTP handshakes: provider name -> { phone, otpToken, deviceId, expiresAt }
// OTP request & verify happen on separate requests; we hold the GoBiz otp_token/deviceId
// in-memory so the admin only ever types the SMS code (like nikipayv2's wizard).
const pendingOtps = new Map();

// ── ShopeePay B1: paste manual B: token + pick store ──

// Install a manually pasted B:... merchant token. Discovers stores and returns
// them so the admin can pick one. The token is stored encrypted (like GoPay's
// access_token) and never logged.
router.post('/providers/:name/token', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (!providers.listProviders().includes(name)) return res.status(400).json({ success: false, message: 'Provider tidak dikenal' });
  const prov = providers.getProvider(name);
  if (typeof prov.setManualToken !== 'function') return res.status(400).json({ success: false, message: 'Provider ini tidak mendukung token manual' });
  const token = String(req.body?.token || '').trim();
  const storeId = req.body?.store_id ? String(req.body.store_id) : null;
  if (!token) return res.status(400).json({ success: false, code: 'BAD_TOKEN', message: 'Token tidak boleh kosong' });
  try {
    const r = await prov.setManualToken(token, { storeId });
    logActivity(req.user.id, 'SUCCESS', `Provider ${name} token B1 dipasang (store ${r.store_id})`);
    res.json({ success: true, data: r });
  } catch (e) {
    res.status(e.status || 502).json({ success: false, code: e.code, message: e.message });
  }
}));

// List stores for the currently installed token (store picker).
router.get('/providers/:name/stores', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (!providers.listProviders().includes(name)) return res.status(400).json({ success: false, message: 'Provider tidak dikenal' });
  const prov = providers.getProvider(name);
  if (typeof prov.listStoresForCurrentToken !== 'function') return res.status(400).json({ success: false, message: 'Provider ini tidak mendukung store list' });
  try {
    const s = await prov.summary();
    res.json({ success: true, data: { stores: await prov.listStoresForCurrentToken(), current_store_id: s?.store_id || null } });
  } catch (e) {
    res.status(e.status || 502).json({ success: false, code: e.code, message: e.message });
  }
}));

// Point the session at another store id.
router.post('/providers/:name/store', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (!providers.listProviders().includes(name)) return res.status(400).json({ success: false, message: 'Provider tidak dikenal' });
  const prov = providers.getProvider(name);
  if (typeof prov.selectStore !== 'function') return res.status(400).json({ success: false, message: 'Provider ini tidak mendukung store selection' });
  const storeId = String(req.body?.store_id || '').trim();
  if (!storeId) return res.status(400).json({ success: false, code: 'BAD_STORE', message: 'store_id tidak boleh kosong' });
  try {
    const r = await prov.selectStore(storeId);
    logActivity(req.user.id, 'INFO', `Provider ${name} store dipilih: ${storeId}`);
    res.json({ success: true, data: r });
  } catch (e) {
    res.status(e.status || 502).json({ success: false, code: e.code, message: e.message });
  }
}));

// Device-risk blob (see docs/shopee/device-risk.md): without a real browser
// fingerprint the issuer returns a *degraded* risk token and OTP delivery is
// silently suppressed. Admin pastes their own captured blob; stored on the
// provider instance (in-memory, per process).
router.post('/providers/:name/device-report', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (!providers.listProviders().includes(name)) return res.status(400).json({ success: false, message: 'Provider tidak dikenal' });
  const prov = providers.getProvider(name);
  if (typeof prov.setDeviceReport !== 'function') return res.status(400).json({ success: false, message: 'Provider ini tidak mendukung device report' });
  const blob = typeof req.body?.blob === 'string' ? req.body.blob.trim() : '';
  if (!blob || blob.length < 50) return res.status(400).json({ success: false, code: 'BAD_REPORT', message: 'Device report terlalu pendek / tidak valid' });
  try {
    prov.setDeviceReport(blob);
    logActivity(req.user.id, 'INFO', `Provider ${name} device-risk blob dipasang (${blob.length} bytes)`);
    res.json({ success: true, data: { length: blob.length } });
  } catch (e) {
    res.status(e.status || 502).json({ success: false, code: e.code, message: e.message });
  }
}));

router.post('/providers/:name/otp', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (!providers.listProviders().includes(name)) return res.status(400).json({ success: false, message: 'Provider tidak dikenal' });
  const prov = providers.getProvider(name);
  try {
    if (name === 'shopeepay') {
      // B2: 7-call chain. password optional (only for password-protected accounts);
      // channel 1 SMS, 2 voice, 3 WhatsApp (default), 4 email, 5 Zalo.
      const r = await prov.requestOtp(String(req.body?.phone || ''), {
        password: req.body?.password ? String(req.body.password) : null,
        channel: req.body?.channel ? Number(req.body.channel) : null
      });
      res.json({ success: true, data: r });
    } else {
      const r = await prov.requestOtp(req.body?.phone);
      pendingOtps.set(name, { phone: r.phone, otpToken: r.otpToken, deviceId: r.deviceId, expiresAt: Date.now() + r.expiresIn * 1000 });
      res.json({ success: true, data: { phone: r.phone, expiresIn: r.expiresIn } });
    }
  } catch (e) { res.status(e.status || 502).json({ success: false, code: e.code, message: e.message }); }
}));

router.post('/providers/:name/verify', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (!providers.listProviders().includes(name)) return res.status(400).json({ success: false, message: 'Provider tidak dikenal' });
  const prov = providers.getProvider(name);
  if (name === 'shopeepay') {
    // B2: verify the code -> auto-complete when merchant is unambiguous,
    // else return merchant_selection_required (admin picks, no second OTP).
    try {
      const r = await prov.verifyOtp({
        otp: String(req.body?.otp || ''),
        merchantId: req.body?.merchant_id ? String(req.body.merchant_id) : null
      });
      if (r.merchant_selection_required) {
        res.json({ success: true, data: { merchant_selection_required: true, merchants: r.merchants } });
      } else {
        logActivity(req.user.id, 'SUCCESS', `ShopeePay B2 login OK (merchant ${r.merchant_id})`);
        res.json({ success: true, data: await prov.summary() });
      }
    } catch (e) { res.status(e.status || 502).json({ success: false, code: e.code, message: e.message }); }
    return;
  }
  const pending = pendingOtps.get(name);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingOtps.delete(name);
    return res.status(400).json({ success: false, code: 'OTP_NOT_REQUESTED', message: 'Minta OTP dulu sebelum verifikasi (sesi OTP sudah habis).' });
  }
  try {
    const session = await prov.verifyOtp({ phone: pending.phone, otpToken: pending.otpToken, otp: req.body?.otp, deviceId: pending.deviceId });
    pendingOtps.delete(name);
    logActivity(req.user.id, 'SUCCESS', `Provider ${name} login OK (${session.outlet_name || session.phone_number || ''})`);
    res.json({ success: true, data: await prov.summary() });
  } catch (e) { res.status(e.status || 502).json({ success: false, code: e.code, message: e.message }); }
}));

// ShopeePay B2 step 3: finish a multi-merchant login with the admin's choice.
router.post('/providers/:name/complete-login', wrap(async (req, res) => {
  const name = strid(req.params.name);
  if (name !== 'shopeepay') return res.status(400).json({ success: false, message: 'Hanya ShopeePay yang memakai complete-login' });
  const prov = providers.getProvider(name);
  const merchantId = String(req.body?.merchant_id || '').trim();
  if (!merchantId) return res.status(400).json({ success: false, code: 'BAD_MERCHANT', message: 'merchant_id tidak boleh kosong' });
  try {
    const r = await prov.completeOtpLogin({ merchantId });
    logActivity(req.user.id, 'SUCCESS', `ShopeePay B2 login OK (merchant ${r.merchant_id})`);
    res.json({ success: true, data: await prov.summary() });
  } catch (e) { res.status(e.status || 502).json({ success: false, code: e.code, message: e.message }); }
}));

router.delete('/providers/:name', wrap(async (req, res) => {
  const name = strid(req.params.name);
  await accounts.deleteSession(name);
  logActivity(req.user.id, 'WARNING', `Session ${name} dicabut admin`);
  res.json({ success: true });
}));

// ── orders & invoices ──
router.get('/orders', wrap(async (req, res) => res.json({ success: true, data: await subs.listOrders({ limit: req.query.limit || 100 }) })));
router.post('/orders/:id/settle', wrap(async (req, res) => {
  const id = strid(req.params.id);
  const status = await subs.settleOrder(id);
  if (!status) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
  res.json({ success: true, data: { status } });
}));
router.get('/qris', wrap(async (req, res) => {
  const lim = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = await db.query(`SELECT i.id, i.user_id, u.email, i.provider, i.trx_id, i.base_amount, i.unique_code, i.total_amount, i.reference, i.kind, i.status, i.created_at FROM invoices i JOIN users u ON u.id = i.user_id ORDER BY i.created_at DESC LIMIT ${lim}`);
  res.json({ success: true, data: rows });
}));
router.post('/qris/:id/mark-paid', wrap(async (req, res) => res.json({ success: true, data: await payments.manualMarkPaid(req.user.id, String(strid(req.params.id)), 'admin', 'admin') })));

// ── withdrawals (process / reject) ──
router.get('/withdrawals', wrap(async (req, res) => res.json({ success: true, data: await withdrawals.listAll({ limit: req.query.limit || 100, status: req.query.status }) })));
router.post('/withdrawals/:id/process', wrap(async (req, res) => res.json({ success: true, data: await withdrawals.process(strid(req.params.id), req.user.email) })));
router.post('/withdrawals/:id/reject', wrap(async (req, res) => res.json({ success: true, data: await withdrawals.reject(strid(req.params.id), req.body?.reason, req.user.email) })));

// ── unmatched payments (admin reconcile) ──
router.get('/unmatched', wrap(async (req, res) => {
  const lim = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = await db.query(`SELECT * FROM unmatched_payments WHERE status = 'pending' ORDER BY id DESC LIMIT ${lim}`);
  res.json({ success: true, data: rows.map((r) => ({ ...r, raw: r.raw_json ? JSON.parse(r.raw_json) : null })) });
}));
router.post('/unmatched/:id/resolve', wrap(async (req, res) => {
  const id = pid(req.params.id);
  const qrisId = req.body?.qris_id ? String(req.body.qris_id) : null;
  await db.query("UPDATE unmatched_payments SET status = 'resolved', resolved_to_qris_id = ? WHERE id = ?", [qrisId, id]);
  logActivity(req.user.id, 'INFO', `Unmatched ${id} di-resolve${qrisId ? ' ke invoice ' + qrisId : ''}`);
  res.json({ success: true });
}));

router.get('/logs', wrap(async (req, res) => res.json({ success: true, data: await listLogs({ limit: req.query.limit || 100 }) })));

module.exports = router;
