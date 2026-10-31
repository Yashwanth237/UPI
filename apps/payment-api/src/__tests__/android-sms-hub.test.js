import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { PaymentStatus } from '@youpi/common';
import { startServer as startPaymentApi } from '../index.js';
import { maskSmsSender, maskLongDigits } from '../routes/pollers.routes.js';
import { AndroidObserverDriver } from '../../../android-observer-app/driver.js';
import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';

// Android SMS Hub: what a merchant sees for each credit alert a paired phone uploaded. Synthetic
// SMS on an in-memory database; personal-SMS protection and sender checks unchanged.
describe('Android SMS Hub', () => {
  const MERCHANT = '00000000-0000-0000-0000-000000000001';
  const ACCOUNT = '00000000-0000-0000-0000-000000000002';
  let api;
  let db;
  let base;
  let phone;
  const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
  const hub = async () => (await fetch(`${base}/api/v1/admin/sms-gateway/messages`, { headers: admin })).json();
  const openCheckout = (orderId, amountPaise) => {
    const ctx = api.app.context;
    const s = ctx.sessionRepo.create({ merchantId: MERCHANT, receivingAccountId: ACCOUNT, orderId, amountPaise });
    ctx.queueEngine.enqueueOrActivate(s.id, ACCOUNT);
    ctx.timingEngine.handlePaymentDone(s.id);
    return s;
  };

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6235, db);
    base = `http://localhost:${api.port}`;
    const qr = await (await fetch(`${base}/api/v1/admin/sms-gateway/pair-qr`, { headers: admin })).json();
    phone = new AndroidObserverDriver({ apiBaseUrl: base, deviceName: 'RMX5110', deviceModel: 'realme RMX5110' });
    await phone.pair(qr.enrollmentToken);
  });

  after(async () => {
    await api.close();
    db.close();
  });

  test('the hub endpoint is admin-only', async () => {
    assert.equal((await fetch(`${base}/api/v1/admin/sms-gateway/messages`)).status, 401);
  });

  test('a bank credit with no open checkout is NEEDS_REVIEW, not accepted', async () => {
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    const res = await phone.submitSms({ sender: 'AD-SBIUPI-S', body: 'Dear SBI user, A/C 1234 credited by Rs 88.00 by UPI Ref 401299880088.' });
    assert.equal(res.status, 400, JSON.stringify({ reason: res.body.reason, stage: res.body.pipeline?.failingStage, why: res.body.error }));
    const row = (await hub()).messages.find(m => m.amountPaise === '8800');
    assert.equal(row.reason, 'NO_ACTIVE_SESSION', JSON.stringify(row));
    assert.equal(row.status, 'NEEDS_REVIEW');
    assert.equal(row.reason, 'NO_ACTIVE_SESSION');
  });

  test('a supported bank credit from a bank header, with a matching checkout, shows as ACCEPTED', async () => {
    const s = openCheckout('HUB-ORD-1', 31700n);
    const res = await phone.submitSms({ sender: 'VM-HDFCBK', body: 'Rs.317.00 credited to a/c XX1234 (UPI Ref No 512398760317).' });
    assert.equal(res.status, 200);
    assert.equal(api.app.context.sessionRepo.findById(s.id).status, PaymentStatus.SUCCESS);

    const row = (await hub()).messages.find(m => m.amountPaise === '31700');
    assert.equal(row.status, 'ACCEPTED');
    assert.equal(row.reason, 'VERIFIED');
    assert.equal(row.sender, 'VM-HDFCBK');
    assert.equal(row.deviceName, 'RMX5110');
    assert.equal(row.merchantId, MERCHANT);
    assert.equal(row.referenceLast4, '0317');
  });

  test('a credit-shaped SMS from a phone number stays REJECTED, with the number masked everywhere', async () => {
    const res = await phone.submitSms({ sender: '+919876543210', body: 'Rs.1.00 credited to a/c XX0000 UPI Ref No 500000000001' });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, 'PERSONAL_SMS_REJECTED');
    assert.doesNotMatch(JSON.stringify(res.body), /9876543210|543210/);

    const row = (await hub()).messages.find(m => m.reason === 'PERSONAL_SMS_REJECTED');
    assert.equal(row.status, 'REJECTED');
    assert.equal(row.sender, 'number ••••3210');
    assert.doesNotMatch(JSON.stringify(await hub()), /9876543210/);
  });

  test('an unknown made-up sender code is not accepted', async () => {
    const res = await phone.submitSms({ sender: 'FAKE*BANK!', body: 'Rs.5.00 credited to a/c XX1234 Ref 512300000555' });
    assert.equal(res.status, 400);
    assert.equal((await hub()).messages.find(m => m.amountPaise === '500').status, 'REJECTED');
  });

  test('a duplicate upload of an accepted alert does not settle another checkout', async () => {
    const before = (await hub()).messages.length;
    const second = openCheckout('HUB-ORD-2', 31700n);
    await phone.submitSms({ sender: 'VM-HDFCBK', body: 'Rs.317.00 credited to a/c XX1234 (UPI Ref No 512398760317).' });
    assert.notEqual(api.app.context.sessionRepo.findById(second.id).status, PaymentStatus.SUCCESS);
    const rows = (await hub()).messages;
    assert.equal(rows.length, before + 1);
    assert.notEqual(rows[0].status, 'ACCEPTED');
  });

  test('message text never appears in the hub', async () => {
    const all = JSON.stringify(await hub());
    assert.doesNotMatch(all, /credited to a\/c|Dear SBI user/);
  });

  test('masking helpers keep bank headers and hide numbers', () => {
    assert.equal(maskSmsSender('VM-HDFCBK'), 'VM-HDFCBK');
    assert.equal(maskSmsSender('+91 98765 43210'), 'number ••••3210');
    assert.equal(maskSmsSender(''), null);
    assert.equal(maskLongDigits('Personal SMS from numeric phone numbers (+919876543210) is rejected.'), 'Personal SMS from numeric phone numbers (••••) is rejected.');
    assert.equal(maskLongDigits('Rs 499.00 at 10:30'), 'Rs 499.00 at 10:30');
  });
});
