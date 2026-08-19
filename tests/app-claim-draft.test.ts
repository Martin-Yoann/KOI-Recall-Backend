import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import type { ClaimDraftResponse } from '../src/contracts/toc.js';
import { loadConfig } from '../src/config/env.js';
import type { ClaimDraftService, CreatedClaimDraft } from '../src/modules/claim-drafts/service.js';
import type { AuthorizedUpload, DocumentService } from '../src/modules/documents/service.js';
import {
  DraftExpiredOrInvalidError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  EvidenceRulesViolationError,
} from '../src/shared/errors.js';

const draft: CreatedClaimDraft = {
  draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
  draftToken: 'one-time-secret-with-at-least-32-characters-1234',
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
      draftToken: 'one-time-secret-with-at-least-32-characters-1234',
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

const DRAFT_ID = '21326c9a-5dc2-430f-98a6-546729a1065f';
const DRAFT_TOKEN = 'one-time-secret-with-at-least-32-characters';

function appWithDocuments(
  documents: Pick<DocumentService, 'authorizeUpload' | 'scheduleDraftDocumentDeletion'>,
  assertActive: ClaimDraftService['assertActive'] = () => Promise.resolve(),
) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: {
      ...base.services,
      claimDrafts: { create: () => Promise.resolve(null), assertActive },
      documents: documents as DocumentService,
    },
    platform: base.platform,
  };
  return createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    registry,
  });
}

const validUploadBody = {
  category: 'product_photo' as const,
  fileName: 'product-front.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 1024,
};

const authorized: AuthorizedUpload = {
  documentId: 'a996d56a-da5e-49c3-bf76-665130bbb88a',
  pathname:
    'drafts/21326c9a-5dc2-430f-98a6-546729a1065f/a996d56a-da5e-49c3-bf76-665130bbb88a/product-front.jpg',
  clientToken: 'short-lived-private-blob-token',
  expiresAt: '2026-08-04T13:15:00.000Z',
};

async function requestUploadToken(
  app: ReturnType<typeof appWithDocuments>,
  body: unknown = validUploadBody,
) {
  return app.request(`/v1/claim-drafts/${DRAFT_ID}/upload-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Draft-Token': DRAFT_TOKEN },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/claim-drafts/{draftId}/upload-tokens', () => {
  it('returns 201 with the authorized upload', async () => {
    const response = await requestUploadToken(
      appWithDocuments({
        authorizeUpload: () => Promise.resolve(authorized),
        scheduleDraftDocumentDeletion: () => Promise.resolve(),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(authorized);
  });

  it('returns 410 when the draft token is invalid or expired', async () => {
    const app = appWithDocuments(
      {
        authorizeUpload: () => Promise.resolve(authorized),
        scheduleDraftDocumentDeletion: () => Promise.resolve(),
      },
      () => Promise.reject(new DraftExpiredOrInvalidError('expired')),
    );
    const response = await requestUploadToken(app);

    expect(response.status).toBe(410);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    await expect(response.json()).resolves.toMatchObject({ status: 410, title: 'Gone' });
  });

  it('returns 413 when the file exceeds the size limit', async () => {
    const app = appWithDocuments({
      authorizeUpload: () => Promise.reject(new PayloadTooLargeError('too big')),
      scheduleDraftDocumentDeletion: () => Promise.resolve(),
    });
    const response = await requestUploadToken(app);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ status: 413 });
  });

  it('returns 415 when the media type is not allowed', async () => {
    const app = appWithDocuments({
      authorizeUpload: () => Promise.reject(new UnsupportedMediaTypeError('not allowed')),
      scheduleDraftDocumentDeletion: () => Promise.resolve(),
    });
    const response = await requestUploadToken(app);

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({ status: 415 });
  });

  it('returns 422 when evidence rules are violated', async () => {
    const app = appWithDocuments({
      authorizeUpload: () => Promise.reject(new EvidenceRulesViolationError('too many files')),
      scheduleDraftDocumentDeletion: () => Promise.resolve(),
    });
    const response = await requestUploadToken(app);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ status: 422 });
  });

  it('returns 503 when a dependency is unavailable', async () => {
    const app = appWithDocuments({
      authorizeUpload: () =>
        Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
      scheduleDraftDocumentDeletion: () => Promise.resolve(),
    });
    const response = await requestUploadToken(app);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      title: 'Dependency Unavailable',
      status: 503,
    });
  });

  it('returns 500 instead of a contract-invalid 201 response', async () => {
    const invalid: AuthorizedUpload = { ...authorized, pathname: '../not-safe' };
    const app = appWithDocuments({
      authorizeUpload: () => Promise.resolve(invalid),
      scheduleDraftDocumentDeletion: () => Promise.resolve(),
    });
    const response = await requestUploadToken(app);

    expect(response.status).toBe(500);
  });
});

describe('DELETE /v1/claim-drafts/{draftId}/documents/{documentId}', () => {
  it('delegates token validation and deletion atomically to the Document service', async () => {
    const deletionCalls: unknown[][] = [];
    let standaloneDraftChecks = 0;
    const app = appWithDocuments(
      {
        authorizeUpload: () => Promise.resolve(authorized),
        scheduleDraftDocumentDeletion: (...args: unknown[]) => {
          deletionCalls.push(args);
          return Promise.resolve();
        },
      },
      () => {
        standaloneDraftChecks += 1;
        return Promise.resolve();
      },
    );
    const response = await app.request(
      `/v1/claim-drafts/${DRAFT_ID}/documents/a996d56a-da5e-49c3-bf76-665130bbb88a`,
      { method: 'DELETE', headers: { 'X-Draft-Token': DRAFT_TOKEN } },
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(standaloneDraftChecks).toBe(0);
    expect(deletionCalls).toEqual([
      [DRAFT_ID, 'a996d56a-da5e-49c3-bf76-665130bbb88a', DRAFT_TOKEN],
    ]);
  });
});
