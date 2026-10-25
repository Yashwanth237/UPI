import crypto from 'node:crypto';
import { getAdminToken, safeEqual, permissionsForRole, roleHasPermission, StaffRole } from '@youpi/common';
import { hashOpaqueToken } from '@youpi/db';
import { HttpServer } from './server.js';

/**
 * Staff authentication for the operations console and (optionally) the legacy admin API.
 *
 * Credentials accepted, in order:
 *  1. `Authorization: Bearer <ADMIN_API_TOKEN>`: the machine / break-glass credential. It acts
 *     as a platform administrator ("system") so existing integrations keep working.
 *  2. The `youpi_staff` session cookie (HttpOnly, SameSite=Strict). State-changing requests
 *     authenticated by cookie must also carry `X-CSRF-Token` equal to the `youpi_staff_csrf`
 *     cookie (double-submit), which is verified against the hash stored with the session.
 */

export const STAFF_SESSION_COOKIE = 'youpi_staff';
export const STAFF_CSRF_COOKIE = 'youpi_staff_csrf';
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(req, name) {
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function isSecureContext(req) {
  return process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
}

export function buildStaffCookies(req, { token, csrfToken, maxAgeSeconds }) {
  const secure = isSecureContext(req) ? '; Secure' : '';
  return [
    `${STAFF_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure}`,
    // Readable by the console script so it can echo it in X-CSRF-Token.
    `${STAFF_CSRF_COOKIE}=${csrfToken}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Strict${secure}`
  ];
}

export function clearStaffCookies(req) {
  const secure = isSecureContext(req) ? '; Secure' : '';
  return [
    `${STAFF_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
    `${STAFF_CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`
  ];
}

export function clientIp(req) {
  // Only trust X-Forwarded-For from a co-located proxy (the merchant-admin relay / tunnel).
  const remote = req.socket?.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = isLoopback ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return (forwarded || remote || 'unknown').slice(0, 45);
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
  return match ? match[1].trim() : '';
}

/** The principal used when the admin API token is presented. */
function systemPrincipal() {
  return {
    kind: 'system',
    id: 'system:admin-token',
    email: null,
    fullName: 'System (admin API token)',
    role: StaffRole.PLATFORM_ADMIN,
    merchantId: null,
    permissions: permissionsForRole(StaffRole.PLATFORM_ADMIN),
    sessionId: null
  };
}

/**
 * Resolves the authenticated staff principal, or null.
 * @param {any} req
 * @param {{ staffRepo: any, staffSessionRepo: any }} ctx
 * @param {{ touch?: boolean }} [opts]
 */
export function resolveStaffPrincipal(req, ctx, opts = {}) {
  const presented = bearerToken(req);
  if (presented && safeEqual(presented, getAdminToken())) {
    return systemPrincipal();
  }

  const token = readCookie(req, STAFF_SESSION_COOKIE);
  if (!token || !ctx.staffSessionRepo) return null;
  const session = ctx.staffSessionRepo.findActiveByToken(token);
  if (!session) return null;
  const user = ctx.staffRepo.findById(session.staffUserId);
  if (!user || user.status !== 'ACTIVE') return null;

  if (opts.touch !== false) {
    ctx.staffSessionRepo.touch(session.id, { idleMs: SESSION_IDLE_MS, absoluteMaxMs: SESSION_ABSOLUTE_MS });
  }

  return {
    kind: 'staff',
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    merchantId: user.merchantId,
    permissions: permissionsForRole(user.role),
    sessionId: session.id,
    csrfTokenHash: session.csrfTokenHash
  };
}

/** Double-submit CSRF check for cookie-authenticated, state-changing requests. */
export function verifyCsrf(req, principal) {
  if (SAFE_METHODS.has(String(req.method).toUpperCase())) return true;
  if (principal.kind === 'system') return true; // bearer header: not sent automatically by browsers
  const header = String(req.headers['x-csrf-token'] || '');
  const cookie = readCookie(req, STAFF_CSRF_COOKIE) || '';
  if (!header || !cookie || !safeEqual(header, cookie)) return false;
  return safeEqual(hashOpaqueToken(header), principal.csrfTokenHash);
}

/**
 * Route helper: authenticates, checks CSRF and one permission. Sends the error response and
 * returns null when the request must stop.
 */
export function requireStaff(req, res, ctx, permission) {
  const principal = resolveStaffPrincipal(req, ctx);
  if (!principal) {
    HttpServer.json(res, 401, { error: 'Sign in required.', code: 'AUTH_REQUIRED' });
    return null;
  }
  if (!verifyCsrf(req, principal)) {
    HttpServer.json(res, 403, { error: 'Security token missing or invalid. Reload the page and try again.', code: 'CSRF_FAILED' });
    return null;
  }
  if (permission && !roleHasPermission(principal.role, permission)) {
    HttpServer.json(res, 403, { error: 'You do not have permission to do this.', code: 'FORBIDDEN', permission });
    return null;
  }
  return principal;
}

/**
 * Merchant the request acts on. Merchant-scoped staff are pinned to their own merchant;
 * a requested other merchant is refused rather than silently replaced.
 * @returns {{ merchantId: string } | { error: number, message: string }}
 */
export function resolveMerchantScope(principal, requestedMerchantId, defaultMerchantId) {
  if (principal.merchantId) {
    if (requestedMerchantId && requestedMerchantId !== principal.merchantId) {
      return { error: 403, message: 'You can only access your own merchant.' };
    }
    return { merchantId: principal.merchantId };
  }
  return { merchantId: requestedMerchantId || defaultMerchantId };
}

/** Fixed-window login limiter per client IP. */
export class LoginRateLimiter {
  constructor({ limit = 10, windowMs = 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** @returns {boolean} true when the attempt is allowed */
  attempt(key) {
    const now = Date.now();
    if (this.hits.size > 10000) this.hits.clear();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

/** Public shape of a staff user (never includes secrets). */
export function publicStaffUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    merchantId: user.merchantId,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    lockedUntil: user.lockedUntil && user.lockedUntil.getTime() > Date.now() ? user.lockedUntil : null,
    createdAt: user.createdAt
  };
}

export function newRandomPassword() {
  // 18 random bytes -> 24 base64url characters (~144 bits).
  return crypto.randomBytes(18).toString('base64url');
}
