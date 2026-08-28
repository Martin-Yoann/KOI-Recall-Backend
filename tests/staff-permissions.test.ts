import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  hasPermission,
  piiTierFor,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
} from '../src/modules/staff/permissions.js';

describe('staff permissions matrix', () => {
  it('contains exactly ADMIN and MANAGER', () => {
    expect(STAFF_ROLES).toEqual(['ADMIN', 'MANAGER']);
    expect(ALL_PERMISSIONS).toContain('case.detail.read_pii_raw');
  });

  it('grants every permission to ADMIN', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(hasPermission('ADMIN', permission)).toBe(true);
    }
  });

  it('grants MANAGER business permissions and staff read access, but not mutations', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(hasPermission('MANAGER', permission)).toBe(permission !== 'staff.manage');
    }
    expect(hasPermission('MANAGER', 'staff.read')).toBe(true);
    expect(hasPermission('MANAGER', 'staff.manage')).toBe(false);
  });

  it('exposes a stable role-to-permission map', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(['ADMIN', 'MANAGER']);
  });

  describe('piiTierFor', () => {
    it('returns raw for both roles', () => {
      expect(piiTierFor('MANAGER')).toBe('raw');
      expect(piiTierFor('ADMIN')).toBe('raw');
    });
  });
});
