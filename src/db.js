'use strict';
// QRISPay DB: mysql2 pool + schema (operator-pooled multi-provider).
const mysql = require('mysql2/promise');
const { config } = require('./config');
const { logger } = require('./utils/logger');

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    ...config.db,
    waitForConnections: true,
    connectionLimit: 5,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    namedPlaceholders: false
  });
  return pool;
}

/** Run a parameterized query; returns rows. */
async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** Return first row or null. */
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/** Run a function inside a transaction (BEGIN/COMMIT/ROLLBACK).
 *  `q` is a bound executor on the held connection (use inside fn). */
async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const q = async (sql, params = []) => (await conn.execute(sql, params))[0];
    const result = await fn(q, conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ── Schema (operator-pooled deltas vs nikipayv2) ──
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(120) NOT NULL,
    role ENUM('user','admin') NOT NULL DEFAULT 'user',
    status ENUM('active','blocked') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Operator-owned provider accounts (ONE row per provider). Replaces nikipayv2's
  // per-user gobiz_sessions + merchant_settings (static QR lives here too).
  `CREATE TABLE IF NOT EXISTS provider_accounts (
    name VARCHAR(24) PRIMARY KEY,
    display_name VARCHAR(120) NOT NULL,
    token_encrypted TEXT NULL,
    cookies_json MEDIUMTEXT NULL,
    merchant_id VARCHAR(64) NULL,
    store_id VARCHAR(64) NULL,
    qris_static TEXT NULL,
    phone VARCHAR(20) NULL,
    outlet_name VARCHAR(190) NULL,
    expires_at DATETIME NULL,
    status ENUM('active','expired','unconfigured') NOT NULL DEFAULT 'unconfigured',
    last_checked_at DATETIME NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Subscription packages (admin-managed). Gains providers JSON + tier (H0/H1).
  `CREATE TABLE IF NOT EXISTS plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(32) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    duration_days INT NOT NULL,
    price INT NOT NULL,
    tier ENUM('H0','H1') NOT NULL DEFAULT 'H1',
    providers JSON NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    sort_order INT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    plan_id INT NULL,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    source ENUM('payment','manual') NOT NULL DEFAULT 'payment',
    note VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sub_user (user_id, ends_at),
    CONSTRAINT fk_sub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS subscription_orders (
    id VARCHAR(24) PRIMARY KEY,
    user_id INT NOT NULL,
    plan_id INT NOT NULL,
    amount INT NOT NULL,
    qris_id VARCHAR(16) NULL,
    status ENUM('PENDING','PAID','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at DATETIME NULL,
    INDEX idx_so_user (user_id, created_at),
    CONSTRAINT fk_so_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS api_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    key_hash CHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(16) NOT NULL,
    label VARCHAR(80) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    INDEX idx_ak_user (user_id),
    CONSTRAINT fk_ak_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Invoices (was qris). total_amount = base_amount + unique_code (global-unique while PENDING).
  `CREATE TABLE IF NOT EXISTS invoices (
    id VARCHAR(16) PRIMARY KEY,
    user_id INT NOT NULL,
    provider VARCHAR(24) NOT NULL,
    trx_id VARCHAR(32) NOT NULL,
    base_amount INT NOT NULL,
    unique_code INT NOT NULL,
    total_amount INT NOT NULL,
    data TEXT NOT NULL,
    reference VARCHAR(255) NULL,
    attributes TEXT NULL,
    callback_url VARCHAR(500) NULL,
    kind ENUM('api','subscription','test') NOT NULL DEFAULT 'api',
    status ENUM('PENDING','PAID','EXPIRED') NOT NULL DEFAULT 'PENDING',
    transaction_json TEXT NULL,
    created_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    paid_at DATETIME(3) NULL,
    INDEX idx_inv_user_created (user_id, created_at),
    INDEX idx_inv_provider_status (provider, status, expires_at),
    INDEX idx_inv_status_total (status, total_amount),
    INDEX idx_inv_reference (reference),
    CONSTRAINT fk_inv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Idempotency: PK (provider, tx_id) — prevents a mutation settling two invoices (pooled correctness).
  `CREATE TABLE IF NOT EXISTS claimed_transactions (
    provider VARCHAR(24) NOT NULL,
    tx_id VARCHAR(128) NOT NULL,
    qris_id VARCHAR(16) NULL,
    claimed_at BIGINT NOT NULL,
    PRIMARY KEY (provider, tx_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Ledger: running balance per user (race-safe via FOR UPDATE in tx).
  `CREATE TABLE IF NOT EXISTS user_balances (
    user_id INT PRIMARY KEY,
    balance INT NOT NULL DEFAULT 0,
    held INT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ub_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Settlement holds: H+1 payments are credited to `held` (not withdrawable)
  // until release_at, when the scheduler moves them to the balance.
  `CREATE TABLE IF NOT EXISTS settlement_holds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    invoice_id VARCHAR(16) NOT NULL,
    amount INT NOT NULL,
    release_at DATETIME(3) NOT NULL,
    released TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_sh_invoice (invoice_id),
    INDEX idx_sh_release (released, release_at),
    CONSTRAINT fk_sh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Ledger entries (audit trail). balance_after is snapshot after each entry.
  `CREATE TABLE IF NOT EXISTS ledger_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type ENUM('credit','debit_hold','debit_settled','credit_back') NOT NULL,
    amount INT NOT NULL,
    ref_type VARCHAR(32) NULL,
    ref_id VARCHAR(64) NULL,
    balance_after INT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_le_user (user_id, id),
    CONSTRAINT fk_le_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Withdrawal requests (processed manually by operator).
  `CREATE TABLE IF NOT EXISTS withdrawals (
    id VARCHAR(20) PRIMARY KEY,
    user_id INT NOT NULL,
    amount INT NOT NULL,
    bank_detail JSON NOT NULL,
    status ENUM('requested','processed','rejected','cancelled') NOT NULL DEFAULT 'requested',
    note VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    INDEX idx_wd_user (user_id, status),
    CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Unmatched payments: mutations that hit no invoice within the grace window -> admin reconcile.
  `CREATE TABLE IF NOT EXISTS unmatched_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(24) NOT NULL,
    tx_id VARCHAR(128) NOT NULL,
    amount_idr INT NOT NULL,
    create_time DATETIME(3) NULL,
    raw_json MEDIUMTEXT NULL,
    status ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
    resolved_to_qris_id VARCHAR(16) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_unmatched (provider, tx_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS webhooks (
    id VARCHAR(20) PRIMARY KEY,
    user_id INT NOT NULL,
    url VARCHAR(500) NOT NULL,
    secret VARCHAR(190) NULL,
    events VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_wh_user (user_id),
    CONSTRAINT fk_wh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS activity_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    timestamp DATETIME(3) NOT NULL,
    type VARCHAR(16) NOT NULL,
    message VARCHAR(1000) NOT NULL,
    INDEX idx_log_user (user_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS app_settings (
    \`key\` VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Per-user dashboard preferences (provider toggle: shopeepay <-> gopay).
  `CREATE TABLE IF NOT EXISTS user_prefs (
    user_id INT PRIMARY KEY,
    provider_choice ENUM('shopeepay','gopay') NOT NULL DEFAULT 'shopeepay',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

// Default plans: free (H1 shopeepay), paid (H0 gopay+shopeepay).
const DEFAULT_PLANS = [
  { code: 'free', name: 'Gratis (H+1)', duration_days: 0, price: 0, tier: 'H1', providers: ['shopeepay'], sort_order: 0 },
  { code: 'h0-monthly', name: 'Bulanan H+0', duration_days: 30, price: 30000, tier: 'H0', providers: ['gopay', 'shopeepay'], sort_order: 1 }
];

async function migrate() {
  // Ensure the database itself exists (idempotent). The main pool cannot connect when its default
  // database is missing (ER_BAD_DB_ERROR at handshake), so create it through a throwaway connection
  // that has NO default database. On shared hosting (cPanel) the DB is pre-created and the user may
  // lack CREATE privileges — the IF NOT EXISTS + ignore keeps migrate usable there too.
  try {
    const adminPool = mysql.createPool({
      host: config.db.host, port: config.db.port, user: config.db.user,
      password: config.db.password, socketPath: config.db.socketPath,
      waitForConnections: true, connectionLimit: 1, charset: 'utf8mb4', timezone: 'Z', dateStrings: true
    });
    await adminPool.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await adminPool.end();
  } catch (e) {
    logger.warn(`[DB] CREATE DATABASE skipped: ${e.message}`);
  }

  for (const stmt of SCHEMA) await query(stmt);

  // Seed default plans (active=1)
  const plans = await query('SELECT COUNT(*) c FROM plans');
  if (Number(plans[0].c) === 0) {
    for (const p of DEFAULT_PLANS) {
      await query(
        'INSERT INTO plans (code, name, duration_days, price, tier, providers, active, sort_order) VALUES (?,?,?,?,?,?,1,?)',
        [p.code, p.name, p.duration_days, p.price, p.tier, JSON.stringify(p.providers), p.sort_order]
      );
    }
    logger.info('[DB] Seeded default plans (free H1, h0-monthly H0)');
  }

  // Seed provider account rows (one per provider) so admin can configure them.
  const seeded = await query("SELECT name FROM provider_accounts WHERE name IN ('gopay','shopeepay')");
  const have = new Set(seeded.map((r) => r.name));
  if (!have.has('gopay')) {
    await query("INSERT INTO provider_accounts (name, display_name) VALUES ('gopay','GoPay / GoBiz')");
  }
  if (!have.has('shopeepay')) {
    await query("INSERT INTO provider_accounts (name, display_name) VALUES ('shopeepay','ShopeePay')");
  }
}

async function ping() {
  await query('SELECT 1');
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, query, one, tx, migrate, ping, close };
