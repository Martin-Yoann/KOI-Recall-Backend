import type { EvidenceCategory, UploadCompletion } from '../../platform/blob/port.js';
import type { DraftDocumentStatus, DraftDocumentStatusReason } from '../../contracts/toc.js';

/**
 * The result of authorizing a draft document upload: the server-generated
 * {@link documentId} plus the short-lived blob authorization the browser uses
 * to upload directly to Private Blob. The shape mirrors the
 * `UploadTokenResponse` Zod contract, so the route handler can parse the
 * service result directly as the HTTP response body.
 */
export interface AuthorizedUpload {
  documentId: string;
  pathname: string;
  clientToken: string;
  expiresAt: string;
}

/**
 * One entry of the draft documents listing (consumer-front contract §7).
 * Mirrors the `DraftDocument` Zod contract; the six-state model is derived,
 * not stored — see `deriveDocumentStatus`.
 */
export interface DraftDocumentSummary {
  documentId: string;
  category: EvidenceCategory;
  fileName: string;
  status: DraftDocumentStatus;
  statusReason: DraftDocumentStatusReason | null;
  uploadedAt: string | null;
  lastStatusChangedAt: string;
}

/**
 * The input to {@link DocumentService.authorizeUpload}. Mirrors the
 * `UploadTokenRequest` Zod contract plus the draft path parameter; the
 * `documentId` is generated server-side and therefore not part of the request.
 */
export interface AuthorizeUploadInput {
  draftId: string;
  category: EvidenceCategory;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DocumentService {
  /**
   * Validates the upload against the draft's bound campaign-version evidence
   * rules (category, MIME type, size, per-category file counts), persists a
   * draft-owned `document_uploads` row in the `authorized` state, and obtains
   * a short-lived Private Blob client-upload authorization. Throws a typed
   * {@link HttpProblemError} for 413/415/422/404 conditions; throws on
   * connection failures for the caller to map to 503.
   */
  authorizeUpload(input: AuthorizeUploadInput): Promise<AuthorizedUpload>;

  /**
   * Authenticates the caller's draft token (same contract as
   * {@link scheduleDraftDocumentDeletion}: valid token, active draft, not
   * expired) and returns the draft's documents in stable order with their
   * derived six-state status. Deletion-pending, deleted, and case-linked rows
   * are excluded so the list reflects DELETE and submission immediately.
   * Throws {@link DraftExpiredOrInvalidError} for an invalid token or a draft
   * that is no longer active.
   */
  listDraftDocuments(draftId: string, draftToken: string): Promise<DraftDocumentSummary[]>;

  /**
   * Authenticates and locks the active Draft, then locks and conditionally marks
   * its unlinked Document as `deletion_pending` in the same transaction. The
   * actual Private Blob object is removed later by the cleanup job. Idempotent
   * for rows already pending or deleted. Throws {@link ResourceNotFoundError}
   * when the Document does not belong to the Draft.
   */
  scheduleDraftDocumentDeletion(
    draftId: string,
    documentId: string,
    draftToken: string,
  ): Promise<void>;

  /**
   * Reconciles a completed Private Blob upload. Records the webhook event for
   * idempotent deduplication (by provider + event id), then updates the
   * matching `document_uploads` row with the detected MIME type and actual
   * size, advancing it to `verified` — or `rejected` when the detected media
   * type diverges from the declared one. Returns `true` when the event was
   * newly processed, or `false` when it was a duplicate of an already-handled
   * event (so the caller can still answer Vercel with 200).
   */
  reconcileCompletedUpload(
    completion: UploadCompletion,
    event: { providerEventId: string; eventType: string; payload: Record<string, unknown> },
  ): Promise<boolean>;
}
