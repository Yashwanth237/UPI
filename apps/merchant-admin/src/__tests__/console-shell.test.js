import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Database } from '@youpi/db';
import { startAdminServer } from '../index.js';

describe('Operations console shell (/console)', () => {
  let serverInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6104, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      }).on('error', reject);
    });
  }

  test('serves the console with a strict CSP (no inline script or style) and no framing', async () => {
    const res = await get('/console');
    assert.equal(res.status, 200);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src 'self';/);
    assert.ok(!csp.includes('unsafe-inline'));
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.ok(!/<script>(?!\s*<\/script>)/.test(res.text), 'no inline <script> blocks');
    assert.ok(!/\sstyle="/.test(res.text), 'no inline style attributes');
    assert.ok(!/\son[a-z]+="/.test(res.text), 'no inline event handlers');
  });

  test('console assets come from a fixed allow-list', async () => {
    assert.equal((await get('/console/console.js')).status, 200);
    assert.equal((await get('/console/console.css')).status, 200);
    assert.equal((await get('/console/theme.js')).status, 200);
    assert.equal((await get('/ui/components.css')).status, 200);
    assert.notEqual((await get('/console/../server.js')).status, 200);
    assert.notEqual((await get('/console/other.js')).status, 200);
  });

  test('console script never renders server data through innerHTML', async () => {
    const js = (await get('/console/console.js')).text;
    assert.ok(!/\.innerHTML\s*=/.test(js));
    assert.ok(!/insertAdjacentHTML|document\.write/.test(js));
  });
});
