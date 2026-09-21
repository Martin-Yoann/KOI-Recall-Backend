import type { Context } from 'hono';

import type { AdminTransactionRunner, ApplicationRegistry } from '../composition.js';
import type { AuditService } from '../modules/staff/audit-service.js';
import type { StaffPrincipal } from '../modules/staff/service.js';
import { hasPermission, type Permission } from '../modules/staff/permissions.js';
import type { AppEnv } from '../middleware/request-context.js';
import { requestIpHash, requestUserAgentHash } from '../middleware/staff-auth.js';
import { consoleSafeLogger } from '../platform/observability/logger.js';
import { NotImplementedServiceError, problemType } from '../shared/errors.js';

/**
 * The permission guard shared by every `/admin/*` route module.
 *
 * Extracted from the admin route file so a second admin surface could reuse it
 * rather than re-implement it: a duplicated guard is a guard that can drift, and
 * this one decides whether a denied attempt is even recorded.
 */

export function unauthorized(context: Context<AppEnv>) {
  return context.json(
    {
      type: problemType('unauthorized'),
      title: 'Unauthorized',
      status: 401,
      detail: 'A valid staff session is required.',
      requestId: context.get('requestId'),
    },
    401,
    { 'Content-Type': 'application/problem+json' },
  );
}

export function forbidden(context: Context<AppEnv>, permission: Permission) {
  return context.json(
    {
      type: problemType('forbidden'),
      title: 'Forbidden',
      status: 403,
      detail: `This action requires the '${permission}' permission.`,
      requestId: context.get('requestId'),
    },
    403,
    { 'Content-Type': 'application/problem+json' },
  );
}

/**
 * Guards a route by permission; writes a denied audit row on failure. Returns
 * the principal on success, or a ready-to-send error Response on failure. The
 * caller distinguishes the two with `instanceof Response`.
 */
export async function requirePermission(
  context: Context<AppEnv>,
  registry: ApplicationRegistry,
  permission: Permission,
  options: { allowLegacy?: boolean } = {},
): Promise<StaffPrincipal | Response> {
  const principal = context.get('principal');
  if (!principal) {
    return unauthorized(context);
  }
  if (context.get('legacyAdminKey')) {
    if (!options.allowLegacy) return unauthorized(context);
    consoleSafeLogger.info('Deprecated legacy admin key used.', {
      requestId: context.get('requestId'),
      method: context.req.method,
      path: new URL(context.req.url).pathname,
    });
    return principal;
  }
  if (!hasPermission(principal.role, permission)) {
    const audit = requireAuditService(registry);
    await audit.record({
      actorUserId: principal.userId,
      actorRole: principal.role,
      action: permission,
      resourceType: 'permission',
      resourceId: permission,
      outcome: 'denied',
      reasonCode: 'insufficient_role',
      ipAddressHash: await requestIpHash(context, registry.platform.crypto),
      userAgentHash: await requestUserAgentHash(context, registry.platform.crypto),
    });
    return forbidden(context, permission);
  }
  return principal;
}

export function requireAuditService(registry: ApplicationRegistry): AuditService {
  const audit = registry.services.audit;
  if (!audit) throw new NotImplementedServiceError('Admin audit recording');
  return audit;
}

export function requireAdminTransactions(registry: ApplicationRegistry): AdminTransactionRunner {
  const transactions = registry.services.adminTransactions;
  if (!transactions) throw new NotImplementedServiceError('Transactional admin operations');
  return transactions;
}
