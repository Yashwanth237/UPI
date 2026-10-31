import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { getAdminToken } from '@youpi/common';
import { startAdminServer } from '../index.js';

describe('Merchant Admin Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6101, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, { headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      }).on('error', reject);
    });
  }

  test('GET /health returns UP', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.status, 'UP');
    assert.equal(json.service, 'merchant-admin');
  });

  test('GET / renders dashboard with queue monitor, observers, counter desk & pairing modal', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));

    assert.ok(res.text.includes('Real-Time Receiving Account Slot Ownership'));
    assert.ok(res.text.includes('Active Slot (5-Minute Window)'));
    assert.ok(res.text.includes('Processing Slot (30s Verification Window)'));
    assert.ok(res.text.includes('Live Counter Payment Requests'));
    assert.ok(res.text.includes('Payment Observers (SMS & Gmail)'));
    assert.ok(res.text.includes('Android SMS Gateway'));
    assert.ok(res.text.includes('Gmail Direct API'));
  });

  test('Incoming Bank Credit Alerts keep source, sender, bank and app package apart', async () => {
    const { text } = await get('/');
    const head = text.slice(text.indexOf('Incoming Bank Credit Alerts'), text.indexOf('smsHubMessagesBody'));
    for (const col of ['<th>Source</th>', '<th>Sender</th>', '<th>Bank</th>', '<th>Outcome</th>']) assert.ok(head.includes(col), col);
    const render = text.slice(text.indexOf('async function fetchSmsHubMessages'), text.indexOf('async function fetchSmsGatewayDevices'));
    // The package is shown only as technical metadata under Source, never in the Sender cell.
    assert.match(render, /via \$\{escapeHtml\(m\.sourcePackage\)\}/);
    assert.match(render, /escapeHtml\(m\.sender \|\| 'Unknown'\)/);
    assert.doesNotMatch(render, /m\.sender \|\| m\.sourcePackage|m\.sourcePackage \|\| m\.sender/);
    for (const outcome of ['ACCEPTED', 'REJECTED', 'PENDING_REVIEW', 'DUPLICATE', 'NO_MATCHING_CHECKOUT']) assert.ok(render.includes(outcome), outcome);
  });

  test('GET /api/admin/tickets requires the admin token', async () => {
    const anonymous = await get('/api/admin/tickets');
    assert.equal(anonymous.status, 401);

    const res = await get('/api/admin/tickets', { Authorization: `Bearer ${getAdminToken()}` });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.ok(Array.isArray(json));
  });

  test('Control Center supervisor proxy routes (/api/services* and /api/logs/stream) require the admin token', async () => {
    const anonServices = await get('/api/services');
    assert.equal(anonServices.status, 401);

    const wrongToken = await get('/api/services', { Authorization: 'Bearer wrong-token' });
    assert.equal(wrongToken.status, 401);

    const anonLogs = await get('/api/logs/stream');
    assert.equal(anonLogs.status, 401);

    const wrongQueryLogs = await get('/api/logs/stream?token=wrong-token');
    assert.equal(wrongQueryLogs.status, 401);
  });
});
