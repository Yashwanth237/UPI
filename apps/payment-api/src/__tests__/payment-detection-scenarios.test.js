import '../../../../scripts/test-support.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { PaymentStatus } from '@youpi/common';
import { startServer as startPaymentApi } from '../index.js';
import { TEST_OBSERVER_TOKEN, TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';

// End-to-end payment detection scenarios against the real HTTP API, an in-memory SQLite
// database, the verification pipeline and the attribution engine. Every bank message here is
// synthetic; nothing talks to a bank, Gmail or a phone.
describe('Payment detection scenarios (create → observe → settle)', () => {
  let api;
  let db;
  let baseUrl;
  let receivingAccountId;
  let utrSeq = 0;

  const observerAuth = { Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` };
  const nextUtr = () => `5${String(Date.now()).slice(-7)}${String(++utrSeq).padStart(4, '0')}`;

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6297, db);
    baseUrl = `http://localhost:${api.port}`;
    receivingAccountId = api.app.context.accountRepo.findActiveForMerchant('00000000-0000-0000-0000-000000000001').id;
  });

  after(async () => {
    await api.close();
    db.close();
  });

  // Each scenario starts with a free UPI slot so sessions do not queue behind one another.
  beforeEach(() => {
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    db.execute('UPDATE payment_receiving_accounts SET is_slot_busy = 0, current_active_session_id = NULL');
  });

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }

  async function createActivePayment(orderId, amount) {
    const res = await call('/api/v1/payments', {
      method: 'POST',
      body: { orderId, amount, currency: 'INR', autoActivate: true }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, PaymentStatus.ACTIVE);
    return res.body.paymentId;
  }

  const statusOf = id => api.app.context.sessionRepo.findById(id).status;

  const observe = (rawText, { sender = 'VM-HDFCBK', source = 'SMS', auth = observerAuth } = {}) =>
    call('/api/v1/pollers/events', {
      method: 'POST',
      headers: auth,
      body: { source, sender, receivingAccountId, rawText }
    });

  const creditSms = (amount, utr) =>
    `Rs.${amount} credited to a/c XX1234 on 29-10-26 by a/c linked to VPA payer@okaxis (UPI Ref No ${utr}).`;

  test('payment request: unique id, INR, server amount, merchant VPA, starts pending in SQLite', async () => {
    const a = await createActivePayment('DET-CREATE-1', '149.00');
    // A second order on the same VPA queues behind the first (single active slot per VPA).
    const second = await call('/api/v1/payments', {
      method: 'POST',
      body: { orderId: 'DET-CREATE-2', amount: '149.00', currency: 'INR', autoActivate: true }
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.status, PaymentStatus.QUEUED);
    const b = second.body.paymentId;
    assert.notEqual(a, b);

    const row = db.queryOne('SELECT amount_paise, currency, status, receiving_account_id FROM payment_sessions WHERE id = ?', [b]);
    assert.equal(Number(row.amount_paise), 14900);
    assert.equal(row.currency, 'INR');
    assert.equal(row.receiving_account_id, receivingAccountId);
    assert.ok([PaymentStatus.ACTIVE, PaymentStatus.QUEUED].includes(row.status));

    const state = await call(`/api/v1/checkout/${a}/state`);
    assert.equal(state.status, 200);
    const uri = JSON.stringify(state.body).match(/upi:\/\/pay\?[^"\\]+/);
    assert.ok(uri, 'checkout state exposes a upi://pay URI');
    const params = new URL(uri[0]).searchParams;
    const account = api.app.context.accountRepo.findById(receivingAccountId);
    assert.equal(params.get('pa'), account.upiId);
    assert.equal(params.get('am'), '149.00');
  });

  test('pending payment stays pending and repeated status polling has no side effects', async () => {
    const id = await createActivePayment('DET-PENDING', '151.00');
    const obsBefore = db.queryOne('SELECT COUNT(*) AS n FROM payment_observations').n;
    for (let i = 0; i < 5; i++) {
      const res = await call(`/api/v1/payments/${id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, PaymentStatus.ACTIVE);
    }
    assert.equal(statusOf(id), PaymentStatus.ACTIVE);
    assert.equal(db.queryOne('SELECT COUNT(*) AS n FROM payment_observations').n, obsBefore);
  });

  test('valid notification settles exactly the matching order and leaves an audit trail', async () => {
    const id = await createActivePayment('DET-VALID', '152.00');
    const utr = nextUtr();
    const res = await observe(creditSms('152.00', utr));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.accepted, true);
    assert.equal(statusOf(id), PaymentStatus.SUCCESS);

    const obs = db.queryOne('SELECT attributed_payment_id, bank_reference_number FROM payment_observations WHERE bank_reference_number = ?', [utr]);
    assert.equal(obs.attributed_payment_id, id);
    const audit = db.queryOne("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id = ? AND action LIKE 'PAYMENT_%'", [id]);
    assert.ok(audit.n >= 1, 'status transition is audited');
  });

  test('duplicate notification is not processed twice', async () => {
    const id = await createActivePayment('DET-DUP', '153.00');
    const sms = creditSms('153.00', nextUtr());
    assert.equal((await observe(sms)).status, 200);
    const again = await observe(sms);
    assert.equal(again.body.accepted, false);
    assert.equal(statusOf(id), PaymentStatus.SUCCESS);
    const attributed = db.queryOne('SELECT COUNT(*) AS n FROM payment_sessions WHERE order_id = ? AND status = ?', ['DET-DUP', 'SUCCESS']);
    assert.equal(attributed.n, 1);
  });

  test('a reused UTR cannot settle a second order of the same amount', async () => {
    const utr = nextUtr();
    await createActivePayment('DET-REUSE-1', '154.00');
    assert.equal((await observe(creditSms('154.00', utr))).status, 200);

    const second = await createActivePayment('DET-REUSE-2', '154.00');
    const res = await observe(`INR 154.00 received in A/c XX1234. UPI Ref ${utr}. -AXIS`);
    assert.equal(res.body.accepted, false);
    assert.notEqual(statusOf(second), PaymentStatus.SUCCESS);
  });

  test('incorrect amount is rejected and the order stays pending', async () => {
    const id = await createActivePayment('DET-AMOUNT', '155.00');
    const res = await observe(creditSms('15.50', nextUtr()));
    assert.equal(res.status, 400);
    assert.equal(res.body.accepted, false);
    assert.equal(statusOf(id), PaymentStatus.ACTIVE);
  });

  test('a debit alert of the same amount that names the payee as "credited" does not settle the order', async () => {
    const id = await createActivePayment('DET-DEBIT', '156.00');
    const res = await observe(`Acct XX1234 debited for Rs 156.00 on 29-Oct-26; SHOPKEEPER credited. UPI:${nextUtr()}. Call 18001234567 for dispute.`);
    assert.equal(res.body.accepted, false, JSON.stringify(res.body));
    assert.equal(statusOf(id), PaymentStatus.ACTIVE);
  });

  test('a reversal of a failed debit does not settle the order', async () => {
    const id = await createActivePayment('DET-REVERSAL', '157.00');
    const res = await observe(`Rs.157.00 debited from A/c XX1234 for UPI txn ${nextUtr()} has failed and will be credited back within 48 hrs.`);
    assert.equal(res.body.accepted, false, JSON.stringify(res.body));
    assert.equal(statusOf(id), PaymentStatus.ACTIVE);
  });

  test('malformed or incomplete messages are rejected', async () => {
    const id = await createActivePayment('DET-MALFORMED', '158.00');
    for (const text of ['credited', 'Rs.158.00 credited to your account', `Your OTP is 123456. UPI Ref ${nextUtr()}`]) {
      const res = await observe(text);
      assert.equal(res.body.accepted, false, text);
    }
    assert.equal(statusOf(id), PaymentStatus.ACTIVE);
  });

  test('untrusted sources are rejected: personal number, non-bank email domain, missing observer token', async () => {
    const id = await createActivePayment('DET-UNTRUSTED', '159.00');
    const sms = creditSms('159.00', nextUtr());

    const personal = await observe(sms, { sender: '+919876543210' });
    assert.equal(personal.body.reason, 'PERSONAL_SMS_REJECTED');

    const email = await observe(sms, { source: 'GMAIL', sender: 'alerts@bank-alerts-secure.com' });
    assert.equal(email.body.reason, 'INVALID_EMAIL_DOMAIN');

    const anon = await observe(sms, { auth: {} });
    assert.equal(anon.status, 401);

    assert.equal(statusOf(id), PaymentStatus.ACTIVE);
  });

  test('a notification with no open order marks nothing paid', async () => {
    const before = db.queryOne("SELECT COUNT(*) AS n FROM payment_sessions WHERE status = 'SUCCESS'").n;
    const res = await observe(creditSms('160.00', nextUtr()));
    assert.equal(res.body.accepted, false);
    assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM payment_sessions WHERE status = 'SUCCESS'").n, before);
  });

  test('expired and cancelled orders cannot be marked paid by a later notification', async () => {
    const expired = await createActivePayment('DET-EXPIRED', '161.00');
    assert.equal((await call(`/api/v1/checkout/${expired}/expire`, { method: 'POST' })).status, 200);
    const late = await observe(creditSms('161.00', nextUtr()));
    assert.equal(late.body.accepted, false);
    assert.equal(statusOf(expired), PaymentStatus.EXPIRED);

    const cancelled = await createActivePayment('DET-CANCELLED', '162.00');
    assert.equal((await call(`/api/v1/checkout/${cancelled}/cancel`, { method: 'POST' })).status, 200);
    const afterCancel = await observe(creditSms('162.00', nextUtr()));
    assert.equal(afterCancel.body.accepted, false);
    assert.equal(statusOf(cancelled), PaymentStatus.CANCELLED);
  });

  test('forged client actions never produce SUCCESS', async () => {
    const id = await createActivePayment('DET-FORGED', '163.00');

    // "Payment done" only starts verification.
    const done = await call(`/api/v1/checkout/${id}/payment-done`, { method: 'POST', body: { status: 'SUCCESS' } });
    assert.equal(done.body.status, PaymentStatus.PROCESSING);

    // The developer simulator needs the admin credential.
    const sim = await call(`/api/v1/checkout/${id}/simulate-observation`, {
      method: 'POST',
      body: { source: 'SMS', rawText: creditSms('163.00', nextUtr()) }
    });
    assert.equal(sim.status, 401);

    // Query-string and body tampering on read/trigger endpoints change nothing.
    await call(`/api/v1/payments/${id}?status=SUCCESS`);
    await call(`/api/v1/checkout/${id}/trigger-hook`, { method: 'POST', body: { action: 'SUCCESS', details: { status: 'SUCCESS' } } });

    assert.equal(statusOf(id), PaymentStatus.PROCESSING);
  });

  test('a valid notification that arrives during verification settles the order once', async () => {
    const id = await createActivePayment('DET-DELAYED', '164.00');
    await call(`/api/v1/checkout/${id}/payment-done`, { method: 'POST' });
    assert.equal(statusOf(id), PaymentStatus.PROCESSING);

    const sms = creditSms('164.00', nextUtr());
    assert.equal((await observe(sms)).status, 200);
    assert.equal(statusOf(id), PaymentStatus.SUCCESS);
    assert.equal((await observe(sms)).body.accepted, false);
    assert.equal(statusOf(id), PaymentStatus.SUCCESS);
  });

  test('repeated views of an expired checkout record its terminal hook once and send one webhook', async () => {
    const id = await createActivePayment('DET-REVIEW-EXPIRED', '166.00');
    assert.equal((await call(`/api/v1/checkout/${id}/expire`, { method: 'POST' })).status, 200);
    assert.equal(statusOf(id), PaymentStatus.EXPIRED);

    const hook = () => call(`/api/v1/checkout/${id}/trigger-hook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: { action: 'PAYMENT_FAILED', details: { status: 'EXPIRED' } }
    });
    const first = await hook();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await hook();
    const third = await hook();
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(third.body.duplicate, true);

    const hookRows = api.app.context.auditRepo.findByEntity('PAYMENT_SESSION', id).filter(e => e.action === 'HOOK_PAYMENT_FAILED');
    assert.equal(hookRows.length, 1);
    const webhooks = db.query("SELECT event_type FROM webhook_deliveries WHERE payment_id = ? AND event_type = 'EXPIRED'", [id]);
    assert.ok(webhooks.length <= 1, `expected at most one EXPIRED webhook, got ${webhooks.length}`);
    assert.equal(statusOf(id), PaymentStatus.EXPIRED);
  });

  test('with Test Mode off the checkout simulator refuses a FAKEBNK message and the order stays unpaid', async () => {
    const id = await createActivePayment('DET-SIM-OFF', '167.00');
    const res = await call(`/api/v1/checkout/${id}/simulate-observation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: { source: 'SMS', sender: 'FAKEBNK', rawText: creditSms('167.00', nextUtr()) }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'TEST_MODE_INACTIVE');
    assert.equal(statusOf(id), PaymentStatus.ACTIVE);
  });

  test('unknown payment ids return 404', async () => {
    const missing = '11111111-2222-3333-4444-555555555555';
    assert.equal((await call(`/api/v1/payments/${missing}`)).status, 404);
    assert.equal((await call(`/api/v1/checkout/${missing}/payment-done`, { method: 'POST' })).status, 404);
    assert.equal((await call(`/api/v1/checkout/${missing}/cancel`, { method: 'POST' })).status, 404);
  });
});

describe('Payment detection with the database unavailable', () => {
  test('observations and status reads fail with a server error, never a success', async () => {
    const db = new Database({ inMemory: true });
    const api = await startPaymentApi(6298, db);
    const baseUrl = `http://localhost:${api.port}`;
    const receivingAccountId = api.app.context.accountRepo.findActiveForMerchant('00000000-0000-0000-0000-000000000001').id;
    db.close();
    try {
      const obs = await fetch(`${baseUrl}/api/v1/pollers/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` },
        body: JSON.stringify({
          source: 'SMS',
          sender: 'VM-HDFCBK',
          receivingAccountId,
          rawText: 'Rs.165.00 credited to a/c XX1234 (UPI Ref No 512345678901).'
        })
      });
      assert.ok(obs.status >= 500, `expected 5xx, got ${obs.status}`);
      const body = await obs.json().catch(() => ({}));
      assert.notEqual(body.accepted, true);

      const read = await fetch(`${baseUrl}/api/v1/payments/11111111-2222-3333-4444-555555555555`);
      assert.ok(read.status >= 500, `expected 5xx, got ${read.status}`);
    } finally {
      await api.close();
    }
  });
});
