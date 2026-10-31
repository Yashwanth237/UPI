import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getCoinStoreWebhookSecret, LEGACY_DEFAULT_WEBHOOK_SECRET } from '@youpi/common';
import { getDatabase } from './database.js';
import { MerchantRepository } from './repositories/merchant.repository.js';
import { ReceivingAccountRepository } from './repositories/receiving-account.repository.js';
import { CustomerRepository } from './repositories/customer.repository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The placeholder receiving account seeded on a fresh install. Never a real payee. */
export const DEMO_RECEIVING_ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';
export const DEMO_RECEIVING_VPA = 'merchant@upi';

function seedDefaultMerchant(merchantRepo) {
  return merchantRepo.create({
    id: '00000000-0000-0000-0000-000000000001',
    businessName: 'YOUPI Demo Store',
    slug: 'demo-store',
    contactEmail: 'merchant@youpi.local',
    contactPhone: '9876543210',
    webhookUrl: process.env.COIN_STORE_WEBHOOK_URL || 'http://localhost:5000/api/webhook',
    webhookSecret: getCoinStoreWebhookSecret(),
    branding: {
      appName: 'YOUPI PG',
      primaryColor: '#2563eb',
      logoUrl: null
    }
  });
}

/**
 * Numbered schema migrations. Append only; never renumber or remove an entry.
 * 1: everything up to and including the 10 original table groups (pre-ledger installs).
 * 2: staff identity (staff_users, staff_sessions) and the ledger itself.
 * 3: observation_records (one processed bank alert per row, keyed by the pipeline observation id).
 */
export const SCHEMA_MIGRATIONS = Object.freeze([
  [1, 'baseline_payment_gateway'],
  [2, 'staff_identity_and_sessions'],
  [3, 'observation_records']
]);

/**
 * Runs database migrations and applies base seeds.
 * @param {import('./database.js').Database} [targetDb]
 */
export function runMigrations(targetDb) {
  const db = targetDb || getDatabase();
  const schemaPath = path.join(__dirname, 'sqlite-schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Detect if customers table has an obsolete schema (phone_number/merchant_id instead of email/mobile_number, or password_hash NOT NULL).
  // The old table is only rebuilt when it holds no customers: a schema mismatch must never destroy customer data.
  try {
    const tableInfo = db.query ? db.query("PRAGMA table_info(customers)") : [];
    const colNames = (tableInfo || []).map(c => c.name);
    const hasOldColumns = colNames.length > 0 && (
      !colNames.includes('email') ||
      colNames.includes('phone_number') ||
      colNames.includes('merchant_id') ||
      !colNames.includes('otp_code') ||
      tableInfo.some(c => c.name === 'password_hash' && c.notnull === 1)
    );
    if (hasOldColumns) {
      const customerCount = Number(db.queryOne('SELECT COUNT(*) AS n FROM customers')?.n || 0);
      if (customerCount === 0) {
        try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
        try { db.exec("DROP TABLE IF EXISTS customer_sessions;"); } catch {}
        try { db.exec("DROP TABLE IF EXISTS customers;"); } catch {}
        try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
      } else {
        console.error(`[migrate] customers table has an obsolete schema but holds ${customerCount} row(s); leaving it untouched. Back up and migrate it manually.`);
      }
    }
  } catch (err) {
    console.error('[migrate] Could not inspect customers table schema; skipping rebuild:', err.message);
  }

  // Fallback alter columns if customers/sessions table exists without new columns
  try { db.exec("ALTER TABLE merchants ADD COLUMN api_key_hash TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN email TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN mobile_number TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN otp_code TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN otp_expires_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN otp_attempts INTEGER NOT NULL DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN is_phone_verified INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN ban_reason TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN banned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN unbanned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN last_device TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN device_id TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_level INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_sources TEXT DEFAULT '[]';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_tag TEXT DEFAULT 'UNVERIFIED';"); } catch {}

  // Execute schema DDL
  db.exec(schemaSql);

  // Versioned ledger. The DDL above is idempotent (CREATE ... IF NOT EXISTS); the ledger records
  // which numbered, additive migrations a database has received so operators can audit upgrades.
  for (const [version, name] of SCHEMA_MIGRATIONS) {
    db.execute('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [version, name, new Date().toISOString()]);
  }

  // Alter table columns if migrating existing databases
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_level INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_sources TEXT DEFAULT '[]';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_tag TEXT DEFAULT 'UNVERIFIED';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN attempt_id TEXT;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session_per_order ON payment_sessions (merchant_id, order_id) WHERE status NOT IN ('FAILED', 'EXPIRED', 'CANCELLED');"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_slot_per_receiving_account ON payment_sessions (receiving_account_id) WHERE status IN ('ACTIVE', 'PROCESSING') AND receiving_account_id IS NOT NULL;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_payment_sessions_order ON payment_sessions (merchant_id, order_id, created_at);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries (is_successful, next_retry_at);"); } catch {}
  try { db.exec("ALTER TABLE payment_receiving_accounts ADD COLUMN is_merchant_enabled INTEGER NOT NULL DEFAULT 1;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_vpa_per_merchant ON payment_receiving_accounts (merchant_id) WHERE is_active = 1;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers (email);"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile ON customers (mobile_number);"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN ban_reason TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN banned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN unbanned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN last_device TEXT;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions (token, is_active);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_customer ON security_events (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_session ON security_events (payment_session_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events (event_type);"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN device_id TEXT REFERENCES devices(id);"); } catch {}
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
      public_key TEXT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      user_agent TEXT,
      platform TEXT,
      browser TEXT,
      timezone TEXT,
      language TEXT,
      screen_signature TEXT,
      device_token TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices (fingerprint_hash);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_payment_sessions_device ON payment_sessions (device_id);"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_sessions_attributed_obs ON payment_sessions (attributed_observation_id) WHERE attributed_observation_id IS NOT NULL;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_observations_bank_ref ON payment_observations (bank_reference_number);"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_unique_attributed_bank_ref ON payment_observations (bank_reference_number) WHERE bank_reference_number IS NOT NULL AND attributed_payment_id IS NOT NULL;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_observations_fingerprint ON payment_observations (fingerprint_hash);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_observations_attributed_payment ON payment_observations (attributed_payment_id);"); } catch {}

  // Seed default merchant if empty
  const merchantRepo = new MerchantRepository(db);
  const existing = merchantRepo.findAll();

  // Seeding is check-then-insert, and every service runs these migrations on start. On a fresh
  // database started by several services at once, two processes can both see "empty" and both
  // insert the fixed seed id; the loser hit UNIQUE constraint failed and crashed. The seed rows
  // have fixed ids, so losing that race just means another process already seeded: re-read.
  const isSeedRace = err => /UNIQUE constraint failed/.test(err?.message || '');

  let defaultMerchant;
  if (existing.length === 0) {
    try {
      defaultMerchant = seedDefaultMerchant(merchantRepo);
    } catch (err) {
      if (!isSeedRace(err)) throw err;
      defaultMerchant = merchantRepo.findAll()[0];
    }
  } else {
    defaultMerchant = existing[0];
    if (!defaultMerchant.webhookSecret) {
      merchantRepo.update(defaultMerchant.id, {
        webhookUrl: 'http://localhost:5000/api/webhook',
        webhookSecret: getCoinStoreWebhookSecret()
      });
    } else if (defaultMerchant.webhookSecret === LEGACY_DEFAULT_WEBHOOK_SECRET) {
      // Older installs were seeded with a publicly known secret: rotate it.
      merchantRepo.update(defaultMerchant.id, { webhookSecret: getCoinStoreWebhookSecret() });
      console.warn('[migrate] Rotated the default merchant webhook secret away from the legacy public value. Update your merchant webhook verifier.');
    }
  }

  // Seed default UPI receiving account if none
  const accountRepo = new ReceivingAccountRepository(db);
  const accounts = accountRepo.findByMerchantId(defaultMerchant.id);
  if (accounts.length === 0) {
    try {
      accountRepo.create({
        id: DEMO_RECEIVING_ACCOUNT_ID,
        merchantId: defaultMerchant.id,
        upiId: DEMO_RECEIVING_VPA,
        payeeName: defaultMerchant.businessName,
        isActive: true
      });
    } catch (err) {
      if (!isSeedRace(err)) throw err;
    }
  }

  // Demo customer seeding is opt-in and never carries real personal data.
  // Previously this unconditionally created a customer with a real name, phone number and
  // email, and flagged the phone as verified — shipping someone's PII (and a pre-authorised
  // OTP login identity) into every merchant deployment.
  if (process.env.YOUPI_SEED_DEMO_CUSTOMER === 'true') {
    const customerRepo = new CustomerRepository(db);
    const demoMobile = '9000000000';
    if (!customerRepo.findByMobile(demoMobile)) {
      customerRepo.create({
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Demo Customer',
        email: 'demo-customer@youpi.local',
        mobileNumber: demoMobile,
        isPhoneVerified: false
      });
    }
  }

  return {
    db,
    defaultMerchant
  };
}

/**
 * Completely wipes all customer identity records and active sessions,
 * reinitializing the customer identity store to a pristine state.
 * @param {import('./database.js').Database} [targetDb]
 */
export function reinitializeCustomerIdentity(targetDb) {
  const db = targetDb || getDatabase();
  try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
  try { db.exec("UPDATE payment_sessions SET customer_id = NULL WHERE customer_id IS NOT NULL;"); } catch {}
  try { db.exec("DELETE FROM customer_sessions;"); } catch {}
  try { db.exec("DELETE FROM customers;"); } catch {}
  try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
  return { success: true, message: 'All old customer identity records wiped and reinitialized.' };
}

// Auto-run if executed directly as script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Running YOUPI PG database migrations...');
  const result = runMigrations();
  console.log(`Migration completed successfully. Default merchant: ${result.defaultMerchant.businessName} (${result.defaultMerchant.id})`);
}
