import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { ClaimSubmissionResponse } from '../src/contracts/toc.js';
import type { CaseService } from '../src/modules/cases/service.js';
import {
  ClaimConflictError,
  ClaimValidationError,
  DraftExpiredOrInvalidError,
  ResourceNotFoundError,
} from '../src/shared/errors.js';

const testConfig = loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' });

const validClaimBody = {
  draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
  draftToken: 'one-time-secret-with-at-least-32-characters',
  locale: 'en-US' as const,
  consumer: {
    firstName: 'Taylor',
    lastName: 'Example',
    email: 'taylor@example.com',
    currentDeliveryAddress: {
      line1: '100 Example Street',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      countryCode: 'US',
    },
  },
  products: [
    {
      campaignProductId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
      quantity: 1,
      shape: 'Bear',
      flavor: 'Peach',
      lotCode: 'ML-2406-A',
      dateCode: '06/2024',
      identificationMode: 'product_identifiers' as const,
      purchaseChannel: 'amazon' as const,
    },
  ],
  remedyCode: 'replacement',
  documentIds: ['a996d56a-da5e-49c3-bf76-665130bbb88a', 'de0d8447-2889-4500-89bc-e81a27d17de5'],
  consents: [
    { type: 'privacy_notice' as const, textVersion: '2026-08-04', accepted: true as const },
    {
      type: 'information_accuracy' as const,
      textVersion: '2026-08-04',
      accepted: true as const,
    },
  ],
  incidentAnswer: 'no' as const,
};

function appWithCaseService(submit: CaseService['submit']) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: { ...base.services, cases: { submit } },
    platform: base.platform,
  };
  return createApp({ config: testConfig, registry });
}

async function postClaim(app: ReturnType<typeof appWithCaseService>) {
  return app.request('/v1/recall-campaigns/music-lollipop-demo-2026/claims', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key-0123456789' },
    body: JSON.stringify(validClaimBody),
  });
}

describe('POST /v1/recall-campaigns/{slug}/claims', () => {
  it('returns the validated service result as 201', async () => {
    const result: ClaimSubmissionResponse = {
      caseReference: 'KOI-7N4Q-A91M2X6P',
      submittedAt: '2026-08-06T09:00:00.000Z',
      emailStatus: 'queued',
      nextStep: 'Keep this reference. We will email you after your claim has been received.',
    };

    const response = await postClaim(appWithCaseService(() => Promise.resolve(result)));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(result);
  });

  it('turns a contract-invalid service result into 500', async () => {
    const response = await postClaim(
      appWithCaseService(() =>
        Promise.resolve({
          caseReference: 'internal-1',
          submittedAt: 'not-a-date',
          emailStatus: 'queued',
          nextStep: '',
        } as ClaimSubmissionResponse),
      ),
    );

    expect(response.status).toBe(500);
  });

  it.each([
    [new ResourceNotFoundError('Campaign not found.'), 404],
    [new ClaimConflictError('Claim conflict.'), 409],
    [new DraftExpiredOrInvalidError('Draft unavailable.'), 410],
    [new ClaimValidationError('Claim invalid.'), 422],
  ] as const)('maps domain errors to Problem Details', async (error, status) => {
    const response = await postClaim(appWithCaseService(() => Promise.reject(error)));

    expect(response.status).toBe(status);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
  });

  it('returns 503 when the Claim database is unavailable', async () => {
    const response = await postClaim(
      appWithCaseService(() =>
        Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
      ),
    );

    expect(response.status).toBe(503);
  });

  it('keeps the default Claim capability at 501 without providers', async () => {
    const response = await postClaim(createApp({ config: testConfig }));

    expect(response.status).toBe(501);
  });
});
