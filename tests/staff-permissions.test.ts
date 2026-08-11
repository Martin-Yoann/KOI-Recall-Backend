import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  hasPermission,
  piiTierFor,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
} from '../src/modules/staff/permissions.js';

describe('staff permissions matrix', () => {
  it('covers exactly the documented roles and permissions', () => {
    expect(STAFF_ROLES).toEqual(['viewer', 'reviewer', 'compliance', 'administrator']);
    expect(ALL_PERMISSIONS).toContain('case.detail.read_pii_raw');
  });

  it('grants every permission to administrator', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(hasPermission('administrator', permission)).toBe(true);
    }
  });

  it('grants viewer only queue + masked detail read', () => {
    expect(hasPermission('viewer', 'case.queue.read')).toBe(true);
    expect(hasPermission('viewer', 'case.detail.read')).toBe(true);
    expect(hasPermission('viewer', 'case.assign')).toBe(false);
    expect(hasPermission('viewer', 'case.status.transition')).toBe(false);
    expect(hasPermission('viewer', 'case.detail.read_pii_raw')).toBe(false);
    expect(hasPermission('viewer', 'case.export')).toBe(false);
    expect(hasPermission('viewer', 'review.close')).toBe(false);
  });

  it('lets reviewer assign and transition but NOT read raw PII or export', () => {
    expect(hasPermission('reviewer', 'case.assign')).toBe(true);
    expect(hasPermission('reviewer', 'case.status.transition')).toBe(true);
    expect(hasPermission('reviewer', 'case.detail.read')).toBe(true);
    // Critical invariant: raw PII is independent of detail read.
    expect(hasPermission('reviewer', 'case.detail.read_pii_raw')).toBe(false);
    expect(hasPermission('reviewer', 'case.export')).toBe(false);
    expect(hasPermission('reviewer', 'review.close')).toBe(false);
  });

  it('lets compliance read raw PII, export, and close reviews', () => {
    expect(hasPermission('compliance', 'case.detail.read_pii_raw')).toBe(true);
    expect(hasPermission('compliance', 'case.export')).toBe(true);
    expect(hasPermission('compliance', 'review.close')).toBe(true);
    expect(hasPermission('compliance', 'audit.read')).toBe(false);
    expect(hasPermission('compliance', 'staff.manage')).toBe(false);
  });

  it('does not imply read_pii_raw from case.detail.read for any non-compliance/admin role', () => {
    for (const role of STAFF_ROLES) {
      const canReadDetail = hasPermission(role, 'case.detail.read');
      const canReadRaw = hasPermission(role, 'case.detail.read_pii_raw');
      if (canReadRaw) {
        expect(canReadDetail).toBe(true); // raw implies detail
      } else if (canReadDetail) {
        // detail without raw must hold (viewer, reviewer)
        expect(role === 'viewer' || role === 'reviewer').toBe(true);
      }
    }
  });

  it('only administrator gets audit.read and staff.manage', () => {
    for (const role of STAFF_ROLES) {
      if (role === 'administrator') continue;
      expect(hasPermission(role, 'audit.read')).toBe(false);
      expect(hasPermission(role, 'staff.manage')).toBe(false);
    }
  });

  it('exposes a stable role→permission map (no mutations)', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([
      'administrator',
      'compliance',
      'reviewer',
      'viewer',
    ]);
  });

  describe('piiTierFor', () => {
    it('returns masked for viewer and reviewer', () => {
      expect(piiTierFor('viewer')).toBe('masked');
      expect(piiTierFor('reviewer')).toBe('masked');
    });

    it('returns raw for compliance and administrator', () => {
      expect(piiTierFor('compliance')).toBe('raw');
      expect(piiTierFor('administrator')).toBe('raw');
    });
  });
});
