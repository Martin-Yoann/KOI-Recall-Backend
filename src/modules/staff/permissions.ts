/**
 * Fixed-role RBAC for the internal-operations (B-end) surface (ADR-0004 §2.2).
 *
 * Roles are a closed enum; the role→permission mapping is hardcoded and not
 * configurable at runtime. Permissions are `resource:action` verbs. The
 * ADMIN and MANAGER both manage business data; only ADMIN manages staff accounts.
 */

export type StaffRole = 'ADMIN' | 'MANAGER';

export type Permission =
  | 'case.queue.read'
  | 'case.detail.read'
  | 'case.detail.read_pii_raw'
  | 'case.export'
  | 'case.assign'
  | 'case.status.transition'
  | 'review.close'
  | 'audit.read'
  | 'staff.read'
  | 'staff.manage';

/** Both roles can manage business data; only ADMIN can manage staff accounts. */
const MANAGER: ReadonlySet<Permission> = new Set([
  'case.queue.read',
  'case.detail.read',
  'case.detail.read_pii_raw',
  'case.export',
  'case.assign',
  'case.status.transition',
  'review.close',
  'audit.read',
  'staff.read',
]);
const ADMIN: ReadonlySet<Permission> = new Set<Permission>([...MANAGER, 'staff.manage']);

export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, ReadonlySet<Permission>>> = {
  ADMIN,
  MANAGER,
};

/** All permissions, for exhaustive test coverage. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'case.queue.read',
  'case.detail.read',
  'case.detail.read_pii_raw',
  'case.export',
  'case.assign',
  'case.status.transition',
  'review.close',
  'audit.read',
  'staff.read',
  'staff.manage',
];

export const STAFF_ROLES: readonly StaffRole[] = ['ADMIN', 'MANAGER'];

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * The PII visibility tier a role sees on case detail. Both current roles have
 * the raw-PII permission, and every raw read is still audited by the route.
 */
export function piiTierFor(role: StaffRole): 'raw' | 'masked' {
  return hasPermission(role, 'case.detail.read_pii_raw') ? 'raw' : 'masked';
}
