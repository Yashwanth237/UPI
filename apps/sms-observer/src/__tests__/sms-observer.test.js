import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startSmsObserver } from '../index.js';
import { BankSmsParser } from '../sms-parser.js';
import { SmsObserverService } from '../sms-service.js';
import { PaymentStatus } from '@youpi/common';
import { TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

describe('Google Messages / SMS Payment Observer Integration Tests', () => {
  let apiInstance;
  let smsInstance;
  let smsBaseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6196, testDb);
    smsInstance = await startSmsObserver(6098, {
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002'
    });
    smsBaseUrl = `http://localhost:${smsInstance.port}`;
  });

  after(async () => {
    await smsInstance.close();
    await apiInstance.close();
    testDb.close();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${smsBaseUrl}${path}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, text: data });
        });
      }).on('error', reject);
    });
  }

  describe('Direct ingestion endpoint', () => {
    const post = (headers) => new Promise((resolve, reject) => {
      const req = http.request(`${smsBaseUrl}/process-sms`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text: 'Rs 500 credited UTR 612345678901', sender: 'HDFCBK' }));
    });

    test('POST /process-sms rejects anonymous and wrong-token callers', async () => {
      assert.equal(await post({}), 401);
      assert.equal(await post({ Authorization: 'Bearer wrong' }), 401);
    });

    test('POST /process-sms accepts the observer token', async () => {
      assert.notEqual(await post({ Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` }), 401);
    });
  });

  describe('Bank SMS Parser', () => {
    test('correctly parses credit SMS with amount, UTR, and sender VPA', () => {
      const sms = {
        text: 'Dear SBI user, A/C 1234 credited by Rs 499.00 on 08Sep26 by UPI/CR/667788/buyer@okhdfcbank Ref: 667788.',
        sender: 'VK-SBIUPI'
      };

      const parsed = BankSmsParser.parse(sms);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 49900n);
      assert.equal(parsed.amount, '499.00');
      assert.equal(parsed.bankReferenceNumber, '667788');
      assert.equal(parsed.senderVpa, 'buyer@okhdfcbank');
    });

    test('ignores debit SMS alerts', () => {
      const debitSms = {
        text: 'Your a/c 1234 debited by Rs 250.00 at Grocery Store.',
        sender: 'VK-HDFCBK'
      };

      const parsed = BankSmsParser.parse(debitSms);
      assert.equal(parsed, null);
    });
  });

  describe('SMS Observer HTTP Service & Attribution', () => {
    test('GET /health returns UP', async () => {
      const res = await get('/health');
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.equal(json.status, 'UP');
      assert.equal(json.service, 'sms-observer');
      assert.equal(typeof json.sourceConnected, 'boolean');
      assert.equal(json.sourceConnected, json.sources.googleMessages.status === 'CONNECTED');
    });

    describe('health reports the real SMS source state', () => {
      let saved;
      before(() => {
        const a = smsInstance.automator;
        saved = { isPaired: a.isPaired, mode: a.mode, lastSeenAt: a.lastSeenAt };
      });
      after(() => Object.assign(smsInstance.automator, saved));

      test('no paired source: service is UP but sourceConnected is false', async () => {
        Object.assign(smsInstance.automator, { isPaired: false, mode: 'STANDBY', lastSeenAt: null });
        const json = JSON.parse((await get('/health')).text);
        assert.equal(json.status, 'UP');
        assert.equal(json.sourceConnected, false);
        assert.equal(json.sources.googleMessages.paired, false);
        assert.equal(json.sources.googleMessages.status, 'STANDBY');
      });

      test('a remembered pairing without a live browser is not a connected source', async () => {
        Object.assign(smsInstance.automator, { isPaired: true, mode: 'STANDBY', lastSeenAt: null });
        const json = JSON.parse((await get('/health')).text);
        assert.equal(json.sources.googleMessages.paired, true);
        assert.equal(json.sourceConnected, false);
      });

      test('paired, background and recently seen counts as connected', async () => {
        Object.assign(smsInstance.automator, { isPaired: true, mode: 'BACKGROUND', lastSeenAt: new Date() });
        const json = JSON.parse((await get('/health')).text);
        assert.equal(json.sources.googleMessages.status, 'CONNECTED');
        assert.equal(json.sourceConnected, true);
      });

      test('payment API unavailable: a credit SMS fails loudly and is not counted as observed', async () => {
        const offline = new SmsObserverService({ apiBaseUrl: 'http://127.0.0.1:9' });
        await assert.rejects(offline.processSms({
          text: 'A/C 1234 credited with Rs. 12.00 on 08-Sep-2026. Ref: UTR-OFFLINE-12 from payer@upi',
          sender: 'VM-ICICIB'
        }));
        assert.equal(offline.observedCount, 0);
      });

      test('a non-payment SMS creates no observation', async () => {
        const before = smsInstance.service.observedCount;
        const result = await smsInstance.service.processSms({ text: 'Your OTP is 482913. Do not share it.', sender: 'VM-ICICIB' });
        assert.equal(result, null);
        assert.equal(smsInstance.service.observedCount, before);
      });
    });

    test('GET / serves an HTML landing page instead of "Route Not Found"', async () => {
      const res = await get('/');
      assert.equal(res.status, 200);
      assert.ok(res.text.includes('SMS Observer'));
      assert.ok(!res.text.includes('Route Not Found'));
    });

    test('End-to-End: processing bank SMS confirms active payment session in Payment API', async () => {
      // 1. Create a payment in Payment API for ₹499
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'SMS-ORD-499',
        amountPaise: 49900n
      });

      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      // 2. Process incoming SMS alert via SMS Observer
      const result = await smsInstance.service.processSms({
        text: 'A/C 1234 credited with Rs. 499.00 on 08-Sep-2026. Ref: UTR-SMS-499 from payer@upi',
        sender: 'VM-ICICIB'
      });

      assert.ok(result);
      assert.equal(result.accepted, true);
      assert.equal(result.attribution.attributed, true);
      assert.equal(result.attribution.paymentSessionId, session.id);
      assert.equal(result.attribution.outcomeStatus, PaymentStatus.SUCCESS);

      // 3. Verify session in DB updated to SUCCESS
      const updated = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.equal(updated.status, PaymentStatus.SUCCESS);
    });
  });
});
