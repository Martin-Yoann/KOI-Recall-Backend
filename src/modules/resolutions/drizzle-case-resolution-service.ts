import { eq } from 'drizzle-orm';

import type { DatabaseExecutor, DatabaseHandle } from '../../db/client.js';
import {
  adminAuditEvents,
  caseEvents,
  caseResolutions,
  recallCases,
} from '../../db/schema/index.js';
import type { SensitiveDataCryptoPort } from '../../platform/crypto/port.js';
import {
  ClaimConflictError,
  ClaimValidationError,
  ResourceNotFoundError,
} from '../../shared/errors.js';
import type { StaffRole } from '../staff/permissions.js';
import type {
  ApproveResolutionInput,
  CancelResolutionInput,
  CaseResolution,
  CaseResolutionService,
  CaseResolutionStatus,
  CaseResolutionType,
  CompleteResolutionInput,
  RequestResolutionInput,
} from './service.js';

/** Map a campaign remedy code to the normalized resolution type. */
export function resolutionTypeForRemedyCode(remedyCode: string): CaseResolutionType {
  return remedyCode === 'refund' ? 'refund' : 'replacement';
}

function toCaseResolution(row: typeof caseResolutions.$inferSelect): CaseResolution {
  return {
    id: row.id,
    caseId: row.caseId,
    requestedType: row.requestedType,
    requestedRemedyOptionId: row.requestedRemedyOptionId,
    approvedType: row.approvedType,
    status: row.status,
    refundAmountMinor: row.refundAmountMinor,
    currency: row.currency,
    approvedByStaffUserId: row.approvedByStaffUserId,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    externalReference: row.externalReference,
    completedByStaffUserId: row.completedByStaffUserId,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    version: row.version,
  };
}

const ISO4217 = /^[A-Z]{3}$/;

/**
 * Drizzle-backed CaseResolutionModule. Approve/complete/cancel each open their
 * own transaction so the resolution write, the Case Event, and the Admin Audit
 * Event commit or roll back together (ADR redesign §5.1 / §10).
 */
export class DrizzleCaseResolutionService implements CaseResolutionService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly crypto: SensitiveDataCryptoPort,
  ) {}

  async requestFromSubmission(tx: DatabaseExecutor, input: RequestResolutionInput): Promise<void> {
    await tx.insert(caseResolutions).values({
      caseId: input.caseId,
      requestedType: input.requestedType,
      requestedRemedyOptionId: input.requestedRemedyOptionId,
      status: 'requested',
      version: 1,
    });
    await tx.insert(caseEvents).values({
      caseId: input.caseId,
      eventType: 'resolution.requested',
      actorType: 'system',
      data: { resolutionType: input.requestedType, status: 'requested' },
    });
  }

  async approve(input: ApproveResolutionInput): Promise<CaseResolution> {
    const note = await this.crypto.encrypt(input.note);
    const result = await this.handle.transaction(async (tx) => {
      const locked = await this.lockForUpdate(tx, input.caseId);
      this.assertVersion(locked.version, input.expectedVersion);
      this.assertStatus(locked.status, 'requested', 'approved');

      const resolutionType: CaseResolutionType = input.type;
      let refundAmountMinor: number | null = null;
      let currency: string | null = null;
      if (resolutionType === 'refund') {
        if (!input.refundAmountMinor || input.refundAmountMinor <= 0) {
          throw new ClaimValidationError('refundAmountMinor must be a positive integer.');
        }
        if (!input.currency || !ISO4217.test(input.currency)) {
          throw new ClaimValidationError('currency must be an uppercase ISO 4217 code.');
        }
        refundAmountMinor = input.refundAmountMinor;
        currency = input.currency;
      }

      const [updated] = await tx
        .update(caseResolutions)
        .set({
          approvedType: resolutionType,
          status: 'approved',
          refundAmountMinor,
          currency,
          approvedByStaffUserId: input.actorUserId,
          approvedAt: new Date(),
          approvalNoteEncrypted: note.value,
          approvalNoteKeyVersion: note.keyVersion,
          version: input.expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(caseResolutions.id, locked.id))
        .returning();
      if (!updated) throw new Error('Resolution update returned no row.');

      await tx.insert(caseEvents).values({
        caseId: input.caseId,
        eventType: 'resolution.approved',
        actorType: 'staff',
        actorId: input.actorUserId,
        data: {
          resolutionType,
          ...(refundAmountMinor !== null ? { refundAmountMinor } : {}),
          ...(currency !== null ? { currency } : {}),
        },
      });
      await this.recordAudit(
        tx,
        input.actorUserId,
        input.actorRole,
        'resolution.approve',
        input.caseId,
        locked.id,
        {
          resolutionType,
          ...(refundAmountMinor !== null ? { refundAmountMinor } : {}),
          ...(currency !== null ? { currency } : {}),
        },
      );

      return toCaseResolution(updated);
    });
    return result;
  }

  async recordExternalCompletion(input: CompleteResolutionInput): Promise<CaseResolution> {
    const note = await this.crypto.encrypt(input.note);
    return this.handle.transaction(async (tx) => {
      const locked = await this.lockForUpdate(tx, input.caseId);
      this.assertVersion(locked.version, input.expectedVersion);
      this.assertStatus(locked.status, 'approved', 'externally_completed');

      const [updated] = await tx
        .update(caseResolutions)
        .set({
          status: 'externally_completed',
          externalReference: input.externalReference ?? null,
          completionNoteEncrypted: note.value,
          completionNoteKeyVersion: note.keyVersion,
          completedByStaffUserId: input.actorUserId,
          completedAt: new Date(),
          version: input.expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(caseResolutions.id, locked.id))
        .returning();
      if (!updated) throw new Error('Resolution update returned no row.');

      await tx.insert(caseEvents).values({
        caseId: input.caseId,
        eventType: 'resolution.externally_completed',
        actorType: 'staff',
        actorId: input.actorUserId,
        data: {
          ...(input.externalReference ? { externalReference: input.externalReference } : {}),
        },
      });
      await this.recordAudit(
        tx,
        input.actorUserId,
        input.actorRole,
        'resolution.complete',
        input.caseId,
        locked.id,
        {
          ...(input.externalReference ? { externalReference: input.externalReference } : {}),
        },
      );

      return toCaseResolution(updated);
    });
  }

  async cancel(input: CancelResolutionInput): Promise<CaseResolution> {
    const note = await this.crypto.encrypt(input.note);
    return this.handle.transaction(async (tx) => {
      const locked = await this.lockForUpdate(tx, input.caseId);
      this.assertVersion(locked.version, input.expectedVersion);

      if (locked.status === 'approved' && !input.actorIsAdministrator) {
        throw new ClaimValidationError('Only an administrator may cancel an approved resolution.');
      }
      if (locked.status !== 'requested' && locked.status !== 'approved') {
        throw new ClaimValidationError(
          `Resolution in status '${locked.status}' cannot be cancelled.`,
        );
      }

      const [updated] = await tx
        .update(caseResolutions)
        .set({
          status: 'cancelled',
          completionNoteEncrypted: note.value,
          completionNoteKeyVersion: note.keyVersion,
          version: input.expectedVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(caseResolutions.id, locked.id))
        .returning();
      if (!updated) throw new Error('Resolution update returned no row.');

      await tx.insert(caseEvents).values({
        caseId: input.caseId,
        eventType: 'resolution.cancelled',
        actorType: 'staff',
        actorId: input.actorUserId,
        data: {},
      });
      await this.recordAudit(
        tx,
        input.actorUserId,
        input.actorRole,
        'resolution.cancel',
        input.caseId,
        locked.id,
        {},
      );

      return toCaseResolution(updated);
    });
  }

  async getForCase(caseId: string): Promise<CaseResolution | null> {
    const [row] = await this.handle.db
      .select()
      .from(caseResolutions)
      .where(eq(caseResolutions.caseId, caseId))
      .limit(1);
    return row ? toCaseResolution(row) : null;
  }

  private async lockForUpdate(
    tx: DatabaseExecutor,
    caseId: string,
  ): Promise<typeof caseResolutions.$inferSelect> {
    const [row] = await tx
      .select()
      .from(caseResolutions)
      .where(eq(caseResolutions.caseId, caseId))
      .for('update')
      .limit(1);
    if (!row) throw new ResourceNotFoundError('Case Resolution was not found.');
    return row;
  }

  private assertVersion(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new ClaimConflictError(
        `Resolution version conflict: expected ${expected}, found ${actual}.`,
      );
    }
  }

  private assertStatus(
    actual: CaseResolutionStatus,
    expected: CaseResolutionStatus,
    action: string,
  ): void {
    if (actual !== expected) {
      throw new ClaimValidationError(
        `Resolution must be '${expected}' to ${action}, but is '${actual}'.`,
      );
    }
  }

  private async recordAudit(
    tx: DatabaseExecutor,
    actorUserId: string,
    actorRole: StaffRole,
    action: string,
    caseId: string,
    resolutionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Resolution actions share the case-scoped audit identity (resourceType
    // 'case', resourceId = public reference) so per-case audit queries — the
    // case detail trail, /access filters — see them alongside status
    // transitions. The touched resolution stays identified in metadata.
    const [caseRow] = await tx
      .select({ reference: recallCases.publicReference })
      .from(recallCases)
      .where(eq(recallCases.id, caseId))
      .limit(1);
    if (!caseRow) throw new Error('Resolution audit could not resolve the case reference.');
    await tx.insert(adminAuditEvents).values({
      actorUserId,
      actorRole,
      action,
      resourceType: 'case',
      resourceId: caseRow.reference,
      outcome: 'success',
      metadata: { ...metadata, resolutionId },
    });
  }
}
