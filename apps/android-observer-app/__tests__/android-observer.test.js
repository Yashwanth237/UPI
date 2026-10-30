import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../apps/payment-api/src/index.js';
import { AndroidObserverDriver } from '../driver.js';
import { PaymentStatus, resolveSecret, getAdminToken } from '@youpi/common';

describe('Android Payment Observer Integration Tests', () => {
  let apiInstance;
  let driver;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6217, testDb);
    driver = new AndroidObserverDriver({
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      deviceName: 'Pixel 8 Pro Tester',
      deviceModel: 'Pixel 8 Pro'
    });
  });

  // The pairing token the Merchant Admin page shows (and encodes in the pairing QR).
  async function fetchPairQr() {
    const res = await fetch(`http://localhost:${apiInstance.port}/api/v1/admin/sms-gateway/pair-qr`, {
      headers: { Authorization: `Bearer ${getAdminToken()}` }
    });
    assert.equal(res.status, 200);
    return res.json();
  }

  after(async () => {
    driver.stopHeartbeat();
    await apiInstance.close();
    testDb.close();
  });

  test('rejects pairing with invalid enrollment token', async () => {
    await assert.rejects(
      () => driver.pair('invalid_token_123'),
      /Device pairing failed/
    );
  });

  test('rejects the long-lived enrollment secret itself; only a minted pairing token pairs', async () => {
    const enrollmentSecret = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
    await assert.rejects(() => driver.pair(enrollmentSecret), /Device pairing failed/);
  });

  test('rejects an expired or tampered pairing token', async () => {
    const qr = await fetchPairQr();
    const [, exp, mac] = qr.enrollmentToken.split('.');
    await assert.rejects(() => driver.pair(`yp1.${Number(exp) - 11 * 60 * 1000}.${mac}`), /Device pairing failed/);
    await assert.rejects(() => driver.pair(qr.enrollmentToken, '00000000-0000-0000-0000-0000000000ff'), /Device pairing failed/);
  });

  test('successfully pairs Android device with valid enrollment token', async () => {
    const qr = await fetchPairQr();
    const pairResult = await driver.pair(qr.enrollmentToken);

    assert.ok(pairResult.paired);
    assert.ok(pairResult.deviceId);
    assert.ok(pairResult.signingKey);

    assert.equal(driver.deviceId, pairResult.deviceId);
    assert.equal(driver.signingKey, pairResult.signingKey);
  });

  test('sends heartbeat acknowledging liveness', async () => {
    const hbResult = await driver.sendHeartbeat();
    assert.equal(hbResult.status, 'HEARTBEAT_ACK');
    assert.ok(hbResult.timestamp);
  });

  test('refuses an unsigned or forged heartbeat, so nobody else can keep a device looking online', async () => {
    const url = `http://localhost:${apiInstance.port}/api/v1/pollers/android/heartbeat`;
    const bodyString = JSON.stringify({ deviceId: driver.deviceId });
    const before = apiInstance.app.context.db.queryOne('SELECT last_heartbeat_at FROM android_devices WHERE id = ?', [driver.deviceId]);

    const unsigned = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': driver.deviceId },
      body: bodyString
    });
    assert.equal(unsigned.status, 401);

    const forged = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': driver.deviceId,
        'X-Timestamp': Date.now().toString(),
        'X-Signature': 'ab'.repeat(32)
      },
      body: bodyString
    });
    assert.equal(forged.status, 401);

    const unknown = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'not-a-paired-device' },
      body: JSON.stringify({ deviceId: 'not-a-paired-device' })
    });
    assert.equal(unknown.status, 403);

    const after = apiInstance.app.context.db.queryOne('SELECT last_heartbeat_at FROM android_devices WHERE id = ?', [driver.deviceId]);
    assert.equal(after.last_heartbeat_at, before.last_heartbeat_at);
  });

  test('rejects observation with expired/drifted timestamp (Replay Protection)', async () => {
    // Window: at most 5 minutes old, at most 60 s in the future (same as device-security.js).
    const tooOld = await driver.submitObservation({
      amount: '200.00',
      timestampOverride: Date.now() - 6 * 60 * 1000
    });
    assert.equal(tooOld.status, 401);
    assert.ok(tooOld.body.error.includes('validity window'));

    const fromTheFuture = await driver.submitObservation({
      amount: '200.00',
      timestampOverride: Date.now() + 2 * 60 * 1000
    });
    assert.equal(fromTheFuture.status, 401);
    assert.ok(fromTheFuture.body.error.includes('validity window'));
  });

  test('submits valid HMAC-signed observation and confirms payment in Payment API', async () => {
    // 1. Create and activate a payment session for ₹350
    const session = apiInstance.app.context.sessionRepo.create({
      merchantId: '00000000-0000-0000-0000-000000000001',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      orderId: 'ANDR-ORD-350',
      amountPaise: 35000n
    });

    apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
    apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

    // 2. Android observer submits observation for ₹350
    const res = await driver.submitObservation({
      amount: '350.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-ANDR-9876',
      senderVpa: 'customer@paytm',
      notificationText: 'Payment of ₹350 received from customer@paytm on PhonePe'
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.attribution.attributed, true);
    assert.equal(res.body.attribution.paymentSessionId, session.id);
    assert.equal(res.body.attribution.outcomeStatus, PaymentStatus.SUCCESS);

    // 3. Verify session in DB updated to SUCCESS
    const updated = apiInstance.app.context.sessionRepo.findById(session.id);
    assert.equal(updated.status, PaymentStatus.SUCCESS);
  });

  describe('SMS forwarded in the APK\'s own request shape (synthetic messages, in-memory database)', () => {
    const ctx = () => apiInstance.app.context;
    const openSession = (orderId, amountPaise) => {
      const session = ctx().sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId,
        amountPaise
      });
      ctx().queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      ctx().timingEngine.handlePaymentDone(session.id);
      return session;
    };

    test('a credit alert settles the matching synthetic checkout, and a re-delivery does not settle another', async () => {
      const first = openSession('ANDR-SMS-421', 42100n);
      const sms = { sender: 'VM-HDFCBK', body: 'Rs.421.00 credited to a/c XX1234 (UPI Ref No 512398765432).', receivedAt: Date.now() };

      const res = await driver.submitSms(sms);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.accepted, true);
      assert.equal(ctx().sessionRepo.findById(first.id).status, PaymentStatus.SUCCESS);
      assert.doesNotMatch(JSON.stringify(res.body), /credited to a\/c/, 'response must not echo the SMS text');

      // The outbox retries after a lost response; the same alert must not pay a second order.
      const second = openSession('ANDR-SMS-421-B', 42100n);
      const again = await driver.submitSms(sms);
      assert.notEqual(again.body.accepted, true);
      assert.notEqual(ctx().sessionRepo.findById(second.id).status, PaymentStatus.SUCCESS);
    });

    test('an alert delivered late (phone was offline) is signed now and judged by its receive time', async () => {
      const res = await driver.submitSms({
        sender: 'AD-SBIUPI-S',
        body: 'Dear SBI user, A/C 1234 credited by Rs 77.00 by UPI Ref 401299887766.',
        receivedAt: Date.now() - 20 * 60 * 1000
      });
      assert.notEqual(res.status, 401, 'a fresh signature must be accepted however old the SMS is');
    });

    test('a non-bank SMS is acknowledged without being stored as an observation', async () => {
      const before = ctx().db.queryOne('SELECT COUNT(*) AS n FROM payment_observations').n;
      const res = await driver.submitSms({ sender: '+919876543210', body: 'Reached home, call you later' });
      assert.ok(res.status === 200 || res.status === 400, `status ${res.status}`);
      assert.equal(ctx().db.queryOne('SELECT COUNT(*) AS n FROM payment_observations').n, before);
    });

    test('a forged signature or an unpaired device is refused before any parsing', async () => {
      const forged = new AndroidObserverDriver({ apiBaseUrl: driver.apiBaseUrl });
      forged.deviceId = driver.deviceId;
      forged.signingKey = 'f'.repeat(64);
      const res = await forged.submitSms({ sender: 'VM-HDFCBK', body: 'Rs.10.00 credited Ref 512300000001' });
      assert.equal(res.status, 401);

      const stranger = new AndroidObserverDriver({ apiBaseUrl: driver.apiBaseUrl });
      stranger.deviceId = 'not-a-paired-device';
      stranger.signingKey = 'f'.repeat(64);
      assert.equal((await stranger.submitSms({ sender: 'VM-HDFCBK', body: 'Rs.10.00 credited Ref 512300000002' })).status, 403);
    });
  });

  test('Issue #61: rejects notification observation when rawNotification has missing or empty package', async () => {
    const resWithoutPkg = await driver.submitObservation({
      amount: '100.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-MISSING-PKG',
      notificationText: 'Payment of ₹100 received from user@bank on UPI',
      package: ''
    });

    assert.equal(resWithoutPkg.status, 400);
    assert.match(resWithoutPkg.body.error, /must specify a valid package name/);
  });

  test('Issue #61: rejects notification observation from untrusted/unallowed package name', async () => {
    const resUntrusted = await driver.submitObservation({
      amount: '100.00',
      receivingAccountId: '00000000-0000-0000-0000-000000000002',
      utr: 'UTR-UNTRUSTED-PKG',
      notificationText: 'Payment of ₹100 received from fake@bank on FakeApp',
      package: 'com.attacker.fake.banking'
    });

    assert.equal(resUntrusted.status, 400);
    assert.match(resUntrusted.body.error, /Untrusted Android notification package/);
  });
});
