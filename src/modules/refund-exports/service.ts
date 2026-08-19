import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

import type { DatabaseHandle } from '../../db/client.js';
import { adminAuditEvents, caseResolutions, recallCases, refundExportBatches, refundExportItems } from '../../db/schema/index.js';
import type { StaffRole } from '../staff/permissions.js';

export interface RefundExportInput {
  actorUserId: string;
  actorRole: StaffRole;
  purpose: string;
  includeExported?: boolean;
}

export interface RefundExportResult {
  batchId: string;
  rowCount: number;
  sha256: string;
  csv: string;
}

const CSV_HEADERS = ['caseReference', 'resolutionId', 'amountMinor', 'currency', 'resolutionVersion'];

function csvCell(value: string | number): string {
  const raw = String(value);
  const safe = /^[=+@-]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function renderRefundCsv(rows: readonly { caseReference: string; resolutionId: string; amountMinor: number; currency: string; resolutionVersion: number }[]): string {
  return [CSV_HEADERS.join(','), ...rows.map((row) => [row.caseReference, row.resolutionId, row.amountMinor, row.currency, row.resolutionVersion].map(csvCell).join(','))].join('\r\n') + '\r\n';
}

export class RefundExportService {
  constructor(private readonly handle: DatabaseHandle) {}

  async export(input: RefundExportInput): Promise<RefundExportResult> {
    if (input.purpose.trim().length === 0 || input.purpose.length > 500) throw new Error('purpose must be 1-500 characters.');
    return this.handle.transaction(async (tx) => {
      const resolutions = await tx.select({ id: caseResolutions.id, caseId: caseResolutions.caseId, amountMinor: caseResolutions.refundAmountMinor, currency: caseResolutions.currency, version: caseResolutions.version })
        .from(caseResolutions).where(and(eq(caseResolutions.approvedType, 'refund'), eq(caseResolutions.status, 'externally_completed')));
      const ids = resolutions.map((row) => row.id);
      const prior = input.includeExported || ids.length === 0 ? [] : await tx.select({ caseResolutionId: refundExportItems.caseResolutionId }).from(refundExportItems).where(inArray(refundExportItems.caseResolutionId, ids));
      const priorIds = new Set(prior.map((row) => row.caseResolutionId));
      const selected = resolutions.filter((row) => input.includeExported || !priorIds.has(row.id));
      if (selected.length === 0) throw new Error('No refund resolutions are eligible for export.');
      const caseIds = selected.map((row) => row.caseId);
      const cases = await tx.select({ id: recallCases.id, reference: recallCases.publicReference }).from(recallCases).where(inArray(recallCases.id, caseIds));
      const referenceById = new Map(cases.map((row) => [row.id, row.reference]));
      const rows = selected.map((row) => ({ caseReference: referenceById.get(row.caseId) ?? row.caseId, resolutionId: row.id, amountMinor: row.amountMinor ?? 0, currency: row.currency ?? '', resolutionVersion: row.version }));
      const csv = renderRefundCsv(rows);
      const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
      const [batch] = await tx.insert(refundExportBatches).values({ requestedByStaffUserId: input.actorUserId, purpose: input.purpose, rowCount: rows.length, fileSha256: sha256 }).returning({ id: refundExportBatches.id });
      if (!batch) throw new Error('Refund export batch was not created.');
      await tx.insert(refundExportItems).values(selected.map((row, index) => ({ exportBatchId: batch.id, caseResolutionId: row.id, resolutionVersion: row.version, rowSha256: createHash('sha256').update(csv.split('\r\n')[index + 1] ?? '').digest('hex') })));
      await tx.insert(adminAuditEvents).values({ actorUserId: input.actorUserId, actorRole: input.actorRole, action: 'refund.export', resourceType: 'refund_export', resourceId: batch.id, outcome: 'success', metadata: { rowCount: rows.length, fileSha256: sha256, purpose: input.purpose } });
      return { batchId: batch.id, rowCount: rows.length, sha256, csv };
    });
  }
}
