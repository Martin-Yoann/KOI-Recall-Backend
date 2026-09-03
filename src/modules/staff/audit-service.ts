import type { StaffRole } from './permissions.js';

/**
 * Cross-surface audit (ADR-0004 §2.4). Records every authorized write, every
 * raw-PII read, and every denied attempt. `actorRole` is a snapshot so history
 * survives later role changes.
 */
export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditEventInput {
  actorUserId: string | null;
  actorRole: StaffRole | null;
  action: string;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  outcome: AuditOutcome;
  reasonCode?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  ipAddressHash?: string | undefined;
  userAgentHash?: string | undefined;
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  actorRole: StaffRole | null;
  action: string;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  outcome: AuditOutcome;
  reasonCode?: string | undefined;
  metadata: Record<string, unknown>;
  ipAddressHash?: string | undefined;
  userAgentHash?: string | undefined;
  occurredAt: string;
}

export interface AuditQuery {
  actorUserId?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  action?: string | undefined;
  outcome?: AuditOutcome | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit: number;
  /** Opaque cursor from a previous page (see buildAuditCursor). */
  cursor?: string | undefined;
}

export interface AuditQueryPage {
  events: AuditEvent[];
  /** Total rows matching the current filters (not just this page). */
  total: number;
  /** Cursor for the next page; null when exhausted. */
  nextCursor: string | null;
}

/** A stable, forward-only cursor over (occurredAt, id) — opaque to callers. */
export function buildAuditCursor(occurredAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ o: occurredAt.toISOString(), i: id }), 'utf8').toString('base64url');
}

/** Decodes an audit cursor; returns null when malformed. */
export function parseAuditCursor(cursor: string): { occurredAt: Date; id: string } | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: string; i?: string };
    if (!raw?.o || !raw?.i) return null;
    const occurredAt = new Date(raw.o);
    if (Number.isNaN(occurredAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(raw.i)) return null;
    return { occurredAt, id: raw.i };
  } catch {
    return null;
  }
}

export interface AuditService {
  record(input: AuditEventInput): Promise<void>;
  query(query: AuditQuery): Promise<AuditQueryPage>;
}
