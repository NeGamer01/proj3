'use strict';
const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');
const { withRetry } = require('../utils/retry');
const { logger } = require('../utils/logger');

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function verifySignature(body, header, secret) {
  if (!header || !secret) return false;
  const a = Buffer.from(sign(body, secret)); const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function headersFor(event, id, body, secret) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': 'QRISPay-Webhook/1.0', 'X-Webhook-Event': event, 'X-Webhook-Delivery': id };
  if (secret) h['X-Webhook-Signature'] = sign(body, secret);
  return h;
}

async function ping(url, secret) {
  const payload = { id: 'ping_' + crypto.randomBytes(4).toString('hex'), event: 'webhook.ping', timestamp: new Date().toISOString(), data: { message: 'Webhook verification ping' } };
  const body = JSON.stringify(payload);
  await axios.post(url, body, { headers: headersFor('webhook.ping', payload.id, body, secret), timeout: 5000 });
  return true;
}

async function list(userId) {
  const rows = await db.query('SELECT id, url, secret, events, created_at FROM webhooks WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return rows.map((r) => ({ id: r.id, url: r.url, has_secret: Boolean(r.secret), secret: r.secret || null, events: JSON.parse(r.events), created_at: r.created_at }));
}

async function register(userId, url, secret, events = ['payment.success']) {
  const id = 'whk_' + crypto.randomBytes(5).toString('hex');
  await db.query('INSERT INTO webhooks (id, user_id, url, secret, events) VALUES (?,?,?,?,?)', [id, userId, url, secret || null, JSON.stringify(events.length ? events : ['payment.success'])]);
  return { id, url, events, has_secret: Boolean(secret) };
}

async function remove(userId, id) {
  const r = await db.query('DELETE FROM webhooks WHERE id = ? AND user_id = ?', [id, userId]);
  return r.affectedRows > 0;
}

async function dispatchWebhookEvent(userId, event, data) {
  const hooks = (await list(userId)).filter((w) => w.events.includes('*') || w.events.includes(event));
  if (!hooks.length) return;
  const payload = { id: 'evt_' + crypto.randomBytes(5).toString('hex'), event, timestamp: new Date().toISOString(), data };
  const body = JSON.stringify(payload);
  for (const w of hooks) {
    withRetry(() => axios.post(w.url, body, { headers: headersFor(event, payload.id, body, w.secret), timeout: 8000 }), { retries: 2, delayMs: 1000 })
      .catch((e) => logger.error(`Webhook ${w.id} -> ${w.url} failed: ${e.message}`));
  }
}

module.exports = { sign, verifySignature, ping, list, register, remove, dispatchWebhookEvent };
