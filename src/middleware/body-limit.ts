import { createMiddleware } from 'hono/factory';

import { problemType } from '../shared/errors.js';
import type { AppEnv } from './request-context.js';

/**
 * Rejects request bodies larger than `maxBytes` with 413 (T6.2/O6). The check
 * uses the Content-Length header — the common case — and deliberately does NOT
 * consume the body stream: downstream handlers (Hono validation, the Vercel
 * Blob webhook replay) must still be able to read the request body. Chunked
 * bodies without a length header are rare from our consumers and are handled
 * by normal Hono parsing. Attachment uploads never pass through this path —
 * they go straight to Private Blob direct upload.
 */
export function bodyLimit(maxBytes: number) {
  return createMiddleware<AppEnv>(async (context, next) => {
    const declared = context.req.header('Content-Length');
    if (declared !== undefined) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > maxBytes) {
        return context.json(
          {
            type: problemType('payload-too-large'),
            title: 'Payload Too Large',
            status: 413,
            detail: `Request body exceeds the ${maxBytes} byte limit.`,
            requestId: context.get('requestId'),
          },
          413,
          { 'Content-Type': 'application/problem+json' },
        );
      }
    }

    await next();
  });
}

export const DEFAULT_JSON_BODY_LIMIT = 256 * 1024; // 256 KiB for JSON claims/checks
export const DEFAULT_WEBHOOK_BODY_LIMIT = 512 * 1024; // 512 KiB for provider webhooks
