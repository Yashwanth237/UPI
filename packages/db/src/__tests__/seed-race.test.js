import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Every service runs migrations on start, so `npm run dev` / the control center starting the
// API, checkout and admin together on a fresh database used to race on the seed rows and crash
// one of them with "UNIQUE constraint failed: payment_receiving_accounts.id".
test('simultaneous first start on a fresh database seeds exactly once and every process succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-seed-race-'));
  const dbPath = path.join(dir, 'fresh.sqlite');
  const migrateUrl = pathToFileURL(path.resolve(import.meta.dirname, '../migrate.js')).href;
  const script = `const m = await import(${JSON.stringify(migrateUrl)}); m.runMigrations();`;

  try {
    const runs = Array.from({ length: 12 }, () => new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, SQLITE_DB_PATH: dbPath, NODE_ENV: 'test' },
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      child.on('exit', code => resolve({ code, stderr }));
    }));
    const results = await Promise.all(runs);
    for (const r of results) assert.equal(r.code, 0, r.stderr.split('\n').slice(0, 6).join('\n'));

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM merchants').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_receiving_accounts').get().n, 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
