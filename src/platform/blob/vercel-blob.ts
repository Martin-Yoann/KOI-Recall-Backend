import { generateClientTokenFromReadWriteToken, handleUpload } from '@vercel/blob/client';

import type {
  BlobAccessUrl,
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
 * The client-upload flow returns a constrained token and pathname from our
 * `upload-tokens` route. The browser passes both to `@vercel/blob/client`'s
 * `put()` function and uploads directly to Blob. When the upload finishes,
 * Vercel POSTs a `blob.upload-completed` event to the `callbackUrl`, processed via
 * {@link handleUploadCallback}.
 */
export class VercelBlobAdapter implements PrivateBlobPort {
  /**
   * @param callbackUrl The route Vercel POSTs upload-completion events to
   *   (our `POST /webhooks/vercel-blob`). May be empty for local dev where
   *   Vercel cannot reach localhost; completion is then best-effort.
   * @param token The `BLOB_READ_WRITE_TOKEN`. Defaults to the env var so the
   *   adapter works without explicit wiring on Vercel.
   */
  constructor(
    private readonly callbackUrl: string,
    private readonly token: string | undefined = process.env.BLOB_READ_WRITE_TOKEN,
  ) {}

  async authorizeClientUpload(request: UploadAuthorizationRequest): Promise<UploadAuthorization> {
    // The evidence-rule validation (size, MIME, counts) is performed by the
    // domain DocumentService before this is called; the signed token repeats
    // the accepted content type and size ceiling so Vercel Blob enforces them
    // server-side as a second line of defense.
    const pathname = blobPathname(request);
    const expiresAt = Date.now() + CLIENT_TOKEN_TTL_MS;
    const tokenPayload = JSON.stringify({ documentId: request.documentId });
    const clientToken = await generateClientTokenFromReadWriteToken({
      pathname,
      allowedContentTypes: [request.mimeType],
      maximumSizeInBytes: request.sizeBytes,
      addRandomSuffix: true,
      validUntil: expiresAt,
      ...(this.callbackUrl
        ? { onUploadCompleted: { callbackUrl: this.callbackUrl, tokenPayload } }
        : {}),
      ...(this.token ? { token: this.token } : {}),
    });

    return {
      pathname,
      clientToken,
      expiresAt: new Date(expiresAt).toISOString(),
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

  async createAccessUrl(pathname: string): Promise<BlobAccessUrl> {
    const { head, issueSignedToken, presignUrl } = await import('@vercel/blob');
    // `head()` supplies the authoritative content type. On private stores the
    // URLs it returns are the canonical object URLs — not browser-fetchable —
    // so mint a short-lived presigned GET URL the admin client can use directly.
    const [meta, token] = await Promise.all([
      head(pathname, this.token ? { token: this.token } : undefined),
      issueSignedToken({
        pathname,
        ...(this.token ? { token: this.token } : {}),
      }),
    ]);
    const { presignedUrl } = await presignUrl(
      { clientSigningToken: token.clientSigningToken, delegationToken: token.delegationToken },
      { operation: 'get', pathname, access: 'private' },
    );
    return { url: presignedUrl, downloadUrl: presignedUrl, contentType: meta.contentType };
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

/** Keeps the pathname component free of path separators and control chars. */
function sanitize(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}
