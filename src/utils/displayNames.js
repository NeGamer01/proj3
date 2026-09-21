'use strict';
// Public display names for the payment channels. The internal provider names
// ("gopay" / "shopeepay") stay in the registry, DB, poller and admin panel; this
// layer is what the end-user dashboard and docs show.
//
//   shopeepay -> "QRIS"         (H+1 settlement — the free default)
//   gopay     -> "QRIS Realtime" (H+0 settlement — priority-plan only)

const DISPLAY = {
  shopeepay: 'QRIS',
  gopay: 'QRIS Realtime'
};

const DISPLAY_SHORT = {
  shopeepay: 'QRIS',
  gopay: 'Realtime'
};

/** Map an internal provider name to its public label. Unknown -> raw name. */
function providerLabel(name) {
  return DISPLAY[String(name || '').toLowerCase()] || String(name || '');
}

/** Shorter label for the toggle switch itself. */
function providerLabelShort(name) {
  return DISPLAY_SHORT[String(name || '').toLowerCase()] || String(name || '');
}

/**
 * Public channel aliases -> internal provider names. The API accepts "qris" and
 * "realtime" from clients; the legacy "gopay"/"shopeepay" values keep working.
 */
const CHANNEL_ALIASES = { qris: 'shopeepay', realtime: 'gopay' };
function resolveChannelAlias(v) {
  return CHANNEL_ALIASES[String(v || '').toLowerCase()] || String(v || '').toLowerCase();
}

/**
 * Settlement speed depends ONLY on the user's subscription tier — never on the
 * provider that carried the transaction. A realtime subscriber gets H+0 even
 * when the QR was drawn from a normally-slow provider, and an unsubscribed user
 * always gets H+1 regardless of which provider processed it.
 *
 * @param {string|null} tier - 'H0' for realtime subscribers, 'H1' otherwise
 * @returns {object} { speed, label, settle_hours, estimated_settle_at }
 */
function settlementInfo(tier) {
  const realtime = tier === 'H0';
  const settleHours = realtime ? 0 : 24;
  return {
    speed: realtime ? 'H+0' : 'H+1',
    label: realtime ? 'Realtime (seketika)' : 'H+1 (hari berikutnya)',
    settle_hours: settleHours,
    // For H+0 the funds are already usable; the timestamp is informational only.
    estimated_settle_at: new Date(Date.now() + settleHours * 3600000).toISOString()
  };
}

module.exports = { DISPLAY, DISPLAY_SHORT, CHANNEL_ALIASES, providerLabel, providerLabelShort, resolveChannelAlias, settlementInfo };
