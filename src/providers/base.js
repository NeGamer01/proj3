'use strict';
// Provider interface contract. Both gopay & shopeepay implement this so that
// matching / payments / routes never branch on provider.
//
//   interface Provider {
//     name: 'gopay' | 'shopeepay'
//     // Auto-refresh near expiry where possible; returns null if dead/unconfigured.
//     getActiveSession(): Promise<Session | null>
//     // Persist a renewed session.
//     saveSession(session): Promise<void>
//     // Fetch recent mutations, normalized to whole-rupiah ints.
//     fetchRecentMutasi({ startTimeMs }): Promise<NormalizedTx[]>
//     // Operator's static QR for this provider (for dynamic injection).
//     staticQris(): Promise<string | null>
//     // Request OTP (GoPay only in phase 1; ShopeePay in phase 2 B2).
//     requestOtp?(phone, opts?): Promise<any>
//     // Verify OTP and persist session.
//     verifyOtp?(challenge, otp): Promise<Session>
//     // Refresh a session without OTP (GoPay yes; ShopeePay B1 no -> throws/returns null).
//     refresh?(session): Promise<Session | null>
//     // Health summary for admin.
//     summary(): Promise<object>
//   }
//
//   NormalizedTx = { txId, amount_idr (INT rupiah), create_time_ms, completed, raw }
//
// IMPORTANT: amount_idr is WHOLE RUPIAH for both providers. GoPay normalizes sen->rupiah;
// ShopeePay parses grouped strings ("409.662" -> 409662). The matcher does an exact
// amount_idr === invoice.total_amount comparison.

/** Base class with shared helpers. */
class BaseProvider {
  constructor(name, displayName) {
    this.name = name;
    this.displayName = displayName;
  }
}

module.exports = { BaseProvider };
