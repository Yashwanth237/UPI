#!/usr/bin/env node
/**
 * Online, consistent SQLite backup using `VACUUM INTO` (safe while the gateway is running in
 * WAL mode). Writes data/backups/youpi_pg-<UTC timestamp>.sqlite (or YOUPI_BACKUP_DIR) with
 * mode 0600, verifies it with `PRAGMA integrity_check`, and keeps the newest N files
 * (YOUPI_BACKUP_KEEP, default 14).
 *
 *   npm run db:backup
 *
 * Restore: stop all services, copy the backup over SQLITE_DB_PATH (and delete any stale
 * -wal / -shm files next to it), then start the services. See docs/MIGRATIONS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const envFile = path.join(rootDir, '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
} catch {}

const source = process.env.SQLITE_DB_PATH
  ? (path.isAbsolute(process.env.SQLITE_DB_PATH) ? process.env.SQLITE_DB_PATH : path.resolve(rootDir, process.env.SQLITE_DB_PATH))
  : path.resolve(rootDir, 'data/youpi_pg.sqlite');
const backupDir = path.resolve(process.env.YOUPI_BACKUP_DIR || path.join(rootDir, 'data', 'backups'));
const keep = Math.max(1, Number(process.env.YOUPI_BACKUP_KEEP) || 14);

if (!fs.existsSync(source)) {
  console.error(`[db:backup] Database not found: ${source}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupDir, `youpi_pg-${stamp}.sqlite`);

const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}
try { fs.chmodSync(target, 0o600); } catch {}

const check = new DatabaseSync(target, { readOnly: true });
const result = check.prepare('PRAGMA integrity_check').get();
check.close();
if (!result || Object.values(result)[0] !== 'ok') {
  console.error(`[db:backup] Integrity check FAILED for ${target}`);
  process.exit(1);
}

const backups = fs.readdirSync(backupDir).filter(f => /^youpi_pg-.*\.sqlite$/.test(f)).sort().reverse();
for (const old of backups.slice(keep)) fs.rmSync(path.join(backupDir, old));

console.log(`[db:backup] OK ${target} (${fs.statSync(target).size} bytes, integrity ok, keeping newest ${keep})`);
