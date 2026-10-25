import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { startGmailObserver } from '../index.js';
import { BankEmailParser } from '../parser.js';
import { GmailPoller, extractBodyFromGmailPayload, isFinalSubmissionFailure, MAX_RAW_TEXT_CHARS, UNRESOLVED_RETRY_WINDOW_MS } from '../gmail-poller.js';
import { PaymentStatus, createOAuthState } from '@youpi/common';
import { TEST_OBSERVER_TOKEN } from '../../../../scripts/test-support.js';

describe('Gmail Payment Observer Integration Tests', () => {
  let apiInstance;
  let gmailInstance;
  let gmailBaseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(6198, testDb);
    gmailInstance = await startGmailObserver(6099, {
      apiBaseUrl: `http://localhost:${apiInstance.port}`,
      receivingAccountId: '00000000-0000-0000-0000-000000000002'
    });
    gmailBaseUrl = `http://localhost:${gmailInstance.port}`;
  });

  after(async () => {
    await gmailInstance.close();
    await apiInstance.close();
    testDb.close();
  });

  function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get(`${gmailBaseUrl}${path}`, { headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, text: data });
        });
      }).on('error', reject);
    });
  }

  describe('Bank Email Parser', () => {
    test('correctly parses HDFC credit notification email', () => {
      const email = {
        subject: 'ALERT: Account credited with Rs. 200.00',
        body: 'Dear Customer, your account has been credited with Rs. 200.00 on 08-Sep-2026. Ref no: UTR-HDFC-9911 from sender@upi.',
        from: 'alerts@hdfcbank.net'
      };

      const parsed = BankEmailParser.parse(email);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 20000n);
      assert.equal(parsed.amount, '200.00');
      assert.equal(parsed.bankReferenceNumber, 'UTR-HDFC-9911');
      assert.equal(parsed.senderVpa, 'sender@upi');
    });

    test('correctly parses custom or alt-account emails like "20.00 received"', () => {
      const altEmail = {
        subject: '20.00 received',
        body: '20.00 received from alt account',
        from: 'alt@gmail.com'
      };

      const parsed = BankEmailParser.parse(altEmail);
      assert.ok(parsed);
      assert.equal(parsed.amountPaise, 2000n);
      assert.equal(parsed.amount, '20.00');
    });

    test('ignores debit notification emails', () => {
      const debitEmail = {
        subject: 'ALERT: Account debited with Rs. 500.00',
        body: 'Your account was debited for purchase at Amazon.',
        from: 'alerts@hdfcbank.net'
      };

      const parsed = BankEmailParser.parse(debitEmail);
      assert.equal(parsed, null);
    });
  });

  describe('Gmail Observer HTTP Service', () => {
    test('GET /health returns UP', async () => {
      const res = await get('/health');
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.equal(json.status, 'UP');
      assert.equal(json.service, 'gmail-observer');
    });

    test('GET / serves an HTML landing page instead of "Route Not Found"', async () => {
      const res = await get('/');
      assert.equal(res.status, 200);
      assert.ok(res.text.includes('Gmail Observer'));
      assert.ok(!res.text.includes('Route Not Found'));
    });

    test('GET /oauth/url requires a token and returns a Google OAuth URL carrying a signed state', async () => {
      assert.equal((await get('/oauth/url')).status, 401);

      const res = await get('/oauth/url', { Authorization: `Bearer ${TEST_OBSERVER_TOKEN}` });
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.ok(json.authUrl.includes('accounts.google.com/o/oauth2/v2/auth'));
      assert.ok(json.authUrl.includes('gmail.readonly'));
      assert.ok(new URL(json.authUrl).searchParams.get('state'));
      assert.ok(!json.redirectUri.includes('gauravtesting'));
    });

    test('GET /oauth/callback rejects a missing, forged or reused state', async () => {
      const bad = await get('/oauth/callback?code=abc');
      assert.equal(bad.status, 400);
      assert.ok(bad.text.includes('Invalid or expired OAuth state'));

      const forged = await get('/oauth/callback?code=abc&state=aaaa.9999999999999.bbbb');
      assert.ok(forged.text.includes('Invalid or expired OAuth state'));

      const state = createOAuthState();
      const first = await get(`/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
      assert.ok(!first.text.includes('Invalid or expired OAuth state')); // passes the state check, fails later (no credentials)
      const replay = await get(`/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
      assert.ok(replay.text.includes('Invalid or expired OAuth state'));
    });

    test('End-to-End: processing bank email confirms active payment session in Payment API', async () => {
      // 1. Create a payment in Payment API
      const session = apiInstance.app.context.sessionRepo.create({
        merchantId: '00000000-0000-0000-0000-000000000001',
        receivingAccountId: '00000000-0000-0000-0000-000000000002',
        orderId: 'GMAIL-ORD-777',
        amountPaise: 20000n
      });

      apiInstance.app.context.queueEngine.enqueueOrActivate(session.id, '00000000-0000-0000-0000-000000000002');
      apiInstance.app.context.timingEngine.handlePaymentDone(session.id);

      // 2. Process matching incoming bank email via Gmail Observer
      const result = await gmailInstance.poller.processEmail({
        subject: 'Credit alert: Rs 200.00 received',
        body: 'Your account received Rs 200.00 from buyer@upi Ref: UTR-GMAIL-777',
        from: 'alerts@icicibank.com'
      });

      assert.ok(result);
      assert.equal(result.accepted, true);
      assert.equal(result.attribution.attributed, true);
      assert.equal(result.attribution.paymentSessionId, session.id);

      // Verify session updated to SUCCESS in DB
      const updated = apiInstance.app.context.sessionRepo.findById(session.id);
      assert.equal(updated.status, PaymentStatus.SUCCESS);
    });
  });
});

describe('Gmail poller message handling', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

  test('a single-part HTML alert is stripped to text (no raw markup, under the scan limit)', () => {
    const html = `<html><head><style>${'.x{color:red}'.repeat(2000)}</style></head><body><p>Rs.&nbsp;499.00 credited to a/c XX1234</p><p>UPI Ref 123456789012</p></body></html>`;
    const text = extractBodyFromGmailPayload({ mimeType: 'text/html', body: { data: b64(html) } });
    assert.ok(!text.includes('<'), 'markup must be removed');
    assert.ok(!text.includes('color:red'), 'style blocks must be removed');
    assert.match(text, /Rs\. 499\.00 credited/);
    assert.ok(text.length < MAX_RAW_TEXT_CHARS);
  });

  test('text/plain is found inside nested multipart and preferred over HTML', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [{
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: b64('<b>html</b>') } },
          { mimeType: 'text/plain', body: { data: b64('plain credit alert') } }
        ]
      }]
    };
    assert.equal(extractBodyFromGmailPayload(payload), 'plain credit alert');
  });

  test('REJECTED verdicts are final; UNRESOLVED retries only while recent; 5xx/network always retry', () => {
    const now = Date.now();
    const rejected = Object.assign(new Error('x'), { status: 400, body: { status: 'REJECTED', reason: 'MISSING_CREDIT_INDICATOR' } });
    const unresolved = Object.assign(new Error('x'), { status: 400, body: { status: 'UNRESOLVED', reason: 'NO_ACTIVE_SESSION' } });
    assert.equal(isFinalSubmissionFailure(rejected, now, now), true);
    assert.equal(isFinalSubmissionFailure(unresolved, now - 60_000, now), false);
    assert.equal(isFinalSubmissionFailure(unresolved, now - UNRESOLVED_RETRY_WINDOW_MS - 1, now), true);
    assert.equal(isFinalSubmissionFailure(Object.assign(new Error('x'), { status: 503 }), now, now), false);
    assert.equal(isFinalSubmissionFailure(new Error('ECONNREFUSED'), now, now), false);
  });

  /** Stub payment API serving /api/v1/admin/gmail/credentials with the given refresh token. */
  async function credentialStub(refreshToken) {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec', refreshToken, connectedEmail: 'owner@example.com' }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    return { srv, base: `http://127.0.0.1:${srv.address().port}` };
  }

  test('after a restart the poller resumes when a Google account is still linked', async () => {
    const { srv, base } = await credentialStub('stored-refresh-token');
    const poller = new GmailPoller({ apiBaseUrl: base, pollIntervalMs: 60_000 });
    poller.pollCycle = async () => {}; // no Google calls in tests
    try {
      assert.equal(await poller.resumeIfConnected({ attempts: 1 }), true);
      assert.equal(poller.isRunning, true);
    } finally {
      poller.stop();
      srv.close();
    }
  });

  test('a disconnected account (no refresh token) stays stopped', async () => {
    const { srv, base } = await credentialStub('');
    const poller = new GmailPoller({ apiBaseUrl: base, pollIntervalMs: 60_000 });
    try {
      assert.equal(await poller.resumeIfConnected({ attempts: 1 }), false);
      assert.equal(poller.isRunning, false);
    } finally {
      srv.close();
    }
  });
});
