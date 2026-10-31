import '../../../../scripts/test-support.js';
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { PaymentStatus } from '@youpi/common';
import { BankSmsParser, describeObservationSender, classifyObservationOutcome } from '@youpi/core';
import { startServer as startPaymentApi } from '../index.js';
import { AndroidObserverDriver } from '../../../android-observer-app/driver.js';
import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';

// Credit-indicator recognition and sender identity for bank alerts. Synthetic messages on an
// in-memory database; every check of the verification pipeline stays on.
describe('Bank SMS credit indicators and sender identity', () => {
  const MERCHANT = '00000000-0000-0000-0000-000000000001';
  const ACCOUNT = '00000000-0000-0000-0000-000000000002';
  let api;
  let db;
  let base;
  let phone;
  const admin = { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
  const hub = async () => (await fetch(`${base}/api/v1/admin/sms-gateway/messages`, { headers: admin })).json();
  // Also ages earlier successes past the pipeline's 60 s "recently completed" fallback, so each
  // test sees only its own checkout.
  const closeCheckouts = () => {
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE status IN ('ACTIVE', 'PROCESSING', 'QUEUED')");
    db.execute("UPDATE payment_sessions SET completed_at = '2000-01-01T00:00:00.000Z' WHERE status = 'SUCCESS'");
  };
  const openCheckout = (orderId, amountPaise) => {
    closeCheckouts();
    const ctx = api.app.context;
    const s = ctx.sessionRepo.create({ merchantId: MERCHANT, receivingAccountId: ACCOUNT, orderId, amountPaise });
    ctx.queueEngine.enqueueOrActivate(s.id, ACCOUNT);
    ctx.timingEngine.handlePaymentDone(s.id);
    return s;
  };
  const status = id => api.app.context.sessionRepo.findById(id).status;
  const hubRowFor = async ref4 => (await hub()).messages.find(m => m.referenceLast4 === ref4);
  // Stage-2 refusals stop before the reference is read, so those rows are found by amount.
  const hubRowForAmount = async paise => (await hub()).messages.find(m => m.amountPaise === paise);

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6243, db);
    base = `http://localhost:${api.port}`;
    const qr = await (await fetch(`${base}/api/v1/admin/sms-gateway/pair-qr`, { headers: admin })).json();
    phone = new AndroidObserverDriver({ apiBaseUrl: base, deviceName: 'Pixel 8', deviceModel: 'Google Pixel 8' });
    await phone.pair(qr.enrollmentToken);
  });

  after(async () => {
    await api.close();
    db.close();
  });

  afterEach(() => {
    delete process.env.SMS_TRUSTED_SENDERS;
  });

  describe('credit indicators', () => {
    const CREDITS = [
      ['has been credited', 'Dear Customer, INR 100.00 has been credited to your A/c XX1234 on 31-10-2026 at 11:30 AM through UPI. UPI Ref No: 612345678901.'],
      ['received through UPI', 'Rs.250.00 received through UPI in your a/c XX5678 from rahul@okaxis. UPI Ref 512345678902'],
      ['deposited', 'INR 500.00 deposited in your A/c XX9012 on 31-10-26. Ref No 412345678903']
    ];

    for (const [label, text] of CREDITS) {
      test(`"${label}" is recognised as a credit by the parser and by stage 3`, () => {
        assert.ok(BankSmsParser.parse({ text, sender: 'VM-HDFCBK' }), text);
        const result = api.app.context.pipeline.process({ source: 'SMS', sender: 'VM-HDFCBK', rawText: text, receivingAccountId: ACCOUNT });
        assert.notEqual(result.failingCondition, 'MISSING_CREDIT_INDICATOR', JSON.stringify(result.stages.stage3));
        assert.ok(!result.failingStage || result.failingStage > 3, `${label}: failed at stage ${result.failingStage} (${result.failingCondition})`);
      });
    }

    test('debit alerts are never recognised as incoming credits', async () => {
      const debits = [
        'Rs 100.00 debited from A/c XX1234 to VPA shop@ybl. UPI Ref 612345678911',
        'Your A/c XX1234 is debited for Rs 100.00; amount credited to payee@ybl. Ref 612345678912',
        'INR 100.00 withdrawn from A/c XX1234 at ATM. Ref 612345678913'
      ];
      const s = openCheckout('CR-DEBIT-1', 10000n);
      for (const text of debits) {
        assert.equal(BankSmsParser.parse({ text, sender: 'VM-HDFCBK' }), null, text);
        const res = await phone.submitSms({ sender: 'VM-HDFCBK', body: text });
        assert.equal(res.status, 400, text);
        assert.equal(res.body.reason, 'DEBIT_NOTIFICATION', text);
      }
      assert.notEqual(status(s.id), PaymentStatus.SUCCESS);
    });

    test('a notification whose credit wording is in the title is read whole, not text-only', async () => {
      const s = openCheckout('CR-NOTIF-1', 10000n);
      const res = await phone.submitObservation({
        rawNotification: { title: '₹100.00 credited', text: 'to A/c XX1234 via UPI. UPI Ref 612345678921', package: 'com.phonepe.app' }
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(status(s.id), PaymentStatus.SUCCESS);
      const row = await hubRowFor('8921');
      assert.equal(row.source, 'NOTIFICATION');
      assert.equal(row.sourcePackage, 'com.phonepe.app');
      assert.equal(row.sender, null, 'an app package is not a bank sender');
      assert.equal(row.senderTrustStatus, 'UNKNOWN');
    });

    test('an empty message is rejected as missing text, not as missing credit wording', () => {
      const result = api.app.context.pipeline.process({ source: 'SMS', sender: 'VM-HDFCBK', rawText: '   ', isTest: true });
      assert.equal(result.status, 'REJECTED');
      assert.equal(result.failingCondition, 'MISSING_RAW_TEXT');
    });
  });

  describe('sender identity', () => {
    for (const pkg of ['com.truecaller', 'com.google.android.apps.messaging']) {
      test(`a ${pkg} notification never shows the package as the bank sender and cannot settle a checkout`, async () => {
        const [ref, rupees] = pkg === 'com.truecaller' ? ['612345678931', '31'] : ['612345678932', '32'];
        const s = openCheckout(`CR-RELAY-${ref}`, BigInt(rupees) * 100n);
        const res = await phone.submitObservation({
          rawNotification: { title: 'AX-HDFCBK', text: `Rs ${rupees}.00 credited to A/c XX1234 UPI Ref ${ref}`, package: pkg }
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.reason, 'UNVERIFIED_NOTIFICATION_SENDER');
        assert.notEqual(status(s.id), PaymentStatus.SUCCESS);

        const row = await hubRowForAmount(`${rupees}00`);
        assert.ok(row, 'the refused copy is still listed');
        assert.notEqual(row.sender, pkg);
        assert.equal(row.sender, null);
        assert.equal(row.sourcePackage, pkg);
        assert.equal(row.source, 'NOTIFICATION');
        assert.equal(row.outcome, 'UNVERIFIED_NOTIFICATION_SENDER', 'no SMS with this UTR yet, so not a known copy');
      });
    }

    test('rows stored before the split, with a package as sender, are shown with the package moved', () => {
      const id = describeObservationSender({ sender: 'com.truecaller' });
      assert.deepEqual(id, { source: 'NOTIFICATION', sender: null, sourcePackage: 'com.truecaller', bankName: null, senderTrustStatus: 'UNKNOWN' });
    });

    test('the SMS originating address is preserved exactly', async () => {
      openCheckout('CR-ADDR-1', 4200n);
      await phone.submitSms({ sender: 'AX-AIRBNK-S', body: 'Rs 42.00 credited to your A/c XX1234 via UPI Ref 612345678941' });
      const row = await hubRowFor('8941');
      assert.equal(row.sender, 'AX-AIRBNK-S');
      assert.equal(row.source, 'SMS');
      assert.equal(row.sourcePackage, null);
    });

    test('a sender on SMS_TRUSTED_SENDERS is VERIFIED; one off the list stays unverified and is refused', async () => {
      process.env.SMS_TRUSTED_SENDERS = 'HDFCBK';
      const s = openCheckout('CR-TRUST-1', 4300n);
      const ok = await phone.submitSms({ sender: 'VM-HDFCBK-S', body: 'Rs 43.00 credited to your A/c XX1234 via UPI Ref 612345678951' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(status(s.id), PaymentStatus.SUCCESS);
      assert.equal((await hubRowFor('8951')).senderTrustStatus, 'VERIFIED');

      const s2 = openCheckout('CR-TRUST-2', 4400n);
      const bad = await phone.submitSms({ sender: 'VM-FAKEBK', body: 'Rs 44.00 credited to your A/c XX1234 via UPI Ref 612345678952' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.reason, 'UNTRUSTED_SMS_SENDER');
      assert.notEqual(status(s2.id), PaymentStatus.SUCCESS);
      assert.equal((await hubRowForAmount('4400')).senderTrustStatus, 'UNVERIFIED');
    });

    test('an unknown sender stays unverified, and an SMS without an address is refused', async () => {
      assert.equal(describeObservationSender({ source: 'SMS', sender: 'JD-NEWBNK' }).senderTrustStatus, 'UNVERIFIED');
      const s = openCheckout('CR-NOADDR-1', 4500n);
      const res = await phone.submitSms({ body: 'Rs 45.00 credited to your A/c XX1234 via UPI Ref 612345678961' });
      assert.equal(res.status, 400);
      assert.equal(res.body.reason, 'MISSING_SMS_SENDER');
      assert.notEqual(status(s.id), PaymentStatus.SUCCESS);
      const row = await hubRowForAmount('4500');
      assert.equal(row.sender, null);
      assert.equal(row.senderTrustStatus, 'UNKNOWN');
      assert.equal(row.outcome, 'INVALID_BANK_SENDER');
    });

    test('a Gmail sender keeps its address, and the bank comes only from its .bank.in domain', () => {
      const id = describeObservationSender({ source: 'GMAIL', sender: 'HDFC Bank <Alerts@hdfcbank.bank.in>' });
      assert.equal(id.source, 'GMAIL');
      assert.equal(id.sender, 'alerts@hdfcbank.bank.in');
      assert.equal(id.bankName, 'HDFCBANK');
      assert.equal(id.senderTrustStatus, 'UNVERIFIED');
      assert.equal(describeObservationSender({ source: 'GMAIL', sender: 'alerts@hdfcbank.bank.in' }, { trustedEmails: new Set(['alerts@hdfcbank.bank.in']) }).senderTrustStatus, 'VERIFIED');
      assert.equal(describeObservationSender({ source: 'GMAIL', sender: 'donotreply.sbionline@alerts.sbi.co.in' }).bankName, null);

      const result = api.app.context.pipeline.process({ source: 'GMAIL', sender: 'HDFC Bank <alerts@hdfcbank.bank.in>', rawText: 'Rs 1.00 credited UPI Ref 612345678971' });
      assert.equal(result.senderIdentity.sender, 'alerts@hdfcbank.bank.in');
    });
  });

  describe('payment outcomes stay distinct', () => {
    test('a valid credit with no open checkout is NO_MATCHING_CHECKOUT, not a success', async () => {
      closeCheckouts();
      const res = await phone.submitSms({ sender: 'VM-HDFCBK', body: 'Rs 46.00 credited to your A/c XX1234 via UPI Ref 612345678981' });
      assert.equal(res.status, 400);
      assert.notEqual(res.body.accepted, true);
      const row = await hubRowFor('8981');
      assert.equal(row.outcome, 'NO_MATCHING_CHECKOUT', JSON.stringify(row));
      assert.notEqual(row.status, 'ACCEPTED');
    });

    test('a credit matching the open checkout is ACCEPTED; the same UTR cannot confirm a second one', async () => {
      const first = openCheckout('CR-UTR-1', 4700n);
      const body = 'Rs 47.00 credited to your A/c XX1234 via UPI Ref 612345678991';
      const ok = await phone.submitSms({ sender: 'VM-HDFCBK', body });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(status(first.id), PaymentStatus.SUCCESS);
      assert.equal((await hub()).messages[0].outcome, 'ACCEPTED');

      const second = openCheckout('CR-UTR-2', 4700n);
      const again = await phone.submitSms({ sender: 'VM-HDFCBK', body });
      assert.equal(again.status, 400);
      assert.notEqual(status(second.id), PaymentStatus.SUCCESS);
      assert.equal((await hub()).messages[0].outcome, 'DUPLICATE');
    });

    test('one genuine bank SMS, its phone retry and its messaging-app copies settle exactly one payment', async () => {
      const s = openCheckout('CR-ONCE-1', 4800n);
      const body = 'Rs 48.00 credited to your A/c XX1234 via UPI Ref 612345670481';
      assert.equal((await phone.submitSms({ sender: 'AX-AIRBNK-S', body })).status, 200);
      assert.equal(status(s.id), PaymentStatus.SUCCESS);

      // The phone retries the upload (later receive time) and two apps show the same SMS.
      assert.notEqual((await phone.submitSms({ sender: 'AX-AIRBNK-S', body, receivedAt: Date.now() + 5000 })).status, 200);
      for (const pkg of ['com.google.android.apps.messaging', 'com.truecaller']) {
        const copy = await phone.submitObservation({ rawNotification: { title: 'AX-AIRBNK-S', text: body, package: pkg } });
        assert.equal(copy.body.reason, 'UNVERIFIED_NOTIFICATION_SENDER');
      }

      const attributed = db.queryOne('SELECT COUNT(*) AS n FROM payment_observations WHERE bank_reference_number = ? AND attributed_payment_id IS NOT NULL', ['612345670481']);
      assert.equal(Number(attributed.n), 1, 'credited once');
      const rows = (await hub()).messages.filter(m => m.amountPaise === '4800');
      assert.deepEqual(rows.map(r => r.outcome).sort(), ['ACCEPTED', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
      const copies = rows.filter(r => r.source === 'NOTIFICATION');
      assert.equal(copies.length, 2);
      for (const c of copies) assert.equal(c.sender, null, 'the package is not shown as the bank sender');
      assert.deepEqual(copies.map(c => c.sourcePackage).sort(), ['com.google.android.apps.messaging', 'com.truecaller']);
    });

    test('two genuine payments with different UTRs are not merged', async () => {
      const a = openCheckout('CR-TWO-A', 4900n);
      assert.equal((await phone.submitSms({ sender: 'VM-HDFCBK', body: 'Rs 49.00 credited to your A/c XX1234 via UPI Ref 612345670491' })).status, 200);
      const b = openCheckout('CR-TWO-B', 4900n);
      assert.equal((await phone.submitSms({ sender: 'VM-HDFCBK', body: 'Rs 49.00 credited to your A/c XX1234 via UPI Ref 612345670492' })).status, 200);
      assert.equal(status(a.id), PaymentStatus.SUCCESS);
      assert.equal(status(b.id), PaymentStatus.SUCCESS);
    });

    test('a bank-app notification missing its amount is INCOMPLETE_NOTIFICATION, with the accurate reason', async () => {
      const s = openCheckout('CR-INCOMPLETE-1', 5000n);
      const res = await phone.submitObservation({ rawNotification: { title: 'Payment received', text: 'Tap to view details', package: 'com.phonepe.app' } });
      assert.equal(res.status, 400);
      assert.equal(res.body.reason, 'MISSING_CURRENCY_INDICATOR');
      assert.notEqual(status(s.id), PaymentStatus.SUCCESS);
      assert.equal((await hub()).messages[0].outcome, 'INCOMPLETE_NOTIFICATION');
    });

    test('outcome classification keeps the outcomes apart', () => {
      assert.equal(classifyObservationOutcome({ status: 'VERIFIED' }), 'ACCEPTED');
      assert.equal(classifyObservationOutcome({ status: 'REJECTED', failingCondition: 'PERSONAL_SMS_REJECTED' }), 'INVALID_BANK_SENDER');
      assert.equal(classifyObservationOutcome({ status: 'REJECTED', failingCondition: 'UNVERIFIED_NOTIFICATION_SENDER' }), 'UNVERIFIED_NOTIFICATION_SENDER');
      assert.equal(classifyObservationOutcome({ status: 'REJECTED', failingCondition: 'MISSING_CURRENCY_INDICATOR' }, 'NOTIFICATION'), 'INCOMPLETE_NOTIFICATION');
      assert.equal(classifyObservationOutcome({ status: 'REJECTED', failingCondition: 'MISSING_CURRENCY_INDICATOR' }, 'SMS'), 'REJECTED');
      assert.equal(classifyObservationOutcome({ status: 'REJECTED', failingCondition: 'DEBIT_NOTIFICATION' }), 'REJECTED');
      assert.equal(classifyObservationOutcome({ status: 'REJECTED', failingCondition: 'DUPLICATE_OBSERVATION' }), 'DUPLICATE');
      assert.equal(classifyObservationOutcome({ status: 'REJECTED', failingCondition: 'REFERENCE_ALREADY_USED' }), 'DUPLICATE');
      assert.equal(classifyObservationOutcome({ status: 'UNRESOLVED', failingCondition: 'NO_ACTIVE_SESSION' }), 'NO_MATCHING_CHECKOUT');
      assert.equal(classifyObservationOutcome({ status: 'UNRESOLVED', failingCondition: 'AMBIGUOUS_MATCH' }), 'PENDING_REVIEW');
    });
  });
});
