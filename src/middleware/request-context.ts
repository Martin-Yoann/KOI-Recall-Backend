import { createMiddleware } from 'hono/factory';

import type { StaffPrincipal } from '../modules/staff/service.js';

export interface AppEnv {
  Variables: {
    requestId: string;
    /** Best-effort client source (first X-Forwarded-For hop or connection). */
    clientSource: string;
    /**
     * ADR-0004: the resolved staff principal, set by staff-auth middleware on
     * `/admin/*`. Absent on public, cron, and webhook routes.
     */
    principal?: StaffPrincipal;
    /**
     * Whether the current request authenticated via the legacy `ADMIN_API_KEY`
     * shared secret (M2 dual-mode). Present only during the M2→M3 transition.
     */
    legacyAdminKey?: boolean;
  };
}

/**
 * Derives a best-effort client source for rate limiting: the first
 * X-Forwarded-For hop when present, else a fallback token. Not trusted for
 * auth — it only shapes the rate-limit key so one client cannot trivially
 * bypass per-path quotas by rotating a header the proxy does not set.
 */
export function deriveClientSource(context: { req: { header(name: string): string | undefined } }) {
  const forwarded = context.req.header('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return context.req.header('CF-Connecting-IP') ?? 'unknown-client';
}

export const requestContext = createMiddleware<AppEnv>(async (context, next) => {
  const incoming = context.req.header('X-Request-Id');
  const requestId =
    incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  context.set('requestId', requestId);
  context.header('X-Request-Id', requestId);
  context.set('clientSource', deriveClientSource(context));
  await next();
});
