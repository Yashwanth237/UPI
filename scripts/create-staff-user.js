#!/usr/bin/env node
/**
 * Creates a staff account (first platform administrator, or any merchant-scoped role).
 *
 *   npm run staff:create -- --email ops@example.com --name "Ops Lead" --role platform_admin
 *   npm run staff:create -- --email till@example.com --name "Till 1" --role cashier --merchant <merchantId>
 *
 * The password is read from STAFF_PASSWORD when set (min. 12 chars); otherwise a random one is
 * generated and printed ONCE. It is stored only as an scrypt hash.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, runMigrations, StaffRepository, MerchantRepository } from '../packages/db/src/index.js';
import { isValidStaffRole, validateStaffPassword, ROLE_LABELS } from '../packages/common/src/index.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const envFile = path.join(rootDir, '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
} catch {}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`\n[staff:create] ${message}\n`);
  process.exit(1);
}

const email = arg('email');
const fullName = arg('name');
const role = arg('role') || 'platform_admin';
let merchantId = arg('merchant') || null;

if (!email || !fullName) {
  fail(`Usage: npm run staff:create -- --email <email> --name "<full name>" [--role <role>] [--merchant <merchantId>]\nRoles: ${Object.keys(ROLE_LABELS).join(', ')}`);
}
if (!isValidStaffRole(role)) fail(`Unknown role "${role}". Roles: ${Object.keys(ROLE_LABELS).join(', ')}`);

const db = getDatabase();
runMigrations(db);
const merchants = new MerchantRepository(db);

if (role === 'platform_admin') {
  merchantId = null;
} else {
  merchantId = merchantId || merchants.getDefault()?.id;
  if (!merchantId || !merchants.findById(merchantId)) fail(`Merchant not found: ${merchantId || '(none)'}`);
}

const generated = !process.env.STAFF_PASSWORD;
const password = process.env.STAFF_PASSWORD || crypto.randomBytes(18).toString('base64url');
const problem = validateStaffPassword(password);
if (problem) fail(problem);

const staff = new StaffRepository(db);
if (staff.findByEmailWithSecret(email)) fail(`A staff account with email ${email} already exists.`);

const user = staff.create({ email, fullName, role, password, merchantId, createdBy: 'cli' });
db.execute(
  "INSERT INTO audit_logs (id, merchant_id, entity_type, entity_id, action, actor_type, actor_id, details, created_at) VALUES (?, ?, 'STAFF', ?, 'STAFF_USER_CREATED', 'SYSTEM', 'cli', ?, ?)",
  [crypto.randomUUID(), merchantId, user.id, JSON.stringify({ role, email: user.email, via: 'cli' }), new Date().toISOString()]
);

console.log('\n[staff:create] Staff account created');
console.log(`  Email : ${user.email}`);
console.log(`  Role  : ${ROLE_LABELS[role]}`);
if (merchantId) console.log(`  Merchant: ${merchantId}`);
if (generated) {
  console.log(`  Temporary password (shown once): ${password}`);
  console.log('  Sign in at the merchant console (/console) and change it under Account.');
}
console.log('');
