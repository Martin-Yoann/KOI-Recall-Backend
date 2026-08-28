import { createMiddleware } from 'hono/factory';

import type { SensitiveDataCryptoPort } from '../platform/crypto/port.js';
import type { AppEnv } from './request-context.js';
import { deriveClientSource } from './request-context.js';
import type { StaffService } from '../modules/staff/service.js';

/**
 * Builds a `/admin/*` auth middleware (ADR-0004 §2.5). Resolves a bearer
 * session token to a {@link StaffPrincipal} via {@link StaffService} and
 * attaches it to the context. Without a principal the handler returns 401.
 *
 * M2 dual-mode: when `legacyAdminApiKey` is provided, a request carrying that
 * exact bearer secret is accepted as a legacy principal (marked
 * `legacyAdminKey` on the context) with an `ADMIN` role. This path is
 * removed in M3.
 */
export function createStaffAuthMiddleware(deps: {
  staffService?: StaffService | undefined;
  crypto: SensitiveDataCryptoPort;
  legacyAdminApiKey?: string | undefined;
}) {
  return createMiddleware<AppEnv>(async (context, next) => {
    const authHeader = context.req.header('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '');

    // M2 dual-mode: legacy shared secret, full ADMIN role, no session row.
    if (deps.legacyAdminApiKey && bearer === deps.legacyAdminApiKey) {
      context.set('principal', {
        userId: '00000000-0000-0000-0000-000000000000',
        sessionId: '',
        role: 'ADMIN',
        displayName: 'Legacy Admin Key',
        email: '',
      });
      context.set('legacyAdminKey', true);
      await next();
      return;
    }

    if (deps.staffService && bearer) {
      const session = await deps.staffService.resolveSession(bearer);
      if (session) {
        context.set('principal', {
          userId: session.userId,
          sessionId: session.sessionId,
          role: session.role,
          displayName: session.displayName,
          email: session.email,
        });
        // Sliding activity touch; fire-and-forget — never blocks the request.
        void deps.staffService.touchSession(session.sessionId);
      }
    }

    await next();
  });
}

/**
 * Computes an HMAC digest of the request IP (best-effort) for audit trails, so
 * logs carry a stable, non-reversible identifier without the raw IP.
 */
export async function requestIpHash(
  context: { req: { header(name: string): string | undefined } },
  crypto: SensitiveDataCryptoPort,
): Promise<string | undefined> {
  const source = deriveClientSource(context);
  if (!source || source === 'unknown-client') return undefined;
  return crypto.lookupHash(source);
}

/** HMAC digest of the User-Agent header for audit trails. */
export async function requestUserAgentHash(
  context: { req: { header(name: string): string | undefined } },
  crypto: SensitiveDataCryptoPort,
): Promise<string | undefined> {
  const ua = context.req.header('User-Agent');
  if (!ua) return undefined;
  return crypto.lookupHash(ua);
}

export type { AppEnv };
