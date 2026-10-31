import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startCheckoutServer } from '../index.js';
import { generateQrSvg } from '@youpi/core';
import { buildUpiUri, toPaise } from '@youpi/common';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS = path.resolve(__dirname, '..', 'views');
const ICONS = path.resolve(__dirname, '..', '..', 'public', 'icons');
const THEME_CSS = path.resolve(__dirname, '..', '..', 'public', 'css', 'checkout-theme.css');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/**
 * Minimal tag-stack walk of the rendered page body. Returns the ancestor chain
 * (outermost first) of every element with an id or one of the tracked classes, and any
 * close tag that did not match the open element.
 */
function walk(html) {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '');
  const stack = [];
  const ancestors = {};
  const mismatches = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/g)) {
    const [, closing, rawTag, attrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const top = stack.pop();
      if (!top || top.tag !== tag) mismatches.push(`</${tag}> closed <${top?.tag}${top?.label || ''}>`);
      continue;
    }
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    const cls = /\sclass="([^"]+)"/.exec(attrs)?.[1] || '';
    const label = id ? `#${id}` : (cls ? `.${cls.split(/\s+/)[0]}` : '');
    if (label) (ancestors[label] ||= []).push(stack.map(s => s.label).filter(Boolean));
    if (!VOID.has(tag) && !selfClose) stack.push({ tag, label });
  }
  return { ancestors, mismatches, unclosed: stack.map(s => `<${s.tag}${s.label}>`) };
}

describe('Checkout QR rendering, app icons and payment-panel layout', () => {
  let serverInstance;
  let baseUrl;
  let stubApi;
  let stubState;
  const stubRequests = [];
  const savedApiPort = process.env.PAYMENT_API_PORT;

  before(async () => {
    // Stand-in for the payment API: answers only the checkout state lookup.
    stubApi = http.createServer((req, res) => {
      stubRequests.push(`${req.method} ${req.url}`);
      if (req.method === 'GET' && /\/api\/v1\/checkout\/[^/]+\/state$/.test(req.url) && stubState) {
        res.writeHead(stubState.httpStatus || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stubState.body));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise(resolve => stubApi.listen(0, '127.0.0.1', resolve));
    process.env.PAYMENT_API_PORT = String(stubApi.address().port);

    serverInstance = await startCheckoutServer(7196);
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    await new Promise(resolve => stubApi.close(resolve));
    if (savedApiPort === undefined) delete process.env.PAYMENT_API_PORT;
    else process.env.PAYMENT_API_PORT = savedApiPort;
  });

  function get(urlPath) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${urlPath}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      }).on('error', reject);
    });
  }

  const activeUri = buildUpiUri({
    payeeVpa: 'merchant@ybl',
    payeeName: 'YOUPI Demo Store',
    amountPaise: toPaise('1.00'),
    transactionRef: 'ORDER-QR-1'
  });

  describe('UPI payment URI', () => {
    test('carries the receiving VPA, payee name, exact amount and order reference', () => {
      const params = new URL(activeUri.replace('upi://', 'http://x/')).searchParams;
      assert.ok(activeUri.startsWith('upi://pay?'));
      assert.equal(params.get('pa'), 'merchant@ybl');
      assert.equal(params.get('pn'), 'YOUPI Demo Store');
      assert.equal(params.get('am'), '1.00');
      assert.equal(params.get('tn'), 'ORDER-QR-1');
      assert.deepEqual([...params.keys()].sort(), ['am', 'pa', 'pn', 'tn']);
    });

    test('refuses a missing or malformed VPA', () => {
      for (const payeeVpa of ['', null, 'not-a-vpa', 'x@', '@ybl']) {
        assert.throws(() => buildUpiUri({ payeeVpa, payeeName: 'Store', amountPaise: 100n, transactionRef: 'O1' }));
      }
    });

    test('refuses a missing, zero or negative amount', () => {
      for (const amountPaise of [undefined, null, 0n, -100n, 'abc']) {
        assert.throws(() => buildUpiUri({ payeeVpa: 'shop@ybl', payeeName: 'Store', amountPaise, transactionRef: 'O1' }));
      }
    });
  });

  describe('GET /checkout/:id/qr.svg', () => {
    test('ACTIVE session: returns the QR of exactly the payment API\'s upi://pay URI', async () => {
      stubState = { body: { status: 'ACTIVE', amount: '1.00', upiUri: activeUri } };
      const res = await get('/checkout/pay_qr_active/qr.svg');
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /image\/svg\+xml/);
      assert.match(res.headers['cache-control'], /no-store/);
      assert.equal(res.text, generateQrSvg(activeUri, 220));
    });

    test('non-ACTIVE session: no QR is invented (no placeholder VPA or amount)', async () => {
      for (const status of ['INITIATED', 'QUEUED', 'PROCESSING', 'SUCCESS', 'EXPIRED', 'CANCELLED', 'FAILED']) {
        // payeeVpa is present in the state, but without an ACTIVE upiUri it must not be used.
        stubState = { body: { status, amount: '1.00', payeeVpa: 'shop@ybl', upiUri: null } };
        const res = await get('/checkout/pay_qr_inactive/qr.svg');
        assert.equal(res.status, 409, status);
        assert.ok(!res.text.includes('<svg'), status);
        assert.equal(JSON.parse(res.text).error, 'QR_NOT_AVAILABLE');
      }
    });

    test('ACTIVE session without a usable URI, or the payment API failing: still no QR', async () => {
      for (const s of [
        { body: { status: 'ACTIVE', amount: '1.00', upiUri: null } },
        { body: { status: 'ACTIVE', amount: '1.00', upiUri: 'https://evil.example/pay' } },
        { httpStatus: 500, body: { error: 'boom' } },
        { httpStatus: 409, body: { error: 'DUPLICATE_SESSION_DETECTED' } },
        null
      ]) {
        stubState = s;
        const res = await get('/checkout/pay_qr_broken/qr.svg');
        assert.equal(res.status, 409);
        assert.ok(!res.text.includes('<svg'));
        assert.ok(!res.text.includes('merchant@upi'));
      }
    });

    test('generating a QR only reads state: it never asks the payment API to change anything', async () => {
      stubRequests.length = 0;
      stubState = { body: { status: 'ACTIVE', amount: '1.00', upiUri: activeUri } };
      await get('/checkout/pay_qr_readonly/qr.svg');
      await get('/checkout/pay_qr_readonly/qr.svg');
      assert.ok(stubRequests.length >= 2);
      for (const r of stubRequests) assert.match(r, /^GET \/api\/v1\/checkout\/pay_qr_readonly\/state$/);
    });
  });

  describe('Checkout page markup', () => {
    test('partials are balanced and the payment panel and footer sit inside the workspace', async () => {
      stubState = null;
      const res = await get('/checkout/pay_layout_1');
      assert.equal(res.status, 200);
      const { ancestors, mismatches, unclosed } = walk(res.text);
      assert.deepEqual(mismatches, []);
      assert.deepEqual(unclosed, []);
      assert.equal(ancestors['.ypg-wrapper'].length, 1, 'exactly one checkout wrapper');

      // The footer was a flex sibling of the workspace, which squeezed the QR column to ~44px.
      for (const id of ['#ypgStickyFooter', '#paymentGatewayInterface', '#qrImageContainer', '#preGatewayAuthView']) {
        assert.ok(ancestors[id]?.[0].includes('.ypg-pc-workspace'), `${id} is inside .ypg-pc-workspace`);
      }
      assert.ok(!ancestors['#ypgStickyFooter'][0].includes('.ypg-body'));
      assert.ok(ancestors['#qrImageContainer'][0].includes('.ypg-body'));
      assert.ok(ancestors['#ypgSplashScreen'][0].includes('.ypg-wrapper'), 'splash overlays the wrapper');
      assert.equal(ancestors['.ypg-body'].length, 1, 'one scrollable body, not nested');
    });

    test('every partial balances its own div/main tags, except the workspace opened in header and closed in footer', () => {
      const count = (file) => {
        const s = fs.readFileSync(path.join(VIEWS, 'partials', file), 'utf8')
          .replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
        const n = (re) => (s.match(re) || []).length;
        return { div: n(/<div\b/g) - n(/<\/div>/g), main: n(/<main\b/g) - n(/<\/main>/g) };
      };
      for (const f of ['auth.html', 'payment-methods.html', 'sidebar.html', 'splash.html', 'modals.html']) {
        assert.deepEqual(count(f), { div: 0, main: 0 }, f);
      }
      assert.deepEqual(count('header.html'), { div: 1, main: 0 });
      assert.deepEqual(count('footer.html'), { div: -1, main: 0 });
    });

    test('the QR box starts as a loading message, and the loader has an error + retry path', async () => {
      const res = await get('/checkout/pay_layout_2');
      assert.match(res.text, /id="qrImageContainer"[^>]*>\s*<div[^>]*>Loading QR\.\.\.<\/div>/);
      assert.ok(res.text.includes('Could not load the payment QR'));
      assert.ok(res.text.includes("btn.textContent = 'Retry'"));
      assert.ok(res.text.includes('QR_MAX_AUTO_RETRIES'));
      // The QR is only requested for an ACTIVE session.
      assert.match(res.text, /data\.status === 'ACTIVE' && qrContainerBox && !qrContainerBox\.querySelector\('svg'\)/);
    });

    test('every app icon the page references exists and is served', async () => {
      const res = await get('/checkout/pay_layout_3');
      const srcs = [...new Set([...res.text.matchAll(/src="(\/icons\/[^"]+)"/g)].map(m => m[1]))];
      assert.ok(srcs.length >= 6);
      for (const src of srcs) {
        assert.ok(fs.existsSync(path.join(ICONS, path.basename(src))), `${src} exists on disk`);
        const icon = await get(src);
        assert.equal(icon.status, 200, src);
        assert.match(icon.headers['content-type'], /^image\//, src);
      }
      for (const name of ['GPay', 'PhonePe', 'Paytm', 'CRED', 'BHIM', 'Amazon Pay']) {
        assert.ok(res.text.includes(`alt="${name}"`), `${name} has an accessible name`);
      }
    });

    test('a logo that fails to load becomes a text label (fallback defined before the body)', async () => {
      const res = await get('/checkout/pay_layout_4');
      assert.ok(!res.text.includes('FALLBACK_ICONS'), 'no handler pointing at an undefined global');
      const head = res.text.slice(0, res.text.indexOf('<body'));
      assert.ok(head.includes('function ypgIconFallback(img)'));
      const appIcons = [...res.text.matchAll(/<img class="ypg-pc-mini-icon"[^>]*>|<div class="ypg-app-icon"[^>]*><img[^>]*>/g)];
      assert.ok(appIcons.length >= 10);
      for (const [tag] of appIcons) assert.ok(tag.includes('onerror="ypgIconFallback(this)"'), tag);

      // Run the fallback against a tiny DOM stand-in, in an isolated context.
      let replacedWith = null;
      const img = { alt: 'PhonePe', parentNode: {}, replaceWith: (el) => { replacedWith = el; } };
      const sandbox = { document: { createElement: () => ({}) }, img };
      vm.runInNewContext(`${/function ypgIconFallback[\s\S]*?\n    }/.exec(head)[0]}\nypgIconFallback(img);`, sandbox);
      assert.equal(replacedWith.textContent, 'PhonePe');
      assert.equal(replacedWith.className, 'ypg-icon-text-fallback');
    });

    test('desktop QR is enlarged for scanning; mobile keeps the fixed footer', () => {
      const css = fs.readFileSync(THEME_CSS, 'utf8');
      assert.match(css, /@media \(min-width: 769px\)\s*{\s*\.ypg-qr-image-box\s*{\s*width:\s*172px;\s*height:\s*172px;/);
      assert.ok(css.includes('.ypg-icon-text-fallback'));
      assert.ok(css.includes('.ypg-qr-retry'));
    });
  });
});
