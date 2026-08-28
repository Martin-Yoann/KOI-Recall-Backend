import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { CaseStatusLookupResponse } from '../src/contracts/toc.js';
import type { CaseStatusLookupService } from '../src/modules/cases/case-status-lookup-service.js';
import { cannedLookupView } from './helpers/case-status-fixture.js';

const REQUEST_ID = 'case-status-lookup-test';

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/v1/case-status-lookups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': REQUEST_ID },
    body: JSON.stringify(body),
  });
}

function appWith(caseStatusLookups: CaseStatusLookupService) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: { ...base.services, caseStatusLookups },
    platform: base.platform,
  };
  return createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    registry,
  });
}

describe('POST /v1/case-status-lookups', () => {
  it('returns exactly the whitelisted fields on success', async () => {
    const view = cannedLookupView();
    const response = await post(appWith({ lookup: () => Promise.resolve(view) }), {
      caseReference: 'KOI-B2C4-D6E8F0A1',
      email: 'consumer@example.com',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as CaseStatusLookupResponse;
    expect(Object.keys(body).sort()).toEqual(
      [
        'caseReference',
        'campaignTitle',
        'publicStatus',
        'publicStatusLabel',
        'consumerNextAction',
        'requestedResolution',
        'approvedResolution',
        'lastUpdatedAt',
      ].sort(),
    );
    expect(body).toEqual(view);
  });

  it('renders the same failure bytes for an unknown reference and an email mismatch', async () => {
    // The service collapses both auth failures into null; the route must give
    // both the identical ProblemDetails shape — byte-for-byte for a fixed
    // request id.
    const app = appWith({ lookup: () => Promise.resolve(null) });

    const unknownReference = await post(app, {
      caseReference: 'KOI-Z9Y8-W7X6V5U4',
      email: 'consumer@example.com',
    });
    const emailMismatch = await post(app, {
      caseReference: 'KOI-B2C4-D6E8F0A1',
      email: 'someone-else@example.com',
    });

    expect(unknownReference.status).toBe(404);
    expect(emailMismatch.status).toBe(404);
    expect(await unknownReference.text()).toBe(await emailMismatch.text());
  });

  it('rejects malformed bodies with a validation ProblemDetails', async () => {
    const response = await post(appWith({ lookup: () => Promise.resolve(cannedLookupView()) }), {
      caseReference: 'not-a-reference',
      email: 'also-not-an-email',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Invalid Request', status: 400 });
  });

  it('stays 501 when the capability is not wired to a provider', async () => {
    const base = createPlaceholderRegistry();
    const app = createApp({
      config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
      registry: base,
    });
    const response = await post(app, {
      caseReference: 'KOI-B2C4-D6E8F0A1',
      email: 'consumer@example.com',
    });
    expect(response.status).toBe(501);
  });

  it('applies its own tight per-IP quota of 10 requests per minute', async () => {
    const service: CaseStatusLookupService = { lookup: () => Promise.resolve(null) };
    const app = appWith(service);
    const payload = { caseReference: 'KOI-B2C4-D6E8F0A1', email: 'consumer@example.com' };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await post(app, payload);
      expect(response.status).toBe(404);
    }

    const throttled = await post(app, payload);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('RateLimit-Limit')).toBe('10');
    const body = (await throttled.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: 'Too Many Requests', requestId: REQUEST_ID });
  });
});
