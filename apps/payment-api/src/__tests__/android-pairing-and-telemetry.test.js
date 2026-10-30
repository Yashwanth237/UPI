import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { sanitizeAndroidTelemetry } from '../routes/pollers.routes.js';
import { AndroidObserverDriver } from '../../../android-observer-app/driver.js';
import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';

// Why five "RMX5110" registrations appeared for one phone, and what the phone tells the gateway
// about each SMS. Synthetic devices on an in-memory database.
describe('Android pairing hygiene and delivery telemetry', () => {
  let api;
  let db;
  let base;
  const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
  const pairQr = async () => (await fetch(`${base}/api/v1/admin/sms-gateway/pair-qr`, { headers: admin })).json();
  const isActive = id => db.queryOne('SELECT is_active FROM android_devices WHERE id = ?', [id]).is_active;

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6233, db);
    base = `http://localhost:${api.port}`;
  });

  after(async () => {
    await api.close();
    db.close();
  });

  test('a pairing QR registers one device; scanning it again is refused (409)', async () => {
    const qr = await pairQr();
    const phone = new AndroidObserverDriver({ apiBaseUrl: base, deviceModel: 'realme RMX5110' });
    await phone.pair(qr.enrollmentToken);
    const other = new AndroidObserverDriver({ apiBaseUrl: base });
    await assert.rejects(() => other.pair(qr.enrollmentToken), /HTTP 409/);
    const count = db.queryOne("SELECT COUNT(*) AS n FROM android_devices WHERE device_model = 'realme RMX5110'").n;
    assert.equal(count, 1);
  });

  test('re-pairing with a new QR retires the phone\'s previous registration', async () => {
    const phone = new AndroidObserverDriver({ apiBaseUrl: base });
    const first = await phone.pair((await pairQr()).enrollmentToken);
    const second = await phone.pair((await pairQr()).enrollmentToken);
    assert.equal(second.replacedDeviceId, first.deviceId);
    assert.equal(isActive(first.deviceId), 0);
    assert.equal(isActive(second.deviceId), 1);

    // The retired identity can no longer post.
    const old = new AndroidObserverDriver({ apiBaseUrl: base });
    old.deviceId = first.deviceId;
    old.signingKey = first.signingKey;
    assert.equal((await old.submitSms({ sender: 'VM-HDFCBK', body: 'Rs.5.00 credited Ref 512300000009' })).status, 403);
  });

  test('a previousDeviceId without a valid proof deactivates nothing', async () => {
    const victim = new AndroidObserverDriver({ apiBaseUrl: base });
    const v = await victim.pair((await pairQr()).enrollmentToken);
    const qr = await pairQr();
    const res = await fetch(`${base}/api/v1/pollers/android/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: qr.enrollmentToken, previousDeviceId: v.deviceId, previousProof: 'ab'.repeat(32) })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).replacedDeviceId, null);
    assert.equal(isActive(v.deviceId), 1);
  });

  test('the signed heartbeat\'s delivery counters reach Merchant Admin; text and numbers never do', async () => {
    const phone = new AndroidObserverDriver({ apiBaseUrl: base });
    const { deviceId } = await phone.pair((await pairQr()).enrollmentToken);
    const t = Date.now() - 5000;
    await phone.sendHeartbeat({
      pendingObservations: 1,
      telemetry: {
        smsReceived: 3, smsKeptOnDevice: 2, smsQueued: 1, uploadAttempts: 1, uploadsAccepted: 0, uploadsRejected: 0,
        uploadsRetried: 1, lastSmsReceivedAt: t, lastUploadHttpStatus: -1, workerRunning: true, smsPermissionGranted: true,
        appVersion: '1.1.0', body: 'Rs 500 credited to a/c 1234', sender: '+919876543210'
      }
    });

    const diag = await (await fetch(`${base}/api/v1/admin/observations/diagnostics`, { headers: admin })).json();
    const reported = diag.androidDevices.find(d => d.id === deviceId).telemetry;
    assert.equal(reported.smsReceived, 3);
    assert.equal(reported.smsKeptOnDevice, 2);
    assert.equal(reported.pendingUploads, 1);
    assert.equal(reported.lastUploadHttpStatus, -1);
    assert.equal(reported.workerRunning, true);
    assert.equal(reported.lastSmsReceivedAt, new Date(t).toISOString());
    assert.doesNotMatch(JSON.stringify(diag), /credited to a\/c|919876543210/);

    const qr = await pairQr();
    assert.equal(qr.devices.find(d => d.id === deviceId).telemetry.smsQueued, 1);
  });

  test('telemetry sanitising keeps only counts, times and status codes', () => {
    assert.equal(sanitizeAndroidTelemetry({}), null);
    const out = sanitizeAndroidTelemetry({ telemetry: { smsReceived: -4, uploadsAccepted: 2.5, lastUploadHttpStatus: 9999, workerRunning: 'yes', appVersion: '<b>1.1</b>' } });
    assert.equal(out.smsReceived, null);
    assert.equal(out.uploadsAccepted, null);
    assert.equal(out.lastUploadHttpStatus, null);
    assert.equal(out.workerRunning, null);
    assert.equal(out.appVersion, 'b1.1b');
  });
});
