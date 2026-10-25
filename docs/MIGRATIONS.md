# Database migrations, backup and restore

YouPI uses SQLite (`node:sqlite`, WAL mode) as its only runtime database. `packages/db/src/schema.sql`
is a PostgreSQL variant kept in parity by `schema-parity.test.js`; no code loads a PostgreSQL driver yet.

## How migrations run

`runMigrations()` (`packages/db/src/migrate.js`) runs on every boot (`npm start`, `npm run dev`):

1. Additive `ALTER TABLE ... ADD COLUMN` statements for columns added before the ledger existed.
2. `sqlite-schema.sql`, which only uses `CREATE TABLE/INDEX IF NOT EXISTS` (never drops or rewrites).
3. The ledger: every entry of `SCHEMA_MIGRATIONS` is recorded in `schema_migrations` once.

| Version | Name | Adds |
| --- | --- | --- |
| 1 | `baseline_payment_gateway` | Everything before the ledger existed |
| 2 | `staff_identity_and_sessions` | `schema_migrations`, `staff_users`, `staff_sessions` |

The applied versions are visible in the console under **System health → Applied migrations**.

### Adding a migration

1. Change both `sqlite-schema.sql` and `schema.sql` (additive only; `IF NOT EXISTS`).
2. Append `[next, 'descriptive_name']` to `SCHEMA_MIGRATIONS`. Never renumber or remove entries.
3. Update repositories and the parity test; add a test that upgrades an existing database
   (see `packages/db/src/__tests__/migration-ledger.test.js`).

## Rolling back migration 2

Migration 2 only adds three independent tables; no existing table or row is modified. To roll back,
stop all services, back up, then:

```sql
DROP TABLE staff_sessions;
DROP TABLE staff_users;
DELETE FROM schema_migrations WHERE version = 2;
```

and deploy the previous release. Staff will fall back to the admin API token.

## Backups

```bash
npm run db:backup
```

* Uses `VACUUM INTO`, which produces a consistent copy while the gateway is running.
* Writes `data/backups/youpi_pg-<UTC timestamp>.sqlite` (or `YOUPI_BACKUP_DIR`) with mode `0600`.
* Runs `PRAGMA integrity_check` on the copy and fails loudly if it is not `ok`.
* Keeps the newest `YOUPI_BACKUP_KEEP` files (default 14).

Schedule it (cron, systemd timer or Windows Task Scheduler), at least daily, and copy backups
off the host. The backup contains customer PII, encrypted webhook secrets and OTP data: store it
encrypted and restrict access.

## Restore

1. Stop every service (`Ctrl+C` on `npm start`, or stop the supervisor).
2. Keep the current file aside: move `data/youpi_pg.sqlite` and its `-wal` / `-shm` files.
3. Copy the chosen backup to the `SQLITE_DB_PATH` location.
4. Start the services. Migrations run automatically and are idempotent.
5. Check **System health** in the console: integrity `OK`, expected schema version.

Payments that happened after the backup was taken are not in it. Reconcile them from webhook
logs on the merchant side and from bank statements.
