import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startCheckoutServer } from '../index.js';
import { CONFIRMATION_COPY } from '../server.js';

/** Checkout redesign: accessibility, honest copy and the same-device UPI intent. */
describe('Checkout UX: accessibility and honest copy', () => {
  let serverInstance;
  let baseUrl;

  before(async () => {
    serverInstance = await startCheckoutServer(7197);
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
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

  test('pinch-zoom is not disabled (WCAG 1.4.4)', async () => {
    const res = await get('/checkout/pay_ux_1');
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(res.text)?.[1] || '';
    assert.ok(viewport.includes('width=device-width'));
    assert.ok(!/user-scalable\s*=\s*no/i.test(viewport));
    assert.ok(!/maximum-scale\s*=\s*1(\.0)?\b/i.test(viewport));
  });

  test('no fabricated social proof, unearned badges or marketing encryption claims by default', async () => {
    const res = await get('/checkout/pay_ux_2');
    for (const claim of ['500+ orders', '200+ orders', 'Verified Business', 'Trusted Business', 'Verified & Protected', '256-Bit']) {
      assert.ok(!res.text.includes(claim), `default page must not contain "${claim}"`);
    }
  });

  test('design system assets are served and the theme layer is linked', async () => {
    const res = await get('/checkout/pay_ux_3');
    assert.ok(res.text.includes('/ui/tokens.css'));
    assert.ok(res.text.includes('/css/checkout-theme.css'));
    const tokens = await get('/ui/tokens.css');
    assert.equal(tokens.status, 200);
    assert.match(tokens.headers['content-type'], /text\/css/);
    const font = await get('/ui/fonts/dm-sans.woff2');
    assert.equal(font.status, 200);
    assert.equal((await get('/ui/../server.js')).status, 404);
    assert.equal((await get('/ui/secret.txt')).status, 404);
  });

  test('same-device UPI intent exists, starts hidden and is only enabled for upi://pay URIs', async () => {
    const res = await get('/checkout/pay_ux_4');
    assert.match(res.text, /id="upiIntentBox"[^>]*hidden/);
    assert.ok(res.text.includes('id="upiIntentLink"'));
    // The client only enables it for an ACTIVE session whose URI is a upi://pay link.
    assert.match(res.text, /data\.status === 'ACTIVE' && \/\^upi:/);
  });

  test('confirmation status wording describes the gateway, not "UPI servers"', async () => {
    for (const tier of ['YELLOW', 'RED']) {
      const c = CONFIRMATION_COPY[tier];
      assert.ok(!/UPI server/i.test(`${c.label} ${c.heading} ${c.message}`));
      assert.ok(/UTR/.test(c.message), 'tells the customer what to keep if confirmation is delayed');
    }
    const res = await get('/checkout/pay_ux_5');
    assert.ok(!res.text.includes('UPI Server Facing Issues'));
  });
});
