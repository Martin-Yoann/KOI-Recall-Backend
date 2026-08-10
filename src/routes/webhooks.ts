import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import type { AppConfig } from '../config/env.js';
import type { AppEnv } from '../middleware/request-context.js';
import { consoleSafeLogger } from '../platform/observability/logger.js';
import { isConnectionError, problemType } from '../shared/errors.js';
import { dependencyUnavailable, deriveProviderEventId } from './shared.js';

/**
 * Registers the provider webhook routes. The Vercel Blob webhook verifies the
 * upload callback signature and reconciles the completed upload; the Resend
 * webhook (T5.3/O5) validates the shared secret, deduplicates via
 * webhook_events, and transitions the communication status.
 */
export function registerWebhookRoutes(
  app: OpenAPIHono<AppEnv>,
  registry: ApplicationRegistry,
  config: AppConfig,
) {
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
          type: problemType('validation-error'),
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
          type: problemType('validation-error'),
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

  app.post('/webhooks/resend', async (context) => {
    // T5.3/O5: validate the shared secret. Resend signs webhooks; we check the
    // configured secret header so unauthenticated callers cannot mutate state.
    const presented =
      context.req.header('X-Resend-Webhook-Secret') ??
      context.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    if (config.RESEND_WEBHOOK_SECRET === undefined || presented !== config.RESEND_WEBHOOK_SECRET) {
      return context.json(
        {
          type: problemType('unauthorized'),
          title: 'Unauthorized',
          status: 401,
          detail: 'A valid Resend webhook secret is required.',
          requestId: context.get('requestId'),
        },
        401,
        { 'Content-Type': 'application/problem+json' },
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = await context.req.json();
    } catch {
      return context.json(
        {
          type: problemType('validation-error'),
          title: 'Invalid Request',
          status: 400,
          detail: 'The webhook payload was not valid JSON.',
          requestId: context.get('requestId'),
        },
        400,
        { 'Content-Type': 'application/problem+json' },
      );
    }

    const typeValue = parsed.type;
    const eventType = typeof typeValue === 'string' ? typeValue : '';
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const emailId = data.email_id;
    const dataId = data.id;
    const providerMessageId =
      typeof emailId === 'string' ? emailId : typeof dataId === 'string' ? dataId : '';
    if (!providerMessageId || !eventType.startsWith('email.')) {
      // Ack unknown events without mutating state so Resend stops retrying.
      return context.body(null, 200);
    }

    try {
      await registry.services.communications.recordDeliveryEvent({
        providerEventId: deriveProviderEventId(parsed),
        providerMessageId,
        eventType: eventType as never,
        payload: parsed,
      });
    } catch (error) {
      if (isConnectionError(error))
        return dependencyUnavailable(context, 'Resend webhook processing');
      throw error;
    }

    return context.body(null, 200);
  });
}
