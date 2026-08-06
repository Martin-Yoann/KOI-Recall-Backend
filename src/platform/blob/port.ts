/** The evidence categories a draft document may belong to. */
export type EvidenceCategory = 'product_photo' | 'proof_of_purchase' | 'incident_evidence';

export interface UploadAuthorizationRequest {
  draftId: string;
  documentId: string;
  category: EvidenceCategory;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadAuthorization {
  pathname: string;
  clientToken: string;
  expiresAt: string;
}

/**
 * The outcome of a blob upload-completion callback, used to reconcile the
 * `document_uploads` row with the actually-uploaded blob metadata.
 */
export interface UploadCompletion {
  documentId: string;
  detectedMimeType: string;
  sizeBytes: number;
  pathname: string;
}

export interface PrivateBlobPort {
  /**
   * Mints a short-lived client-upload token for a draft document. The token
   * authorizes a browser to upload one object directly to Private Blob; the
   * completion is later reconciled through {@link handleUploadCallback}.
   */
  authorizeClientUpload(request: UploadAuthorizationRequest): Promise<UploadAuthorization>;

  /**
   * Processes a raw Vercel Blob upload-completion webhook request (verifying
   * its signature) and returns the reconciled upload metadata, or `null` when
   * the request is not an upload-completion event (e.g. a token-generation
   * event routed here by mistake).
   */
  handleUploadCallback(request: Request): Promise<UploadCompletion | null>;

  /** Deletes a Private Blob object by its pathname. */
  delete(pathname: string): Promise<void>;
}
