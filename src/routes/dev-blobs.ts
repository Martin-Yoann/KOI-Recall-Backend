import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import type { AppEnv } from '../middleware/request-context.js';
import { LocalFilesystemBlobAdapter } from '../platform/blob/local-filesystem.js';
import { NotImplementedServiceError } from '../shared/errors.js';

/**
 * The development upload endpoint.
 *
 * The real flow hands the browser a token and lets it transfer the file to the
 * store, which then posts a completion callback. There is no store locally, so
 * this route stands in for both halves: it receives the bytes, writes them through
 * the filesystem adapter, and runs the same reconciliation the webhook runs — the
 * `document_uploads` row reaches `verified` by the same call, so nothing
 * downstream can tell the difference.
 *
 * Registered only when the filesystem adapter is the configured one, so no
 * deployment gains a route that accepts writes.
 */
export function registerDevBlobRoutes(
  app: OpenAPIHono<AppEnv>,
  registry: ApplicationRegistry,
): void {
  const blob = registry.platform.blob;
  if (!(blob instanceof LocalFilesystemBlobAdapter)) return;

  app.post('/dev/blobs/upload', async (context) => {
    const pathname = context.req.query('pathname');
    const clientToken = context.req.header('X-Blob-Token');
    if (!pathname || !clientToken) {
      return context.json({ detail: 'pathname and X-Blob-Token are required.' }, 422);
    }

    const body = await context.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return context.json({ detail: 'A file part is required.' }, 422);
    }

    let completion;
    try {
      completion = await blob.writeObject(
        clientToken,
        pathname,
        new Uint8Array(await file.arrayBuffer()),
        file.type || 'application/octet-stream',
      );
    } catch (error) {
      // A token that does not cover this pathname, or has expired, is a client
      // error rather than a server fault.
      return context.json(
        { detail: error instanceof Error ? error.message : 'Upload refused.' },
        422,
      );
    }

    const documents = registry.services.documents;
    if (!documents) throw new NotImplementedServiceError('Document reconciliation');
    await documents.reconcileCompletedUpload(completion, {
      providerEventId: `local-upload:${pathname}`,
      eventType: 'blob.upload-completed',
      payload: { pathname, source: 'local-filesystem' },
    });

    return context.json(completion, 201);
  });
}
