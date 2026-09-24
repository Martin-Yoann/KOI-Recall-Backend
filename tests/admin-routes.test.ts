import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { AdminService } from '../src/modules/admin/service.js';
import type { AuditEventInput, AuditService } from '../src/modules/staff/audit-service.js';
import type { StaffService } from '../src/modules/staff/service.js';
import { makeDisposalFake } from './helpers/disposal-fake.js';

/**
 * Records audit calls so tests can assert the trail, not just the status code.
 */
function makeAuditSpy(): { service: AuditService; inputs: AuditEventInput[] } {
  const inputs: AuditEventInput[] = [];
  return {
    inputs,
    service: {
      record: (input) => {
        inputs.push(input);
        return Promise.resolve();
      },
      query: () => Promise.resolve({ events: [], total: 0, nextCursor: null }),
    },
  };
}

// None of the routes exercised here reach the staff service, so an empty object
// is honest rather than a stub with fake behaviour. The transaction runner only
// requires the shape because real callers (staff management) do use it.
const staffStub = {} as StaffService;

function appWith(admin: AdminService, audit: AuditService = makeAuditSpy().service) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: {
      ...base.services,
      admin,
      audit,
      // `admin`, `audit` and the transaction runner are created in one block by
      // createApplicationRegistry, so a registry holding `admin` without a
      // runner is a shape production cannot produce — the harness mirrors the
      // real one. Previously it did not, which is why the legacy close path
      // looked like it needed no transaction.
      adminTransactions: {
        run: (work) => work({ admin, staff: staffStub, audit, disposal: makeDisposalFake() }),
      },
    },
    platform: base.platform,
  };
  return createApp({
    config: loadConfig({
      CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
      ADMIN_API_KEY: 'admin-secret',
    }),
    registry,
  });
}

const summary = {
  caseReference: 'KOI-7N4Q-A91M2X6P',
  status: 'submitted',
  subtype: 'standard',
  incidentFlag: false,
  submittedAt: '2026-08-07T09:00:00.000Z',
};

const admin: AdminService = {
  listCaseEscalations: () => Promise.resolve([]),
  openCaseEscalation: () => Promise.resolve({ escalationId: 'escalation-1' }),
  closeCaseEscalation: () => Promise.resolve(),
  listCases: () => Promise.resolve({ cases: [summary], total: 1, nextCursor: null }),
  listIncidents: () => Promise.resolve({ incidents: [], total: 0, nextCursor: null }),
  getIncidentDetail: () => Promise.resolve(null),
  listCampaigns: () => Promise.resolve([]),
  exportCases: () => Promise.resolve([summary]),
  closeReportabilityReview: () => Promise.resolve(),
  getCaseDetail: () => Promise.resolve(null),
  assignCase: () => Promise.resolve(),
  transitionCaseStatus: () => Promise.resolve(),
};

describe('admin routes (T8/O10)', () => {
  it('rejects a missing admin key with 401', async () => {
    const response = await appWith(admin).request('/admin/cases');
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Unauthorized', status: 401 });
  });

  it('rejects an invalid admin key with 401', async () => {
    const response = await appWith(admin).request('/admin/cases', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(response.status).toBe(401);
  });

  it('lists cases for a queue with the admin key', async () => {
    const response = await appWith(admin).request('/admin/cases?queue=standard', {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cases: (typeof summary)[] };
    expect(body.cases[0]?.caseReference).toBe('KOI-7N4Q-A91M2X6P');
  });

  it('exports cases as CSV with the admin key', async () => {
    const response = await appWith(admin).request('/admin/cases/export', {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    const csv = await response.text();
    expect(csv).toContain('caseReference,status,subtype,incidentFlag,submittedAt');
    expect(csv).toContain('KOI-7N4Q-A91M2X6P');
  });

  it('refuses an outcome that is not one of the two decisions', async () => {
    const spy = makeAuditSpy();
    const response = await appWith(admin, spy.service).request(
      '/admin/reportability-reviews/00000000-0000-4000-8000-000000000001/close',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret' },
        body: JSON.stringify({
          outcome: 'Reportable',
          reviewerId: '00000000-0000-4000-8000-000000000002',
          rationale: 'Verified the incident report and filed with CPSC.',
          cpscReference: 'CPSC-2026-001',
        }),
      },
    );

    // 'Reportable' is not a decision this endpoint records, and it used to be closed
    // as 'filed' — a safety review recorded as filed with no intent to file.
    expect(response.status).toBe(422);
    expect(spy.inputs).toHaveLength(0);
  });

  it('closes a reportability review with the admin key', async () => {
    const spy = makeAuditSpy();
    const response = await appWith(admin, spy.service).request(
      '/admin/reportability-reviews/00000000-0000-4000-8000-000000000001/close',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret' },
        body: JSON.stringify({
          outcome: 'filed',
          reviewerId: '00000000-0000-4000-8000-000000000002',
          rationale: 'Verified the incident report and filed with CPSC.',
          cpscReference: 'CPSC-2026-001',
        }),
      },
    );
    expect(response.status).toBe(204);

    // This path used to write no audit row at all, which is how a safety
    // decision could reach a terminal state with no trail.
    expect(spy.inputs).toHaveLength(1);
    expect(spy.inputs[0]).toMatchObject({
      action: 'review.close',
      resourceType: 'review',
      resourceId: '00000000-0000-4000-8000-000000000001',
      outcome: 'success',
      metadata: { outcome: 'filed', via: 'legacy_admin_key' },
    });
  });

  it('preserves the legacy reviewerId during the M2 dual-mode window', async () => {
    let reviewerId: string | undefined;
    const legacyAdmin: AdminService = {
      ...admin,
      closeReportabilityReview: (_reviewId, input) => {
        reviewerId = input.reviewerId;
        return Promise.resolve();
      },
    };

    const response = await appWith(legacyAdmin).request(
      '/admin/reportability-reviews/00000000-0000-4000-8000-000000000001/close',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret' },
        body: JSON.stringify({
          outcome: 'documented_non_reportable',
          reviewerId: '00000000-0000-4000-8000-000000000002',
          rationale: 'Reviewed and documented as non-reportable.',
        }),
      },
    );

    expect(response.status).toBe(204);
    expect(reviewerId).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('surfaces 501 when no admin service is wired', async () => {
    const base = createPlaceholderRegistry();
    const app = createApp({
      config: loadConfig({
        CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
        ADMIN_API_KEY: 'admin-secret',
      }),
      registry: base,
    });
    const response = await app.request('/admin/cases', {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    // CLAUDE.md convention: a missing service is a 501 NotImplementedServiceError,
    // never a bare 500.
    expect(response.status).toBe(501);
  });
});
