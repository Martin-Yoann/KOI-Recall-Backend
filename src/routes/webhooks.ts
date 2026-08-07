import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import type { AppEnv } from '../middleware/request-context.js';
import { consoleSafeLogger } from '../platform/observability/logger.js';
import { isConnectionError } from '../shared/errors.js';
import { dependencyUnavailable, deriveProviderEventId, problem } from './shared.js';

/**
 * Registers the provider webhook routes. The Vercel Blob webhook verifies the
 * upload callback signature and reconciles the completed upload; the Resend
 * webhook remains a 501 until the email provider adapter lands (O5/T5.3).
 */
export function registerWebhookRoutes(app: OpenAPIHono<AppEnv>, registry: ApplicationRegistry) {
  app.post('/webhooks/vercel-blob', async (context) => {
    // Read the raw body once and hand the adapter a fresh Request built from
    // it: the body stream is single-use, but the adapter must also read it to
    // dispatch the completion event, and we need the parsed body for dedup.
    const rawBody = await context.req.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return context.json(
        {
          type: 'https://api.example.invalid/problems/validation-error',
          title: 'Invalid Request',
          status: 400,
          detail: 'The webhook payload was not valid JSON.',
          requestId: context.get('requestId'),
        },
        400,
        { 'Content-Type': 'application/problem+json' },
      );
    }

    const replayed = new Request(context.req.raw.url, {
      method: context.req.raw.method,
      headers: context.req.raw.headers,
      body: rawBody,
    });

    // `handleUploadCallback` verifies the request signature and extracts
    // completion metadata; token-generation events return null.
    let completion;
    try {
      completion = await registry.platform.blob.handleUploadCallback(replayed);
    } catch (error) {
      if (isConnectionError(error))
        return dependencyUnavailable(context, 'Private Blob upload callback');
      // Signature verification failures and malformed payloads are reported to
      // Vercel as 400 so it does not endlessly retry an undeliverable event.
      consoleSafeLogger.error('Vercel Blob callback rejected', {
        requestId: context.get('requestId'),
        errorCode: error instanceof Error ? error.name : 'unknown',
      });
      return context.json(
        {
          type: 'https://api.example.invalid/problems/validation-error',
          title: 'Invalid Request',
          status: 400,
          detail: 'The webhook payload could not be verified or processed.',
          requestId: context.get('requestId'),
        },
        400,
        { 'Content-Type': 'application/problem+json' },
      );
    }

    if (!completion) {
      // Not an upload-completion event (e.g. token generation routed here); ack
      // so Vercel does not retry.
      return context.body(null, 200);
    }

    const providerEventId = deriveProviderEventId(parsed);
    try {
      await registry.services.documents.reconcileCompletedUpload(completion, {
        providerEventId,
        eventType: 'blob.upload-completed',
        payload: parsed,
      });
    } catch (error) {
      if (isConnectionError(error))
        return dependencyUnavailable(context, 'Private Blob upload callback');
      throw error;
    }

    // Ack only after reconciliation succeeds (or identifies a fully processed
    // duplicate). Failures surface as 5xx so Vercel can retry safely.
    return context.body(null, 200);
  });

  app.post('/webhooks/resend', (context) =>
    context.json(problem(context.get('requestId'), 'Resend webhook processing'), 501, {
      'Content-Type': 'application/problem+json',
    }),
  );
}
