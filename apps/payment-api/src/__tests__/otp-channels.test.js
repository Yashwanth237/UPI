import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { createPaymentApp } from '../index.js';
import { Database, CustomerRepository } from '@youpi/db';
import { OtpDispatcher, OtpDeliveryError } from '@youpi/core';
import { authFetch } from '../../../../scripts/test-support.js';

const silentLogger = { log() {}, warn() {}, error() {} };

/** A scripted provider standing in for a vendor (tests only). */
function scriptedProvider(channel, { fail = false } = {}) {
  return {
    channel,
    name: `${channel}-scripted`,
    official: true,
    sent: [],
    isConfigured: () => true,
    async send(msg) {
      if (fail) throw new OtpDeliveryError('vendor down', { code: 'PROVIDER_UNREACHABLE', provider: this.name });
      this.sent.push(msg);
      return { messageId: `${channel}-1` };
    }
  };
}

async function startWith(dispatcher) {
  const db = new Database({ inMemory: true });
  const app = createPaymentApp(db, { otpCooldownMs: 0, otpDispatcher: dispatcher });
  const server = await new Promise(resolve => {
    const s = app.rawServer.listen(0, () => resolve(s));
  });
  return { db, app, server, base: `http://localhost:${server.address().port}` };
}

async function post(base, path, body) {
  const res = await authFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

describe('Customer OTP delivery is honest and provider-independent', () => {
  describe('when no channel can deliver', () => {
    let ctx;
    before(async () => {
      ctx = await startWith(new OtpDispatcher({ providers: [scriptedProvider('whatsapp', { fail: true })], channels: ['whatsapp', 'email'], logger: silentLogger }));
      new CustomerRepository(ctx.db).create({ name: 'Asha Rao', email: 'asha@example.com', mobileNumber: '9811122233', isPhoneVerified: true });
    });
    after(() => { ctx.app.destroy(); ctx.server.close(); });

    test('send-otp answers 503 OTP_DELIVERY_UNAVAILABLE instead of claiming success', async () => {
      const res = await post(ctx.base, '/api/v1/customer/send-otp', { mobileNumber: '9822233344', name: 'New Person', email: 'new@example.com', isNewUser: true });
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'OTP_DELIVERY_UNAVAILABLE');
      assert.equal(res.body.success, false);
    });

    test('an undelivered code is withdrawn for existing customers', async () => {
      const res = await post(ctx.base, '/api/v1/customer/send-otp', { mobileNumber: '9811122233' });
      assert.equal(res.status, 503);
      const customer = new CustomerRepository(ctx.db).findByMobile('9811122233');
      assert.equal(customer.otpCode, null, 'no live OTP may remain after a failed delivery');
    });

    test('the failure is audited without the code', async () => {
      const rows = ctx.db.query("SELECT details FROM audit_logs WHERE action = 'OTP_DELIVERY_FAILED'");
      assert.ok(rows.length >= 1);
      assert.ok(rows.every(r => !/\b\d{6}\b/.test(r.details)), 'audit details must not contain a 6-digit code');
    });
  });

  describe('when WhatsApp fails and email is configured', () => {
    let ctx;
    let email;
    before(async () => {
      email = scriptedProvider('email');
      ctx = await startWith(new OtpDispatcher({ providers: [scriptedProvider('whatsapp', { fail: true }), email], channels: ['whatsapp', 'email'], logger: silentLogger }));
      new CustomerRepository(ctx.db).create({ name: 'Ravi Kumar', email: 'ravi@example.com', mobileNumber: '9833344455', isPhoneVerified: true });
    });
    after(() => { ctx.app.destroy(); ctx.server.close(); });

    test('the code falls back to the customer email and the response says so', async () => {
      const res = await post(ctx.base, '/api/v1/customer/send-otp', { mobileNumber: '9833344455' });
      assert.equal(res.status, 200);
      assert.equal(res.body.channel, 'email');
      assert.equal(res.body.destination, 'ra***@example.com');
      assert.equal(res.body.fallbackUsed, true);
      assert.match(res.body.message, /email/);
      assert.equal(res.body.delivered, true);
      assert.equal(email.sent.length, 1);
    });

    test('the delivered code verifies and is single-use', async () => {
      const code = email.sent.at(-1).code;
      const ok = await post(ctx.base, '/api/v1/customer/verify-otp', { mobileNumber: '9833344455', otp: code });
      assert.equal(ok.status, 200);
      const replay = await post(ctx.base, '/api/v1/customer/verify-otp', { mobileNumber: '9833344455', otp: code });
      assert.notEqual(replay.status, 200, 'replaying a used code must fail');
    });
  });

  describe('when only the development console can take the code', () => {
    let ctx;
    before(async () => {
      const devConsole = { ...scriptedProvider('dev'), name: 'dev-console', official: false };
      ctx = await startWith(new OtpDispatcher({ providers: [scriptedProvider('whatsapp', { fail: true }), devConsole], channels: ['whatsapp', 'dev'], logger: silentLogger }));
    });
    after(() => { ctx.app.destroy(); ctx.server.close(); });

    test('the response reports delivered: false so the checkout does not claim "Code sent"', async () => {
      const res = await post(ctx.base, '/api/v1/customer/send-otp', { mobileNumber: '9844455566', name: 'Dev Person', email: 'dev@example.com', isNewUser: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.delivered, false);
      assert.match(res.body.message, /not sent to a real device/);
    });
  });
});
