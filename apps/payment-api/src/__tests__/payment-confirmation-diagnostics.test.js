import '../../../../scripts/test-support.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { PaymentStatus } from '@youpi/common';
import { startServer as startPaymentApi } from '../index.js';
import { TEST_ADMIN_TOKEN, TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

// Payment confirmation: what the checkout is told after a credit settles, and the trail left
// when an observation does not settle anything. Every bank message here is SYNTHETIC TEST DATA
// against an in-memory database; nothing talks to a bank, Gmail or a phone.
describe('Payment confirmation: receipt state and not-settled diagnostics', () => {
  let api;
  let db;
  let baseUrl;
  let receivingAccountId;
  let seq = 0;

  const observerAuth = { Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` };
  const adminAuth = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
  const nextUtr = () => `6${String(Date.now()).slice(-7)}${String(++seq).padStart(4, '0')}`;

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6296, db);
    baseUrl = `http://localhost:${api.port}`;
    receivingAccountId = api.app.context.accountRepo.findActiveForMerchant('00000000-0000-0000-0000-000000000001').id;
  });

  after(async () => {
    await api.close();
    db.close();
  });

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
    return { status: res.status, body: json, text };
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

  const creditSms = (amount, utr) =>
    `[TEST DATA] Rs.${amount} credited to a/c XX1234 on 29-10-26 by a/c linked to VPA payer@okaxis (UPI Ref No ${utr}).`;

  const observe = (rawText, extra = {}, headers = observerAuth) =>
    call('/api/v1/pollers/events', {
      method: 'POST',
      headers,
      body: { source: 'SMS', sender: 'VM-HDFCBK', receivingAccountId, rawText, ...extra }
    });

  const notSettled = () => db.query("SELECT entity_id, details FROM audit_logs WHERE action = 'OBSERVATION_NOT_SETTLED' ORDER BY created_at ASC")
    .map(r => ({ id: r.entity_id, ...JSON.parse(r.details) }));

  test('pending order: the checkout state stays ACTIVE and carries no receipt fields', async () => {
    const id = await createActivePayment('CONF-PENDING', '201.00');
    for (let i = 0; i < 3; i++) {
      const state = await call(`/api/v1/checkout/${id}/state`, { headers: adminAuth });
      assert.equal(state.status, 200);
      assert.equal(state.body.status, PaymentStatus.ACTIVE);
      assert.equal(state.body.utr, undefined);
      assert.equal(state.body.completedAt, undefined);
    }
  });

  test('settled order: the checkout state returns SUCCESS with the stored UTR, time and livemode', async () => {
    const id = await createActivePayment('CONF-OK', '202.00');
    const utr = nextUtr();
    const res = await observe(creditSms('202.00', utr));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.accepted, true);

    // The persisted status and the API status agree.
    assert.equal(db.queryOne('SELECT status FROM payment_sessions WHERE id = ?', [id]).status, PaymentStatus.SUCCESS);
    const state = await call(`/api/v1/checkout/${id}/state`);
    assert.equal(state.status, 200);
    assert.equal(state.body.status, PaymentStatus.SUCCESS);
    assert.equal(state.body.amount, '202.00');
    assert.equal(state.body.orderId, 'CONF-OK');
    assert.equal(state.body.utr, utr);
    assert.equal(state.body.method, 'UPI');
    assert.equal(state.body.merchantName, 'YOUPI Demo Store');
    assert.equal(state.body.livemode, true);
    assert.ok(!Number.isNaN(new Date(state.body.completedAt).getTime()));

    // A page refresh after success reads the same terminal state again.
    const again = await call(`/api/v1/checkout/${id}/state`);
    assert.deepEqual({ ...again.body }, { ...state.body });
  });

  test('a session settled by an admin test message is reported livemode:false', async () => {
    const id = await createActivePayment('CONF-TEST', '203.00');
    const res = await observe(creditSms('203.00', nextUtr()), { isTest: true }, adminAuth);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const state = await call(`/api/v1/checkout/${id}/state`);
    assert.equal(state.body.status, PaymentStatus.SUCCESS);
    assert.equal(state.body.livemode, false);
  });

  test('cancelled and expired orders report their own status with no receipt', async () => {
    const id = await createActivePayment('CONF-EXP', '204.00');
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE id = ?", [id]);
    const state = await call(`/api/v1/checkout/${id}/state`);
    assert.equal(state.body.status, PaymentStatus.EXPIRED);
    assert.equal(state.body.utr, undefined);
    assert.equal(state.body.livemode, undefined);
  });

  test('wrong amount, debit, refund and ambiguous alerts are each recorded with a stage and reason, never the text', async () => {
    await createActivePayment('CONF-REJ', '205.00');
    const before = notSettled().length;
    const secret = 'SECRETMARKER-should-not-be-stored';
    const messages = [
      `[TEST DATA] Rs.999.00 credited to a/c XX1234 by VPA payer@okaxis (UPI Ref No ${nextUtr()}). ${secret}`,
      `[TEST DATA] Rs.205.00 debited from a/c XX1234 to VPA shop@ybl (UPI Ref No ${nextUtr()}). ${secret}`,
      `[TEST DATA] Refund of Rs.205.00 credited to a/c XX1234 (UPI Ref No ${nextUtr()}). ${secret}`,
      `[TEST DATA] Rs.205.00 debited and credited to a/c XX1234 (UPI Ref No ${nextUtr()}). ${secret}`
    ];
    for (const m of messages) {
      const res = await observe(m);
      assert.notEqual(res.body.accepted, true, m);
    }
    const rows = notSettled().slice(before);
    assert.equal(rows.length, messages.length);
    for (const r of rows) {
      assert.ok(r.reason, 'reason recorded');
      assert.equal(r.channel, 'POLLER_EVENTS');
      assert.equal(r.source, 'SMS');
      assert.equal(r.sender, 'VM-HDFCBK');
      assert.equal(r.receivingAccountId, receivingAccountId);
      assert.ok(r.textLength > 0);
      assert.ok(r.referenceLast4 === null || /^\d{4}$/.test(r.referenceLast4));
    }
    const allAudit = db.query('SELECT details FROM audit_logs').map(r => r.details).join('\n');
    assert.ok(!allAudit.includes(secret), 'bank message text is never copied into the audit log');
    assert.equal(db.queryOne("SELECT COUNT(*) AS n FROM payment_sessions WHERE order_id = 'CONF-REJ' AND status = 'SUCCESS'").n, 0);
  });

  test('a credit with no open order is recorded and settles nothing', async () => {
    const before = notSettled().length;
    const res = await observe(creditSms('206.00', nextUtr()));
    assert.notEqual(res.body.accepted, true);
    assert.equal(notSettled().length, before + 1);
  });

  test('a successful settlement leaves no not-settled record', async () => {
    await createActivePayment('CONF-OK-2', '207.00');
    const before = notSettled().length;
    const res = await observe(creditSms('207.00', nextUtr()));
    assert.equal(res.body.accepted, true);
    assert.equal(notSettled().length, before);
  });

  test('a duplicate UTR is recorded as not settled and cannot settle a second order', async () => {
    const utr = nextUtr();
    const first = await createActivePayment('CONF-DUP-1', '208.00');
    assert.equal((await observe(creditSms('208.00', utr))).body.accepted, true);
    const second = await createActivePayment('CONF-DUP-2', '208.00');
    const before = notSettled().length;
    const res = await observe(creditSms('208.00', utr));
    assert.notEqual(res.body.accepted, true);
    assert.equal(notSettled().length, before + 1);
    assert.equal(api.app.context.sessionRepo.findById(first).status, PaymentStatus.SUCCESS);
    assert.notEqual(api.app.context.sessionRepo.findById(second).status, PaymentStatus.SUCCESS);
  });

  test('diagnostics endpoint: admin only, sanitized, reports devices and last stored observation', async () => {
    const anon = await call('/api/v1/admin/observations/diagnostics');
    assert.equal(anon.status, 401);
    const asObserver = await call('/api/v1/admin/observations/diagnostics', { headers: observerAuth });
    assert.ok([401, 403].includes(asObserver.status));

    const res = await call('/api/v1/admin/observations/diagnostics?limit=5', { headers: adminAuth });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.notSettled));
    assert.ok(res.body.notSettled.length > 0 && res.body.notSettled.length <= 5);
    assert.ok(Array.isArray(res.body.androidDevices));
    assert.ok(res.body.lastStoredObservationAt);
    for (const row of res.body.notSettled) {
      assert.ok(row.reason && row.at && row.observationId);
      assert.equal(row.rawText, undefined);
    }
    assert.ok(!res.text.includes('credited to a/c'), 'no message text in the response');
  });

  test('an unauthenticated observation is refused before the pipeline and leaves nothing behind', async () => {
    const before = notSettled().length;
    const res = await observe(creditSms('209.00', nextUtr()), {}, {});
    assert.ok([401, 403].includes(res.status));
    assert.equal(notSettled().length, before);
  });
});
