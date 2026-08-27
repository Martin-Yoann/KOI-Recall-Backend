import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { DraftDocumentListResponse } from '../src/contracts/toc.js';
import { DraftExpiredOrInvalidError } from '../src/shared/errors.js';
import type { DraftDocumentSummary, DocumentService } from '../src/modules/documents/service.js';

const VALID_TOKEN = 'one-time-secret-with-at-least-32-characters-1234';

function summary(overrides: Partial<DraftDocumentSummary> = {}): DraftDocumentSummary {
  return {
    documentId: 'd6a7bd18-1f36-4f0e-a9e2-d5cd2b3ba111',
    category: 'proof_of_purchase',
    fileName: 'receipt.jpg',
    status: 'scan_pending',
    statusReason: null,
    uploadedAt: '2026-08-27T03:12:00.000Z',
    lastStatusChangedAt: '2026-08-27T03:13:41.000Z',
    ...overrides,
  };
}

function appWith(documents: DocumentService) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: { ...base.services, documents },
    platform: base.platform,
  };
  return createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    registry,
  });
}

function get(app: ReturnType<typeof createApp>, token = VALID_TOKEN) {
  return app.request('/v1/claim-drafts/21326c9a-5dc2-430f-98a6-546729a1065f/documents', {
    headers: { 'X-Draft-Token': token },
  });
}

describe('GET /v1/claim-drafts/{draftId}/documents', () => {
  it('returns the derived six-state listing for an authorized draft', async () => {
    const documents: DocumentService = {
      authorizeUpload: () => Promise.reject(new Error('not used')),
      scheduleDraftDocumentDeletion: () => Promise.reject(new Error('not used')),
      listDraftDocuments: () =>
        Promise.resolve([
          summary({
            documentId: '11111111-2222-4333-8444-555555555555',
            status: 'verifying',
          }),
          summary({
            documentId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            fileName: 'box.jpg',
            status: 'rejected',
            statusReason: 'mime_mismatch',
            uploadedAt: null,
          }),
        ]),
      reconcileCompletedUpload: () => Promise.reject(new Error('not used')),
    };

    const response = await get(appWith(documents));

    expect(response.status).toBe(200);
    const body = (await response.json()) as DraftDocumentListResponse;
    expect(body.documents).toHaveLength(2);
    expect(body.documents[0]).toMatchObject({ status: 'verifying', statusReason: null });
    expect(body.documents[1]).toMatchObject({ status: 'rejected', statusReason: 'mime_mismatch' });
  });

  it('maps an invalid draft token or inactive draft to 410 Gone', async () => {
    const documents: DocumentService = {
      authorizeUpload: () => Promise.reject(new Error('not used')),
      scheduleDraftDocumentDeletion: () => Promise.reject(new Error('not used')),
      listDraftDocuments: () =>
        Promise.reject(
          new DraftExpiredOrInvalidError(
            'The draft token is invalid, or the draft is no longer active or has expired.',
          ),
        ),
      reconcileCompletedUpload: () => Promise.reject(new Error('not used')),
    };

    const response = await get(appWith(documents));

    expect(response.status).toBe(410);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Gone', status: 410 });
  });

  it('requires a well-formed X-Draft-Token header', async () => {
    const response = await get(
      appWith({
        authorizeUpload: () => Promise.reject(new Error('not used')),
        scheduleDraftDocumentDeletion: () => Promise.reject(new Error('not used')),
        listDraftDocuments: () => Promise.resolve([]),
        reconcileCompletedUpload: () => Promise.reject(new Error('not used')),
      }),
      'short',
    );

    expect(response.status).toBe(400);
  });
});
