import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { openApiConfig } from '../src/contracts/toc.js';

function document() {
  return createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'http://localhost:3000' }),
  }).getOpenAPIDocument(openApiConfig);
}

describe('OpenAPI contract', () => {
  it('contains exactly the six public Phase 1 paths', () => {
    const paths = Object.keys(document().paths ?? {});

    expect(paths).toEqual([
      '/v1/recall-campaigns/{slug}',
      '/v1/recall-campaigns/{slug}/product-checks',
      '/v1/recall-campaigns/{slug}/claim-drafts',
      '/v1/claim-drafts/{draftId}/upload-tokens',
      '/v1/claim-drafts/{draftId}/documents/{documentId}',
      '/v1/recall-campaigns/{slug}/claims',
    ]);
    expect(
      paths.every((path) => !path.startsWith('/internal') && !path.startsWith('/webhooks')),
    ).toBe(true);
  });

  it('documents idempotency and all requested error statuses', () => {
    const serialized = JSON.stringify(document());

    expect(serialized).toContain('Idempotency-Key');
    for (const status of [400, 404, 409, 410, 413, 415, 422, 429, 500, 503]) {
      expect(serialized).toContain(`"${status}"`);
    }
  });

  it('does not expose storage or persistence-only sensitive field names', () => {
    const serialized = JSON.stringify(document());

    for (const forbidden of [
      'storagePathname',
      'encryptedPayload',
      'emailLookupHash',
      'addressLookupHash',
      'providerMessageId',
      'companyObtainedAt',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
