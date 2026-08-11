import { and, desc, eq, gte, lte } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../db/client.js';
import { adminAuditEvents } from '../../db/schema/index.js';
import type { AuditEvent, AuditEventInput, AuditQuery, AuditService } from './audit-service.js';

/**
 * Drizzle-backed cross-surface audit log (ADR-0004 §2.4). Every authorized
 * write, raw-PII read, and denied attempt produces exactly one row. The write
 * is synchronous so a failed audit insert fails the originating operation
 * (fail-closed for compliance).
 */
export class DrizzleAuditService implements AuditService {
  constructor(private readonly db: DatabaseExecutor) {}

  async record(input: AuditEventInput): Promise<void> {
    await this.db.insert(adminAuditEvents).values({
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      metadata: input.metadata ?? {},
      ipAddressHash: input.ipAddressHash ?? null,
      userAgentHash: input.userAgentHash ?? null,
    });
  }

  async query(query: AuditQuery): Promise<AuditEvent[]> {
    const conditions = [];
    if (query.actorUserId) conditions.push(eq(adminAuditEvents.actorUserId, query.actorUserId));
    if (query.resourceType) conditions.push(eq(adminAuditEvents.resourceType, query.resourceType));
    if (query.resourceId) conditions.push(eq(adminAuditEvents.resourceId, query.resourceId));
    if (query.action) conditions.push(eq(adminAuditEvents.action, query.action));
    if (query.since) conditions.push(gte(adminAuditEvents.occurredAt, new Date(query.since)));
    if (query.until) conditions.push(lte(adminAuditEvents.occurredAt, new Date(query.until)));

    const rows = await this.db
      .select()
      .from(adminAuditEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(adminAuditEvents.occurredAt))
      .limit(query.limit);

    return rows.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      actorRole: row.actorRole as AuditEvent['actorRole'],
      action: row.action,
      resourceType: row.resourceType ?? undefined,
      resourceId: row.resourceId ?? undefined,
      outcome: row.outcome,
      reasonCode: row.reasonCode ?? undefined,
      metadata: row.metadata,
      occurredAt: row.occurredAt.toISOString(),
      ipAddressHash: row.ipAddressHash ?? undefined,
      userAgentHash: row.userAgentHash ?? undefined,
    }));
  }
}
