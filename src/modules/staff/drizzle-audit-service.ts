import { and, count, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../db/client.js';
import { adminAuditEvents } from '../../db/schema/index.js';
import type { AuditEvent, AuditEventInput, AuditQuery, AuditQueryPage, AuditService } from './audit-service.js';
import { buildAuditCursor, parseAuditCursor } from './audit-service.js';

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

  async query(query: AuditQuery): Promise<AuditQueryPage> {
    const filterConditions = [];
    if (query.actorUserId) filterConditions.push(eq(adminAuditEvents.actorUserId, query.actorUserId));
    if (query.resourceType) filterConditions.push(eq(adminAuditEvents.resourceType, query.resourceType));
    if (query.resourceId) filterConditions.push(eq(adminAuditEvents.resourceId, query.resourceId));
    if (query.action) filterConditions.push(eq(adminAuditEvents.action, query.action));
    if (query.outcome) filterConditions.push(eq(adminAuditEvents.outcome, query.outcome));
    if (query.since) filterConditions.push(gte(adminAuditEvents.occurredAt, new Date(query.since)));
    if (query.until) filterConditions.push(lte(adminAuditEvents.occurredAt, new Date(query.until)));
    const filterWhere = filterConditions.length > 0 ? and(...filterConditions) : undefined;

    // Forward-only cursor over (occurredAt desc, id desc); the id tie-breaks
    // identical timestamps so pages never skip or repeat rows.
    const cursor = query.cursor ? parseAuditCursor(query.cursor) : null;
    let cursorCondition = null;
    if (query.cursor && !cursor) {
      // Malformed cursor: return an empty page rather than erroring so a
      // stale client bookmark degrades gracefully.
      cursorCondition = sql`false`;
    } else if (cursor) {
      cursorCondition = or(
        lt(adminAuditEvents.occurredAt, cursor.occurredAt),
        and(
          eq(adminAuditEvents.occurredAt, cursor.occurredAt),
          lt(adminAuditEvents.id, cursor.id),
        ),
      );
    }

    const pageWhere = cursorCondition
      ? (filterWhere ? and(filterWhere, cursorCondition) : cursorCondition)
      : filterWhere;

    const rows = await this.db
      .select()
      .from(adminAuditEvents)
      .where(pageWhere)
      .orderBy(desc(adminAuditEvents.occurredAt), desc(adminAuditEvents.id))
      .limit(query.limit);

    // Total matching rows for the *filters* (cursor excluded) so the UI can
    // show "page x of total" without a second request.
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(adminAuditEvents)
      .where(filterWhere);
    const total = Number(totalRow?.value ?? 0);

    let nextCursor: string | null = null;
    if (rows.length === query.limit && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      const [lookahead] = await this.db
        .select({ id: adminAuditEvents.id })
        .from(adminAuditEvents)
        .where(and(
          pageWhere,
          or(
            lt(adminAuditEvents.occurredAt, last.occurredAt),
            and(
              eq(adminAuditEvents.occurredAt, last.occurredAt),
              lt(adminAuditEvents.id, last.id),
              ),
            ),

        ))
        .limit(1);
      if (lookahead) {
        nextCursor = buildAuditCursor(last.occurredAt, last.id);
      }
    }

    return {
      events: rows.map((row) => ({
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
      })),
      total,
      nextCursor,
    };
  }
}
