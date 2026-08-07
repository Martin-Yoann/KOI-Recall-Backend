import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Database, DatabaseHandle } from '../../db/client.js';
import {
  campaignEvidenceRequirements,
  claimDrafts,
  documentUploads,
  webhookEvents,
} from '../../db/schema/index.js';
import type { documentUploadStatusEnum } from '../../db/schema/index.js';
import type { PrivateBlobPort, UploadCompletion } from '../../platform/blob/port.js';
import {
  DraftExpiredOrInvalidError,
  EvidenceRulesViolationError,
  isUniqueViolation,
  PayloadTooLargeError,
  ResourceNotFoundError,
  UnsupportedMediaTypeError,
} from '../../shared/errors.js';
import { hashDraftToken } from '../claim-drafts/tokens.js';
import type { AuthorizeUploadInput, DocumentService, AuthorizedUpload } from './service.js';

/** The full union of `document_uploads.upload_status` values. */
type DocumentUploadStatus = (typeof documentUploadStatusEnum.enumValues)[number];

/**
 * Statuses eligible for soft deletion (advance to `deletion_pending`). Rows
 * already pending or deleted are treated as idempotently deleted.
 */
const DELETABLE_UPLOAD_STATUSES = ['authorized', 'uploaded', 'verified'] as const;

/** How long a draft-owned document authorization remains valid. Matches the draft TTL. */
const DOCUMENT_AUTHORIZATION_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Persists draft-owned document uploads in Postgres via Drizzle and obtains
 * short-lived Private Blob client-upload authorizations. The injected
 * {@link Database} is the dual-adapter union; the {@link PrivateBlobPort}
 * isolates the blob provider so the service is testable without Vercel.
 */
export class DrizzleDocumentService implements DocumentService {
  constructor(
    private readonly db: Database,
    private readonly blob: PrivateBlobPort,
    private readonly transaction: DatabaseHandle['transaction'],
  ) {}

  async authorizeUpload(input: AuthorizeUploadInput): Promise<AuthorizedUpload> {
    const db = this.db;

    // Evidence rules are pinned to the draft's bound campaign version, not the
    // campaign's current published version: a draft may outlive a republish,
    // and the submit-time re-check must use the same rules the draft saw.
    const [draft] = await db
      .select({ campaignVersionId: claimDrafts.campaignVersionId })
      .from(claimDrafts)
      .where(eq(claimDrafts.id, input.draftId))
      .limit(1);
    if (!draft) throw new ResourceNotFoundError('Draft was not found or is no longer accessible.');

    const [rule] = await db
      .select({
        allowedMimeTypes: campaignEvidenceRequirements.allowedMimeTypes,
        maximumFileSizeBytes: campaignEvidenceRequirements.maximumFileSizeBytes,
        maximumFiles: campaignEvidenceRequirements.maximumFiles,
      })
      .from(campaignEvidenceRequirements)
      .where(
        and(
          eq(campaignEvidenceRequirements.campaignVersionId, draft.campaignVersionId),
          eq(campaignEvidenceRequirements.category, input.category),
        ),
      )
      .limit(1);
    if (!rule) {
      throw new EvidenceRulesViolationError(
        `Evidence category '${input.category}' is not accepted by this campaign.`,
      );
    }

    if (input.sizeBytes > rule.maximumFileSizeBytes) {
      throw new PayloadTooLargeError(
        `File size ${input.sizeBytes} bytes exceeds the ${rule.maximumFileSizeBytes}-byte limit for category '${input.category}'.`,
      );
    }
    if (!rule.allowedMimeTypes.includes(input.mimeType)) {
      throw new UnsupportedMediaTypeError(
        `Media type '${input.mimeType}' is not allowed for category '${input.category}'.`,
      );
    }

    const documentId = randomUUID();
    // storagePathname is unique. This constrained upload target is returned
    // once with the client token; the provider adds a random suffix and the
    // callback replaces this provisional value with the final pathname.
    const storagePathname = `drafts/${input.draftId}/${documentId}/${sanitizeFileName(input.fileName)}`;
    const expiresAt = new Date(Date.now() + DOCUMENT_AUTHORIZATION_TTL_MS);

    let inserted = false;
    for (let categorySlot = 1; categorySlot <= rule.maximumFiles; categorySlot += 1) {
      try {
        const rows = await db
          .insert(documentUploads)
          .values({
            id: documentId,
            draftId: input.draftId,
            category: input.category,
            categorySlot,
            storagePathname,
            originalFileName: input.fileName,
            declaredMimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            uploadStatus: 'authorized',
            expiresAt,
          })
          .returning();
        if (!rows[0]) throw new Error('Document upload insert returned no row.');
        inserted = true;
        break;
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }
    if (!inserted) {
      throw new EvidenceRulesViolationError(
        `Category '${input.category}' accepts at most ${rule.maximumFiles} file(s) per draft.`,
      );
    }

    let authorization;
    try {
      authorization = await this.blob.authorizeClientUpload({
        draftId: input.draftId,
        documentId,
        category: input.category,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      });
    } catch (error) {
      // The document row exists but no client can ever complete an upload
      // against it; remove it so the per-category count and cleanup index stay
      // accurate. This best-effort delete happens after the Blob authorization
      // failed; a leftover row would be reaped by the draft-cleanup job via the
      // expiresAt index.
      await db
        .delete(documentUploads)
        .where(eq(documentUploads.id, documentId))
        .execute()
        .catch((deleteError) => {
          console.error('Failed to roll back orphaned document upload', {
            documentId,
            name: deleteError instanceof Error ? deleteError.name : 'unknown',
          });
        });
      throw error;
    }

    return {
      documentId,
      pathname: authorization.pathname,
      clientToken: authorization.clientToken,
      expiresAt: authorization.expiresAt,
    };
  }

  async scheduleDraftDocumentDeletion(
    draftId: string,
    documentId: string,
    draftToken: string,
  ): Promise<void> {
    const now = new Date();
    await this.transaction(async (tx) => {
      const [draft] = await tx
        .select({
          tokenHash: claimDrafts.tokenHash,
          status: claimDrafts.status,
          expiresAt: claimDrafts.expiresAt,
        })
        .from(claimDrafts)
        .where(eq(claimDrafts.id, draftId))
        .for('update');
      if (
        !draft ||
        draft.tokenHash !== hashDraftToken(draftToken) ||
        draft.status !== 'active' ||
        draft.expiresAt.getTime() <= now.getTime()
      ) {
        throw new DraftExpiredOrInvalidError(
          'The draft token is invalid, or the draft is no longer active or has expired.',
        );
      }

      const [document] = await tx
        .select({
          draftId: documentUploads.draftId,
          caseId: documentUploads.caseId,
          uploadStatus: documentUploads.uploadStatus,
        })
        .from(documentUploads)
        .where(eq(documentUploads.id, documentId))
        .for('update');
      if (!document || document.draftId !== draftId || document.caseId !== null) {
        throw new ResourceNotFoundError('Document was not found for this draft.');
      }

      const deletable = DELETABLE_UPLOAD_STATUSES as readonly DocumentUploadStatus[];
      if (!deletable.includes(document.uploadStatus)) return;

      const [updated] = await tx
        .update(documentUploads)
        .set({ uploadStatus: 'deletion_pending', categorySlot: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(documentUploads.id, documentId),
            eq(documentUploads.draftId, draftId),
            isNull(documentUploads.caseId),
            inArray(documentUploads.uploadStatus, DELETABLE_UPLOAD_STATUSES),
          ),
        )
        .returning({ id: documentUploads.id });
      if (!updated) throw new ResourceNotFoundError('Document was not found for this draft.');
    });
  }

  async reconcileCompletedUpload(
    completion: UploadCompletion,
    event: { providerEventId: string; eventType: string; payload: Record<string, unknown> },
  ): Promise<boolean> {
    const db = this.db;

    // Atomically claim a new or retryable event. An event already marked
    // processed does not satisfy setWhere, so RETURNING is empty
    // and the duplicate can be acknowledged without doing work twice. A stale
    // processing row is reclaimable because recording a failure can itself be
    // interrupted by a database outage.
    const [claimedEvent] = await db
      .insert(webhookEvents)
      .values({
        provider: 'vercel-blob',
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        payload: event.payload,
        status: 'processing',
      })
      .onConflictDoUpdate({
        target: [webhookEvents.provider, webhookEvents.providerEventId],
        set: {
          status: 'processing',
          payload: event.payload,
          lastErrorCode: null,
        },
        setWhere: inArray(webhookEvents.status, ['received', 'processing', 'failed']),
      })
      .returning();
    if (!claimedEvent) return false;

    try {
      // Reconcile the document row. A divergence between the declared and
      // detected media type rejects the upload rather than surfacing it to the
      // claim submit transaction.
      const [document] = await db
        .select({
          declaredMimeType: documentUploads.declaredMimeType,
          status: documentUploads.uploadStatus,
        })
        .from(documentUploads)
        .where(eq(documentUploads.id, completion.documentId))
        .limit(1);

      if (
        document &&
        (document.status === 'authorized' || document.status === 'deletion_pending')
      ) {
        const deletionRequested = document.status === 'deletion_pending';
        const rejected =
          !!document.declaredMimeType && document.declaredMimeType !== completion.detectedMimeType;
        await db
          .update(documentUploads)
          .set({
            uploadStatus: deletionRequested
              ? 'deletion_pending'
              : rejected
                ? 'rejected'
                : 'verified',
            ...(deletionRequested || rejected ? { categorySlot: null } : {}),
            storagePathname: completion.pathname,
            detectedMimeType: completion.detectedMimeType,
            sizeBytes: completion.sizeBytes,
            uploadedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(documentUploads.id, completion.documentId))
          .execute();
      }

      await db
        .update(webhookEvents)
        .set({
          status: 'processed',
          processedAt: sql`now()`,
          lastErrorCode: null,
        })
        .where(eq(webhookEvents.id, claimedEvent.id))
        .execute();

      return true;
    } catch (error) {
      await db
        .update(webhookEvents)
        .set({
          status: 'failed',
          lastErrorCode: errorCode(error),
        })
        .where(eq(webhookEvents.id, claimedEvent.id))
        .execute()
        .catch((statusError) => {
          console.error('Failed to record Vercel Blob webhook failure', {
            providerEventId: event.providerEventId,
            name: statusError instanceof Error ? statusError.name : 'unknown',
          });
        });
      throw error;
    }
  }
}

/** Keeps the storage path component free of path separators and control chars. */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code.slice(0, 100);
  }
  return (error instanceof Error ? error.name : 'unknown').slice(0, 100);
}
