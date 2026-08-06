import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { DocumentService } from '../src/modules/documents/service.js';
import type { PrivateBlobPort, UploadCompletion } from '../src/platform/blob/port.js';

function appWith(
  blob: Pick<PrivateBlobPort, 'handleUploadCallback'>,
  documents: Pick<DocumentService, 'reconcileCompletedUpload'>,
) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: { ...base.services, documents: documents as DocumentService },
    platform: { ...base.platform, blob: blob as PrivateBlobPort },
  };
  return createApp({
    config: loadConfig({ CORS_ALLOWED_ORIGINS: 'https://consumer.example.com' }),
    registry,
  });
}

const completion: UploadCompletion = {
  documentId: 'a996d56a-da5e-49c3-bf76-665130bbb88a',
  detectedMimeType: 'image/jpeg',
  sizeBytes: 2048,
  pathname: 'drafts/abc/d/photo.jpg',
};

const completedEventBody = JSON.stringify({
  type: 'blob.upload-completed',
  payload: {
    blob: { pathname: 'drafts/abc/d/photo.jpg', contentType: 'image/jpeg' },
    tokenPayload: JSON.stringify({ documentId: completion.documentId }),
  },
  id: 'evt_123',
});

async function postWebhook(app: ReturnType<typeof appWith>, body: string) {
  return app.request('/webhooks/vercel-blob', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

describe('POST /webhooks/vercel-blob', () => {
  it('acks a completed upload with 200 and reconciles the document', async () => {
    let reconciled = false;
    const app = appWith(
      { handleUploadCallback: () => Promise.resolve(completion) },
      {
        reconcileCompletedUpload: () => {
          reconciled = true;
          return Promise.resolve(true);
        },
      },
    );

    const response = await postWebhook(app, completedEventBody);

    expect(response.status).toBe(200);
    expect(reconciled).toBe(true);
  });

  it('returns 200 without reconciling for a non-completion event', async () => {
    let reconciled = false;
    const app = appWith(
      { handleUploadCallback: () => Promise.resolve(null) },
      {
        reconcileCompletedUpload: () => {
          reconciled = true;
          return Promise.resolve(true);
        },
      },
    );

    const response = await postWebhook(app, completedEventBody);

    expect(response.status).toBe(200);
    expect(reconciled).toBe(false);
  });

  it('returns 400 when the payload is not valid JSON', async () => {
    const app = appWith(
      { handleUploadCallback: () => Promise.resolve(completion) },
      { reconcileCompletedUpload: () => Promise.resolve(true) },
    );

    const response = await postWebhook(app, '{not json');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ status: 400 });
  });

  it('returns 400 when the blob adapter rejects the payload', async () => {
    const app = appWith(
      { handleUploadCallback: () => Promise.reject(new Error('bad signature')) },
      { reconcileCompletedUpload: () => Promise.resolve(true) },
    );

    const response = await postWebhook(app, completedEventBody);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ status: 400 });
  });

  it('returns 500 when reconciliation fails so Vercel can retry', async () => {
    const app = appWith(
      { handleUploadCallback: () => Promise.resolve(completion) },
      {
        reconcileCompletedUpload: () => Promise.reject(new Error('database down')),
      },
    );

    const response = await postWebhook(app, completedEventBody);

    expect(response.status).toBe(500);
  });
});
