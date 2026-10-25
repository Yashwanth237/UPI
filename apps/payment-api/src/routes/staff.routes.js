import { HttpServer } from '../server.js';
import {
  Permission,
  StaffRole,
  ROLE_LABELS,
  assignableRoles,
  isValidEmail,
  normalizeEmail,
  permissionsForRole,
  validateStaffPassword
} from '@youpi/common';
import { verifyStaffPassword, dummyStaffPasswordCheck } from '@youpi/db';
import {
  buildStaffCookies,
  clearStaffCookies,
  clientIp,
  LoginRateLimiter,
  newRandomPassword,
  publicStaffUser,
  readCookie,
  requireStaff,
  resolveStaffPrincipal,
  STAFF_SESSION_COOKIE
} from '../staff-auth.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Staff identity routes: sign-in, sign-out, profile, and team management.
 * @param {HttpServer} server
 * @param {{ staffRepo: any, staffSessionRepo: any, auditRepo: any, merchantRepo: any, defaultMerchant: any }} ctx
 */
export function registerStaffRoutes(server, ctx) {
  // Per-IP limit on sign-in attempts; per-account lockout below covers targeted guessing.
  const loginLimiter = new LoginRateLimiter({ limit: ctx.staffLoginRateLimit || Number(process.env.STAFF_LOGIN_RATE_LIMIT) || 10, windowMs: 60 * 1000 });

  function audit(principal, action, entityId, details = {}, merchantId = null, req = null) {
    ctx.auditRepo?.log({
      merchantId: merchantId || principal?.merchantId || null,
      entityType: 'STAFF',
      entityId: entityId || principal?.id || 'unknown',
      action,
      actorType: principal ? (principal.kind === 'system' ? 'SYSTEM' : 'STAFF') : 'ANONYMOUS',
      actorId: principal?.id || null,
      details,
      ipAddress: req ? clientIp(req) : null
    });
  }

  // POST /api/v1/staff/auth/login
  server.post('/api/v1/staff/auth/login', async (req, res) => {
    const ip = clientIp(req);
    if (!loginLimiter.attempt(ip)) {
      HttpServer.json(res, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.', code: 'RATE_LIMITED' });
      return;
    }

    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    // One generic message for every failure, so the endpoint does not reveal which emails exist.
    const genericFailure = () => HttpServer.json(res, 401, { error: 'Email or password is incorrect.', code: 'INVALID_CREDENTIALS' });

    if (!email || !password) {
      genericFailure();
      return;
    }

    const user = ctx.staffRepo.findByEmailWithSecret(email);
    if (!user) {
      dummyStaffPasswordCheck(password); // equalise timing with the real path
      audit(null, 'STAFF_LOGIN_FAILED', `email:${email}`, { reason: 'UNKNOWN_EMAIL' }, null, req);
      genericFailure();
      return;
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      dummyStaffPasswordCheck(password);
      audit(null, 'STAFF_LOGIN_FAILED', user.id, { reason: 'LOCKED' }, user.merchantId, req);
      HttpServer.json(res, 423, { error: 'This account is temporarily locked after repeated failed sign-ins. Try again later or ask an administrator to reset it.', code: 'ACCOUNT_LOCKED' });
      return;
    }

    const passwordOk = verifyStaffPassword(password, user.passwordHash);
    if (!passwordOk || user.status !== 'ACTIVE') {
      if (!passwordOk) {
        const { lockedUntil } = ctx.staffRepo.recordFailedLogin(user.id, { maxFailures: MAX_FAILED_LOGINS, lockMs: LOCKOUT_MS });
        audit(null, lockedUntil ? 'STAFF_ACCOUNT_LOCKED' : 'STAFF_LOGIN_FAILED', user.id, { reason: 'BAD_PASSWORD' }, user.merchantId, req);
      } else {
        audit(null, 'STAFF_LOGIN_FAILED', user.id, { reason: 'DISABLED' }, user.merchantId, req);
      }
      genericFailure();
      return;
    }

    ctx.staffRepo.recordSuccessfulLogin(user.id);
    const { session, token, csrfToken } = ctx.staffSessionRepo.create(user.id, {
      ttlMs: SESSION_TTL_MS,
      ipAddress: ip,
      userAgent: req.headers['user-agent'] || null
    });
    audit({ kind: 'staff', id: user.id, merchantId: user.merchantId }, 'STAFF_LOGIN', user.id, { sessionId: session.id }, user.merchantId, req);

    res.setHeader('Set-Cookie', buildStaffCookies(req, { token, csrfToken, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) }));
    const fresh = ctx.staffRepo.findById(user.id);
    HttpServer.json(res, 200, {
      user: publicStaffUser(fresh),
      permissions: permissionsForRole(fresh.role),
      expiresAt: session.expiresAt
    });
  });

  // POST /api/v1/staff/auth/logout (idempotent; always clears cookies)
  server.post('/api/v1/staff/auth/logout', async (req, res) => {
    const token = readCookie(req, STAFF_SESSION_COOKIE);
    const session = token ? ctx.staffSessionRepo.findActiveByToken(token) : null;
    if (session) {
      ctx.staffSessionRepo.revoke(session.id, 'logout');
      audit({ kind: 'staff', id: session.staffUserId }, 'STAFF_LOGOUT', session.staffUserId, { sessionId: session.id }, null, req);
    }
    res.setHeader('Set-Cookie', clearStaffCookies(req));
    HttpServer.json(res, 200, { success: true });
  });

  // GET /api/v1/staff/auth/me
  server.get('/api/v1/staff/auth/me', async (req, res) => {
    const principal = resolveStaffPrincipal(req, ctx);
    if (!principal) {
      HttpServer.json(res, 401, {
        error: 'Sign in required.',
        code: 'AUTH_REQUIRED',
        // Lets the sign-in page explain first-time setup instead of a dead end.
        setupRequired: ctx.staffRepo.count() === 0
      });
      return;
    }
    const merchant = principal.merchantId ? ctx.merchantRepo.findById(principal.merchantId) : null;
    HttpServer.json(res, 200, {
      user: principal.kind === 'system'
        ? { id: principal.id, fullName: principal.fullName, role: principal.role, merchantId: null }
        : publicStaffUser(ctx.staffRepo.findById(principal.id)),
      roleLabel: ROLE_LABELS[principal.role] || principal.role,
      permissions: principal.permissions,
      merchant: merchant ? { id: merchant.id, businessName: merchant.businessName } : null,
      defaultMerchantId: ctx.defaultMerchant?.id || null
    });
  });

  // POST /api/v1/staff/auth/change-password
  server.post('/api/v1/staff/auth/change-password', async (req, res) => {
    const principal = requireStaff(req, res, ctx, null);
    if (!principal) return;
    if (principal.kind !== 'staff') {
      HttpServer.json(res, 400, { error: 'The admin API token has no password.', code: 'NOT_A_STAFF_ACCOUNT' });
      return;
    }
    const body = await HttpServer.parseBody(req).catch(() => ({}));
    const user = ctx.staffRepo.findByEmailWithSecret(principal.email);
    if (!user || !verifyStaffPassword(String(body.currentPassword || ''), user.passwordHash)) {
      HttpServer.json(res, 400, { error: 'Current password is incorrect.', code: 'INVALID_CREDENTIALS' });
      return;
    }
    const problem = validateStaffPassword(body.newPassword);
    if (problem) {
      HttpServer.json(res, 400, { error: problem, code: 'WEAK_PASSWORD' });
      return;
    }
    ctx.staffRepo.setPassword(user.id, body.newPassword);
    // Sign out every other session; keep the current one.
    for (const s of ctx.staffSessionRepo.listActiveForUser(user.id)) {
      if (s.id !== principal.sessionId) ctx.staffSessionRepo.revoke(s.id, 'password_changed');
    }
    audit(principal, 'STAFF_PASSWORD_CHANGED', user.id, {}, user.merchantId, req);
    HttpServer.json(res, 200, { success: true });
  });

  // ---------------------------------------------------------------------------------------
  // Team management
  // ---------------------------------------------------------------------------------------

  /** Loads a target user the principal may manage, or answers 404/403. */
  function loadManagedUser(principal, res, id) {
    const target = ctx.staffRepo.findById(id);
    // Out-of-scope users answer 404 so ids from other merchants cannot be probed.
    if (!target || (principal.merchantId && target.merchantId !== principal.merchantId)) {
      HttpServer.json(res, 404, { error: 'Team member not found.', code: 'NOT_FOUND' });
      return null;
    }
    if (target.role === StaffRole.PLATFORM_ADMIN && principal.role !== StaffRole.PLATFORM_ADMIN) {
      HttpServer.json(res, 403, { error: 'Only platform administrators can change a platform administrator.', code: 'FORBIDDEN' });
      return null;
    }
    return target;
  }

  function wouldRemoveLastPlatformAdmin(target, nextRole, nextStatus) {
    if (target.role !== StaffRole.PLATFORM_ADMIN || target.status !== 'ACTIVE') return false;
    const losesAdmin = (nextRole && nextRole !== StaffRole.PLATFORM_ADMIN) || nextStatus === 'DISABLED';
    return losesAdmin && ctx.staffRepo.countActiveByRole(StaffRole.PLATFORM_ADMIN) <= 1;
  }

  // GET /api/v1/staff/users
  server.get('/api/v1/staff/users', async (req, res) => {
    const principal = requireStaff(req, res, ctx, Permission.TEAM_VIEW);
    if (!principal) return;
    const users = principal.merchantId ? ctx.staffRepo.list(principal.merchantId) : ctx.staffRepo.list(undefined);
    HttpServer.json(res, 200, {
      users: users.map(publicStaffUser),
      roles: Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label })),
      assignableRoles: assignableRoles(principal.role)
    });
  });

  // POST /api/v1/staff/users  { email, fullName, role, merchantId? }
  // Returns a one-time temporary password; it is never stored or shown again.
  server.post('/api/v1/staff/users', async (req, res) => {
    const principal = requireStaff(req, res, ctx, Permission.TEAM_MANAGE);
    if (!principal) return;
    const body = await HttpServer.parseBody(req).catch(() => ({}));

    const email = normalizeEmail(body.email);
    const fullName = String(body.fullName || '').trim().slice(0, 120);
    const role = String(body.role || '');
    if (!email || !isValidEmail(email)) {
      HttpServer.json(res, 400, { error: 'Enter a valid email address.', code: 'VALIDATION_ERROR', field: 'email' });
      return;
    }
    if (!fullName) {
      HttpServer.json(res, 400, { error: 'Enter the person\'s name.', code: 'VALIDATION_ERROR', field: 'fullName' });
      return;
    }
    if (!assignableRoles(principal.role).includes(role)) {
      HttpServer.json(res, 403, { error: 'You cannot assign that role.', code: 'FORBIDDEN', field: 'role' });
      return;
    }

    let merchantId = null;
    if (role !== StaffRole.PLATFORM_ADMIN) {
      merchantId = principal.merchantId || body.merchantId || ctx.defaultMerchant?.id;
      if (principal.merchantId && body.merchantId && body.merchantId !== principal.merchantId) {
        HttpServer.json(res, 403, { error: 'You can only add people to your own merchant.', code: 'FORBIDDEN' });
        return;
      }
      if (!ctx.merchantRepo.findById(merchantId)) {
        HttpServer.json(res, 400, { error: 'Unknown merchant.', code: 'VALIDATION_ERROR', field: 'merchantId' });
        return;
      }
    }

    if (ctx.staffRepo.findByEmailWithSecret(email)) {
      HttpServer.json(res, 409, { error: 'A team member with this email already exists.', code: 'DUPLICATE' });
      return;
    }

    const temporaryPassword = newRandomPassword();
    const created = ctx.staffRepo.create({ email, fullName, role, password: temporaryPassword, merchantId, createdBy: principal.id });
    audit(principal, 'STAFF_USER_CREATED', created.id, { role, email }, merchantId, req);
    HttpServer.json(res, 201, { user: publicStaffUser(created), temporaryPassword });
  });

  // POST /api/v1/staff/users/:id  { fullName?, role?, status? }
  server.post('/api/v1/staff/users/:id', async (req, res, params) => {
    const principal = requireStaff(req, res, ctx, Permission.TEAM_MANAGE);
    if (!principal) return;
    const target = loadManagedUser(principal, res, params.id);
    if (!target) return;
    const body = await HttpServer.parseBody(req).catch(() => ({}));

    const changes = {};
    if (body.fullName !== undefined) changes.fullName = String(body.fullName).trim().slice(0, 120) || target.fullName;
    if (body.role !== undefined) {
      if (!assignableRoles(principal.role).includes(body.role)) {
        HttpServer.json(res, 403, { error: 'You cannot assign that role.', code: 'FORBIDDEN' });
        return;
      }
      if ((body.role === StaffRole.PLATFORM_ADMIN) !== (target.role === StaffRole.PLATFORM_ADMIN)) {
        HttpServer.json(res, 400, { error: 'Moving between platform and merchant scope is not supported. Create a new account instead.', code: 'SCOPE_CHANGE' });
        return;
      }
      changes.role = body.role;
    }
    if (body.status !== undefined) {
      if (!['ACTIVE', 'DISABLED'].includes(body.status)) {
        HttpServer.json(res, 400, { error: 'Status must be ACTIVE or DISABLED.', code: 'VALIDATION_ERROR' });
        return;
      }
      changes.status = body.status;
    }
    if (principal.kind === 'staff' && target.id === principal.id && (changes.status === 'DISABLED' || (changes.role && changes.role !== target.role))) {
      HttpServer.json(res, 400, { error: 'You cannot change your own role or disable yourself.', code: 'SELF_CHANGE' });
      return;
    }
    if (wouldRemoveLastPlatformAdmin(target, changes.role, changes.status)) {
      HttpServer.json(res, 400, { error: 'At least one active platform administrator must remain.', code: 'LAST_ADMIN' });
      return;
    }

    const updated = ctx.staffRepo.update(target.id, changes);
    if (changes.status === 'DISABLED' || (changes.role && changes.role !== target.role)) {
      ctx.staffSessionRepo.revokeAllForUser(target.id, changes.status === 'DISABLED' ? 'disabled' : 'role_changed');
    }
    audit(principal, 'STAFF_USER_UPDATED', target.id, { from: { role: target.role, status: target.status }, to: changes }, target.merchantId, req);
    HttpServer.json(res, 200, { user: publicStaffUser(updated) });
  });

  // POST /api/v1/staff/users/:id/reset-password -> one-time temporary password, all sessions revoked
  server.post('/api/v1/staff/users/:id/reset-password', async (req, res, params) => {
    const principal = requireStaff(req, res, ctx, Permission.TEAM_MANAGE);
    if (!principal) return;
    const target = loadManagedUser(principal, res, params.id);
    if (!target) return;
    const temporaryPassword = newRandomPassword();
    ctx.staffRepo.setPassword(target.id, temporaryPassword);
    const revoked = ctx.staffSessionRepo.revokeAllForUser(target.id, 'password_reset');
    audit(principal, 'STAFF_PASSWORD_RESET', target.id, { sessionsRevoked: revoked }, target.merchantId, req);
    HttpServer.json(res, 200, { temporaryPassword, sessionsRevoked: revoked });
  });

  // POST /api/v1/staff/users/:id/revoke-sessions
  server.post('/api/v1/staff/users/:id/revoke-sessions', async (req, res, params) => {
    const principal = requireStaff(req, res, ctx, Permission.TEAM_MANAGE);
    if (!principal) return;
    const target = loadManagedUser(principal, res, params.id);
    if (!target) return;
    const revoked = ctx.staffSessionRepo.revokeAllForUser(target.id, 'revoked_by_admin');
    audit(principal, 'STAFF_SESSIONS_REVOKED', target.id, { sessionsRevoked: revoked }, target.merchantId, req);
    HttpServer.json(res, 200, { sessionsRevoked: revoked });
  });
}
