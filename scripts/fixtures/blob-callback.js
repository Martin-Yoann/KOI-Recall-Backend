import { handleUpload } from '@vercel/blob/client';
import { put } from '@vercel/blob';
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  const chunks = [];
  if (req.body === undefined) {
    for await (const part of req) chunks.push(part);
  }
  const text =
    req.body === undefined
      ? Buffer.concat(chunks).toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  if (body.type !== 'blob.upload-completed') {
    res.status(400).json({ error: 'Only completion callbacks are accepted' });
    return;
  }
  const headers = {};
  for (const [key, value] of Object.entries(req.headers))
    if (typeof value === 'string') headers[key] = value;
  try {
    await handleUpload({
      body,
      request: new Request('https://isolated.test/api/callback', {
        method: 'POST',
        headers,
        body: text,
      }),
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async () => ({ allowedContentTypes: [] }),
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const { documentId } = JSON.parse(tokenPayload);
        if (!/^[0-9a-f-]{36}$/i.test(documentId)) throw Error('Unexpected document ID');
        await put('callbacks/' + documentId + '.json', JSON.stringify({ body, headers, blob }), {
          token: process.env.BLOB_READ_WRITE_TOKEN,
          access: 'private',
          contentType: 'application/json',
          addRandomSuffix: false,
        });
      },
    });
    res.status(200).json({ ok: true });
  } catch {
    res.status(400).json({ error: 'Callback verification failed' });
  }
}
