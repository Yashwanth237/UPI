import '../../../../scripts/test-support.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { Database } from '@youpi/db';
import { PaymentStatus, generateHmac } from '@youpi/common';
import { startServer as startPaymentApi } from '../index.js';
import { TEST_ADMIN_TOKEN, TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

// Security and multi-account behaviour of the observation path: transaction direction, sender
// allow-list, Android HMAC/replay, response redaction, VPA switching, same-amount queueing and
// webhook idempotency. All bank messages are synthetic.
describe('Observation security and receiving accounts', () => {
  const MERCHANT = '00000000-0000-0000-0000-000000000001';
  let api;
  let db;
  let baseUrl;
  let primaryAccountId;
  let utrSeq = 0;

  const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
  const observer = { Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` };
  const nextUtr = () => `6${String(Date.now()).slice(-7)}${String(++utrSeq).padStart(4, '0')}`;
  const creditSms = (amount, utr) => `Rs.${amount} credited to a/c XX1234 by VPA payer@okaxis (UPI Ref No ${utr}).`;

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6299, db);
    baseUrl = `http://localhost:${api.port}`;
    primaryAccountId = api.app.context.accountRepo.findActiveForMerchant(MERCHANT).id;
  });

  after(async () => {
    await api.close();
    db.close();
  });

  beforeEach(() => {
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    db.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL');
    api.app.context.accountRepo.activateAccount(MERCHANT, primaryAccountId);
    delete process.env.SMS_TRUSTED_SENDERS;
  });

  async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body))
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, text };
  }

  async function pay(orderId, amount) {
    const res = await call('/api/v1/payments', { method: 'POST', body: { orderId, amount, autoActivate: true } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  }

  const statusOf = id => api.app.context.sessionRepo.findById(id).status;
  const observe = (rawText, { sender = 'VM-HDFCBK', receivingAccountId = primaryAccountId } = {}) =>
    call('/api/v1/pollers/events', { method: 'POST', headers: observer, body: { source: 'SMS', sender, receivingAccountId, rawText } });

  describe('transaction direction', () => {
    const cases = [
      ['credit word before a debit word', a => `Rs.${a} credited to SHOPKEEPER from your A/c XX1234, debited on 29-10-26. UPI Ref ${nextUtr()}`, 'AMBIGUOUS_DIRECTION'],
      ['refund credited', a => `Refund of Rs.${a} credited to your A/c XX1234. Ref No ${nextUtr()}`, 'REVERSAL_OR_REFUND'],
      ['reversal credited', a => `Rs.${a} reversed and credited to A/c XX1234 for UPI txn ${nextUtr()}`, 'REVERSAL_OR_REFUND'],
      ['failed transaction', a => `Your UPI txn of Rs.${a} has failed. Amount if debited will be credited. Ref ${nextUtr()}`, 'REVERSAL_OR_REFUND'],
      ['debit transferred out', a => `Rs.${a} debited from A/c XX1234 and transferred to merchant@ybl. UPI Ref ${nextUtr()}`, 'DEBIT_NOTIFICATION']
    ];
    let n = 0;
    for (const [name, text, reason] of cases) {
      test(`${name} does not settle the order (${reason})`, async () => {
        const amount = `${210 + ++n}.00`;
        const { paymentId } = await pay(`DIR-${n}`, amount);
        const res = await observe(text(amount));
        assert.equal(res.body.accepted, false);
        assert.equal(res.body.reason, reason);
        assert.equal(statusOf(paymentId), PaymentStatus.ACTIVE);
      });
    }

    test('a plain credit still settles', async () => {
      const { paymentId } = await pay('DIR-OK', '220.00');
      assert.equal((await observe(creditSms('220.00', nextUtr()))).status, 200);
      assert.equal(statusOf(paymentId), PaymentStatus.SUCCESS);
    });
  });

  describe('SMS sender allow-list (SMS_TRUSTED_SENDERS)', () => {
    test('unset: any alphanumeric sender passes the filter', async () => {
      const { paymentId } = await pay('SND-OPEN', '230.00');
      assert.equal((await observe(creditSms('230.00', nextUtr()), { sender: 'FAKEBNK' })).status, 200);
      assert.equal(statusOf(paymentId), PaymentStatus.SUCCESS);
    });

    test('set: only listed headers pass, with operator prefix and category suffix ignored', async () => {
      process.env.SMS_TRUSTED_SENDERS = 'HDFCBK, SBIUPI';
      const { paymentId } = await pay('SND-ENFORCE', '231.00');
      const fake = await observe(creditSms('231.00', nextUtr()), { sender: 'FAKEBNK' });
      assert.equal(fake.body.reason, 'UNTRUSTED_SMS_SENDER');
      assert.equal(statusOf(paymentId), PaymentStatus.ACTIVE);

      assert.equal((await observe(creditSms('231.00', nextUtr()), { sender: 'AD-HDFCBK-S' })).status, 200);
      assert.equal(statusOf(paymentId), PaymentStatus.SUCCESS);
    });
  });

  test('rejected observations do not echo the bank message back', async () => {
    await pay('REDACT', '240.00');
    const secretish = 'A/c XX9876 balance details';
    const res = await observe(`Rs.24.00 credited to ${secretish} (UPI Ref No ${nextUtr()}).`);
    assert.equal(res.body.accepted, false);
    assert.equal(res.text.includes(secretish), false, 'response must not contain the message text');
    assert.equal(res.body.reason, 'AMOUNT_MISMATCH');
  });

  describe('Android observer authentication', () => {
    const deviceId = 'sec-test-android-1';
    const signingKey = crypto.randomBytes(32).toString('hex');

    before(() => {
      db.execute(`
        INSERT OR REPLACE INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, last_heartbeat_at, created_at)
        VALUES (?, ?, 'Sec Device', 'Test', ?, 1, datetime('now'), datetime('now'))
      `, [deviceId, MERCHANT, signingKey]);
    });

    const signed = (bodyObj, { key = signingKey, ts = Date.now(), id = deviceId } = {}) => {
      const raw = JSON.stringify(bodyObj);
      const timestamp = String(ts);
      return { raw, headers: { 'X-Device-Id': id, 'X-Timestamp': timestamp, 'X-Signature': generateHmac(`${raw}:${timestamp}`, key) } };
    };

    test('valid signature settles once; an exact replay and a bad signature do not', async () => {
      const { paymentId } = await pay('AND-1', '250.00');
      const req = signed({ sender: 'VM-HDFCBK', body: creditSms('250.00', nextUtr()), timestamp: Date.now() });

      const bad = await call('/api/v1/observers/sms', { method: 'POST', raw: req.raw, headers: { ...req.headers, 'X-Signature': '00'.repeat(32) } });
      assert.equal(bad.status, 401);
      assert.equal(statusOf(paymentId), PaymentStatus.ACTIVE);

      const ok = await call('/api/v1/observers/sms', { method: 'POST', raw: req.raw, headers: req.headers });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(statusOf(paymentId), PaymentStatus.SUCCESS);

      const replay = await call('/api/v1/observers/sms', { method: 'POST', raw: req.raw, headers: req.headers });
      assert.equal(replay.body.accepted, false);
      assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM payment_sessions WHERE order_id = 'AND-1' AND status = 'SUCCESS'").n, 1);
    });

    test('stale timestamp, unknown device, missing signature and wrong key are refused', async () => {
      const { paymentId } = await pay('AND-2', '251.00');
      const body = { sender: 'VM-HDFCBK', body: creditSms('251.00', nextUtr()) };

      const stale = signed(body, { ts: Date.now() - 10 * 60 * 1000 });
      assert.equal((await call('/api/v1/observers/sms', { method: 'POST', raw: stale.raw, headers: stale.headers })).status, 401);

      const unknown = signed(body, { id: 'not-a-paired-device' });
      assert.equal((await call('/api/v1/observers/sms', { method: 'POST', raw: unknown.raw, headers: unknown.headers })).status, 403);

      const noSig = signed(body);
      delete noSig.headers['X-Signature'];
      assert.equal((await call('/api/v1/observers/sms', { method: 'POST', raw: noSig.raw, headers: noSig.headers })).status, 401);

      const wrongKey = signed(body, { key: crypto.randomBytes(32).toString('hex') });
      assert.equal((await call('/api/v1/observers/sms', { method: 'POST', raw: wrongKey.raw, headers: wrongKey.headers })).status, 401);

      assert.equal(statusOf(paymentId), PaymentStatus.ACTIVE);
    });
  });

  describe('two receiving VPAs', () => {
    let secondId;
    before(async () => {
      const res = await call('/api/v1/admin/upi-accounts', {
        method: 'POST', headers: admin, body: { upiId: 'second.shop@okhdfcbank', payeeName: 'Second Shop', isActive: false }
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      secondId = res.body.account.id;
    });

    test('the same VPA cannot be added twice, and the seeded placeholder is flagged as demo', async () => {
      const dup = await call('/api/v1/admin/upi-accounts', {
        method: 'POST', headers: admin, body: { upiId: 'Second.Shop@okhdfcbank', payeeName: 'Again', isActive: false }
      });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.code, 'DUPLICATE_VPA');

      const list = await call('/api/v1/admin/upi-accounts', { headers: admin });
      const byId = Object.fromEntries(list.body.accounts.map(a => [a.id, a]));
      assert.equal(byId[primaryAccountId].isDemo, true);
      assert.equal(byId[secondId].isDemo, false);
    });

    test('only one VPA is active; switching is refused while the other has a payment open', async () => {
      const { paymentId } = await pay('VPA-OPEN', '260.00');
      const blocked = await call(`/api/v1/admin/upi-accounts/${secondId}/activate`, { method: 'POST', headers: admin });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, 'ACCOUNT_SWITCH_BLOCKED');
      assert.equal(api.app.context.accountRepo.findActiveForMerchant(MERCHANT).id, primaryAccountId);

      await call(`/api/v1/checkout/${paymentId}/cancel`, { method: 'POST' });
      const ok = await call(`/api/v1/admin/upi-accounts/${secondId}/activate`, { method: 'POST', headers: admin });
      assert.equal(ok.status, 200);
      const accounts = api.app.context.accountRepo.findByMerchantId(MERCHANT).filter(a => a.isActive);
      assert.deepEqual(accounts.map(a => a.id), [secondId]);
    });

    test('new payments use the active VPA, and the URI names it', async () => {
      api.app.context.accountRepo.activateAccount(MERCHANT, secondId);
      const { paymentId } = await pay('VPA-B', '261.00');
      assert.equal(api.app.context.sessionRepo.findById(paymentId).receivingAccountId, secondId);
      const state = await call(`/api/v1/checkout/${paymentId}/state`);
      const uri = JSON.stringify(state.body).match(/upi:\/\/pay\?[^"\\]+/)[0];
      assert.equal(new URL(uri).searchParams.get('pa'), 'second.shop@okhdfcbank');
    });

    test('a credit reported for the other VPA never settles this VPA\'s order', async () => {
      api.app.context.accountRepo.activateAccount(MERCHANT, secondId);
      const { paymentId } = await pay('VPA-CROSS', '262.00');
      const res = await observe(creditSms('262.00', nextUtr()), { receivingAccountId: primaryAccountId });
      assert.equal(res.body.accepted, false);
      assert.equal(statusOf(paymentId), PaymentStatus.ACTIVE);
    });
  });

  test('pairing QR flags addresses a phone cannot use', async () => {
    const qr = await call('/api/v1/admin/sms-gateway/pair-qr', { headers: admin });
    assert.equal(qr.status, 200);
    assert.equal(qr.body.phoneReachable, false, 'localhost API URL is not reachable from a phone');
    assert.match(qr.body.phoneReachabilityWarning, /phone itself/);

    const { assessPhoneReachability } = await import('../routes/pollers.routes.js');
    assert.equal(assessPhoneReachability('http://192.168.1.20:6100').ok, false);
    assert.equal(assessPhoneReachability('http://127.0.0.1:6100').ok, false);
    assert.equal(assessPhoneReachability('https://pay-api.example.com').ok, true);
  });

  test('same-amount orders queue; one credit settles only the first, the second needs its own', async () => {
    const first = await pay('SAME-1', '270.00');
    const second = await pay('SAME-2', '270.00');
    assert.equal(first.status, PaymentStatus.ACTIVE);
    assert.equal(second.status, PaymentStatus.QUEUED);

    const utr = nextUtr();
    assert.equal((await observe(creditSms('270.00', utr))).status, 200);
    assert.equal(statusOf(first.paymentId), PaymentStatus.SUCCESS);
    assert.notEqual(statusOf(second.paymentId), PaymentStatus.SUCCESS);

    const again = await observe(creditSms('270.00', utr));
    assert.equal(again.body.accepted, false);
    assert.notEqual(statusOf(second.paymentId), PaymentStatus.SUCCESS);

    assert.equal(statusOf(second.paymentId), PaymentStatus.ACTIVE, 'second order is promoted to the free slot');
    assert.equal((await observe(creditSms('270.00', nextUtr()))).status, 200);
    assert.equal(statusOf(second.paymentId), PaymentStatus.SUCCESS);
  });

  test('a credit after the payment window is refused even if the session was not yet expired', async () => {
    const { paymentId } = await pay('WINDOW', '280.00');
    db.execute("UPDATE payment_sessions SET expires_at = ? WHERE id = ?", [new Date(Date.now() - 60000).toISOString(), paymentId]);
    const res = await observe(creditSms('280.00', nextUtr()));
    assert.equal(res.body.accepted, false);
    assert.notEqual(statusOf(paymentId), PaymentStatus.SUCCESS);
  });

  test('expire on a paid order reports SUCCESS and changes nothing', async () => {
    const { paymentId } = await pay('EXPIRE-PAID', '290.00');
    await observe(creditSms('290.00', nextUtr()));
    const res = await call(`/api/v1/checkout/${paymentId}/expire`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, PaymentStatus.SUCCESS);
    assert.equal(statusOf(paymentId), PaymentStatus.SUCCESS);
  });

  test('a paid order sends exactly one signed SUCCESS webhook despite duplicate and second-channel alerts', async () => {
    const received = [];
    const receiver = http.createServer((req, res) => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => { received.push({ headers: req.headers, body: data }); res.end('{"ok":true}'); });
    });
    await new Promise(r => receiver.listen(0, '127.0.0.1', r));
    const merchantRepo = api.app.context.merchantRepo;
    const previousUrl = merchantRepo.findById(MERCHANT).webhookUrl;
    merchantRepo.update(MERCHANT, { webhookUrl: `http://127.0.0.1:${receiver.address().port}/hook` });
    try {
      const { paymentId } = await pay('HOOK-1', '300.00');
      const utr = nextUtr();
      await observe(creditSms('300.00', utr));
      await observe(creditSms('300.00', utr));
      await call('/api/v1/pollers/events', {
        method: 'POST', headers: observer,
        body: { source: 'GMAIL', sender: 'alerts@hdfcbank.net', receivingAccountId: primaryAccountId, rawText: `Rs.300.00 credited to your account. UPI Ref No ${utr}` }
      });
      await new Promise(r => setTimeout(r, 500));
      assert.equal(statusOf(paymentId), PaymentStatus.SUCCESS);

      const success = received.filter(r => JSON.parse(r.body).orderId === 'HOOK-1' && JSON.parse(r.body).event === 'SUCCESS');
      assert.equal(success.length, 1);
      const secret = merchantRepo.findById(MERCHANT).webhookSecret;
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(success[0].body).digest('hex');
      assert.equal(success[0].headers['x-gateway-signature'], expected);
      assert.equal(JSON.parse(success[0].body).utr, utr);
      assert.equal(JSON.parse(success[0].body).livemode, true, 'a real observer alert is live');

      // An operator-typed message through the developer simulator is flagged as not live.
      const sim = await pay('HOOK-SIM', '301.00');
      const simRes = await call(`/api/v1/checkout/${sim.paymentId}/simulate-observation`, {
        method: 'POST', headers: admin, body: { source: 'SMS', sender: 'VM-HDFCBK', rawText: creditSms('301.00', nextUtr()) }
      });
      assert.equal(simRes.status, 200, JSON.stringify(simRes.body));
      await new Promise(r => setTimeout(r, 500));
      const simHook = received.find(r => JSON.parse(r.body).orderId === 'HOOK-SIM');
      assert.ok(simHook, 'simulated payment still notifies the merchant');
      assert.equal(JSON.parse(simHook.body).livemode, false);
      assert.equal(simHook.headers['x-gateway-livemode'], 'false');
    } finally {
      merchantRepo.update(MERCHANT, { webhookUrl: previousUrl || null });
      receiver.close();
    }
  });
});
