import { getPayloadFromClientToken } from '@vercel/blob/client';
import { describe, expect, it } from 'vitest';

import { VercelBlobAdapter } from '../src/platform/blob/vercel-blob.js';

const READ_WRITE_TOKEN = 'vercel_blob_rw_test-store_test-secret';

describe('VercelBlobAdapter', () => {
  it('returns a pathname and client token that can be consumed by client put()', async () => {
    const adapter = new VercelBlobAdapter(
      'https://api.example.com/webhooks/vercel-blob',
      READ_WRITE_TOKEN,
    );

    const authorization = await adapter.authorizeClientUpload({
      draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
      documentId: 'a996d56a-da5e-49c3-bf76-665130bbb88a',
      category: 'product_photo',
      fileName: 'product front.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    });

    expect(authorization).toMatchObject({
      pathname:
        'drafts/21326c9a-5dc2-430f-98a6-546729a1065f/a996d56a-da5e-49c3-bf76-665130bbb88a/product_front.jpg',
    });
    expect(typeof authorization.expiresAt).toBe('string');
    expect(authorization).not.toHaveProperty('uploadUrl');

    const token = getPayloadFromClientToken(authorization.clientToken);
    expect(token).toMatchObject({
      pathname:
        'drafts/21326c9a-5dc2-430f-98a6-546729a1065f/a996d56a-da5e-49c3-bf76-665130bbb88a/product_front.jpg',
      allowedContentTypes: ['image/jpeg'],
      maximumSizeInBytes: 2048,
      addRandomSuffix: true,
      onUploadCompleted: {
        callbackUrl: 'https://api.example.com/webhooks/vercel-blob',
        tokenPayload: JSON.stringify({
          documentId: 'a996d56a-da5e-49c3-bf76-665130bbb88a',
        }),
      },
    });
  });
});
