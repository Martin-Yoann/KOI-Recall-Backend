/**
 * Fixed-role RBAC for the internal-operations (B-end) surface (ADR-0004 §2.2).
 *
 * Roles are a closed enum; the role→permission mapping is hardcoded and not
 * configurable at runtime. Permissions are `resource:action` verbs. The
 * critical invariant: `case.detail.read_pii_raw` is NOT implied by
 * `case.detail.read` — a reviewer can see case detail with masked PII only.
 */

export type StaffRole = 'viewer' | 'reviewer' | 'compliance' | 'administrator';

export type Permission =
  | 'case.queue.read'
  | 'case.detail.read'
  | 'case.detail.read_pii_raw'
  | 'case.export'
  | 'case.assign'
  | 'case.status.transition'
  | 'review.close'
  | 'audit.read'
  | 'staff.manage';

const VIEWER: ReadonlySet<Permission> = new Set(['case.queue.read', 'case.detail.read']);
const REVIEWER: ReadonlySet<Permission> = new Set([
  'case.queue.read',
  'case.detail.read',
  'case.assign',
  'case.status.transition',
]);
const COMPLIANCE: ReadonlySet<Permission> = new Set([
  'case.queue.read',
  'case.detail.read',
  'case.detail.read_pii_raw',
  'case.export',
  'case.assign',
  'case.status.transition',
  'review.close',
]);
const ADMINISTRATOR: ReadonlySet<Permission> = new Set<Permission>([
  'case.queue.read',
  'case.detail.read',
  'case.detail.read_pii_raw',
  'case.export',
  'case.assign',
  'case.status.transition',
  'review.close',
  'audit.read',
  'staff.manage',
]);

export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, ReadonlySet<Permission>>> = {
  viewer: VIEWER,
  reviewer: REVIEWER,
  compliance: COMPLIANCE,
  administrator: ADMINISTRATOR,
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
  'staff.manage',
];

export const STAFF_ROLES: readonly StaffRole[] = [
  'viewer',
  'reviewer',
  'compliance',
  'administrator',
];

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * The PII visibility tier a role sees on case detail: `raw` only when the role
 * carries `case.detail.read_pii_raw`, otherwise `masked`. This is the two-tier
 * PII decision (ADR-0004 §2.3) centralized in one place.
 */
export function piiTierFor(role: StaffRole): 'raw' | 'masked' {
  return hasPermission(role, 'case.detail.read_pii_raw') ? 'raw' : 'masked';
}
