import type { EvidenceCategory, UploadCompletion } from '../../platform/blob/port.js';

/**
 * The result of authorizing a draft document upload: the server-generated
 * {@link documentId} plus the short-lived blob authorization the browser uses
 * to upload directly to Private Blob. The shape mirrors the
 * `UploadTokenResponse` Zod contract, so the route handler can parse the
 * service result directly as the HTTP response body.
 */
export interface AuthorizedUpload {
  documentId: string;
  uploadUrl: string;
  clientToken: string;
  expiresAt: string;
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
   * Marks an unsubmitted draft document as `deletion_pending`. The actual
   * Private Blob object is removed later by the cleanup job; this only
   * advances the row's state machine. Idempotent for rows already pending or
   * deleted. Throws {@link ResourceNotFoundError} when the document does not
   * belong to the draft.
   */
  scheduleDraftDocumentDeletion(draftId: string, documentId: string): Promise<void>;

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
