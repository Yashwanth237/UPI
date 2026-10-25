import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../database.js';
import { runMigrations, SCHEMA_MIGRATIONS } from '../migrate.js';
import { PaymentSessionRepository } from '../repositories/payment-session.repository.js';
import { StaffRepository, verifyStaffPassword, hashStaffPassword } from '../repositories/staff.repository.js';

describe('Forward migration to staff identity (migration 2) on an existing database', () => {
  test('an existing pre-staff database upgrades in place with every row preserved', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-mig-'));
    const file = path.join(dir, 'existing.sqlite');
    try {
      // 1. A database as it existed before this change: run migrations, add business data,
      //    then remove the new objects so it matches the previous schema exactly.
      let db = new Database({ dbPath: file, autoMigrate: false });
      const { defaultMerchant } = runMigrations(db);
      const sessions = new PaymentSessionRepository(db);
      for (let i = 0; i < 25; i++) {
        sessions.create({ merchantId: defaultMerchant.id, orderId: `LEGACY-${i}`, amountPaise: BigInt(1000 + i) });
      }
      db.exec('DROP TABLE staff_sessions; DROP TABLE staff_users; DROP TABLE schema_migrations;');
      const before = db.query('SELECT id, order_id, amount_paise, status FROM payment_sessions ORDER BY order_id');
      db.close();

      // 2. Upgrade (what `npm start` does on boot).
      db = new Database({ dbPath: file, autoMigrate: false });
      runMigrations(db);
      const after = db.query('SELECT id, order_id, amount_paise, status FROM payment_sessions ORDER BY order_id');
      assert.deepEqual(after, before, 'existing payment rows are untouched');
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name);
      for (const t of ['staff_users', 'staff_sessions', 'schema_migrations']) assert.ok(tables.includes(t), `${t} created`);
      const ledger = db.query('SELECT version FROM schema_migrations ORDER BY version').map(r => Number(r.version));
      assert.deepEqual(ledger, SCHEMA_MIGRATIONS.map(([v]) => v));

      // 3. Idempotent: running again changes nothing.
      runMigrations(db);
      assert.equal(Number(db.queryOne('SELECT COUNT(*) AS n FROM schema_migrations').n), SCHEMA_MIGRATIONS.length);
      assert.equal(Number(db.queryOne('SELECT COUNT(*) AS n FROM payment_sessions').n), 25);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('staff passwords are stored as scrypt hashes and verified in constant time', () => {
    const db = new Database({ inMemory: true });
    runMigrations(db);
    const repo = new StaffRepository(db);
    const user = repo.create({ email: 'Ops@Example.com', fullName: 'Ops', role: 'platform_admin', password: 'a long enough password' });
    const stored = db.queryOne('SELECT email, password_hash FROM staff_users WHERE id = ?', [user.id]);
    assert.equal(stored.email, 'ops@example.com', 'email normalised');
    assert.match(stored.password_hash, /^scrypt\$32768\$8\$1\$/);
    assert.ok(!stored.password_hash.includes('a long enough password'));
    assert.equal(verifyStaffPassword('a long enough password', stored.password_hash), true);
    assert.equal(verifyStaffPassword('wrong', stored.password_hash), false);
    assert.equal(verifyStaffPassword('x', 'not-a-hash'), false);
    assert.notEqual(hashStaffPassword('same'), hashStaffPassword('same'), 'salted');
    assert.throws(() => repo.create({ email: 'c@example.com', fullName: 'C', role: 'cashier', password: 'x'.repeat(12) }), /require a merchantId/);
    assert.throws(() => repo.create({ email: 'd@example.com', fullName: 'D', role: 'superuser', password: 'x'.repeat(12) }), /Unknown staff role/);
  });
});
