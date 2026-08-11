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
  since?: string | undefined;
  until?: string | undefined;
  limit: number;
}

export interface AuditService {
  record(input: AuditEventInput): Promise<void>;
  query(query: AuditQuery): Promise<AuditEvent[]>;
}
