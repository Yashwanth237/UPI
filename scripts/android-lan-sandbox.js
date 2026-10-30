/**
 * Isolated Payment API for testing a physical Android phone on the local network.
 *
 *   node scripts/android-lan-sandbox.js 192.168.1.128 [port=6110]
 *   node scripts/android-lan-sandbox.js 127.0.0.1 6110   (USB, after `adb reverse tcp:6110 tcp:6110`)
 *
 * - Listens only on the given private LAN IP (never 0.0.0.0) on its own port, so the live
 *   stack on 6100 and its database are untouched.
 * - Uses a fresh SQLite file in the OS temp folder (deleted on exit unless KEEP_SANDBOX_DB=1),
 *   and a temp WhatsApp state folder, so it never takes over the live WhatsApp session.
 * - Writes a pairing QR page for the phone to scan, and prints every device heartbeat and
 *   observation as it arrives (no SMS text is printed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../packages/db/src/database.js';
import { getAdminToken } from '../packages/common/src/secrets.js';
import { isPrivateLanIPv4 } from './android-network-config.js';

const [lanIp, portArg] = process.argv.slice(2);
const port = Number(portArg || 6110);
// 127.0.0.1: USB/ADB mode. The phone reaches it through `adb reverse tcp:<port> tcp:<port>`.
if (!isPrivateLanIPv4(lanIp) && lanIp !== '127.0.0.1') {
  console.error('Usage: node scripts/android-lan-sandbox.js <this PC\'s private LAN IP | 127.0.0.1 with adb reverse> [port]');
  process.exit(1);
}
if (port === 6100) {
  console.error('Port 6100 belongs to the live Payment API. Use another port (default 6110).');
  process.exit(1);
}

process.env.YOUPI_BIND_HOST = lanIp;
process.env.YOUPI_ANDROID_GATEWAY_URL = `http://${lanIp}:${port}`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-android-sandbox-'));
const dbPath = path.join(workDir, 'sandbox.sqlite');
const db = new Database({ dbPath });
const { startServer } = await import('../apps/payment-api/src/index.js');
const api = await startServer(port, db);

const res = await fetch(`http://${lanIp}:${port}/api/v1/admin/sms-gateway/pair-qr`, {
  headers: { Authorization: `Bearer ${getAdminToken()}` }
});
const qr = await res.json();
const qrPage = path.join(workDir, 'pairing-qr.html');
fs.writeFileSync(qrPage, `<!doctype html><meta charset="utf-8"><title>YouPI sandbox pairing</title>
<body style="font-family:sans-serif;text-align:center;padding:24px">
<h2>Scan with the YOUPI SMS Gateway app</h2>
<div style="display:inline-block;background:#fff;padding:16px">${qr.qrSvg}</div>
<p>Gateway: <b>${qr.serverUrl}</b> (isolated sandbox, temporary database)</p>
<p>Expires ${new Date(qr.expiresAt).toLocaleTimeString()}. Re-run the sandbox for a new code.</p>
<p style="color:#b45309">${qr.phoneReachabilityWarning || ''}</p></body>`, 'utf8');

console.log(`\n[sandbox] Isolated Payment API on http://${lanIp}:${port}`);
console.log(`[sandbox] Temporary database: ${dbPath}`);
console.log(`[sandbox] Pairing QR page:    ${qrPage}`);
console.log('[sandbox] Watching devices and observations. Ctrl+C to stop.\n');

let lastSeen = '';
const timer = setInterval(() => {
  const devices = db.query('SELECT id, device_model, last_heartbeat_at, last_observation_at FROM android_devices ORDER BY created_at');
  const obs = db.queryOne('SELECT COUNT(*) AS n FROM payment_observations').n;
  const notSettled = db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'OBSERVATION_NOT_SETTLED'").n;
  const line = JSON.stringify({ devices, storedObservations: obs, notSettled });
  if (line !== lastSeen) {
    lastSeen = line;
    console.log(`[sandbox ${new Date().toLocaleTimeString()}] devices=${devices.length} ` +
      devices.map(d => `${d.id.slice(0, 8)}(${d.device_model}) heartbeat=${d.last_heartbeat_at || '-'} lastObservation=${d.last_observation_at || '-'}`).join('; ') +
      ` storedObservations=${obs} notSettled=${notSettled}`);
  }
}, 2000);

const shutdown = async () => {
  clearInterval(timer);
  await api.close();
  db.close();
  if (process.env.KEEP_SANDBOX_DB !== '1') fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
