import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(__dirname, '..', 'views', 'checkout.html'), 'utf8');
const successPartial = fs.readFileSync(path.resolve(__dirname, '..', 'views', 'partials', 'payment-methods.html'), 'utf8');

/** Pulls a slice of the checkout's inline script out by its start and end markers. */
function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `found ${startMarker}`);
  return html.slice(start, end);
}

/** A DOM stand-in with just enough of getElementById for the receipt renderer. */
function fakeDocument(ids) {
  const els = Object.fromEntries(ids.map(id => [id, { id, hidden: true, textContent: '' }]));
  return { els, document: { getElementById: id => els[id] || null } };
}

describe('Checkout status synchronisation and success receipt', () => {
  test('fallback polling stops on every terminal status, including CANCELLED and SUSPICIOUS', () => {
    const block = slice('const TERMINAL_STATUSES', '}, 2000);');
    for (const s of ['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'SUSPICIOUS', 'BLOCKED']) {
      assert.ok(block.includes(`'${s}'`), s);
    }
    assert.ok(block.includes('clearInterval(fallbackPollTimer)'));
  });

  describe('loadState', () => {
    const code = slice('    let loadStateInFlight', '\n    function adjustHexColor');

    function harness(responses) {
      const rendered = [];
      let calls = 0;
      const sandbox = {
        state: null,
        PAYMENT_ID: 'pay_1',
        API_BASE: '',
        DeviceIdentity: {
          resets: 0,
          registrations: 0,
          getOrRegister: async function () { this.registrations++; return {}; },
          reset: async function () { this.resets++; }
        },
        getApiHeaders: () => ({}),
        dismissSplashScreen: () => {},
        renderDuplicateSession: () => rendered.push('DUPLICATE'),
        console: { warn: () => {} },
        fetch: async () => {
          const r = responses[Math.min(calls++, responses.length - 1)];
          if (r instanceof Error) throw r;
          await new Promise(res => setTimeout(res, r.delayMs || 0));
          return { ok: r.status < 400, status: r.status, json: async () => r.body };
        },
        setTimeout,
        Promise
      };
      sandbox.renderState = data => { rendered.push(data.status); sandbox.state = data; };
      vm.createContext(sandbox);
      vm.runInContext(`${code}\nthis.loadState = loadState;`, sandbox);
      return { sandbox, rendered, calls: () => calls };
    }

    const staleDevice = { status: 409, body: { error: 'DUPLICATE_SESSION_DETECTED', code: 'DEVICE_REVOKED', boundDeviceId: null } };

    test('a stale device identity on an unbound session re-registers once and loads the real state', async () => {
      const h = harness([staleDevice, { status: 200, body: { status: 'ACTIVE' } }]);
      await h.sandbox.loadState();
      assert.equal(h.sandbox.DeviceIdentity.resets, 1);
      assert.deepEqual(h.rendered, ['ACTIVE'], 'no Duplicate Session screen for our own browser');
    });

    test('if the fresh identity is refused too, the Duplicate Session screen shows and it does not loop', async () => {
      const h = harness([staleDevice, staleDevice, staleDevice]);
      await h.sandbox.loadState();
      await h.sandbox.loadState();
      assert.equal(h.sandbox.DeviceIdentity.resets, 1, 'one re-registration per page');
      assert.deepEqual(h.rendered, ['DUPLICATE', 'DUPLICATE']);
    });

    test('a session bound to another device stays blocked: no re-registration', async () => {
      const h = harness([{ status: 409, body: { error: 'DUPLICATE_SESSION_DETECTED', code: 'DEVICE_MISMATCH', boundDeviceId: 'dev_other' } }]);
      await h.sandbox.loadState();
      assert.equal(h.sandbox.DeviceIdentity.resets, 0);
      assert.deepEqual(h.rendered, ['DUPLICATE']);
      const h2 = harness([{ status: 409, body: { error: 'DUPLICATE_SESSION_DETECTED', code: 'DEVICE_REVOKED', boundDeviceId: 'dev_other' } }]);
      await h2.sandbox.loadState();
      assert.equal(h2.sandbox.DeviceIdentity.resets, 0, 'bound sessions are never escaped by re-registering');
    });

    test('overlapping calls are serialised: one request at a time, one re-run afterwards', async () => {
      const h = harness([{ status: 200, body: { status: 'ACTIVE' }, delayMs: 30 }]);
      await Promise.all([h.sandbox.loadState(), h.sandbox.loadState(), h.sandbox.loadState()]);
      await new Promise(r => setTimeout(r, 80));
      assert.equal(h.calls(), 2, 'first request plus a single coalesced re-run');
    });

    test('pending while the backend is pending, then SUCCESS once the backend reports it', async () => {
      const h = harness([
        { status: 200, body: { status: 'ACTIVE' } },
        { status: 200, body: { status: 'ACTIVE' } },
        { status: 200, body: { status: 'SUCCESS', utr: '123456789012' } }
      ]);
      await h.sandbox.loadState();
      await h.sandbox.loadState();
      assert.deepEqual(h.rendered, ['ACTIVE', 'ACTIVE']);
      await h.sandbox.loadState();
      assert.deepEqual(h.rendered, ['ACTIVE', 'ACTIVE', 'SUCCESS']);
    });

    test('a late pending response never replaces a terminal state', async () => {
      const h = harness([
        { status: 200, body: { status: 'SUCCESS' } },
        { status: 200, body: { status: 'ACTIVE' } }
      ]);
      await h.sandbox.loadState();
      await h.sandbox.loadState();
      assert.deepEqual(h.rendered, ['SUCCESS']);
      assert.equal(h.sandbox.state.status, 'SUCCESS');
    });

    test('an unreachable or failing status endpoint never renders success', async () => {
      const h = harness([new Error('network down'), { status: 500, body: { error: 'boom' } }, { status: 502, body: {} }]);
      await h.sandbox.loadState();
      await h.sandbox.loadState();
      await h.sandbox.loadState();
      assert.deepEqual(h.rendered, []);
      assert.equal(h.sandbox.state, null);
    });
  });

  describe('DeviceIdentity', () => {
    const objSrc = slice('    const DeviceIdentity = {', '\n    function getApiHeaders');

    function load(registerDelayMs = 20) {
      const store = new Map();
      let registerCalls = 0;
      const sandbox = {
        API_BASE: '',
        window: { crypto: null, indexedDB: null, screen: {} },
        navigator: {},
        document: { createElement: () => ({ getContext: () => null }) },
        localStorage: {
          getItem: k => (store.has(k) ? store.get(k) : null),
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: k => store.delete(k)
        },
        btoa: s => Buffer.from(s).toString('base64'),
        Intl,
        console: { warn: () => {}, error: () => {} },
        fetch: async () => {
          const n = ++registerCalls;
          await new Promise(r => setTimeout(r, registerDelayMs));
          return { json: async () => ({ deviceId: `dev_${n}`, deviceToken: `tok_${n}` }) };
        },
        setTimeout,
        Promise
      };
      vm.createContext(sandbox);
      vm.runInContext(`${objSrc}\nthis.DeviceIdentity = DeviceIdentity;`, sandbox);
      return { D: sandbox.DeviceIdentity, store, registerCalls: () => registerCalls };
    }

    test('concurrent first calls share one registration', async () => {
      const { D, registerCalls } = load();
      const results = await Promise.all([D.getOrRegister(), D.getOrRegister(), D.getOrRegister()]);
      assert.equal(registerCalls(), 1);
      assert.ok(results.every(r => r.deviceId === 'dev_1'));
    });

    test('reset() forgets the stored identity so the next call registers a new device', async () => {
      const { D, store, registerCalls } = load(0);
      await D.getOrRegister();
      assert.equal(store.get('ypg_device_id'), 'dev_1');
      await D.reset();
      assert.equal(store.has('ypg_device_id'), false);
      assert.equal(store.has('ypg_device_token'), false);
      const again = await D.getOrRegister();
      assert.equal(again.deviceId, 'dev_2');
      assert.equal(registerCalls(), 2);
    });
  });

  describe('duplicate-session and blocked screens on the first state response', () => {
    // Both panels start hidden. If the first answer is a 409 duplicate session (or a block),
    // the screen must still be visible, not a 0x0 view inside a hidden panel.
    function run(fnName) {
      const authFn = slice('    function setGatewayAuthMode', '\n    function ');
      const target = slice(`    function ${fnName}`, '\n    function ');
      const ids = ['preGatewayAuthView', 'paymentGatewayInterface', 'ypgStickyFooter', 'paymentMethodSelectorBar',
        'viewDuplicateSessionContent', 'viewBlockedContent', 'pcMethodsList'];
      const els = Object.fromEntries(ids.map(id => [id, {
        id, hidden: true, textContent: '',
        style: { display: '', props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } }
      }]));
      els.paymentGatewayInterface.style.props.display = 'none';
      const topbar = { textContent: 'Sign in to Pay' };
      const document = {
        getElementById: id => els[id] || null,
        querySelector: sel => (sel === '.ypg-pc-topbar-title' ? topbar : (sel === '.ypg-pc-active-view' ? { style: {} } : null)),
        querySelectorAll: () => []
      };
      const noop = () => {};
      vm.runInNewContext(`${authFn}\n${target}\n${fnName}({ session_id: 'pay_1' });`, {
        document, PAYMENT_ID: 'pay_1', state: null, countdownTimer: null, queuePollTimer: null, sse: null,
        lastDuplicateSessionPayload: null, hideAllContent: noop, emitTriggerHook: noop, closeProcessingModal: noop,
        closeCancelPaymentModal: noop, clearInterval: noop, setTimeout: noop, escapeHtml: s => s, console
      });
      return { els, topbar };
    }

    test('renderDuplicateSession shows the payment panel and its view, hides sign-in', () => {
      const { els, topbar } = run('renderDuplicateSession');
      assert.equal(els.paymentGatewayInterface.hidden, false);
      assert.equal(els.paymentGatewayInterface.style.props.display, undefined, 'display:none removed');
      assert.equal(els.viewDuplicateSessionContent.hidden, false);
      assert.equal(els.preGatewayAuthView.hidden, true);
      assert.equal(els.ypgStickyFooter.style.display, 'none');
      assert.equal(topbar.textContent, 'Device Security Verification');
    });

    test('renderBlockedState shows the payment panel and its view, hides sign-in', () => {
      const { els } = run('renderBlockedState');
      assert.equal(els.paymentGatewayInterface.hidden, false);
      assert.equal(els.viewBlockedContent.hidden, false);
      assert.equal(els.preGatewayAuthView.hidden, true);
      assert.equal(els.ypgStickyFooter.style.display, 'none');
    });
  });

  describe('success receipt', () => {
    const fn = slice('    function renderSuccessReceipt', '\n    // --- QR SVG LOADER ---');
    const ids = ['successRowOrder', 'successOrderVal', 'successRowUtr', 'successUtrVal', 'successRowTime', 'successTimeVal', 'successReceipt', 'successTestBadge'];

    function render(data, isCod = false) {
      const { els, document } = fakeDocument(ids);
      vm.runInNewContext(`${fn}\nrenderSuccessReceipt(data, isCod);`, { document, data, isCod, Date, isNaN });
      return els;
    }

    test('shows the order, UTR and confirmation time the backend returned', () => {
      const els = render({ orderId: 'ORD-1', utr: '123456789012', completedAt: '2026-10-29T12:00:00.000Z', livemode: true });
      assert.equal(els.successReceipt.hidden, false);
      assert.equal(els.successOrderVal.textContent, 'ORD-1');
      assert.equal(els.successUtrVal.textContent, '123456789012');
      assert.equal(els.successRowTime.hidden, false);
      assert.ok(els.successTimeVal.textContent.length > 0);
      assert.equal(els.successTestBadge.hidden, true);
    });

    test('a field the backend did not return stays hidden; nothing is made up', () => {
      const els = render({ orderId: 'ORD-2' });
      assert.equal(els.successRowUtr.hidden, true);
      assert.equal(els.successUtrVal.textContent, '');
      assert.equal(els.successRowTime.hidden, true);
      const none = render({});
      assert.equal(none.successReceipt.hidden, true);
    });

    test('a synthetic settlement is labelled as a test payment', () => {
      assert.equal(render({ orderId: 'O', livemode: false }).successTestBadge.hidden, false);
    });

    test('COD orders never show a UTR', () => {
      assert.equal(render({ orderId: 'O', utr: '123456789012' }, true).successRowUtr.hidden, true);
    });

    test('the success view has the receipt and test-badge elements', () => {
      for (const id of ['successReceipt', 'successTestBadge', 'successUtrVal', 'successTimeVal', 'successOrderVal']) {
        assert.ok(successPartial.includes(`id="${id}"`), id);
      }
      assert.ok(html.includes('renderSuccessReceipt(data, isCodOrder);'));
    });
  });
});
