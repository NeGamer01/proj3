'use strict';
const { config, validate } = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const { logger } = require('./utils/logger');
const users = require('./services/users');
const invoices = require('./services/invoices');
const matching = require('./services/matching');
const { pruneLogs } = require('./services/logs');
const poller = require('./poller');
const providers = require('./providers');
const accounts = require('./services/providerAccounts');
const ledger = require('./services/ledger');

async function main() {
  validate();
  await db.ping();
  await db.migrate();
  const adminState = await users.ensureAdminFromEnv();
  logger.info(`[Startup] DB ready (${config.db.database}); admin account: ${adminState}`);

  const app = createApp();
  const server = app.listen(config.port, () => logger.log('SYSTEM', `${config.appName} running on port ${config.port} (${config.env})`));

  // background jobs
  setInterval(() => invoices.expireStale().catch(() => {}), 60 * 1000).unref();
  setInterval(() => matching.cleanOldClaims().catch(() => {}), 60 * 60 * 1000).unref();
  setInterval(() => pruneLogs().catch(() => {}), 6 * 60 * 60 * 1000).unref();
  // Refresh GoPay operator token every 6h (GoPay supports refresh_token).
  setInterval(async () => {
    for (const name of providers.listProviders()) {
      if (!providers.isImplemented(name)) continue;
      const prov = providers.getProvider(name);
      const s = await prov.getActiveSession();
      if (s && accounts.isExpired(s) && prov.refresh) {
        await prov.refresh(s).catch((e) => logger.error(`[Refresh] ${name}: ${e.message}`));
      }
    }
  }, 6 * 60 * 60 * 1000).unref();
  // Daily 17:00 WIB (10:00 UTC) settlement sweep: release ALL unreleased H+1
  // holds regardless of age. Note this overrides the per-hold release_at — a
  // payment landing at 16:59 WIB is released one minute later by design.
  const HOLD_SWEEP_UTC_HOUR = 10; // 17:00 WIB
  const scheduleHoldSweep = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(HOLD_SWEEP_UTC_HOUR, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    const delayMs = next.getTime() - now.getTime();
    setTimeout(() => {
      ledger.releaseDueHolds({ mode: 'all', limit: 1000 })
        .then((r) => { if (r.released_count) logger.info(`[HoldSweep] released ${r.released_count} hold(s), Rp ${r.total_amount}`); })
        .catch((e) => logger.error(`[HoldSweep] ${e.message}`))
        .finally(scheduleHoldSweep); // re-arm for the next day
    }, delayMs).unref();
  };
  scheduleHoldSweep();
  // Start the background poller (idle-when-empty).
  poller.start();

  const shutdown = () => { poller.stop(); server.close(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

module.exports = { main };
