import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { AdminService } from '../src/modules/admin/service.js';

function appWith(admin: AdminService) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: { ...base.services, admin },
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
  listCases: () => Promise.resolve([summary]),
  listIncidents: () => Promise.resolve([]),
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

  it('closes a reportability review with the admin key', async () => {
    const response = await appWith(admin).request(
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
    expect(response.status).toBe(500);
  });
});
