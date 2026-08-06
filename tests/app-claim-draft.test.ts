import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import type { ClaimDraftResponse } from '../src/contracts/toc.js';
import { loadConfig } from '../src/config/env.js';
import type { ClaimDraftService, CreatedClaimDraft } from '../src/modules/claim-drafts/service.js';

const draft: CreatedClaimDraft = {
  draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
  draftToken: 'one-time-secret-with-at-least-32-characters',
  expiresAt: '2026-08-07T12:00:00.000Z',
};

function appWith(claimDrafts: ClaimDraftService) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: { ...base.services, claimDrafts },
    platform: base.platform,
  };
  return createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    registry,
  });
}

function service(create: ClaimDraftService['create']): ClaimDraftService {
  return {
    create,
    assertActive: () => Promise.resolve(),
  };
}

async function createDraft(app: ReturnType<typeof appWith>) {
  return app.request('/v1/recall-campaigns/music-lollipop-demo-2026/claim-drafts', {
    method: 'POST',
  });
}

describe('POST /v1/recall-campaigns/{slug}/claim-drafts', () => {
  it('returns 201 with the created draft', async () => {
    const response = await createDraft(appWith(service(() => Promise.resolve(draft))));

    expect(response.status).toBe(201);
    const body = (await response.json()) as ClaimDraftResponse;
    expect(body).toEqual({
      draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
      draftToken: 'one-time-secret-with-at-least-32-characters',
      expiresAt: '2026-08-07T12:00:00.000Z',
    });
  });

  it('returns 404 when the campaign is not found or not publicly visible', async () => {
    const response = await createDraft(appWith(service(() => Promise.resolve(null))));

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Not Found', status: 404 });
  });

  it('returns 503 when the database connection fails', async () => {
    const response = await createDraft(
      appWith(
        service(() =>
          Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
        ),
      ),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Dependency Unavailable', status: 503 });
  });

  it('returns 500 instead of a contract-invalid 201 response', async () => {
    const invalid: CreatedClaimDraft = {
      ...draft,
      draftToken: 'too-short', // below the contract minimum of 32 characters
    };
    const response = await createDraft(appWith(service(() => Promise.resolve(invalid))));

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    await expect(response.json()).resolves.toMatchObject({
      title: 'Internal Server Error',
      status: 500,
    });
  });

  it('returns 501 when no database is configured (placeholder registry)', async () => {
    // No `registry` argument: createDefaultRegistry falls back to the all-placeholder
    // registry, so claim-draft creation rejects with NotImplementedServiceError -> 501.
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    });

    const response = await createDraft(app);

    expect(response.status).toBe(501);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Not Implemented', status: 501 });
  });
});
