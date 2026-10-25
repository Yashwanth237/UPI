/**
 * Staff roles and permissions.
 *
 * Every permission is checked server-side. Merchant-scoped roles can only ever act on their
 * own merchant's data; `platform_admin` is the only cross-merchant role.
 *
 * There is deliberately NO permission that marks a payment SUCCESS: that outcome is produced
 * exclusively by the verification engine from bank evidence.
 */

export const StaffRole = Object.freeze({
  PLATFORM_ADMIN: 'platform_admin',
  MERCHANT_ADMIN: 'merchant_admin',
  CASHIER: 'cashier',
  SUPPORT: 'support',
  DEVELOPER: 'developer',
  VIEWER: 'viewer'
});

export const Permission = Object.freeze({
  DASHBOARD_VIEW: 'dashboard:view',
  PAYMENTS_VIEW: 'payments:view',
  PAYMENTS_EXPORT: 'payments:export',
  PAYMENTS_CANCEL: 'payments:cancel',
  OPERATIONS_VIEW: 'operations:view',
  WEBHOOKS_VIEW: 'webhooks:view',
  WEBHOOKS_RETRY: 'webhooks:retry',
  SUPPORT_VIEW: 'support:view',
  SUPPORT_RESPOND: 'support:respond',
  AUDIT_VIEW: 'audit:view',
  TEAM_VIEW: 'team:view',
  TEAM_MANAGE: 'team:manage',
  SETTINGS_VIEW: 'settings:view',
  SYSTEM_VIEW: 'system:view',
  MERCHANTS_MANAGE: 'merchants:manage',
  // Access to the legacy admin API (/api/v1/admin/*), which is not merchant-scoped.
  LEGACY_ADMIN: 'legacy:admin'
});

const P = Permission;

export const ROLE_PERMISSIONS = Object.freeze({
  [StaffRole.PLATFORM_ADMIN]: Object.freeze(Object.values(P)),
  [StaffRole.MERCHANT_ADMIN]: Object.freeze([
    P.DASHBOARD_VIEW, P.PAYMENTS_VIEW, P.PAYMENTS_EXPORT, P.PAYMENTS_CANCEL, P.OPERATIONS_VIEW,
    P.WEBHOOKS_VIEW, P.WEBHOOKS_RETRY, P.SUPPORT_VIEW, P.SUPPORT_RESPOND, P.AUDIT_VIEW,
    P.TEAM_VIEW, P.TEAM_MANAGE, P.SETTINGS_VIEW
  ]),
  [StaffRole.CASHIER]: Object.freeze([
    P.DASHBOARD_VIEW, P.PAYMENTS_VIEW, P.PAYMENTS_CANCEL, P.OPERATIONS_VIEW
  ]),
  [StaffRole.SUPPORT]: Object.freeze([
    P.DASHBOARD_VIEW, P.PAYMENTS_VIEW, P.SUPPORT_VIEW, P.SUPPORT_RESPOND, P.AUDIT_VIEW
  ]),
  [StaffRole.DEVELOPER]: Object.freeze([
    P.DASHBOARD_VIEW, P.PAYMENTS_VIEW, P.WEBHOOKS_VIEW, P.WEBHOOKS_RETRY, P.SETTINGS_VIEW
  ]),
  [StaffRole.VIEWER]: Object.freeze([
    P.DASHBOARD_VIEW, P.PAYMENTS_VIEW
  ])
});

export const ROLE_LABELS = Object.freeze({
  [StaffRole.PLATFORM_ADMIN]: 'Platform administrator',
  [StaffRole.MERCHANT_ADMIN]: 'Merchant administrator',
  [StaffRole.CASHIER]: 'Cashier',
  [StaffRole.SUPPORT]: 'Support',
  [StaffRole.DEVELOPER]: 'Developer',
  [StaffRole.VIEWER]: 'Viewer'
});

export function isValidStaffRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role);
}

export function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

export function roleHasPermission(role, permission) {
  return permissionsForRole(role).includes(permission);
}

/**
 * Roles a given actor may assign. Only platform admins create platform admins; merchant
 * admins manage merchant-scoped roles. Nobody else assigns roles.
 */
export function assignableRoles(actorRole) {
  if (actorRole === StaffRole.PLATFORM_ADMIN) return Object.values(StaffRole);
  if (actorRole === StaffRole.MERCHANT_ADMIN) {
    return [StaffRole.MERCHANT_ADMIN, StaffRole.CASHIER, StaffRole.SUPPORT, StaffRole.DEVELOPER, StaffRole.VIEWER];
  }
  return [];
}

/** Staff password policy: length beats composition rules (NIST SP 800-63B). */
export function validateStaffPassword(password) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < 12) return 'Password must be at least 12 characters.';
  if (value.length > 256) return 'Password must be at most 256 characters.';
  if (/^(.)\1+$/.test(value)) return 'Password must not be a single repeated character.';
  return null;
}
