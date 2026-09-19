'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is required (see .env.example)`);
  return v;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_GATEWAY_URL || '').replace(/\/$/, ''),
  appName: process.env.APP_NAME || 'QRISPay',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'qrispay',
    socketPath: process.env.DB_SOCKET || undefined
  },
  sessionSecret: process.env.SESSION_SECRET || '',
  masterKey: process.env.PROVIDER_MASTER_KEY || '',
  admin: {
    email: (process.env.ADMIN_EMAIL || '').toLowerCase().trim(),
    password: process.env.ADMIN_PASSWORD || ''
  },
  qrisExpiryMs: Number(process.env.QRIS_EXPIRY_MS || 5 * 60 * 1000),
  subscriptionQrisExpiryMs: Number(process.env.SUBSCRIPTION_QRIS_EXPIRY_MS || 15 * 60 * 1000),
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE || 60),
  registrationOpen: (process.env.REGISTRATION_OPEN || 'true') !== 'false',
  uniqueCode: {
    min: Number(process.env.UNIQUE_CODE_MIN || 21),
    max: Number(process.env.UNIQUE_CODE_MAX || 200)
  },
  pollerIntervalMs: Number(process.env.POLLER_INTERVAL_MS || 10000),
  mutasiLookbackMinutes: Number(process.env.MUTASI_LOOKBACK_MINUTES || 15),
  unmatchedGraceMinutes: Number(process.env.UNMATCHED_GRACE_MINUTES || 10)
};

function validate() {
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters (node scripts/gen-secrets.js)');
  }
  if (!config.masterKey || config.masterKey.length !== 64) {
    throw new Error('PROVIDER_MASTER_KEY must be 64 hex characters (node scripts/gen-secrets.js)');
  }
  if (config.uniqueCode.min < 1 || config.uniqueCode.max < config.uniqueCode.min) {
    throw new Error('UNIQUE_CODE_MIN/UNIQUE_CODE_MAX invalid');
  }
}

module.exports = { config, validate, required };
