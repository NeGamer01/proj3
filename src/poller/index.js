'use strict';
// Background poller: per-provider, every pollerIntervalMs, ONLY while >=1 pending invoice exists.
// One fetch serves ALL pending invoices of that provider (big pooled-model efficiency win).
// Idle (zero traffic) when no pending invoices. This settles payments even if a client stops polling.
const db = require('../db');
const invoices = require('../services/invoices');
const matching = require('../services/matching');
const payments = require('../services/payments');
const providers = require('../providers');
const { config } = require('../config');
const { logger } = require('../utils/logger');

const pollers = new Map(); // provider name -> { timer, running }

async function tick(providerName) {
  const state = pollers.get(providerName);
  if (!state || state.running) return;
  state.running = true;
  try {
    const count = await invoices.countPendingForProvider(providerName);
    if (count === 0) return; // idle: no pending invoices, zero traffic
    const provider = providers.getProvider(providerName);
    if (!providers.isImplemented(providerName)) return;
    if (!await provider.getActiveSession()) return; // not connected

    const startMs = Date.now() - config.mutasiLookbackMinutes * 60 * 1000;
    const mutations = await provider.fetchRecentMutasi({ startTimeMs: startMs });
    const pending = await invoices.listPendingForProvider(providerName);
    const matches = await matching.matchMutations(providerName, mutations, pending);

    for (const { invoice, tx } of matches) {
      await payments.settle(invoice, tx).catch((e) => logger.error(`[Poller] settle ${invoice.id} failed: ${e.message}`));
    }
    // Record unmatched completed mutations for admin reconciliation.
    if (matches.length < mutations.length) {
      const matchedTxIds = new Set(matches.map((m) => m.tx.txId));
      for (const tx of mutations) {
        if (!tx.completed || matchedTxIds.has(tx.txId)) continue;
        // Only record if there's truly no pending invoice matching (avoid noise).
        await matching.recordUnmatched(providerName, tx).catch(() => {});
      }
    }
    if (matches.length) logger.info(`[Poller:${providerName}] settled ${matches.length} payment(s)`);
  } catch (e) {
    logger.error(`[Poller:${providerName}] tick failed: ${e.message}`);
  } finally {
    state.running = false;
  }
}

function startProvider(providerName) {
  if (pollers.has(providerName)) return;
  const state = { timer: null, running: false };
  pollers.set(providerName, state);
  const run = () => tick(providerName).catch(() => {});
  state.timer = setInterval(run, config.pollerIntervalMs);
  state.timer.unref();
  setTimeout(run, 10 * 1000).unref(); // first tick 10s after boot
  logger.info(`[Poller] started for ${providerName} (interval ${config.pollerIntervalMs}ms, idle-when-empty)`);
}

function start() {
  for (const name of providers.listProviders()) startProvider(name);
}

function stop() {
  for (const [, state] of pollers) if (state.timer) clearInterval(state.timer);
  pollers.clear();
}

module.exports = { start, stop, tick, startProvider };
