import { describe, expect, it, vi } from 'vitest';

import { createCacheInvalidator } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import { NotConfiguredCacheInvalidator } from '../src/platform/cache-invalidation/not-configured.js';
import { WebRevalidateCacheInvalidator } from '../src/platform/cache-invalidation/web-revalidate.js';

const ENDPOINT = 'https://web.example.test/api/revalidate';
const SECRET = 'shared-secret-value';
const SLUG = 'music-lollipop-demo-2026';

/** A fetch double typed like the real one, so `mock.calls` stays inspectable. */
function fakeFetch(respond: () => Response) {
  return vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(respond()));
}

describe('WebRevalidateCacheInvalidator', () => {
  it('posts the slug with the bearer secret and reports success', async () => {
    const fetchImpl = fakeFetch(() => new Response('{}', { status: 200 }));
    const invalidator = new WebRevalidateCacheInvalidator(ENDPOINT, SECRET, fetchImpl);

    const result = await invalidator.invalidateCampaign(SLUG);

    expect(result).toEqual({ invalidated: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(init?.body).toBe(JSON.stringify({ slug: SLUG }));
  });

  it('reports failure instead of throwing when the web app rejects the call', async () => {
    const fetchImpl = fakeFetch(() => new Response('{"error":"Unauthorized"}', { status: 401 }));
    const invalidator = new WebRevalidateCacheInvalidator(ENDPOINT, SECRET, fetchImpl);

    const result = await invalidator.invalidateCampaign(SLUG);

    expect(result.invalidated).toBe(false);
    expect(result.detail).toContain('401');
  });

  it('reports failure instead of throwing when the request cannot be made', async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.reject(new Error('ECONNREFUSED')),
    );
    const invalidator = new WebRevalidateCacheInvalidator(ENDPOINT, SECRET, fetchImpl);

    // The publish has already committed by this point, so a transport failure
    // must degrade to the revalidate window rather than surface as an error.
    const result = await invalidator.invalidateCampaign(SLUG);

    expect(result.invalidated).toBe(false);
    expect(result.detail).toBe('request failed (Error)');
  });

  it('never leaks the secret into the reported detail', async () => {
    const fetchImpl = fakeFetch(() => new Response('nope', { status: 500 }));
    const invalidator = new WebRevalidateCacheInvalidator(ENDPOINT, SECRET, fetchImpl);

    const result = await invalidator.invalidateCampaign(SLUG);

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('NotConfiguredCacheInvalidator', () => {
  it('succeeds as a no-op so an unconfigured deployment still publishes', async () => {
    const invalidator = new NotConfiguredCacheInvalidator();

    const result = await invalidator.invalidateCampaign(SLUG);

    expect(result.invalidated).toBe(false);
    expect(result.detail).toBe('no web revalidate endpoint configured');
  });
});

describe('createCacheInvalidator', () => {
  it('builds the HTTP adapter when both endpoint and secret are present', () => {
    const invalidator = createCacheInvalidator(
      loadConfig({ WEB_REVALIDATE_URL: ENDPOINT, WEB_REVALIDATE_SECRET: SECRET }),
    );

    expect(invalidator).toBeInstanceOf(WebRevalidateCacheInvalidator);
  });

  it('falls back to the no-op without a secret', () => {
    const invalidator = createCacheInvalidator(loadConfig({ WEB_REVALIDATE_URL: ENDPOINT }));

    // A URL with no secret would be rejected by the web app anyway, so pairing
    // them is treated as unconfigured rather than a misconfiguration to retry.
    expect(invalidator).toBeInstanceOf(NotConfiguredCacheInvalidator);
  });

  it('falls back to the no-op without an endpoint', () => {
    const invalidator = createCacheInvalidator(loadConfig({ WEB_REVALIDATE_SECRET: SECRET }));

    expect(invalidator).toBeInstanceOf(NotConfiguredCacheInvalidator);
  });
});
