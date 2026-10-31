import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database, CustomerRepository, PaymentSessionRepository } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { authHeadersFor } from '../../../../scripts/test-support.js';

// Regression: a developer injection aimed at a QUEUED session (its receiving account's slot is
// held by another ACTIVE session) used to run the pipeline, end UNRESOLVED, and leave an
// observation fingerprint behind. Retrying the same UTR after the session was promoted then
// failed as DUPLICATE_OBSERVATION. The route must refuse the injection before the pipeline runs.

const merchantId = '00000000-0000-0000-0000-000000000001';
const receivingAccountId = '00000000-0000-0000-0000-000000000002';

describe('Developer simulator: injection into a QUEUED session', () => {
  let api;
  let baseUrl;
  let db;
  let customerRepo;
  let sessionRepo;

  before(async () => {
    db = new Database({ inMemory: true });
    customerRepo = new CustomerRepository(db);
    sessionRepo = new PaymentSessionRepository(db);
    api = await startPaymentApi(6310, db);
    baseUrl = `http://localhost:${api.port}`;
  });

  after(async () => {
    if (api) await api.close();
    if (db) db.close();
  });

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', ...authHeadersFor(path), 'x-merchant-id': merchantId };
      const req = http.request(new URL(path, baseUrl), { method: options.method || 'GET', headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body = data;
          try { body = JSON.parse(data); } catch { /* non-JSON body */ }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      if (options.body) req.write(JSON.stringify(options.body));
      req.end();
    });
  }

  const observationCount = () => db.queryOne('SELECT COUNT(*) AS n FROM payment_observations').n;
  const sessionStatus = (id) => db.queryOne('SELECT status FROM payment_sessions WHERE id = ?', [id])?.status;
  const injectBody = (paymentSessionId, customerId, ref) => ({
    source: 'SMS',
    sender: 'HDFCBK',
    content: `A/C XX1234 credited with Rs 1.00 CR. Ref ${ref}`,
    paymentSessionId,
    customerId
  });

  test('refuses injection into a QUEUED session without writing an observation, and the same UTR still works once the session is ACTIVE', async () => {
    await request('/api/v1/admin/dev/test-mode', { method: 'POST', body: { enabled: true } });
    const customer = customerRepo.create({ merchantId, name: 'Queued Customer', email: 'queued.customer@example.com', mobileNumber: '+919000000010' });

    const holder = await request('/api/v1/payments', { method: 'POST', body: { orderId: 'ORD_Q_HOLDER', amount: 1.00, customerId: customer.id, autoActivate: true } });
    const queued = await request('/api/v1/payments', { method: 'POST', body: { orderId: 'ORD_Q_WAIT', amount: 1.00, customerId: customer.id, autoActivate: true } });
    assert.equal(holder.body.status, 'ACTIVE');
    assert.equal(sessionStatus(queued.body.paymentId), 'QUEUED');

    const before = observationCount();
    const rejected = await request('/api/v1/admin/dev/simulator/inject', { method: 'POST', body: injectBody(queued.body.paymentId, customer.id, '912345678901') });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.success, false);
    assert.equal(rejected.body.reason, 'SESSION_NOT_PROCESSABLE');
    assert.equal(rejected.body.status, 'QUEUED');
    assert.equal(observationCount(), before, 'no observation may be recorded against a queued session');

    // Holder ends; the queue engine promotes the waiting session to ACTIVE.
    sessionRepo.transitionToTerminal(holder.body.paymentId, 'CANCELLED');
    const deadline = Date.now() + 15000;
    while (sessionStatus(queued.body.paymentId) !== 'ACTIVE' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(sessionStatus(queued.body.paymentId), 'ACTIVE');

    // The same UTR must not be blocked as a duplicate, because the rejected attempt left nothing behind.
    const retry = await request('/api/v1/admin/dev/simulator/inject', { method: 'POST', body: injectBody(queued.body.paymentId, customer.id, '912345678901') });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, 'VERIFIED');
    assert.equal(sessionStatus(queued.body.paymentId), 'SUCCESS');
  });

  test('five consecutive independent test payments each verify and settle (no slot reset between them)', async () => {
    await request('/api/v1/admin/dev/test-mode', { method: 'POST', body: { enabled: true } });
    const customer = customerRepo.create({ merchantId, name: 'Sequential Customer', email: 'sequential.customer@example.com', mobileNumber: '+919000000011' });
    for (let i = 1; i <= 5; i++) {
      const pay = await request('/api/v1/payments', { method: 'POST', body: { orderId: `ORD_SEQ_${i}`, amount: 1.00, customerId: customer.id, autoActivate: true } });
      assert.equal(pay.status, 201, `payment ${i} creation`);
      assert.equal(pay.body.status, 'ACTIVE', `payment ${i} should be ACTIVE, not queued`);
      const ref = String(912300000000 + i).padStart(12, '0');
      const inj = await request('/api/v1/admin/dev/simulator/inject', { method: 'POST', body: injectBody(pay.body.paymentId, customer.id, ref) });
      assert.equal(inj.status, 200, `payment ${i} injection`);
      assert.equal(inj.body.status, 'VERIFIED', `payment ${i} verification`);
      assert.equal(sessionStatus(pay.body.paymentId), 'SUCCESS', `payment ${i} settlement`);
    }
  });
});
