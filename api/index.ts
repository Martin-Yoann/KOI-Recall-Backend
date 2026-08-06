// ============================================================
// KOI-Recall-Backend — Vercel Serverless entry point
// Adapts Hono app.fetch → Node.js (req, res) for Vercel
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/app.js';

const app = createApp();

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => {
      data += typeof chunk === 'string' ? chunk : chunk.toString();
    });
    req.on('end', () => resolve(data));
  });
}

function buildWebRequest(req: IncomingMessage, body?: string): Request {
  const protocol = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const host = (req.headers.host as string) ?? 'localhost';
  const url = `${protocol}://${host}${req.url ?? '/'}`;
  const method = req.method ?? 'GET';

  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || value === null) continue;
    webHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }

  if (body !== undefined) {
    return new Request(url, { method, headers: webHeaders, body });
  }
  return new Request(url, { method, headers: webHeaders });
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const webReq = buildWebRequest(req, body);
  const response = await app.fetch(webReq);

  res.statusCode = response.status;
  response.headers.forEach((value: string, key: string) => {
    if (key.toLowerCase() !== 'content-length') {
      res.setHeader(key, value);
    }
  });

  const responseBody = await response.text();
  res.end(responseBody);
}
