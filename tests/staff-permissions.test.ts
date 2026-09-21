import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  hasPermission,
  piiTierFor,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
} from '../src/modules/staff/permissions.js';

describe('staff permissions matrix', () => {
  it('contains exactly ADMIN, MANAGER and COMPLIANCE', () => {
    expect(STAFF_ROLES).toEqual(['ADMIN', 'MANAGER', 'COMPLIANCE']);
    expect(ALL_PERMISSIONS).toContain('case.detail.read_pii_raw');
  });

  it('grants every permission to ADMIN', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(hasPermission('ADMIN', permission)).toBe(true);
    }
  });

  /**
   * Permissions that deliberately do not belong to the operations role. Adding a
   * permission to `ALL_PERMISSIONS` without deciding who holds it fails here,
   * which is the point: nobody should inherit a new capability by accident,
   * least of all one that can tell a consumer to destroy a product.
   */
  const NOT_GRANTED_TO_MANAGER: readonly string[] = [
    'staff.manage',
    'review.close',
    'disposal.review',
    'disposal.hold.manage',
    'disposal.instructions.publish',
  ];

  it('grants MANAGER the business permissions, but never a safety sign-off', () => {
    for (const permission of ALL_PERMISSIONS) {
      const expected = !NOT_GRANTED_TO_MANAGER.includes(permission);
      expect(hasPermission('MANAGER', permission)).toBe(expected);
    }
    expect(hasPermission('MANAGER', 'staff.read')).toBe(true);
    expect(hasPermission('MANAGER', 'staff.manage')).toBe(false);
  });

  /**
   * `ALL_PERMISSIONS` is declared by hand, so a permission added only to a role
   * set would silently escape the loops above. This closes that gap for every
   * role, not just MANAGER.
   */
  it('lists every permission it grants to any role', () => {
    const declared = new Set<string>(ALL_PERMISSIONS);
    for (const role of STAFF_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(declared.has(permission)).toBe(true);
      }
    }
    const granted = new Set(STAFF_ROLES.flatMap((role) => [...ROLE_PERMISSIONS[role]]));
    expect([...granted].sort()).toEqual([...declared].sort());
  });

  it('keeps reportability sign-off off the operations role (separation of duties)', () => {
    // The whole point of the COMPLIANCE role: whoever moves a case through its
    // workflow must not also sign off the safety review behind it.
    expect(hasPermission('MANAGER', 'review.close')).toBe(false);
    expect(hasPermission('COMPLIANCE', 'review.close')).toBe(true);
    expect(hasPermission('ADMIN', 'review.close')).toBe(true);
  });

  it('gives COMPLIANCE read and sign-off, but no case-driving powers', () => {
    expect(hasPermission('COMPLIANCE', 'case.queue.read')).toBe(true);
    expect(hasPermission('COMPLIANCE', 'case.detail.read')).toBe(true);
    expect(hasPermission('COMPLIANCE', 'case.detail.read_pii_raw')).toBe(true);
    expect(hasPermission('COMPLIANCE', 'audit.read')).toBe(true);

    expect(hasPermission('COMPLIANCE', 'case.status.transition')).toBe(false);
    expect(hasPermission('COMPLIANCE', 'case.assign')).toBe(false);
    expect(hasPermission('COMPLIANCE', 'case.export')).toBe(false);
    expect(hasPermission('COMPLIANCE', 'campaign.publish')).toBe(false);
    expect(hasPermission('COMPLIANCE', 'staff.manage')).toBe(false);
  });

  it('keeps consumer-disposal decisions on the safety role', () => {
    for (const permission of [
      'disposal.review',
      'disposal.hold.manage',
      'disposal.instructions.publish',
    ] as const) {
      expect(hasPermission('COMPLIANCE', permission)).toBe(true);
      expect(hasPermission('ADMIN', permission)).toBe(true);
      expect(hasPermission('MANAGER', permission)).toBe(false);
    }
  });

  /**
   * A hold exists to stop a disposal that is already approved. If the role that
   * places it also cannot release it, the task is stuck; if operations can
   * release it, the hold is advisory. Both matter, so both are asserted.
   */
  it('lets the holder of disposal.review also release a hold', () => {
    expect(hasPermission('COMPLIANCE', 'disposal.hold.manage')).toBe(true);
    expect(hasPermission('COMPLIANCE', 'disposal.review')).toBe(true);
  });

  it('exposes a stable role-to-permission map', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(['ADMIN', 'COMPLIANCE', 'MANAGER']);
  });

  describe('piiTierFor', () => {
    it('returns raw for every role that works or reviews a case', () => {
      expect(piiTierFor('MANAGER')).toBe('raw');
      expect(piiTierFor('ADMIN')).toBe('raw');
      expect(piiTierFor('COMPLIANCE')).toBe('raw');
    });
  });
});
