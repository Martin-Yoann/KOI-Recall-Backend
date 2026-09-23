// Unit tests for the local filesystem blob adapter. No database, no store: the
// point of the adapter is that a development machine can exercise the upload path.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalFilesystemBlobAdapter } from '../src/platform/blob/local-filesystem.js';

const REQUEST = {
  draftId: '11111111-1111-4111-8111-111111111111',
  documentId: '22222222-2222-4222-8222-222222222222',
  category: 'product_photo' as const,
  fileName: 'my photo (1).jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 2048,
};

describe('LocalFilesystemBlobAdapter', () => {
  let root: string;
  let adapter: LocalFilesystemBlobAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'koi-blob-'));
    adapter = new LocalFilesystemBlobAdapter({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('mints a pathname in the same shape the real store uses', async () => {
    const authorization = await adapter.authorizeClientUpload(REQUEST);
    // The file name is sanitised: a pathname must not carry separators or spaces.
    expect(authorization.pathname).toBe(
      `drafts/${REQUEST.draftId}/${REQUEST.documentId}/my_photo_1_.jpg`,
    );
    expect(new Date(authorization.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('reconciles an upload with the metadata the real callback reports', async () => {
    const authorization = await adapter.authorizeClientUpload(REQUEST);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const written = await adapter.writeObject(
      authorization.clientToken,
      authorization.pathname,
      bytes,
      'image/jpeg',
    );
    expect(written).toEqual({
      documentId: REQUEST.documentId,
      detectedMimeType: 'image/jpeg',
      sizeBytes: 5,
      pathname: authorization.pathname,
    });

    const callback = await adapter.handleUploadCallback(
      new Request('http://localhost/dev/uploads', {
        method: 'POST',
        body: JSON.stringify({
          clientToken: authorization.clientToken,
          pathname: authorization.pathname,
        }),
      }),
    );
    // The size is read back from disk, not taken from the client's claim.
    expect(callback).toEqual(written);
  });

  it('refuses a token that does not cover the object being written', async () => {
    const authorization = await adapter.authorizeClientUpload(REQUEST);
    await expect(
      adapter.writeObject(
        authorization.clientToken,
        `drafts/${REQUEST.draftId}/somebody-elses-document/x.jpg`,
        new Uint8Array([1]),
        'image/jpeg',
      ),
    ).rejects.toThrow(/does not cover/i);
  });

  it('refuses a forged token and reports no completion', async () => {
    const authorization = await adapter.authorizeClientUpload(REQUEST);
    const forged = `${authorization.clientToken.split('.')[0]}.AAAA`;
    await expect(
      adapter.writeObject(forged, authorization.pathname, new Uint8Array([1]), 'image/jpeg'),
    ).rejects.toThrow(/not valid/i);

    const callback = await adapter.handleUploadCallback(
      new Request('http://localhost/dev/uploads', {
        method: 'POST',
        body: JSON.stringify({ clientToken: forged, pathname: authorization.pathname }),
      }),
    );
    expect(callback).toBeNull();
  });

  it('refuses an expired token', async () => {
    const expiring = new LocalFilesystemBlobAdapter({ root });
    const authorization = await expiring.authorizeClientUpload(REQUEST);
    // Rewrite the envelope's expiry while keeping the signature: the signature is
    // what fails, which is the property worth pinning.
    const [payload, signature] = authorization.clientToken.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as unknown as {
      expiresAt: number;
    };
    decoded.expiresAt = Date.now() - 1000;
    const tampered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    const callback = await adapter.handleUploadCallback(
      new Request('http://localhost/dev/uploads', {
        method: 'POST',
        body: JSON.stringify({ clientToken: tampered, pathname: authorization.pathname }),
      }),
    );
    expect(callback).toBeNull();
  });

  it('refuses a pathname that escapes the storage root', async () => {
    await expect(adapter.delete('../../etc/passwd')).rejects.toThrow(/escape/i);
    const authorization = await adapter.authorizeClientUpload(REQUEST);
    await expect(
      adapter.writeObject(
        authorization.clientToken,
        '../../outside.jpg',
        new Uint8Array([1]),
        'image/jpeg',
      ),
    ).rejects.toThrow();
  });

  it('serves an access URL that encodes the pathname, and forgets a deleted object', async () => {
    const authorization = await adapter.authorizeClientUpload(REQUEST);
    await adapter.writeObject(
      authorization.clientToken,
      authorization.pathname,
      new Uint8Array([1, 2, 3]),
      'image/jpeg',
    );

    const access = await adapter.createAccessUrl(authorization.pathname);
    expect(access.contentType).toBe('image/jpeg');
    expect(access.url).toBe(
      `/dev/blobs/drafts/${REQUEST.draftId}/${REQUEST.documentId}/my_photo_1_.jpg`,
    );
    expect(access.downloadUrl).toBe(`${access.url}?download=1`);

    await adapter.delete(authorization.pathname);
    await expect(adapter.createAccessUrl(authorization.pathname)).rejects.toThrow(
      /No local object/i,
    );
  });
});
