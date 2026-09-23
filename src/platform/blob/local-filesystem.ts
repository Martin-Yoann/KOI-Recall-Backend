import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

import type {
  BlobAccessUrl,
  PrivateBlobPort,
  UploadAuthorization,
  UploadAuthorizationRequest,
  UploadCompletion,
} from './port.js';

/** How long a minted client-upload token remains usable. Matches the real store. */
const CLIENT_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Where the objects live when no directory is configured. */
const DEFAULT_ROOT = '.local-storage/blobs';

interface TokenEnvelope {
  pathname: string;
  documentId: string;
  fileName: string;
  mimeType: string;
  expiresAt: number;
}

/**
 * A `PrivateBlobPort` over the local filesystem, for development.
 *
 * The real store is reached through `@vercel/blob/client`'s `put()`, which performs
 * the transfer itself and cannot be pointed at a filesystem — so this adapter only
 * covers the server half. The development upload route writes objects here through
 * {@link writeObject}, and the browser's development branch posts to that route
 * instead of calling `put()`.
 *
 * Objects are stored under `root` at their pathname, with a sibling `.meta.json`
 * carrying the content type and size: a filesystem has no equivalent of the store's
 * metadata, and `handleUploadCallback` has to report the same authoritative values
 * the real callback does.
 *
 * The client token is a signed envelope rather than an opaque string, so an upload
 * can be validated without keeping server state — the same constraint the real
 * token imposes, and the reason a restart cannot orphan an in-flight upload.
 */
export class LocalFilesystemBlobAdapter implements PrivateBlobPort {
  private readonly root: string;
  private readonly signingKey: Buffer;

  constructor(options: { root?: string; signingKey?: string } = {}) {
    this.root = options.root ?? process.env.LOCAL_BLOB_DIR ?? DEFAULT_ROOT;
    // Ephemeral by default: a local restart simply invalidates outstanding tokens.
    this.signingKey = options.signingKey
      ? Buffer.from(options.signingKey, 'base64')
      : randomBytes(32);
  }

  authorizeClientUpload(request: UploadAuthorizationRequest): Promise<UploadAuthorization> {
    const pathname = localPathname(request);
    const expiresAt = Date.now() + CLIENT_TOKEN_TTL_MS;
    const envelope: TokenEnvelope = {
      pathname,
      documentId: request.documentId,
      fileName: request.fileName,
      mimeType: request.mimeType,
      expiresAt,
    };
    return Promise.resolve({
      pathname,
      clientToken: this.sign(envelope),
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  /**
   * Writes an object for a client token, the way the development upload route does.
   * Returns the completion so the caller can reconcile the `document_uploads` row,
   * and refuses a token that does not cover the pathname being written.
   */
  async writeObject(
    clientToken: string,
    pathname: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<UploadCompletion> {
    const envelope = this.verify(clientToken);
    if (!envelope) throw new Error('This upload token is not valid or has expired.');
    if (envelope.pathname !== pathname) {
      throw new Error('This upload token does not cover the object being written.');
    }

    const target = this.resolve(pathname);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    await writeFile(
      `${target}.meta.json`,
      JSON.stringify({ contentType, sizeBytes: bytes.byteLength }),
    );

    return {
      documentId: envelope.documentId,
      detectedMimeType: contentType,
      sizeBytes: bytes.byteLength,
      pathname,
    };
  }

  /**
   * Reconciles an upload. The local flow has no store to post a callback, so the
   * development upload route passes the token and pathname in the body instead of
   * the store's signed event — the shape the domain expects is unchanged.
   */
  async handleUploadCallback(request: Request): Promise<UploadCompletion | null> {
    let body: { clientToken?: unknown; pathname?: unknown };
    try {
      body = (await request.clone().json()) as typeof body;
    } catch {
      return null;
    }
    const clientToken = typeof body.clientToken === 'string' ? body.clientToken : null;
    const pathname = typeof body.pathname === 'string' ? body.pathname : null;
    if (!clientToken || !pathname) return null;

    const envelope = this.verify(clientToken);
    if (!envelope || envelope.pathname !== pathname) return null;

    const target = this.resolve(pathname);
    const metadata = await this.readMetadata(target, envelope.mimeType);
    if (!metadata) return null;

    return {
      documentId: envelope.documentId,
      detectedMimeType: metadata.contentType,
      sizeBytes: metadata.sizeBytes,
      pathname,
    };
  }

  async delete(pathname: string): Promise<void> {
    const target = this.resolve(pathname);
    await rm(target, { force: true });
    await rm(`${target}.meta.json`, { force: true });
  }

  /**
   * Locally the object is served by the development route, which re-checks the
   * caller's authorization; there is no signed URL to mint.
   */
  async createAccessUrl(pathname: string): Promise<BlobAccessUrl> {
    const target = this.resolve(pathname);
    const metadata = await this.readMetadata(target, 'application/octet-stream');
    if (!metadata) throw new Error(`No local object at ${pathname}.`);
    // Pathnames are POSIX-style, matching the real store — splitting on the
    // platform separator would leave the whole path as one segment on Windows and
    // percent-encode the slashes.
    const url = `/dev/blobs/${pathname.split('/').map(encodeURIComponent).join('/')}`;
    return { url, downloadUrl: `${url}?download=1`, contentType: metadata.contentType };
  }

  /** Absolute path of an object, refusing anything that escapes the root. */
  private resolve(pathname: string): string {
    const root = normalize(this.root);
    const target = normalize(join(root, pathname));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error('A blob pathname may not escape the storage root.');
    }
    return target;
  }

  private async readMetadata(
    target: string,
    fallbackContentType: string,
  ): Promise<{ contentType: string; sizeBytes: number } | null> {
    try {
      const raw = await readFile(`${target}.meta.json`, 'utf8');
      const parsed = JSON.parse(raw) as { contentType?: unknown; sizeBytes?: unknown };
      const sizeBytes =
        typeof parsed.sizeBytes === 'number' ? parsed.sizeBytes : (await stat(target)).size;
      return {
        contentType:
          typeof parsed.contentType === 'string' ? parsed.contentType : fallbackContentType,
        sizeBytes,
      };
    } catch {
      return null;
    }
  }

  private sign(envelope: TokenEnvelope): string {
    const payload = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  private verify(clientToken: string): TokenEnvelope | null {
    const [payload, signature] = clientToken.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(this.signature(payload), 'utf8');
    const provided = Buffer.from(signature, 'utf8');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
    try {
      const envelope = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as TokenEnvelope;
      if (typeof envelope.pathname !== 'string' || typeof envelope.documentId !== 'string')
        return null;
      if (typeof envelope.expiresAt !== 'number' || envelope.expiresAt <= Date.now()) return null;
      return envelope;
    } catch {
      return null;
    }
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.signingKey).update(payload).digest('base64url');
  }
}

/** Mirrors the real store's pathname, so switching stores moves no pointers. */
function localPathname(request: UploadAuthorizationRequest): string {
  return `drafts/${request.draftId}/${request.documentId}/${sanitize(request.fileName)}`;
}

/** Keeps the pathname component free of path separators and control chars. */
function sanitize(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}
