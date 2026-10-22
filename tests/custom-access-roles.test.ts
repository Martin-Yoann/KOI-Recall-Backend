import { describe, expect, it } from 'vitest';
import {
  accessPolicySchema,
  accessRoleIdsSchema,
  defaultAccessPolicy,
  effectivePermissions,
} from '../src/modules/staff/access-policy.js';
import { ALL_PERMISSIONS } from '../src/modules/staff/permissions.js';

describe('custom role definitions and effective permissions', () => {
  it('accepts named roles with descriptions and rejects undeclared capabilities', () => {
    const policy = defaultAccessPolicy();
    policy.roles.role_support = {
      name: 'Customer support',
      description: 'Works recall cases.',
      permissions: ['case.queue.read'],
    };
    expect(accessPolicySchema.parse(policy).roles.role_support?.description).toBe(
      'Works recall cases.',
    );
    policy.roles.role_support.permissions.push('invented.permission' as never);
    expect(accessPolicySchema.safeParse(policy).success).toBe(false);
  });

  it('keeps built-in fallback roles and reserves the Owner identity', () => {
    const policy = defaultAccessPolicy();
    delete (policy.roles as Record<string, unknown>).ADMIN;
    expect(accessPolicySchema.safeParse(policy).success).toBe(false);
    const duplicate = defaultAccessPolicy();
    duplicate.roles.role_support = { name: 'Manager', permissions: [] };
    expect(accessPolicySchema.safeParse(duplicate).success).toBe(false);
    duplicate.roles.role_support.name = 'Owner';
    expect(accessPolicySchema.safeParse(duplicate).success).toBe(false);
    duplicate.roles.role_support.name = 'Custom';
    expect(accessPolicySchema.safeParse(duplicate).success).toBe(true);
  });

  it('combines assigned roles, removes duplicates, and treats empty assignments as no access', () => {
    const policy = defaultAccessPolicy();
    policy.roles.role_support = {
      name: 'Support',
      permissions: ['case.queue.read', 'case.detail.read'],
    };
    policy.roles.role_audit = { name: 'Auditor', permissions: ['case.detail.read', 'audit.read'] };
    expect(effectivePermissions(policy, 'ADMIN', false, ['role_support', 'role_audit'])).toEqual([
      'case.queue.read',
      'case.detail.read',
      'audit.read',
    ]);
    expect(effectivePermissions(policy, 'ADMIN', false, [])).toEqual([]);
    expect(effectivePermissions(policy, 'ADMIN', false, ['role_missing'])).toEqual([]);
    expect(effectivePermissions(policy, 'MANAGER', false, null)).toEqual(
      policy.roles.MANAGER.permissions,
    );
    expect(effectivePermissions(policy, 'MANAGER', true, [])).toEqual(ALL_PERMISSIONS);
  });

  it('bounds role assignments and rejects duplicates or unsafe identifiers', () => {
    expect(accessRoleIdsSchema.safeParse(['role_support', 'role_support']).success).toBe(false);
    expect(accessRoleIdsSchema.safeParse(['__proto__']).success).toBe(false);
    expect(
      accessRoleIdsSchema.safeParse(Array.from({ length: 21 }, (_, i) => `role_${i}`)).success,
    ).toBe(false);
    expect(accessRoleIdsSchema.safeParse([]).success).toBe(true);
  });
});
