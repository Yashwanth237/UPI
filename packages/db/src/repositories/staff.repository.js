import crypto from 'node:crypto';
import { isValidStaffRole, normalizeEmail } from '@youpi/common';

// scrypt cost: N=2^15, r=8, p=1 (~32 MiB, tens of ms). Parameters are stored with each hash so
// they can be raised later without invalidating existing passwords.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Hashes a staff password as `scrypt$N$r$p$saltB64$hashB64`. */
export function hashStaffPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Constant-time verification of a password against a stored scrypt hash. */
export function verifyStaffPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A hash computed once so a login for an unknown email costs the same as a real one. */
let dummyHash = null;
export function dummyStaffPasswordCheck(password) {
  if (!dummyHash) dummyHash = hashStaffPassword(crypto.randomBytes(16).toString('hex'));
  verifyStaffPassword(password, dummyHash);
  return false;
}

/** SHA-256 hex of an opaque token. Tokens are high-entropy, so a fast hash is appropriate. */
export function hashOpaqueToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export class StaffRepository {
  /** @param {import('../database.js').Database} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {{ email: string, fullName: string, role: string, password: string, merchantId?: string | null, createdBy?: string }} data
   */
  create(data) {
    const email = normalizeEmail(data.email);
    if (!email) throw new Error('A valid email is required.');
    if (!isValidStaffRole(data.role)) throw new Error(`Unknown staff role: ${data.role}`);
    if (data.role !== 'platform_admin' && !data.merchantId) throw new Error('Merchant-scoped roles require a merchantId.');
    if (data.role === 'platform_admin' && data.merchantId) throw new Error('platform_admin is not merchant-scoped.');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.execute(`
      INSERT INTO staff_users (id, merchant_id, email, full_name, role, password_hash, status, password_changed_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
    `, [id, data.merchantId || null, email, String(data.fullName || '').trim(), data.role, hashStaffPassword(data.password), now, data.createdBy || null, now, now]);
    return this.findById(id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM staff_users WHERE id = ?', [id]);
    return row ? this.mapRow(row) : null;
  }

  /** Includes the password hash; only the authentication path should call this. */
  findByEmailWithSecret(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = this.db.queryOne('SELECT * FROM staff_users WHERE email = ?', [normalized]);
    return row ? { ...this.mapRow(row), passwordHash: row.password_hash } : null;
  }

  /** @param {string | null | undefined} merchantId undefined = all (platform view) */
  list(merchantId) {
    const rows = merchantId === undefined
      ? this.db.query('SELECT * FROM staff_users ORDER BY created_at ASC')
      : this.db.query('SELECT * FROM staff_users WHERE merchant_id IS ? ORDER BY created_at ASC', [merchantId]);
    return rows.map(r => this.mapRow(r));
  }

  count() {
    return Number(this.db.queryOne('SELECT COUNT(*) AS n FROM staff_users')?.n || 0);
  }

  countActiveByRole(role) {
    return Number(this.db.queryOne("SELECT COUNT(*) AS n FROM staff_users WHERE role = ? AND status = 'ACTIVE'", [role])?.n || 0);
  }

  update(id, { fullName, role, status }) {
    const current = this.findById(id);
    if (!current) return null;
    if (role !== undefined && !isValidStaffRole(role)) throw new Error(`Unknown staff role: ${role}`);
    if (status !== undefined && !['ACTIVE', 'DISABLED'].includes(status)) throw new Error(`Unknown status: ${status}`);
    this.db.execute(`
      UPDATE staff_users SET full_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?
    `, [fullName ?? current.fullName, role ?? current.role, status ?? current.status, new Date().toISOString(), id]);
    return this.findById(id);
  }

  setPassword(id, password) {
    const now = new Date().toISOString();
    this.db.execute(`
      UPDATE staff_users SET password_hash = ?, password_changed_at = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?
    `, [hashStaffPassword(password), now, now, id]);
  }

  /**
   * Records a failed login and locks the account after `maxFailures` consecutive failures.
   * @returns {{ failedCount: number, lockedUntil: Date | null }}
   */
  recordFailedLogin(id, { maxFailures = 5, lockMs = 15 * 60 * 1000 } = {}) {
    return this.db.transaction(() => {
      const row = this.db.queryOne('SELECT failed_login_count FROM staff_users WHERE id = ?', [id]);
      const failedCount = Number(row?.failed_login_count || 0) + 1;
      const lockedUntil = failedCount >= maxFailures ? new Date(Date.now() + lockMs) : null;
      this.db.execute('UPDATE staff_users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?', [
        lockedUntil ? 0 : failedCount,
        lockedUntil ? lockedUntil.toISOString() : null,
        new Date().toISOString(),
        id
      ]);
      return { failedCount, lockedUntil };
    });
  }

  recordSuccessfulLogin(id) {
    const now = new Date().toISOString();
    this.db.execute('UPDATE staff_users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id || null,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      status: row.status,
      failedLoginCount: Number(row.failed_login_count || 0),
      lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
      passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at) : null,
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
      createdBy: row.created_by || null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}

export class StaffSessionRepository {
  /** @param {import('../database.js').Database} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates a session and returns the raw tokens exactly once; only hashes are stored.
   * @returns {{ session: any, token: string, csrfToken: string }}
   */
  create(staffUserId, { ttlMs = 8 * 60 * 60 * 1000, ipAddress = null, userAgent = null } = {}) {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    this.db.execute(`
      INSERT INTO staff_sessions (id, staff_user_id, token_hash, csrf_token_hash, ip_address, user_agent, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, staffUserId, hashOpaqueToken(token), hashOpaqueToken(csrfToken), ipAddress, userAgent ? String(userAgent).slice(0, 512) : null, now.toISOString(), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()]);
    return { session: this.findById(id), token, csrfToken };
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM staff_sessions WHERE id = ?', [id]);
    return row ? this.mapRow(row) : null;
  }

  /** Returns the live (unrevoked, unexpired) session for a raw token, or null. */
  findActiveByToken(token) {
    if (!token) return null;
    const row = this.db.queryOne('SELECT * FROM staff_sessions WHERE token_hash = ? AND revoked_at IS NULL', [hashOpaqueToken(token)]);
    if (!row) return null;
    const session = this.mapRow(row);
    if (session.expiresAt.getTime() <= Date.now()) return null;
    return session;
  }

  /** Sliding idle timeout: extends expiry up to `absoluteMaxMs` after creation. */
  touch(id, { idleMs = 8 * 60 * 60 * 1000, absoluteMaxMs = 24 * 60 * 60 * 1000 } = {}) {
    const session = this.findById(id);
    if (!session) return;
    const now = Date.now();
    const expires = Math.min(now + idleMs, session.createdAt.getTime() + absoluteMaxMs);
    this.db.execute('UPDATE staff_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [new Date(now).toISOString(), new Date(expires).toISOString(), id]);
  }

  revoke(id, reason = 'logout') {
    this.db.execute('UPDATE staff_sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL', [new Date().toISOString(), reason, id]);
  }

  revokeAllForUser(staffUserId, reason = 'revoked') {
    const res = this.db.execute('UPDATE staff_sessions SET revoked_at = ?, revoke_reason = ? WHERE staff_user_id = ? AND revoked_at IS NULL', [new Date().toISOString(), reason, staffUserId]);
    return Number(res.changes || 0);
  }

  listActiveForUser(staffUserId) {
    const rows = this.db.query("SELECT * FROM staff_sessions WHERE staff_user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC", [staffUserId, new Date().toISOString()]);
    return rows.map(r => this.mapRow(r));
  }

  mapRow(row) {
    return {
      id: row.id,
      staffUserId: row.staff_user_id,
      csrfTokenHash: row.csrf_token_hash,
      ipAddress: row.ip_address || null,
      userAgent: row.user_agent || null,
      createdAt: new Date(row.created_at),
      lastSeenAt: new Date(row.last_seen_at),
      expiresAt: new Date(row.expires_at),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null
    };
  }
}
