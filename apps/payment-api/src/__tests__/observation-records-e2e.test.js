import '../../../../scripts/test-support.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '@youpi/db';
import { PaymentStatus } from '@youpi/common';
import { startServer as startPaymentApi } from '../index.js';
import { AndroidObserverDriver } from '../../../android-observer-app/driver.js';
import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One bank alert, one id: Android upload → observation_records → Processing Result Inspector →
// Customer & Session Inspector → checkout state. Synthetic alerts on an in-memory database; every
// pipeline check stays on.
describe('Observation records: Android SMS to inspector and checkout, end to end', () => {
  const MERCHANT = '00000000-0000-0000-0000-000000000001';
  const ACCOUNT = '00000000-0000-0000-0000-000000000002';
  const OTHER_MERCHANT = '00000000-0000-0000-0000-0000000000b2';
  let api;
  let db;
  let base;
  let phone;
  let ctx;
  const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
  const get = async (url, headers = {}) => {
    const res = await fetch(`${base}${url}`, { headers: { ...admin, ...headers } });
    return { status: res.status, body: await res.json() };
  };
  const inspect = id => get(`/api/v1/admin/observations/${encodeURIComponent(id)}`);
  const customerSessions = (customerId, merchantId = MERCHANT) =>
    get(`/api/v1/admin/dev/simulator/customers/${customerId}/sessions`, { 'x-merchant-id': merchantId });
  const status = id => ctx.sessionRepo.findById(id).status;

  let utr = 712345670100;
  const credit = (rupees, ref = String(++utr)) => ({ ref, body: `Rs ${rupees} credited to your A/c XX1234 via UPI Ref ${ref}` });

  const closeCheckouts = () => {
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    db.execute("UPDATE payment_sessions SET completed_at = '2000-01-01T00:00:00.000Z' WHERE status = 'SUCCESS'");
  };
  const openCheckout = (orderId, amountPaise, customerId) => {
    closeCheckouts();
    const s = ctx.sessionRepo.create({ merchantId: MERCHANT, receivingAccountId: ACCOUNT, orderId, amountPaise, customerId });
    ctx.queueEngine.enqueueOrActivate(s.id, ACCOUNT);
    ctx.timingEngine.handlePaymentDone(s.id);
    return s;
  };

  let alice;
  let bob;

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6247, db);
    base = `http://localhost:${api.port}`;
    ctx = api.app.context;
    const qr = await (await fetch(`${base}/api/v1/admin/sms-gateway/pair-qr`, { headers: admin })).json();
    phone = new AndroidObserverDriver({ apiBaseUrl: base, deviceName: 'Realme P4', deviceModel: 'RMX5110' });
    await phone.pair(qr.enrollmentToken);
    alice = ctx.customerRepo.create({ name: 'Alice Obs', mobileNumber: '9123400001' });
    bob = ctx.customerRepo.create({ name: 'Bob Obs', mobileNumber: '9123400002' });
    ctx.merchantRepo.create({ id: OTHER_MERCHANT, businessName: 'Other Store', slug: 'other-store', contactEmail: 'o@other.local', contactPhone: '9000000009' });
  });

  after(async () => {
    await api.close();
    db.close();
  });

  test('a genuine SMS settles its checkout and is one record under one id everywhere', async () => {
    const s = openCheckout('OBS-E2E-1', 4100n, alice.id);
    const { ref, body } = credit('41.00');

    // 1. The upload reaches the API, which answers with the observation id.
    const res = await phone.submitSms({ sender: 'VM-HDFCBK', body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const id = res.body.observationId;
    assert.match(id, /^OBS-[0-9a-f-]{36}$/);

    // 2. Persisted: the record, and the attributed evidence row under the same id.
    const row = db.queryOne('SELECT * FROM observation_records WHERE id = ?', [id]);
    assert.ok(row, 'observation record stored');
    assert.equal(row.payment_observation_id, id);
    assert.equal(db.queryOne('SELECT attributed_payment_id FROM payment_observations WHERE id = ?', [id]).attributed_payment_id, s.id);
    assert.equal(db.queryOne('SELECT attributed_observation_id FROM payment_sessions WHERE id = ?', [s.id]).attributed_observation_id, id);
    assert.ok(!JSON.stringify(row).includes(body), 'the message text is not in the record');
    assert.ok(!JSON.stringify(row).includes(ref), 'the full UTR is not in the record');

    // 6. The matching checkout is settled.
    assert.equal(status(s.id), PaymentStatus.SUCCESS);

    // 3/4. The Processing Result Inspector reads the same id with the real stage results.
    const detail = await inspect(id);
    assert.equal(detail.status, 200);
    const o = detail.body.observation;
    assert.equal(o.observationId, id);
    assert.equal(o.entryPoint, 'ANDROID');
    assert.equal(o.deviceId, phone.deviceId);
    assert.equal(o.deviceName, 'Realme P4');
    assert.equal(o.source, 'SMS');
    assert.equal(o.sender, 'VM-HDFCBK');
    assert.equal(o.processingStatus, 'VERIFIED');
    assert.equal(o.outcome, 'ACCEPTED');
    assert.equal(o.rejectionReason, null);
    assert.equal(o.referenceLast4, ref.slice(-4));
    assert.equal(o.amountPaise, '4100');
    assert.ok(o.receivedAt && o.processedAt);
    assert.deepEqual(
      Object.values(o.stages).map(st => st.status),
      ['LOADED', 'PASSED', 'PARSED', 'VERIFIED', 'PASSED', 'ATTRIBUTED'],
      'every stage shows what it did, none PENDING'
    );
    assert.equal(o.stages.stage1.details.receivedAt, o.receivedAt, 'times and ids are kept readable');
    assert.equal(o.stages.stage4.details.orderId, 'OBS-E2E-1');
    assert.equal(o.stages.stage3.details.reference, `…${ref.slice(-4)}`, 'the reference keeps only its last 4');
    assert.equal(detail.body.session.id, s.id);
    assert.equal(detail.body.session.status, PaymentStatus.SUCCESS);
    assert.equal(detail.body.session.settledByThisObservation, true);
    assert.equal(detail.body.customer.id, alice.id);
    assert.equal(detail.body.evidence.preserved, true);
    assert.equal(detail.body.evidence.simulatedText, null, 'a real alert\'s text is never returned');

    // Incoming Bank Credit Alerts and history carry the same id.
    const hub = (await get('/api/v1/admin/sms-gateway/messages')).body.messages;
    assert.equal(hub.find(m => m.referenceLast4 === ref.slice(-4)).observationId, id);
    const history = (await get('/api/v1/admin/dev/simulator/history', { 'x-merchant-id': MERCHANT })).body.history;
    assert.equal(history.find(h => h.observationId === id).entryPoint, 'ANDROID');

    // 5. The Customer & Session Inspector shows the session with the alert that settled it.
    const sessions = (await customerSessions(alice.id)).body.sessions;
    const mine = sessions.find(x => x.id === s.id);
    assert.equal(mine.status, PaymentStatus.SUCCESS);
    assert.deepEqual(mine.observations.map(x => [x.observationId, x.relation, x.outcome]), [[id, 'SETTLED', 'ACCEPTED']]);
  });

  test('a credit with no open checkout stays visible as NO_MATCHING_CHECKOUT, credited to no one', async () => {
    closeCheckouts();
    const { body } = credit('42.00');
    const res = await phone.submitSms({ sender: 'VM-HDFCBK', body });
    assert.equal(res.status, 400);
    const id = res.body.observationId;
    assert.ok(id);
    const { observation: o, session, customer } = (await inspect(id)).body;
    assert.equal(o.outcome, 'NO_MATCHING_CHECKOUT');
    assert.equal(o.rejectionReason, 'NO_ACTIVE_SESSION');
    assert.equal(o.sessionId, null);
    assert.equal(o.customerId, null);
    assert.equal(session, null);
    assert.equal(customer, null);
    assert.equal(o.stages.stage4.status, 'FAILED');
    assert.equal(o.stages.stage5.status, 'NOT_REACHED');
    assert.equal(o.stages.stage6.status, 'NOT_REACHED');
    const list = (await get('/api/v1/admin/observations?outcome=NO_MATCHING_CHECKOUT')).body.observations;
    assert.ok(list.some(r => r.observationId === id));
  });

  test('a rejected alert shows its exact reason and leaves the checkout unpaid', async () => {
    const s = openCheckout('OBS-E2E-DEBIT', 4300n, alice.id);
    const res = await phone.submitSms({ sender: 'VM-HDFCBK', body: `Rs 43.00 debited from A/c XX1234 to VPA shop@ybl. UPI Ref ${++utr}` });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, 'DEBIT_NOTIFICATION');
    const o = (await inspect(res.body.observationId)).body.observation;
    assert.equal(o.processingStatus, 'REJECTED');
    assert.equal(o.outcome, 'REJECTED');
    assert.equal(o.rejectionReason, 'DEBIT_NOTIFICATION');
    assert.equal(o.failingStage, 3);
    assert.equal(o.stages.stage3.status, 'FAILED');
    assert.equal(o.stages.stage3.reason, 'DEBIT_NOTIFICATION');
    assert.notEqual(status(s.id), PaymentStatus.SUCCESS);
  });

  test('a phone retry and messaging-app copies of one SMS credit once; each copy is its own DUPLICATE record', async () => {
    const s = openCheckout('OBS-E2E-DUP', 4400n, alice.id);
    const { ref, body } = credit('44.00');
    const first = await phone.submitSms({ sender: 'AX-AIRBNK-S', body });
    assert.equal(first.status, 200);
    const retry = await phone.submitSms({ sender: 'AX-AIRBNK-S', body, receivedAt: Date.now() + 5000 });
    assert.notEqual(retry.status, 200);
    const copy = await phone.submitObservation({ rawNotification: { title: 'AX-AIRBNK-S', text: body, package: 'com.google.android.apps.messaging' } });
    assert.notEqual(copy.status, 200);

    assert.equal(Number(db.queryOne('SELECT COUNT(*) AS n FROM payment_observations WHERE bank_reference_number = ? AND attributed_payment_id IS NOT NULL', [ref]).n), 1);
    assert.equal(status(s.id), PaymentStatus.SUCCESS);
    const ids = [first.body.observationId, retry.body.observationId, copy.body.observationId];
    assert.equal(new Set(ids).size, 3, 'each upload has its own id');
    const outcomes = await Promise.all(ids.map(async id => (await inspect(id)).body.observation.outcome));
    assert.deepEqual(outcomes, ['ACCEPTED', 'DUPLICATE', 'DUPLICATE']);
    const settled = (await customerSessions(alice.id)).body.sessions.find(x => x.id === s.id).observations.filter(x => x.relation === 'SETTLED');
    assert.deepEqual(settled.map(x => x.observationId), [first.body.observationId], 'only the first alert settled the session');
  });

  test('two customers\' payments never mix, and another merchant cannot see either', async () => {
    const a = openCheckout('OBS-E2E-ALICE', 4500n, alice.id);
    const ra = await phone.submitSms({ sender: 'VM-HDFCBK', body: credit('45.00').body });
    const b = openCheckout('OBS-E2E-BOB', 4500n, bob.id);
    const rb = await phone.submitSms({ sender: 'VM-HDFCBK', body: credit('45.00').body });
    assert.equal(status(a.id), PaymentStatus.SUCCESS);
    assert.equal(status(b.id), PaymentStatus.SUCCESS);

    assert.equal((await inspect(ra.body.observationId)).body.customer.id, alice.id);
    assert.equal((await inspect(rb.body.observationId)).body.customer.id, bob.id);

    const aliceIds = (await customerSessions(alice.id)).body.sessions.flatMap(x => x.observations.map(o => o.observationId));
    const bobIds = (await customerSessions(bob.id)).body.sessions.flatMap(x => x.observations.map(o => o.observationId));
    assert.ok(aliceIds.includes(ra.body.observationId) && !aliceIds.includes(rb.body.observationId));
    assert.ok(bobIds.includes(rb.body.observationId) && !bobIds.includes(ra.body.observationId));

    // Another merchant: the record is "not found", its lists are empty, the sessions are not listed.
    const other = { 'x-merchant-id': OTHER_MERCHANT };
    assert.equal((await get(`/api/v1/admin/observations/${ra.body.observationId}`, other)).status, 404);
    assert.deepEqual((await get('/api/v1/admin/observations', other)).body.observations, []);
    assert.deepEqual((await customerSessions(alice.id, OTHER_MERCHANT)).body.sessions, []);
  });

  test('the admin event stream announces each processed observation, and the list shows it first', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/admin/stream`, { headers: { ...admin, Accept: 'text/event-stream' }, signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const seen = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const m = buffer.match(/event: observation_processed\ndata: (.+)\n/);
        if (m) return JSON.parse(m[1]);
      }
    })();

    const s = openCheckout('OBS-E2E-SSE', 4600n, bob.id);
    const up = await phone.submitSms({ sender: 'VM-HDFCBK', body: credit('46.00').body });
    assert.equal(up.status, 200);
    const event = await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error('no SSE event')), 3000))]);
    controller.abort();
    assert.equal(event.observationId, up.body.observationId);
    assert.equal(event.outcome, 'ACCEPTED');
    assert.equal(event.sessionId, s.id);
    assert.equal(event.customerId, bob.id);
    assert.ok(!JSON.stringify(event).includes('credited'), 'no message text on the stream');

    const latest = (await get('/api/v1/admin/observations?limit=1')).body.observations[0];
    assert.equal(latest.observationId, up.body.observationId);
  });

  test('a simulator run is recorded under the id it returns, with its typed text as evidence', async () => {
    const merchant = ctx.merchantRepo.findById(MERCHANT);
    ctx.merchantRepo.update(MERCHANT, { branding: { ...merchant.branding, testModeUntil: Date.now() + 60000 } });
    const s = openCheckout('OBS-E2E-SIM', 4700n, alice.id);
    const text = `Rs 47.00 credited to your A/c XX1234 via UPI Ref ${++utr}`;
    const res = await fetch(`${base}/api/v1/admin/dev/simulator/inject`, {
      method: 'POST',
      headers: { ...admin, 'x-merchant-id': MERCHANT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'SMS', sender: 'VM-HDFCBK', content: text, paymentSessionId: s.id })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.match(body.observationId, /^SIM-SMS-/);
    const detail = (await inspect(body.observationId)).body;
    assert.equal(detail.observation.entryPoint, 'SIMULATOR');
    assert.equal(detail.observation.isSimulated, true);
    assert.equal(detail.observation.processingStatus, body.status);
    assert.equal(detail.evidence.simulatedText, text);
    const history = (await get('/api/v1/admin/dev/simulator/history', { 'x-merchant-id': MERCHANT })).body.history;
    assert.equal(history[0].observationId, body.observationId);
  });

  test('the dashboard opens records by id and refreshes on the event, with no placeholder results', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../../merchant-admin/src/views/admin.html'), 'utf8');
    assert.match(html, /Select an observation to inspect\./);
    assert.match(html, /\/api\/v1\/admin\/observations\/\$\{encodeURIComponent\(observationId\)\}/);
    assert.match(html, /addEventListener\('observation_processed'/);
    assert.match(html, /openObservationInspector\(\$\{jsArg\(m\.observationId\)\}\)/, 'hub rows open the inspector');
    assert.match(html, /inspectObservation\(\$\{jsArg\(item\.observationId\)\}\)/, 'history rows open the inspector');
    assert.match(html, /inspectObservation\(\$\{jsArg\(o\.observationId\)\}\)/, 'session alerts open the inspector');
    assert.doesNotMatch(html, /None \(Passed\)/);
    assert.doesNotMatch(html, />UNKNOWN<\/span>/);
    assert.doesNotMatch(html, /simRenderResultInspector/);
  });
});
