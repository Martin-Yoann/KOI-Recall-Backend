import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import {
  campaignEvidenceRequirements,
  claimDrafts,
  documentUploads,
  webhookEvents,
} from '../../db/schema/index.js';
import type { documentUploadStatusEnum } from '../../db/schema/index.js';
import type { PrivateBlobPort, UploadCompletion } from '../../platform/blob/port.js';
import {
  EvidenceRulesViolationError,
  isUniqueViolation,
  PayloadTooLargeError,
  ResourceNotFoundError,
  UnsupportedMediaTypeError,
} from '../../shared/errors.js';
import type { AuthorizeUploadInput, DocumentService, AuthorizedUpload } from './service.js';

/** The full union of `document_uploads.upload_status` values. */
type DocumentUploadStatus = (typeof documentUploadStatusEnum.enumValues)[number];

/**
 * Statuses that represent a document still owned by an unsubmitted draft and
 * therefore still count toward the draft's per-category file limits.
 */
const COUNTED_UPLOAD_STATUSES = ['authorized', 'uploaded', 'verified', 'linked'] as const;

/**
 * Statuses eligible for soft deletion (advance to `deletion_pending`). Rows
 * already pending or deleted are treated as idempotently deleted.
 */
const DELETABLE_UPLOAD_STATUSES = ['authorized', 'uploaded', 'verified', 'linked'] as const;

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

    const countedStatuses = COUNTED_UPLOAD_STATUSES as unknown as DocumentUploadStatus[];
    const [existing] = await db
      .select({ counted: count() })
      .from(documentUploads)
      .where(
        and(
          eq(documentUploads.draftId, input.draftId),
          eq(documentUploads.category, input.category),
          inArray(documentUploads.uploadStatus, countedStatuses),
        ),
      );
    if ((existing?.counted ?? 0) + 1 > rule.maximumFiles) {
      throw new EvidenceRulesViolationError(
        `Category '${input.category}' accepts at most ${rule.maximumFiles} file(s) per draft.`,
      );
    }

    const documentId = randomUUID();
    // storagePathname is unique (uniqueIndex) and never exposed in any HTTP
    // response; the random suffix on the blob object is added by the provider,
    // but this deterministic prefix lets the callback reconcile the document.
    const storagePathname = `drafts/${input.draftId}/${documentId}/${sanitizeFileName(input.fileName)}`;
    const expiresAt = new Date(Date.now() + DOCUMENT_AUTHORIZATION_TTL_MS);

    const inserted = await db
      .insert(documentUploads)
      .values({
        id: documentId,
        draftId: input.draftId,
        category: input.category,
        storagePathname,
        originalFileName: input.fileName,
        declaredMimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadStatus: 'authorized',
        expiresAt,
      })
      .returning();
    // A missing row would indicate an unexpected driver/database state (e.g. a
    // constraint we did not anticipate); surface it as a 500 rather than
    // continuing to mint a blob token for an unpersisted document. We already
    // generated `documentId`, so the row contents are not needed here.
    if (!inserted[0]) throw new Error('Document upload insert returned no row.');

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
      // accurate. This best-effort delete is outside any transaction (Neon HTTP
      // has no interactive transactions); a leftover row would be reaped by the
      // draft-cleanup job via the expiresAt index.
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
      uploadUrl: authorization.uploadUrl,
      clientToken: authorization.clientToken,
      expiresAt: authorization.expiresAt,
    };
  }

  async scheduleDraftDocumentDeletion(draftId: string, documentId: string): Promise<void> {
    const db = this.db;

    const [document] = await db
      .select({ uploadStatus: documentUploads.uploadStatus })
      .from(documentUploads)
      .where(and(eq(documentUploads.id, documentId), eq(documentUploads.draftId, draftId)))
      .limit(1);

    if (!document) throw new ResourceNotFoundError('Document was not found for this draft.');

    // Idempotent: an already-scheduled or deleted document is a no-op success.
    const deletable = DELETABLE_UPLOAD_STATUSES as readonly DocumentUploadStatus[];
    if (!deletable.includes(document.uploadStatus)) return;

    await db
      .update(documentUploads)
      .set({ uploadStatus: 'deletion_pending', updatedAt: sql`now()` })
      .where(eq(documentUploads.id, documentId))
      .execute();
  }

  async reconcileCompletedUpload(
    completion: UploadCompletion,
    event: { providerEventId: string; eventType: string; payload: Record<string, unknown> },
  ): Promise<boolean> {
    const db = this.db;

    // Deduplication: the (provider, providerEventId) unique index makes a
    // duplicate insert fail with SQLSTATE 23505. Neon HTTP has no interactive
    // transactions, so we insert first; a unique violation means Vercel
    // redelivered an event we already handled.
    try {
      await db.insert(webhookEvents).values({
        provider: 'vercel-blob',
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        payload: event.payload,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }

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

    if (document && document.status === 'authorized') {
      const rejected =
        !!document.declaredMimeType && document.declaredMimeType !== completion.detectedMimeType;
      await db
        .update(documentUploads)
        .set({
          uploadStatus: rejected ? 'rejected' : 'verified',
          detectedMimeType: completion.detectedMimeType,
          sizeBytes: completion.sizeBytes,
          uploadedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(documentUploads.id, completion.documentId))
        .execute();
    }

    return true;
  }
}

/** Keeps the storage path component free of path separators and control chars. */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}
