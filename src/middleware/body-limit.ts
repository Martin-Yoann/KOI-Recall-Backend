import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';

import { problemType } from '../shared/errors.js';
import type { AppEnv } from './request-context.js';

/**
 * Rejects request bodies larger than `maxBytes` with 413 (T6.2/O6). The check
 * uses Content-Length when trustworthy and otherwise reads the stream with a
 * running byte count. Hono replays bounded chunks downstream, so JSON parsing
 * and provider webhook verification still receive the original body.
 */
export function bodyLimit(maxBytes: number) {
  return honoBodyLimit({
    maxSize: maxBytes,
    onError: (context: Context<AppEnv>) =>
      context.json(
        {
          type: problemType('payload-too-large'),
          title: 'Payload Too Large',
          status: 413,
          detail: `Request body exceeds the ${maxBytes} byte limit.`,
          requestId: context.get('requestId'),
        },
        413,
        { 'Content-Type': 'application/problem+json' },
      ),
  });
}

export const DEFAULT_JSON_BODY_LIMIT = 256 * 1024; // 256 KiB for JSON claims/checks
export const DEFAULT_WEBHOOK_BODY_LIMIT = 512 * 1024; // 512 KiB for provider webhooks
