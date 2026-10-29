import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Database, runMigrations } from '../index.js';

// The reset runs only on throwaway copies. It used to run on data/youpi_pg.sqlite itself,
// so every `npm test` dropped real customers and support tickets.
function resetCustomersAndVerify(dbPath, label) {
  const db = new Database({ dbPath });
  const merchantsBefore = db.query('SELECT count(*) as c FROM merchants')[0].c;
  const accountsBefore = db.query('SELECT count(*) as c FROM payment_receiving_accounts')[0].c;
  const obsBefore = db.query('SELECT count(*) as c FROM payment_observations')[0].c;

  try { db.execute('UPDATE payment_sessions SET customer_id = NULL WHERE customer_id IS NOT NULL;'); } catch {}
  try { db.execute('DELETE FROM ticket_messages;'); } catch {}
  try { db.execute('DELETE FROM support_tickets;'); } catch {}
  try { db.execute('DROP TABLE IF EXISTS customer_sessions;'); } catch {}
  try { db.execute('DROP TABLE IF EXISTS customers;'); } catch {}

  runMigrations(db);

  db.execute('DELETE FROM customer_sessions;');
  db.execute('DELETE FROM customers;');

  assert.equal(db.query('SELECT count(*) as c FROM customers')[0].c, 0, `${label} customer count must strictly equal 0`);
  assert.equal(db.query('SELECT count(*) as c FROM customer_sessions')[0].c, 0, `${label} customer session count must strictly equal 0`);
  assert.equal(db.query('SELECT count(*) as c FROM merchants')[0].c, merchantsBefore, `${label} merchants must remain 100% intact`);
  assert.equal(db.query('SELECT count(*) as c FROM payment_receiving_accounts')[0].c, accountsBefore, `${label} receiving accounts must remain 100% intact`);
  assert.equal(db.query('SELECT count(*) as c FROM payment_observations')[0].c, obsBefore, `${label} observations must remain 100% intact`);
  db.close();
}

// Consistent copy (WAL included) taken through a read-only connection.
function snapshot(srcPath, destPath) {
  const src = new DatabaseSync(srcPath, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
}

test('Customer reset keeps merchants, accounts and observations intact, on copies only', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-customer-reset-'));
  try {
    const freshPath = path.join(tmpDir, 'fresh.sqlite');
    const freshDb = new Database({ dbPath: freshPath });
    runMigrations(freshDb);
    freshDb.close();
    resetCustomersAndVerify(freshPath, 'Fresh');

    const candidates = [
      ['Production copy', path.resolve('data/youpi_pg.sqlite')],
      ['Dev copy', process.env.DEV_DB_PATH || path.resolve('data/youpi_pg_dev.sqlite')]
    ];
    for (const [label, realPath] of candidates) {
      if (!fs.existsSync(realPath)) continue;
      const before = fs.statSync(realPath).mtimeMs;
      const copyPath = path.join(tmpDir, `${label.replace(/\W+/g, '_')}.sqlite`);
      snapshot(realPath, copyPath);
      resetCustomersAndVerify(copyPath, label);
      assert.equal(fs.statSync(realPath).mtimeMs, before, `${label}: the real database file must not be written`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
