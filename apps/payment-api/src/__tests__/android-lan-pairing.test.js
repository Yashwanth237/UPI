import '../../../../scripts/test-support.js';
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { assessPhoneReachability, isPrivateLanIPv4, resolveAndroidGatewayUrl } from '../routes/pollers.routes.js';
import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';

// Local-network pairing of a physical phone: the pairing QR must carry an address the phone can
// reach (the laptop's LAN IP), never localhost, and must say when the API cannot be reached there.
describe('Android pairing over the local network', () => {
  let api;
  let db;
  const savedEnv = { url: process.env.YOUPI_ANDROID_GATEWAY_URL, bind: process.env.YOUPI_BIND_HOST };

  const pairQr = async () => {
    const res = await fetch(`http://localhost:${api.port}/api/v1/admin/sms-gateway/pair-qr`, {
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6231, db);
  });

  after(async () => {
    await api.close();
    db.close();
  });

  afterEach(() => {
    for (const [key, value] of [['YOUPI_ANDROID_GATEWAY_URL', savedEnv.url], ['YOUPI_BIND_HOST', savedEnv.bind]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('recognises only RFC 1918 private IPv4 addresses as LAN', () => {
    for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.128']) assert.equal(isPrivateLanIPv4(host), true, host);
    for (const host of ['172.32.0.1', '8.8.8.8', '127.0.0.1', '192.169.0.1', 'pay.example.com', '999.168.1.1', '']) assert.equal(isPrivateLanIPv4(host), false, host);
  });

  test('without an override the QR keeps the runtime URL and warns that the phone cannot use it', async () => {
    delete process.env.YOUPI_ANDROID_GATEWAY_URL;
    const qr = await pairQr();
    assert.equal(qr.serverUrl, 'http://localhost:6100');
    assert.equal(qr.phoneReachable, false);
    assert.match(qr.phoneReachabilityWarning, /YOUPI_ANDROID_GATEWAY_URL/);
  });

  test('YOUPI_ANDROID_GATEWAY_URL puts the LAN address in the QR payload', async () => {
    process.env.YOUPI_ANDROID_GATEWAY_URL = 'http://192.168.1.128:6100/';
    process.env.YOUPI_BIND_HOST = '192.168.1.128';
    const qr = await pairQr();
    assert.equal(qr.serverUrl, 'http://192.168.1.128:6100');
    assert.equal(JSON.parse(qr.pairingPayload).serverUrl, 'http://192.168.1.128:6100');
    assert.equal(qr.phoneReachable, true);
    assert.match(qr.phoneReachabilityWarning, /YOUPI_ANDROID_LAN_HOSTS=192\.168\.1\.128/);
  });

  test('a LAN address with the API still bound to loopback is flagged as unreachable', async () => {
    process.env.YOUPI_ANDROID_GATEWAY_URL = 'http://192.168.1.128:6100';
    delete process.env.YOUPI_BIND_HOST;
    const qr = await pairQr();
    assert.equal(qr.phoneReachable, false);
    assert.match(qr.phoneReachabilityWarning, /YOUPI_BIND_HOST=192\.168\.1\.128/);
  });

  test('plain HTTP stays refused for public hosts, even when set explicitly', () => {
    assert.equal(assessPhoneReachability('http://203.0.113.10:6100', { allowLanHttp: true }).ok, false);
    assert.equal(assessPhoneReachability('http://192.168.1.20:6100').ok, false, 'LAN HTTP needs the explicit override');
  });

  test('a malformed override is ignored rather than put in the QR', () => {
    process.env.YOUPI_ANDROID_GATEWAY_URL = 'javascript:alert(1)';
    assert.deepEqual(resolveAndroidGatewayUrl('http://localhost:6100'), { url: 'http://localhost:6100', overridden: false });
    process.env.YOUPI_ANDROID_GATEWAY_URL = 'http://192.168.1.128:6100/some/path';
    assert.equal(resolveAndroidGatewayUrl('http://localhost:6100').overridden, false);
  });
});
