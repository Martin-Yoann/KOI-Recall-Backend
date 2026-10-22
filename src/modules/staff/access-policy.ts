import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
  type Permission,
  type StaffRole,
} from './permissions.js';

export const OWNER_EMAIL = 'admin@koi-platform.com';

export const PERMISSION_NAMES: Record<Permission, string> = {
  'case.queue.read': 'View case queues',
  'case.detail.read': 'View case details',
  'case.detail.read_pii_raw': 'View raw PII',
  'case.export': 'Export cases & refunds',
  'case.assign': 'Assign cases',
  'case.status.transition': 'Transition & resolve cases',
  'campaign.publish': 'Publish campaigns',
  'review.close': 'Close reportability reviews',
  'disposal.review': 'Accept disposal evidence',
  'disposal.hold.manage': 'Place & release evidence holds',
  'disposal.instructions.publish': 'Publish disposal instructions',
  'audit.read': 'Read audit events',
  'staff.read': 'View staff directory',
  'staff.manage': 'Manage staff',
};

export const accessRoleIdSchema = z
  .string()
  .regex(/^(ADMIN|MANAGER|COMPLIANCE|role_[a-z0-9-]{1,64})$/);
export const accessRoleIdsSchema = z
  .array(accessRoleIdSchema)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate role');

const rolePolicy = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(255).optional(),
    permissions: z
      .array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]))
      .max(ALL_PERMISSIONS.length)
      .refine((values) => new Set(values).size === values.length, 'Duplicate permission'),
  })
  .strict();

export const accessPolicySchema = z
  .object({
    roles: z
      .record(accessRoleIdSchema, rolePolicy)
      .refine(
        (roles) => STAFF_ROLES.every((id) => Object.hasOwn(roles, id)),
        'Built-in roles must be retained',
      )
      .refine((roles) => Object.keys(roles).length <= 100, 'At most 100 roles are supported')
      .refine((roles) => {
        const names = Object.values(roles).map((role) => role.name.toLowerCase());
        return new Set(names).size === names.length && !names.includes('owner');
      }, 'Role names must be unique')
      .transform((roles) => roles as typeof roles & Record<StaffRole, z.infer<typeof rolePolicy>>),
    permissionNames: z.record(
      z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]),
      z.string().trim().min(1).max(100),
    ),
  })
  .strict();

export type AccessPolicy = z.infer<typeof accessPolicySchema>;
export interface AccessPolicySnapshot extends AccessPolicy {
  revision: number;
}

/** Defaults seed a new database; live authorization reads the persisted policy. */
export function defaultAccessPolicy(): AccessPolicy {
  const names: Record<StaffRole, string> = {
    ADMIN: 'Admin',
    MANAGER: 'Manager',
    COMPLIANCE: 'Compliance',
  };
  return {
    roles: Object.fromEntries(
      STAFF_ROLES.map((role) => [
        role,
        {
          name: names[role],
          permissions: [...ROLE_PERMISSIONS[role]],
        },
      ]),
    ) as AccessPolicy['roles'],
    permissionNames: { ...PERMISSION_NAMES },
  };
}

export function effectivePermissions(
  policy: AccessPolicy,
  role: StaffRole,
  isOwner: boolean,
  accessRoleIds?: readonly string[] | null,
): Permission[] {
  if (isOwner) return [...ALL_PERMISSIONS];
  const ids = accessRoleIds ?? [role];
  // An unknown/deleted role never falls back to a more privileged legacy role.
  return [
    ...new Set(
      ids.flatMap((id) => (Object.hasOwn(policy.roles, id) ? policy.roles[id]!.permissions : [])),
    ),
  ];
}
