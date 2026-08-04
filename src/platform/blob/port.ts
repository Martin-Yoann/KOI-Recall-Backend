export interface UploadAuthorizationRequest {
  draftId: string;
  documentId: string;
  category: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadAuthorization {
  uploadUrl: string;
  clientToken: string;
  expiresAt: string;
}

export interface PrivateBlobPort {
  authorizeClientUpload(request: UploadAuthorizationRequest): Promise<UploadAuthorization>;
  delete(pathname: string): Promise<void>;
}
