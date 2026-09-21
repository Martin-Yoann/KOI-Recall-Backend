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

  it('grants MANAGER the business permissions, but not staff or review sign-off', () => {
    for (const permission of ALL_PERMISSIONS) {
      const expected = permission !== 'staff.manage' && permission !== 'review.close';
      expect(hasPermission('MANAGER', permission)).toBe(expected);
    }
    expect(hasPermission('MANAGER', 'staff.read')).toBe(true);
    expect(hasPermission('MANAGER', 'staff.manage')).toBe(false);
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
