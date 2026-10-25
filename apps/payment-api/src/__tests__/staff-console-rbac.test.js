import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import { TEST_ADMIN_TOKEN } from '../../../../scripts/test-support.js';
import { createPaymentApp } from '../index.js';
import { Database, MerchantRepository, ReceivingAccountRepository, StaffRepository } from '@youpi/db';
import { PaymentStatus } from '@youpi/common';
import { csvCell } from '../routes/console.routes.js';

const MERCHANT_A = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_A = '00000000-0000-0000-0000-000000000002';
const PASSWORD = 'correct horse battery staple';

/** Minimal cookie-jar client for one staff member. */
class StaffClient {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/Max-Age=0/.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, path, body, { csrf = true, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.Cookie = this.cookieHeader();
    if (csrf && this.cookies.has('youpi_staff_csrf')) h['X-CSRF-Token'] = this.cookies.get('youpi_staff_csrf');
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${this.base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers };
  }

  login(email, password = PASSWORD) {
    return this.request('POST', '/api/v1/staff/auth/login', { email, password });
  }
}

describe('Staff identity, RBAC and merchant isolation', () => {
  let db, app, server, base, merchantB, accountB, staffRepo;
  const ids = {};

  before(async () => {
    db = new Database({ inMemory: true });
    app = createPaymentApp(db, { otpCooldownMs: 0, staffLoginRateLimit: 1000 });
    server = await new Promise(resolve => { const s = app.rawServer.listen(0, () => resolve(s)); });
    base = `http://localhost:${server.address().port}`;

    merchantB = new MerchantRepository(db).create({ businessName: 'Second Shop', slug: 'second-shop', contactEmail: 'ops@second.example', contactPhone: '9000000001' });
    accountB = new ReceivingAccountRepository(db).create({ merchantId: merchantB.id, upiId: 'second@upi', payeeName: 'Second Shop' });

    staffRepo = new StaffRepository(db);
    ids.platform = staffRepo.create({ email: 'root@platform.example', fullName: 'Root Admin', role: 'platform_admin', password: PASSWORD }).id;
    ids.adminA = staffRepo.create({ email: 'owner@a.example', fullName: 'Owner A', role: 'merchant_admin', password: PASSWORD, merchantId: MERCHANT_A }).id;
    ids.cashierA = staffRepo.create({ email: 'till@a.example', fullName: 'Cashier A', role: 'cashier', password: PASSWORD, merchantId: MERCHANT_A }).id;
    ids.viewerA = staffRepo.create({ email: 'viewer@a.example', fullName: 'Viewer A', role: 'viewer', password: PASSWORD, merchantId: MERCHANT_A }).id;
    ids.adminB = staffRepo.create({ email: 'owner@b.example', fullName: 'Owner B', role: 'merchant_admin', password: PASSWORD, merchantId: merchantB.id }).id;
    ids.lockme = staffRepo.create({ email: 'lockme@a.example', fullName: 'Lock Me', role: 'viewer', password: PASSWORD, merchantId: MERCHANT_A }).id;

    const sessionRepo = app.context.sessionRepo;
    const paid = sessionRepo.create({ merchantId: MERCHANT_A, orderId: 'A-PAID-1', amountPaise: 49900n, receivingAccountId: ACCOUNT_A });
    db.execute("UPDATE payment_sessions SET status = 'SUCCESS', completed_at = ? WHERE id = ?", [new Date().toISOString(), paid.id]);
    ids.paidA = paid.id;
    const failed = sessionRepo.create({ merchantId: MERCHANT_A, orderId: 'A-FAIL-1', amountPaise: 10000n, receivingAccountId: ACCOUNT_A });
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED', completed_at = ? WHERE id = ?", [new Date().toISOString(), failed.id]);
    const injected = sessionRepo.create({ merchantId: MERCHANT_A, orderId: '=HYPERLINK("http://evil")', amountPaise: 100n, receivingAccountId: ACCOUNT_A });
    db.execute("UPDATE payment_sessions SET status = 'CANCELLED' WHERE id = ?", [injected.id]);
    ids.paymentB = sessionRepo.create({ merchantId: merchantB.id, orderId: 'B-ORDER-1', amountPaise: 20000n, receivingAccountId: accountB.id }).id;
  });

  after(() => { app.destroy(); server.close(); });

  test('sign-in failures are generic and the account locks after 5 wrong passwords', async () => {
    const c = new StaffClient(base);
    const unknown = await c.login('nobody@a.example', 'whatever-password');
    const wrong = await c.login('lockme@a.example', 'wrong password!!');
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.error, wrong.body.error, 'unknown email and wrong password are indistinguishable');

    for (let i = 0; i < 4; i++) await c.login('lockme@a.example', 'wrong password!!');
    const locked = await c.login('lockme@a.example', PASSWORD);
    assert.equal(locked.status, 423, 'correct password is refused while locked');
    assert.equal(locked.body.code, 'ACCOUNT_LOCKED');
  });

  test('successful sign-in sets an HttpOnly SameSite=Strict session cookie and a CSRF cookie', async () => {
    const c = new StaffClient(base);
    const res = await c.login('owner@a.example');
    assert.equal(res.status, 200);
    const setCookies = res.headers.getSetCookie();
    assert.ok(setCookies.some(l => l.startsWith('youpi_staff=') && /HttpOnly/.test(l) && /SameSite=Strict/.test(l)));
    assert.ok(setCookies.some(l => l.startsWith('youpi_staff_csrf=') && !/HttpOnly/.test(l)));
    assert.ok(!JSON.stringify(res.body).includes('password'), 'no password material in the response');
    const me = await c.request('GET', '/api/v1/staff/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'owner@a.example');
    assert.ok(me.body.permissions.includes('payments:export'));
  });

  test('cookie-authenticated state changes require the CSRF token', async () => {
    const c = new StaffClient(base);
    await c.login('owner@a.example');
    const without = await c.request('POST', '/api/v1/staff/users', { email: 'x@a.example', fullName: 'X', role: 'viewer' }, { csrf: false });
    assert.equal(without.status, 403);
    assert.equal(without.body.code, 'CSRF_FAILED');
    const forged = await c.request('POST', '/api/v1/staff/users', { email: 'x@a.example', fullName: 'X', role: 'viewer' }, { csrf: false, headers: { 'X-CSRF-Token': 'forged' } });
    assert.equal(forged.status, 403);
  });

  test('merchant staff cannot read another merchant\'s payments', async () => {
    const b = new StaffClient(base);
    await b.login('owner@b.example');
    const list = await b.request('GET', '/api/v1/console/payments');
    assert.equal(list.status, 200);
    assert.ok(list.body.payments.every(p => p.orderId.startsWith('B-')), 'only merchant B rows');
    const detail = await b.request('GET', `/api/v1/console/payments/${ids.paidA}`);
    assert.equal(detail.status, 404, 'another merchant\'s payment id is not found');
    const forcedScope = await b.request('GET', `/api/v1/console/payments?merchantId=${MERCHANT_A}`);
    assert.equal(forcedScope.status, 403, 'requesting another merchant scope is refused');
    const overview = await b.request('GET', `/api/v1/console/overview?merchantId=${MERCHANT_A}`);
    assert.equal(overview.status, 403);
  });

  test('roles are enforced: cashier cannot export or manage the team; viewer cannot cancel', async () => {
    const cashier = new StaffClient(base);
    await cashier.login('till@a.example');
    assert.equal((await cashier.request('GET', '/api/v1/console/payments/export.csv')).status, 403);
    assert.equal((await cashier.request('POST', '/api/v1/staff/users', { email: 'y@a.example', fullName: 'Y', role: 'viewer' })).status, 403);
    assert.equal((await cashier.request('GET', '/api/v1/console/system')).status, 403);

    const viewer = new StaffClient(base);
    await viewer.login('viewer@a.example');
    assert.equal((await viewer.request('POST', `/api/v1/console/payments/${ids.paidA}/cancel`, { reason: 'test' })).status, 403);
  });

  test('cashier can cancel an ACTIVE session with a reason, but not one under verification', async () => {
    const sessionRepo = app.context.sessionRepo;
    db.execute("UPDATE payment_sessions SET status = 'EXPIRED' WHERE receiving_account_id = ? AND status IN ('ACTIVE','PROCESSING','QUEUED')", [ACCOUNT_A]);
    const live = sessionRepo.create({ merchantId: MERCHANT_A, orderId: 'A-LIVE-1', amountPaise: 30000n, receivingAccountId: ACCOUNT_A });
    app.context.queueEngine.enqueueOrActivate(live.id, ACCOUNT_A);
    assert.equal(sessionRepo.findById(live.id).status, PaymentStatus.ACTIVE);

    const cashier = new StaffClient(base);
    await cashier.login('till@a.example');
    const noReason = await cashier.request('POST', `/api/v1/console/payments/${live.id}/cancel`, {});
    assert.equal(noReason.status, 400);
    const ok = await cashier.request('POST', `/api/v1/console/payments/${live.id}/cancel`, { reason: 'Customer left the counter' });
    assert.equal(ok.status, 200);
    assert.equal(sessionRepo.findById(live.id).status, PaymentStatus.CANCELLED);
    const trail = app.context.auditRepo.findByEntity('PAYMENT_SESSION', live.id).map(a => a.action);
    assert.ok(trail.includes('PAYMENT_CANCELLED_BY_STAFF'));
    assert.ok(trail.includes('PAYMENT_CANCELLED_BY_OPERATOR'));

    const verifying = sessionRepo.create({ merchantId: MERCHANT_A, orderId: 'A-LIVE-2', amountPaise: 30000n, receivingAccountId: ACCOUNT_A });
    app.context.queueEngine.enqueueOrActivate(verifying.id, ACCOUNT_A);
    sessionRepo.transitionToProcessing(verifying.id);
    const refused = await cashier.request('POST', `/api/v1/console/payments/${verifying.id}/cancel`, { reason: 'trying' });
    assert.equal(refused.status, 409);
    assert.equal(sessionRepo.findById(verifying.id).status, PaymentStatus.PROCESSING);
  });

  test('no console or staff route can mark a payment SUCCESS', async () => {
    const admin = new StaffClient(base);
    await admin.login('root@platform.example');
    const target = app.context.sessionRepo.create({ merchantId: MERCHANT_A, orderId: 'A-NO-FORCE', amountPaise: 1000n });
    for (const path of [`/api/v1/console/payments/${target.id}/succeed`, `/api/v1/console/payments/${target.id}/mark-paid`, `/api/v1/console/payments/${target.id}/status`]) {
      const res = await admin.request('POST', path, { status: 'SUCCESS' });
      assert.equal(res.status, 404);
    }
    assert.equal(app.context.sessionRepo.findById(target.id).status, PaymentStatus.INITIATED);
  });

  test('merchant admin creates merchant-scoped staff but never platform admins', async () => {
    const a = new StaffClient(base);
    await a.login('owner@a.example');
    const denied = await a.request('POST', '/api/v1/staff/users', { email: 'boss@a.example', fullName: 'Boss', role: 'platform_admin' });
    assert.equal(denied.status, 403);
    const created = await a.request('POST', '/api/v1/staff/users', { email: 'new.cashier@a.example', fullName: 'New Cashier', role: 'cashier', merchantId: merchantB.id });
    assert.equal(created.status, 403, 'cannot add people to another merchant');
    const ok = await a.request('POST', '/api/v1/staff/users', { email: 'new.cashier@a.example', fullName: 'New Cashier', role: 'cashier' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.user.merchantId, MERCHANT_A);
    assert.ok(ok.body.temporaryPassword.length >= 20);

    const fresh = new StaffClient(base);
    assert.equal((await fresh.login('new.cashier@a.example', ok.body.temporaryPassword)).status, 200);
    const disabled = await a.request('POST', `/api/v1/staff/users/${ok.body.user.id}`, { status: 'DISABLED' });
    assert.equal(disabled.status, 200);
    assert.equal((await fresh.request('GET', '/api/v1/staff/auth/me')).status, 401, 'disabling revokes live sessions');

    const team = await a.request('GET', '/api/v1/staff/users');
    assert.ok(team.body.users.every(u => u.merchantId === MERCHANT_A), 'team list is merchant-scoped');
    const otherMerchantUser = await a.request('POST', `/api/v1/staff/users/${ids.adminB}`, { status: 'DISABLED' });
    assert.equal(otherMerchantUser.status, 404);
  });

  test('the last active platform administrator cannot be disabled', async () => {
    const res = await fetch(`${base}/api/v1/staff/users/${ids.platform}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'DISABLED' })
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'LAST_ADMIN');
  });

  test('legacy admin API: platform admin session allowed, merchant admin session refused', async () => {
    const root = new StaffClient(base);
    await root.login('root@platform.example');
    assert.equal((await root.request('GET', '/api/v1/admin/payments')).status, 200);
    const a = new StaffClient(base);
    await a.login('owner@a.example');
    assert.equal((await a.request('GET', '/api/v1/admin/payments')).status, 401);
  });

  test('overview reflects database rows; export is audited and formula-safe', async () => {
    const a = new StaffClient(base);
    await a.login('owner@a.example');
    const overview = await a.request('GET', '/api/v1/console/overview?range=24h');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.statusCounts.SUCCESS >= 1, true);
    assert.equal(overview.body.totals.collectedPaise, '49900', 'only the SUCCESS non-COD row counts as collected');
    assert.ok(overview.body.upiSuccessRate.definition.length > 10, 'rate definition is explicit');

    const csv = await a.request('GET', '/api/v1/console/payments/export.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula cell is neutralised');
    assert.ok(!/\b(second@upi|9000000001)\b/.test(csv.text));
    const exported = db.query("SELECT * FROM audit_logs WHERE action = 'PAYMENTS_EXPORTED' AND merchant_id = ?", [MERCHANT_A]);
    assert.ok(exported.length >= 1);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('plain'), 'plain');
  });

  test('admin API token acts as the platform (system) principal for automation', async () => {
    const res = await fetch(`${base}/api/v1/console/system`, { headers: { Authorization: `Bearer ${TEST_ADMIN_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.database.expectedSchemaVersion, body.database.schemaVersion);
    assert.ok(Array.isArray(body.services));
  });

  test('logout revokes the session server-side', async () => {
    const c = new StaffClient(base);
    await c.login('viewer@a.example');
    const stolen = c.cookieHeader();
    await c.request('POST', '/api/v1/staff/auth/logout', {});
    const replay = await fetch(`${base}/api/v1/staff/auth/me`, { headers: { Cookie: stolen } });
    assert.equal(replay.status, 401);
  });
});

describe('Staff sign-in rate limiting', () => {
  test('the per-IP limiter answers 429 once the window budget is spent', async () => {
    const db = new Database({ inMemory: true });
    const app = createPaymentApp(db, { otpCooldownMs: 0, staffLoginRateLimit: 3 });
    const server = await new Promise(resolve => { const s = app.rawServer.listen(0, () => resolve(s)); });
    try {
      const base = `http://localhost:${server.address().port}`;
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${base}/api/v1/staff/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', password: 'nope-nope-nope' }) });
        statuses.push(res.status);
      }
      assert.deepEqual(statuses, [401, 401, 401, 429]);
    } finally {
      app.destroy();
      server.close();
    }
  });
});
