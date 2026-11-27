import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { VercelBlobAdapter } from '../src/platform/blob/vercel-blob.js';
const dir = path.dirname(fileURLToPath(import.meta.url)),
  backend = path.resolve(dir, '..'),
  require = createRequire(path.join(backend, 'package.json'));
const { parse } = require('dotenv');
if (process.env.ALLOW_CLOUD_BLOB_TESTS !== 'true')
  throw Error('Cloud tests require explicit ALLOW_CLOUD_BLOB_TESTS=true.');
const file = process.env.BLOB_TEST_ENV_FILE;
const testEnv = file ? parse(fs.readFileSync(file)) : {};
const token = process.env.BLOB_TEST_READ_WRITE_TOKEN ?? testEnv.BLOB_READ_WRITE_TOKEN;
const expected = process.env.BLOB_TEST_STORE_ID?.replace(/^store_/, '');
const actual = token?.match(/^vercel_blob_rw_([^_]+)_/)?.[1];
if (!expected || actual !== expected)
  throw Error('An explicit matching isolated test store ID and token are required.');
const callbackUrl = process.env.BLOB_TEST_CALLBACK_URL;
if (!callbackUrl || new URL(callbackUrl).protocol !== 'https:')
  throw Error('An isolated HTTPS callback receiver is required.');
const reportPath =
  process.env.BLOB_TEST_REPORT ?? path.join(backend, '.local-storage/cloud-blob-result.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const sdk = await import(pathToFileURL(require.resolve('@vercel/blob')).href);
const client = await import(pathToFileURL(require.resolve('@vercel/blob/client')).href);
const initial = await sdk.list({ token, limit: 1 });
if (initial.blobs.length)
  throw Error('Only an empty isolated test store is allowed. No existing objects were changed.');
const adapter = new VercelBlobAdapter(callbackUrl, token),
  documentId = randomUUID(),
  draftId = randomUUID();
const data = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKIoAAAAASUVORK5CYII=',
  'base64',
);
const receiptPath = 'callbacks/' + documentId + '.json';
let uploaded;
try {
  const auth = await adapter.authorizeClientUpload({
    draftId,
    documentId,
    category: 'product_photo',
    fileName: 'isolated-cloud-test.png',
    mimeType: 'image/png',
    sizeBytes: data.length,
  });
  uploaded = await client.put(auth.pathname, new Blob([data], { type: 'image/png' }), {
    access: 'private',
    contentType: 'image/png',
    token: auth.clientToken,
  });
  if (
    new URL(uploaded.url).hostname !==
    expected.toLowerCase() + '.private.blob.vercel-storage.com'
  )
    throw Error('Unexpected storage host');
  const meta = await sdk.head(uploaded.url, { token });
  if (meta.size !== data.length) throw Error('Stored size mismatch');
  console.log('PASS real scoped client upload and authoritative cloud metadata');
  const anonymous = await fetch(uploaded.url);
  if (anonymous.ok) throw Error('Private file was publicly readable');
  const access = await adapter.createAccessUrl(uploaded.pathname);
  const fetched = await fetch(access.url);
  if (!fetched.ok || !Buffer.from(await fetched.arrayBuffer()).equals(data))
    throw Error('Signed download mismatch');
  console.log('PASS anonymous reads denied; app adapter signed access returns exact bytes');
  let receipt;
  for (let attempt = 0; attempt < 18; attempt++) {
    try {
      const result = await sdk.get(receiptPath, { token, access: 'private' });
      if (result) {
        receipt = JSON.parse(await new Response(result.stream).text());
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!receipt) throw Error('Real provider callback was not received');
  const wire = new Request(callbackUrl, {
    method: 'POST',
    headers: receipt.headers,
    body: JSON.stringify(receipt.body),
  });
  const completed = await adapter.handleUploadCallback(wire);
  if (
    completed?.documentId !== documentId ||
    completed.sizeBytes !== data.length ||
    completed.pathname !== uploaded.pathname
  )
    throw Error('Signed callback reconciliation mismatch');
  console.log(
    'PASS real provider callback verified by the application adapter with matching ID, bytes and pathname',
  );
  const changed = structuredClone(receipt.body);
  changed.payload.blob.pathname += '-tampered';
  let rejected = false;
  try {
    await adapter.handleUploadCallback(
      new Request(callbackUrl, {
        method: 'POST',
        headers: receipt.headers,
        body: JSON.stringify(changed),
      }),
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw Error('Tampered callback accepted');
  console.log('PASS altered callback rejected without a valid signature');
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        privateStoreIsolated: true,
        scopedClientUpload: true,
        anonymousReadDenied: true,
        signedDownloadExactBytes: true,
        realProviderCallback: true,
        applicationCallbackVerification: true,
        tamperedCallbackDenied: true,
        cloudDatabaseCallbackForwarding: false,
      },
      null,
      2,
    ),
  );
} finally {
  if (uploaded) await adapter.delete(uploaded.pathname);
  await sdk.del(receiptPath, { token });
  const remaining = await sdk.list({ token, limit: 10 });
  if (remaining.blobs.length) throw Error('Isolated test storage still contains objects');
  console.log('PASS test image and callback receipt removed; isolated store empty');
  const report = reportPath;
  if (fs.existsSync(report)) {
    const j = JSON.parse(fs.readFileSync(report, 'utf8'));
    j.physicalCloudDeletion = true;
    fs.writeFileSync(report, JSON.stringify(j, null, 2));
  }
}
