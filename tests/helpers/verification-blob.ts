import type {
  BlobAccessUrl,
  PrivateBlobPort,
  UploadAuthorization,
  UploadCompletion,
} from '../../src/platform/blob/port.js';

/**
 * A blob port that records calls and fails closed on the paths a test is not
 * exercising, so an unexpected call is visible rather than silently permissive.
 */
export class VerificationRequiredBlob implements PrivateBlobPort {
  /** When set, authorizes immediately with this pathname (upload-path tests). */
  constructor(private readonly authorizePathname?: (input: unknown) => string) {}

  authorizeClientUpload(input: unknown): Promise<UploadAuthorization> {
    if (!this.authorizePathname) {
      return Promise.reject(new Error('authorizeClientUpload was not expected by this test.'));
    }
    return Promise.resolve({
      pathname: this.authorizePathname(input),
      clientToken: 'test-client-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  handleUploadCallback(): Promise<UploadCompletion | null> {
    return Promise.resolve(null);
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  createAccessUrl(): Promise<BlobAccessUrl> {
    return Promise.reject(new Error('createAccessUrl was not expected by this test.'));
  }
}
