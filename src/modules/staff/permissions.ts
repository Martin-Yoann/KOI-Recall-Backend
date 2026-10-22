/** Permission identifiers and initial role grants. Runtime requests use the database access policy. */

export type StaffRole = 'ADMIN' | 'MANAGER' | 'COMPLIANCE';

export type Permission =
  | 'case.queue.read'
  | 'case.detail.read'
  | 'case.detail.read_pii_raw'
  | 'case.export'
  | 'case.assign'
  | 'case.status.transition'
  | 'campaign.publish'
  | 'review.close'
  | 'disposal.review'
  | 'disposal.hold.manage'
  | 'disposal.instructions.publish'
  | 'audit.read'
  | 'staff.read'
  | 'staff.manage';

/** Read access every internal role needs to work a case at all. */
const CASE_READ: readonly Permission[] = ['case.queue.read', 'case.detail.read'];

/** Operations: works cases through their lifecycle. */
const MANAGER: ReadonlySet<Permission> = new Set<Permission>([
  ...CASE_READ,
  // Injury detail is the substance of a case, and every raw read is audited
  // (`pii.view_raw`), so the tier that works cases holds it.
  'case.detail.read_pii_raw',
  'case.export',
  'case.assign',
  'case.status.transition',
  // Publishing a recall notice is business data, not staff administration.
  'campaign.publish',
  'audit.read',
  'staff.read',
]);

/**
 * Safety oversight: decides whether an incident is reportable, and whether a
 * consumer may be told to dispose of the product. Needs to read the case and its
 * injury detail (that is the evidence for both decisions) and to see the audit
 * trail, but must not move cases through the workflow itself.
 */
const COMPLIANCE: ReadonlySet<Permission> = new Set<Permission>([
  ...CASE_READ,
  'case.detail.read_pii_raw',
  'review.close',
  // Accepting photo evidence and releasing an evidence-retention hold.
  'disposal.review',
  'disposal.hold.manage',
  // Publishing the instructions a consumer will follow. An outward-facing
  // content act, gated on a recorded approval.
  'disposal.instructions.publish',
  'audit.read',
  'staff.read',
]);

const ADMIN: ReadonlySet<Permission> = new Set<Permission>([
  ...MANAGER,
  ...COMPLIANCE,
  'staff.manage',
]);

export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, ReadonlySet<Permission>>> = {
  ADMIN,
  MANAGER,
  COMPLIANCE,
};

/** All permissions, for exhaustive test coverage. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'case.queue.read',
  'case.detail.read',
  'case.detail.read_pii_raw',
  'case.export',
  'case.assign',
  'case.status.transition',
  'campaign.publish',
  'review.close',
  'disposal.review',
  'disposal.hold.manage',
  'disposal.instructions.publish',
  'audit.read',
  'staff.read',
  'staff.manage',
];

export const STAFF_ROLES: readonly StaffRole[] = ['ADMIN', 'MANAGER', 'COMPLIANCE'];

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * The PII visibility tier a role sees on case detail. Every role that works or
 * reviews a case holds the raw-PII permission, and every raw read is still
 * audited by the route.
 */
export function piiTierFor(role: StaffRole): 'raw' | 'masked' {
  return hasPermission(role, 'case.detail.read_pii_raw') ? 'raw' : 'masked';
}
