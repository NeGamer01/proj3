'use strict';
// Plans, active-subscription checks, subscription orders (paid via operator's QRIS), and provider gating.
// Adapted from nikipayv2/subscriptions.js: plans gain `providers` JSON + `tier` (H0/H1).
const crypto = require('crypto');
const db = require('../db');
const { config } = require('../config');
const { logActivity } = require('./logs');

class SubscriptionError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

function toMysql(d) { return new Date(d).toISOString().slice(0, 19).replace('T', ' '); }

function parseProviders(val) {
  if (!val) return [];
  try { const a = typeof val === 'string' ? JSON.parse(val) : val; return Array.isArray(a) ? a : []; } catch { return []; }
}

async function listPlans(includeInactive = false) {
  const rows = await db.query(`SELECT id, code, name, duration_days, price, tier, providers, active, sort_order FROM plans ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`);
  return rows.map((r) => ({ ...r, providers: parseProviders(r.providers) }));
}

async function upsertPlan({ id, code, name, duration_days, price, tier = 'H1', providers = ['shopeepay'], active = 1, sort_order = 0 }) {
  const days = Number(duration_days); const p = Number(price);
  if (!name || !(days > 0) || !(p >= 0)) throw new SubscriptionError('Nama, durasi (hari) dan harga wajib diisi');
  const providersArr = Array.isArray(providers) && providers.length ? providers : ['shopeepay'];
  if (id) {
    await db.query('UPDATE plans SET name=?, duration_days=?, price=?, tier=?, providers=?, active=?, sort_order=? WHERE id=?',
      [name, days, p, tier, JSON.stringify(providersArr), active ? 1 : 0, Number(sort_order) || 0, id]);
    return db.one('SELECT * FROM plans WHERE id = ?', [id]);
  }
  const c = String(code || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
  const r = await db.query('INSERT INTO plans (code, name, duration_days, price, tier, providers, active, sort_order) VALUES (?,?,?,?,?,?,?,?)',
    [c, name, days, p, tier, JSON.stringify(providersArr), active ? 1 : 0, Number(sort_order) || 0]);
  return db.one('SELECT * FROM plans WHERE id = ?', [r.insertId]);
}

/** Active subscription row (ends_at in the future) or null. Admins are always "active". */
async function getActiveSubscription(userId) {
  return db.one(
    `SELECT s.id, s.starts_at, s.ends_at, s.source, p.name plan_name, p.code plan_code, p.tier, p.providers
     FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = ? AND s.ends_at > UTC_TIMESTAMP() ORDER BY s.ends_at DESC LIMIT 1`, [userId]);
}

async function subscriptionStatus(userId, role) {
  const active = await getActiveSubscription(userId);
  const last = active || await db.one('SELECT ends_at FROM subscriptions WHERE user_id = ? ORDER BY ends_at DESC LIMIT 1', [userId]);
  return {
    active: role === 'admin' || Boolean(active),
    unlimited: role === 'admin',
    plan: active?.plan_name || null,
    tier: active?.tier || null,
    providers: role === 'admin' ? ['gopay', 'shopeepay'] : (active ? parseProviders(active.providers) : ['shopeepay']),
    ends_at: active?.ends_at || last?.ends_at || null,
    days_left: active ? Math.max(0, Math.ceil((new Date(active.ends_at + 'Z').getTime() - Date.now()) / 86400000)) : 0
  };
}

/** Resolve which providers a user is permitted to use. Free tier default = shopeepay only. */
async function allowedProviders(userId, role) {
  if (role === 'admin') return ['gopay', 'shopeepay'];
  const sub = await getActiveSubscription(userId);
  if (!sub) return ['shopeepay']; // free tier (H+1)
  return parseProviders(sub.providers);
}

/** Extends from the current end date if still active, otherwise from now. */
async function grant(userId, { planId = null, days, source = 'manual', note = null }) {
  const active = await getActiveSubscription(userId);
  const start = active ? new Date(active.ends_at + 'Z') : new Date();
  const end = new Date(start.getTime() + Number(days) * 86400000);
  await db.query('INSERT INTO subscriptions (user_id, plan_id, starts_at, ends_at, source, note) VALUES (?,?,?,?,?,?)',
    [userId, planId, toMysql(start), toMysql(end), source, note]);
  logActivity(userId, 'SUCCESS', `Langganan +${days} hari (${source}) sampai ${end.toISOString()}`);
  return { starts_at: start.toISOString(), ends_at: end.toISOString() };
}

async function listSubscriptions(userId) {
  return db.query(`SELECT s.id, s.starts_at, s.ends_at, s.source, s.note, p.name plan_name, p.tier FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ? ORDER BY s.id DESC LIMIT 50`, [userId]);
}

// ── orders (paid through the operator's own QRIS — pooled billing) ──

/** The operator user who owns the billing provider accounts (defaults to first admin). */
async function getBillingAdmin() {
  const id = (await db.one("SELECT value FROM app_settings WHERE `key` = 'billing_admin_user_id'"))?.value;
  if (id) return db.one("SELECT id FROM users WHERE id = ? AND role = 'admin'", [id]);
  return db.one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
}

/** Creates an order and its QRIS on the operator's account. createInvoice injected to avoid circular import. */
async function createOrder(userId, planId, createInvoice) {
  const plan = await db.one('SELECT * FROM plans WHERE id = ? AND active = 1', [planId]);
  if (!plan) throw new SubscriptionError('Paket tidak ditemukan', 404, 'PLAN_NOT_FOUND');
  if (plan.price <= 0) throw new SubscriptionError('Paket ini gratis, hubungi admin', 400, 'FREE_PLAN');
  const admin = await getBillingAdmin();
  if (!admin) throw new SubscriptionError('Pembayaran belum dikonfigurasi admin', 503, 'BILLING_NOT_READY');

  // Expire stale pending orders for this user
  await db.query("UPDATE subscription_orders SET status = 'EXPIRED' WHERE user_id = ? AND status = 'PENDING' AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)", [userId]);
  const pending = await db.one("SELECT * FROM subscription_orders WHERE user_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1", [userId]);
  if (pending) return getOrder(userId, pending.id);

  const orderId = 'SUB' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();

  let invoice;
  try {
    // Subscription payments bill to the operator's gopay account (fast settle for the operator).
    invoice = await createInvoice(admin.id, { amount: plan.price, provider: 'gopay', reference: orderId, kind: 'subscription', expiryMs: config.subscriptionQrisExpiryMs });
  } catch (e) {
    throw new SubscriptionError(`Gagal membuat QRIS pembayaran: ${e.message}`, 503, 'BILLING_QRIS_FAILED');
  }
  await db.query('INSERT INTO subscription_orders (id, user_id, plan_id, amount, qris_id) VALUES (?,?,?,?,?)', [orderId, userId, plan.id, invoice.total_amount, invoice.qris_id]);
  logActivity(userId, 'INFO', `Order langganan ${orderId} (${plan.name}) Rp ${invoice.total_amount}`);
  return getOrder(userId, orderId);
}

async function getOrder(userId, orderId) {
  const o = await db.one(
    `SELECT o.*, p.name plan_name, p.duration_days, i.data qris_code, i.total_amount, i.expires_at qris_expires_at, i.status qris_status, i.provider
     FROM subscription_orders o JOIN plans p ON p.id = o.plan_id LEFT JOIN invoices i ON i.id = o.qris_id
     WHERE o.id = ? AND o.user_id = ?`, [orderId, userId]);
  if (!o) throw new SubscriptionError('Order tidak ditemukan', 404, 'ORDER_NOT_FOUND');
  return {
    id: o.id, plan_name: o.plan_name, duration_days: o.duration_days, amount: o.total_amount || o.amount, provider: o.provider,
    status: o.status, qris_id: o.qris_id, qris_code: o.qris_code, qris_expires_at: o.qris_expires_at, created_at: o.created_at, paid_at: o.paid_at
  };
}

/** Called after the order's invoice becomes PAID. Idempotent (FOR UPDATE). */
async function settleOrder(orderId) {
  return db.tx(async (q) => {
    const rows = await q('SELECT * FROM subscription_orders WHERE id = ? FOR UPDATE', [orderId]);
    const o = rows[0];
    if (!o || o.status !== 'PENDING') return o?.status || null;
    const plan = (await q('SELECT * FROM plans WHERE id = ?', [o.plan_id]))[0];
    const active = (await q('SELECT ends_at FROM subscriptions WHERE user_id = ? AND ends_at > UTC_TIMESTAMP() ORDER BY ends_at DESC LIMIT 1', [o.user_id]))[0];
    const start = active ? new Date(active.ends_at + 'Z') : new Date();
    const end = new Date(start.getTime() + plan.duration_days * 86400000);
    await q('INSERT INTO subscriptions (user_id, plan_id, starts_at, ends_at, source, note) VALUES (?,?,?,?,?,?)', [o.user_id, plan.id, toMysql(start), toMysql(end), 'payment', orderId]);
    await q("UPDATE subscription_orders SET status = 'PAID', paid_at = UTC_TIMESTAMP() WHERE id = ?", [orderId]);
    logActivity(o.user_id, 'SUCCESS', `Order ${orderId} lunas — langganan ${plan.name} aktif sampai ${end.toISOString()}`);
    return 'PAID';
  });
}

async function listOrders({ userId = null, limit = 50 }) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  if (userId) return db.query(`SELECT o.id, o.amount, o.status, o.created_at, o.paid_at, p.name plan_name FROM subscription_orders o JOIN plans p ON p.id = o.plan_id WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT ${lim}`, [userId]);
  return db.query(`SELECT o.id, o.user_id, u.email, o.amount, o.status, o.created_at, o.paid_at, p.name plan_name FROM subscription_orders o JOIN plans p ON p.id = o.plan_id JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT ${lim}`);
}

module.exports = { SubscriptionError, parseProviders, listPlans, upsertPlan, getActiveSubscription, subscriptionStatus, allowedProviders, grant, listSubscriptions, createOrder, getOrder, settleOrder, listOrders, getBillingAdmin };
