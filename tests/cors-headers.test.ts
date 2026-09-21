import { describe, expect, it } from 'vitest';

import { CORS_ALLOW_HEADERS } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createDefaultRegistry } from '../src/composition.js';
import { createApp } from '../src/app.js';
import { openApiConfig } from '../src/contracts/routes.js';

/**
 * Every header a browser is asked to send must be in the CORS allow-list.
 *
 * The failure this guards is silent by construction: a missing custom header is
 * never rejected by the API, because the browser's preflight fails first. The
 * client then reports a network error, which reads like an outage rather than a
 * configuration mistake. `X-Disposal-Token` shipped in exactly that state — every
 * test passed, and only loading the page revealed it.
 *
 * The check is derived from the published document rather than a hand-kept list,
 * so adding a header parameter to any route contract fails here until the
 * allow-list is updated.
 */

/** Header parameters reachable from any path in the generated document. */
function documentedHeaderNames(): string[] {
  const app = createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    registry: createDefaultRegistry(
      loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    ),
  });
  const doc = app.getOpenAPIDocument(openApiConfig) as {
    paths?: Record<string, unknown>;
  };

  const names = new Set<string>();
  const collect = (parameters: unknown) => {
    if (!Array.isArray(parameters)) return;
    for (const parameter of parameters) {
      if (
        parameter &&
        typeof parameter === 'object' &&
        (parameter as { in?: unknown }).in === 'header'
      ) {
        const name = (parameter as { name?: unknown }).name;
        if (typeof name === 'string') names.add(name);
      }
    }
  };

  for (const pathItem of Object.values(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const item = pathItem as Record<string, unknown>;
    collect(item.parameters);
    for (const operation of Object.values(item)) {
      if (operation && typeof operation === 'object') {
        collect((operation as Record<string, unknown>).parameters);
      }
    }
  }
  return [...names].sort();
}

describe('CORS allowed headers', () => {
  it('finds header parameters to check at all', () => {
    // A guard over an empty set protects nothing, so the enumeration itself is
    // asserted. If the document shape changes, this fails before the real check
    // silently passes.
    expect(documentedHeaderNames().length).toBeGreaterThan(0);
  });

  it('allows every header a route contract asks a browser to send', () => {
    const allowed = new Set(CORS_ALLOW_HEADERS);
    const missing = documentedHeaderNames().filter((name) => !allowed.has(name));
    expect(missing).toEqual([]);
  });

  it('keeps the list to names a browser may legitimately send', () => {
    // Guards the other direction: a wildcard would make the check above vacuous,
    // and a header the API never accepts is configuration nobody can reason about.
    expect(CORS_ALLOW_HEADERS).not.toContain('*');
    for (const header of CORS_ALLOW_HEADERS) {
      expect(header.trim()).toBe(header);
      expect(header.length).toBeGreaterThan(0);
    }
  });
});
