import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OtpDispatcher,
  OtpDeliveryError,
  WhatsAppCloudApiProvider,
  LinkedDeviceWhatsAppProvider,
  SmtpEmailOtpProvider,
  DevConsoleOtpProvider,
  createOtpDispatcherFromEnv,
  isDeliverableEmail,
  maskDestination
} from '../otp-delivery.js';

const silentLogger = { log() {}, warn() {}, error() {} };

function fakeFetch(status, body, calls) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

describe('OTP delivery providers', () => {
  test('WhatsApp Cloud API sends an authentication template with the code in body and copy-code button', async () => {
    const calls = [];
    const provider = new WhatsAppCloudApiProvider({
      accessToken: 'test-token', phoneNumberId: '1234567890', templateName: 'login_otp', templateLanguage: 'en',
      fetchImpl: fakeFetch(200, { messages: [{ id: 'wamid.TEST' }] }, calls)
    });
    const result = await provider.send({ to: '9876543210', code: '482913' });

    assert.equal(result.messageId, 'wamid.TEST');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/1234567890/messages');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
    const sent = calls[0].body;
    assert.equal(sent.messaging_product, 'whatsapp');
    assert.equal(sent.to, '919876543210');
    assert.equal(sent.template.name, 'login_otp');
    assert.deepEqual(sent.template.components[0], { type: 'body', parameters: [{ type: 'text', text: '482913' }] });
    assert.equal(sent.template.components[1].sub_type, 'url');
    assert.equal(sent.template.components[1].parameters[0].text, '482913');
  });

  test('WhatsApp Cloud API rejection becomes an OtpDeliveryError (never a silent success)', async () => {
    const provider = new WhatsAppCloudApiProvider({
      accessToken: 't', phoneNumberId: '1', templateName: 'x',
      fetchImpl: fakeFetch(400, { error: { code: 132001, message: 'Template does not exist' } }, [])
    });
    await assert.rejects(() => provider.send({ to: '9876543210', code: '111111' }), (err) => {
      assert.ok(err instanceof OtpDeliveryError);
      assert.equal(err.code, 'PROVIDER_REJECTED');
      assert.ok(!err.message.includes('111111'), 'error text must not contain the OTP');
      return true;
    });
  });

  test('linked-device adapter treats simulated sends as undelivered in production', async () => {
    const service = { sendOtp: async () => ({ success: true, delivered: true, simulated: true }) };
    const prod = new LinkedDeviceWhatsAppProvider({ service, isProduction: true });
    await assert.rejects(() => prod.send({ to: '9876543210', code: '123456' }), { code: 'PROVIDER_UNAVAILABLE' });

    const disconnected = new LinkedDeviceWhatsAppProvider({ service: { sendOtp: async () => ({ success: false, delivered: false, queued: true }) } });
    await assert.rejects(() => disconnected.send({ to: '9876543210', code: '123456' }), { code: 'PROVIDER_UNAVAILABLE' });
  });

  test('SMTP provider sends a plain-text code email and refuses placeholder addresses', async () => {
    const sent = [];
    const provider = new SmtpEmailOtpProvider({ from: 'YouPI <no-reply@example.com>', brandName: 'YouPI', transport: { sendMail: async (m) => { sent.push(m); return { messageId: '<m1@example.com>' }; } } });
    const result = await provider.send({ to: 'asha@example.com', code: '765432', ttlSeconds: 300 });
    assert.equal(result.messageId, '<m1@example.com>');
    assert.match(sent[0].subject, /765432/);
    assert.match(sent[0].text, /expires in 5 minutes/);

    await assert.rejects(() => provider.send({ to: '9876543210@customer.youpi.local', code: '1' }), { code: 'INVALID_RECIPIENT' });
  });

  test('development console provider cannot be constructed in production', () => {
    assert.throws(() => new DevConsoleOtpProvider({ env: { NODE_ENV: 'production' } }), /cannot be used when NODE_ENV=production/);
    assert.doesNotThrow(() => new DevConsoleOtpProvider({ env: { NODE_ENV: 'development' }, logger: silentLogger }));
  });

  test('helpers mask destinations and reject undeliverable emails', () => {
    assert.equal(maskDestination('whatsapp', '9876543210'), '******3210');
    assert.equal(maskDestination('email', 'asha@example.com'), 'as***@example.com');
    assert.equal(isDeliverableEmail('x@customer.youpi.local'), false);
    assert.equal(isDeliverableEmail('x@example.com'), true);
  });
});

describe('OtpDispatcher channel policy', () => {
  const failing = (channel, name = `${channel}-down`) => ({
    channel, name, isConfigured: () => true,
    send: async () => { throw new OtpDeliveryError('down', { code: 'PROVIDER_UNREACHABLE', provider: name }); }
  });
  const working = (channel, name = `${channel}-ok`) => ({
    channel, name, isConfigured: () => true, sent: [],
    async send(msg) { this.sent.push(msg); return { messageId: 'ok' }; }
  });

  test('falls back to email when WhatsApp is unavailable and the customer has a deliverable email', async () => {
    const email = working('email');
    const dispatcher = new OtpDispatcher({ providers: [failing('whatsapp'), email], channels: ['whatsapp', 'email'], logger: silentLogger });
    const result = await dispatcher.send({ mobile: '9876543210', email: 'asha@example.com', code: '222222' });
    assert.equal(result.channel, 'email');
    assert.equal(result.destination, 'as***@example.com');
    assert.equal(result.attempts.length, 1);
    assert.equal(email.sent[0].code, '222222');
  });

  test('without fallback, a failed primary channel is final', async () => {
    const email = working('email');
    const dispatcher = new OtpDispatcher({ providers: [failing('whatsapp'), email], channels: ['whatsapp', 'email'], allowFallback: false, logger: silentLogger });
    await assert.rejects(() => dispatcher.send({ mobile: '9876543210', email: 'asha@example.com', code: '1' }), { code: 'OTP_DELIVERY_UNAVAILABLE' });
    assert.equal(email.sent.length, 0);
  });

  test('preferred channel goes first when allowed by policy', async () => {
    const wa = working('whatsapp');
    const email = working('email');
    const dispatcher = new OtpDispatcher({ providers: [wa, email], channels: ['whatsapp', 'email'], logger: silentLogger });
    const result = await dispatcher.send({ mobile: '9876543210', email: 'asha@example.com', code: '3', preferredChannel: 'email' });
    assert.equal(result.channel, 'email');
    assert.equal(wa.sent.length, 0);
  });

  test('reports OTP_DELIVERY_UNAVAILABLE when nothing can deliver', async () => {
    const dispatcher = new OtpDispatcher({ providers: [failing('whatsapp')], channels: ['whatsapp', 'email'], logger: silentLogger });
    await assert.rejects(() => dispatcher.send({ mobile: '9876543210', email: null, code: '4' }), (err) => {
      assert.equal(err.code, 'OTP_DELIVERY_UNAVAILABLE');
      assert.deepEqual(err.attempts.map(a => a.error), ['PROVIDER_UNREACHABLE', 'NO_DESTINATION']);
      return true;
    });
  });

  test('the OTP never appears in dispatcher warnings', async () => {
    const lines = [];
    const logger = { log() {}, warn: (m) => lines.push(m), error() {} };
    const dispatcher = new OtpDispatcher({ providers: [failing('whatsapp')], channels: ['whatsapp'], logger });
    await assert.rejects(() => dispatcher.send({ mobile: '9876543210', code: '918273' }));
    assert.ok(lines.length > 0);
    assert.ok(lines.every(l => !l.includes('918273') && !l.includes('9876543210')));
  });
});

describe('createOtpDispatcherFromEnv', () => {
  test('production never gets the development console provider', () => {
    const dispatcher = createOtpDispatcherFromEnv({ NODE_ENV: 'production', OTP_DEV_CONSOLE: 'true' }, { logger: silentLogger });
    assert.ok(dispatcher.describe().providers.every(p => p.name !== 'dev-console'));
    assert.deepEqual(dispatcher.availableChannels(), []);
  });

  test('prefers the official Cloud API when configured; linked-device only on explicit choice', () => {
    const service = { sendOtp: async () => ({}) };
    const cloudEnv = { NODE_ENV: 'production', WHATSAPP_CLOUD_ACCESS_TOKEN: 't', WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1', WHATSAPP_CLOUD_OTP_TEMPLATE: 'otp' };
    const names = (d) => d.describe().providers.map(p => p.name);

    assert.ok(names(createOtpDispatcherFromEnv(cloudEnv, { linkedDeviceService: service, logger: silentLogger })).includes('whatsapp-cloud-api'));
    assert.ok(!names(createOtpDispatcherFromEnv(cloudEnv, { linkedDeviceService: service, logger: silentLogger })).includes('whatsapp-linked-device'));
    assert.ok(names(createOtpDispatcherFromEnv({ ...cloudEnv, OTP_WHATSAPP_PROVIDER: 'linked-device' }, { linkedDeviceService: service, logger: silentLogger })).includes('whatsapp-linked-device'));
  });

  test('development with nothing configured falls back to the console provider', () => {
    const dispatcher = createOtpDispatcherFromEnv({ NODE_ENV: 'development' }, { logger: silentLogger });
    assert.ok(dispatcher.describe().providers.some(p => p.name === 'dev-console'));
  });

  test('OTP_CHANNELS controls order and ignores unknown channels', () => {
    const dispatcher = createOtpDispatcherFromEnv({ NODE_ENV: 'development', OTP_CHANNELS: 'email, sms ,whatsapp' }, { logger: silentLogger });
    assert.deepEqual(dispatcher.channels, ['email', 'whatsapp']);
  });
});
