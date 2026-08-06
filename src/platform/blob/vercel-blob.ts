import { handleUpload } from '@vercel/blob/client';

import type {
  PrivateBlobPort,
  UploadAuthorization,
  UploadAuthorizationRequest,
  UploadCompletion,
} from './port.js';

/** How long a minted client-upload token remains usable. 1 hour. */
const CLIENT_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Vercel Private Blob adapter. Isolates the `@vercel/blob` client-upload token
 * exchange and completion callback behind {@link PrivateBlobPort} so domain
 * code never imports the SDK directly and stays testable without Vercel.
 *
 * The client-upload flow is a token exchange: the browser POSTs to the
 * `handleUploadUrl` (our `upload-tokens` route), the server mints a short-lived
 * token here, and the browser uploads directly to Blob with that token. When
 * the upload finishes, Vercel POSTs an `blob.upload-completed` event to the
 * `callbackUrl` (our `/webhooks/vercel-blob` route), processed via
 * {@link handleUploadCallback}.
 */
export class VercelBlobAdapter implements PrivateBlobPort {
  /**
   * @param handleUploadUrl The public route the browser calls to mint a token
   *   (our `POST /v1/claim-drafts/{draftId}/upload-tokens`). Returned to the
   *   client as `uploadUrl` so it knows where to request the token.
   * @param callbackUrl The route Vercel POSTs upload-completion events to
   *   (our `POST /webhooks/vercel-blob`). May be empty for local dev where
   *   Vercel cannot reach localhost; completion is then best-effort.
   * @param token The `BLOB_READ_WRITE_TOKEN`. Defaults to the env var so the
   *   adapter works without explicit wiring on Vercel.
   */
  constructor(
    private readonly handleUploadUrl: string,
    private readonly callbackUrl: string,
    private readonly token: string | undefined = process.env.BLOB_READ_WRITE_TOKEN,
  ) {}

  async authorizeClientUpload(request: UploadAuthorizationRequest): Promise<UploadAuthorization> {
    // The evidence-rule validation (size, MIME, counts) is performed by the
    // domain DocumentService before this is called; `onBeforeGenerateToken`
    // re-declares the accepted content type and size ceiling so Vercel Blob
    // enforces them server-side as a second line of defense.
    const options: Parameters<typeof handleUpload>[0] = {
      body: {
        type: 'blob.generate-client-token',
        payload: {
          pathname: blobPathname(request),
          multipart: false,
          clientPayload: JSON.stringify({ documentId: request.documentId }),
        },
      },
      request: syntheticRequest(this.handleUploadUrl),
      onBeforeGenerateToken: () => {
        const base = {
          allowedContentTypes: [request.mimeType],
          maximumSizeInBytes: request.sizeBytes,
          addRandomSuffix: true as const,
          tokenPayload: JSON.stringify({ documentId: request.documentId }),
        };
        // `exactOptionalPropertyTypes` forbids `callbackUrl: undefined`, so only
        // include the field when a real URL is configured.
        const value = this.callbackUrl ? { ...base, callbackUrl: this.callbackUrl } : base;
        return Promise.resolve(value);
      },
    };
    if (this.token) options.token = this.token;

    const response = await handleUpload(options);

    if (response.type !== 'blob.generate-client-token') {
      throw new Error(
        `Vercel Blob returned an unexpected event type '${response.type}' during token generation.`,
      );
    }

    return {
      // The client uses the SDK's `upload()` with `handleUploadUrl` pointing
      // here; we surface the route as uploadUrl so the contract field is a
      // usable URL rather than an opaque token-only response.
      uploadUrl: this.handleUploadUrl,
      clientToken: response.clientToken,
      expiresAt: new Date(Date.now() + CLIENT_TOKEN_TTL_MS).toISOString(),
    };
  }

  async handleUploadCallback(request: Request): Promise<UploadCompletion | null> {
    let completion: UploadCompletion | null = null;

    const options: Parameters<typeof handleUpload>[0] = {
      body: (await request.clone().json()) as Parameters<typeof handleUpload>[0]['body'],
      request,
      onBeforeGenerateToken: () =>
        // Completion callbacks should never trigger token generation; an empty
        // allow-list makes any such attempt fail closed.
        Promise.resolve({ allowedContentTypes: [] }),
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const documentId = parseDocumentId(tokenPayload);
        if (!documentId) return;
        // `PutBlobResult` does not include size; `head()` returns the
        // authoritative metadata so the reconciled row reflects the actual
        // uploaded object rather than the client's declared value.
        const metadata = await headBlob(blob.url, this.token);
        completion = {
          documentId,
          detectedMimeType: blob.contentType,
          sizeBytes: metadata.size,
          pathname: blob.pathname,
        };
      },
    };
    if (this.token) options.token = this.token;

    await handleUpload(options);

    return completion;
  }

  async delete(pathname: string): Promise<void> {
    const { del } = await import('@vercel/blob');
    await del(pathname, this.token ? { token: this.token } : undefined);
  }
}

/** Fetches authoritative blob metadata (size) via `head()`. */
async function headBlob(url: string, token: string | undefined): Promise<{ size: number }> {
  const { head } = await import('@vercel/blob');
  const meta = await head(url, token ? { token } : undefined);
  if (!meta) throw new Error(`Blob object not found after upload: ${url}`);
  return { size: meta.size };
}

/** Builds the Private Blob pathname for a draft document. */
function blobPathname(request: UploadAuthorizationRequest): string {
  return `drafts/${request.draftId}/${request.documentId}/${sanitize(request.fileName)}`;
}

/** Extracts the `documentId` we embedded in the token payload, if present. */
function parseDocumentId(tokenPayload: string | null | undefined): string | undefined {
  if (!tokenPayload) return undefined;
  try {
    const parsed = JSON.parse(tokenPayload) as { documentId?: unknown };
    return typeof parsed.documentId === 'string' ? parsed.documentId : undefined;
  } catch {
    return undefined;
  }
}

/** A minimal Request suitable for `handleUpload` signature verification. */
function syntheticRequest(url: string): Request {
  return new Request(url, { method: 'POST' });
}

/** Keeps the pathname component free of path separators and control chars. */
function sanitize(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}
