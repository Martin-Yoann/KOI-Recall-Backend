import { OpenAPIHono } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { createDefaultRegistry, type ApplicationRegistry } from './composition.js';
import { loadConfig, type AppConfig } from './config/env.js';
import {
  campaignResponseSchema,
  claimDraftResponseSchema,
  createClaimDraftRoute,
  createUploadTokenRoute,
  deleteDraftDocumentRoute,
  getCampaignRoute,
  openApiConfig,
  productCheckResponseSchema,
  productCheckRoute,
  submitClaimRoute,
  uploadTokenResponseSchema,
} from './contracts/toc.js';
import {
  allowAllRateLimiter,
  rateLimitMiddleware,
  type RateLimiter,
} from './middleware/rate-limit.js';
import { requestContext, type AppEnv } from './middleware/request-context.js';
import { consoleSafeLogger } from './platform/observability/logger.js';
import {
  HttpProblemError,
  isConnectionError,
  NotImplementedServiceError,
} from './shared/errors.js';

export interface AppDependencies {
  config?: AppConfig;
  rateLimiter?: RateLimiter;
  registry?: ApplicationRegistry;
}

function problem(requestId: string, capability: string) {
  return {
    type: 'https://api.example.invalid/problems/not-implemented',
    title: 'Not Implemented',
    status: 501,
    detail: `${capability} is contract-complete but not implemented in this Phase 1 skeleton.`,
    requestId,
  };
}

function notImplemented(context: Context<AppEnv>, capability: string): never {
  return context.json(problem(context.get('requestId'), capability), 501, {
    'Content-Type': 'application/problem+json',
  }) as never;
}

function notFound(context: Context<AppEnv>, resource: string): never {
  return context.json(
    {
      type: 'https://api.example.invalid/problems/not-found',
      title: 'Not Found',
      status: 404,
      detail: `${resource} was not found or is not publicly available.`,
      requestId: context.get('requestId'),
    },
    404,
    { 'Content-Type': 'application/problem+json' },
  ) as never;
}

function dependencyUnavailable(context: Context<AppEnv>, capability: string): never {
  return context.json(
    {
      type: 'https://api.example.invalid/problems/dependency-unavailable',
      title: 'Dependency Unavailable',
      status: 503,
      detail: `${capability} could not be completed because a required dependency is unavailable.`,
      requestId: context.get('requestId'),
    },
    503,
    { 'Content-Type': 'application/problem+json' },
  ) as never;
}

/**
 * Derives a stable provider event id from a Vercel Blob webhook payload for
 * deduplication. Falls back to a JSON-derived digest when the payload carries
 * no explicit id so redeliveries still collapse to one row.
 */
function deriveProviderEventId(payload: Record<string, unknown>): string {
  const explicit = payload.id ?? payload.webhookId ?? payload.eventId;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit.slice(0, 200);
  // Node's createHash gives a synchronous digest (WebCrypto's subtle.digest is
  // async), matching the approach used for draft-token hashing.
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 48)}`;
}

export function createApp(dependencies: AppDependencies = {}) {
  const config = dependencies.config ?? loadConfig();
  const registry = dependencies.registry ?? createDefaultRegistry(config);
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, context) => {
      if (result.success) return;
      return context.json(
        {
          type: 'https://api.example.invalid/problems/validation-error',
          title: 'Invalid Request',
          status: 400,
          detail: 'The request did not satisfy the API contract.',
          requestId: context.get('requestId'),
          errors: result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        400,
        { 'Content-Type': 'application/problem+json' },
      );
    },
  });

  app.use('*', requestContext);
  app.use('*', secureHeaders());
  app.use(
    '*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : ''),
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Idempotency-Key', 'X-Draft-Token', 'X-Request-Id'],
      exposeHeaders: [
        'ETag',
        'Content-Language',
        'X-Request-Id',
        'RateLimit-Limit',
        'RateLimit-Remaining',
      ],
      maxAge: 600,
    }),
  );
  app.use('/v1/*', rateLimitMiddleware(dependencies.rateLimiter ?? allowAllRateLimiter));

  app.get('/health/live', (context) =>
    context.json({ status: 'ok', service: 'koi-recall-api', phase: 'skeleton' }),
  );

  app.openapi(getCampaignRoute, async (context) => {
    let campaign;
    try {
      campaign = await registry.services.campaigns.getPublishedCampaign({
        slug: context.req.valid('param').slug,
        locale: context.req.valid('query').locale,
      });
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Campaign retrieval');
      throw error;
    }

    if (!campaign) return notFound(context, 'Campaign');

    const response = campaignResponseSchema.parse({ campaign });
    return context.json(response, 200, {
      'Content-Language': response.campaign.locale,
      ETag: `"v${response.campaign.version}:${response.campaign.locale}"`,
    });
  });
  app.openapi(productCheckRoute, async (context) => {
    let result;
    try {
      result = await registry.services.productChecks.check({
        campaignSlug: context.req.valid('param').slug,
        ...context.req.valid('json'),
      });
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Product checking');
      throw error;
    }

    if (!result) return notFound(context, 'Campaign');

    const response = productCheckResponseSchema.parse({
      ...result,
      disclaimer: 'This check is preliminary and is not a final eligibility decision.',
    });
    return context.json(response, 200);
  });
  app.openapi(createClaimDraftRoute, async (context) => {
    let draft;
    try {
      draft = await registry.services.claimDrafts.create(context.req.valid('param').slug);
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Claim draft creation');
      throw error;
    }

    if (!draft) return notFound(context, 'Campaign');

    const response = claimDraftResponseSchema.parse(draft);
    return context.json(response, 201);
  });
  app.openapi(createUploadTokenRoute, async (context) => {
    const { draftId } = context.req.valid('param');
    await registry.services.claimDrafts.assertActive(
      draftId,
      context.req.valid('header')['X-Draft-Token'],
    );
    let authorization;
    try {
      authorization = await registry.services.documents.authorizeUpload({
        draftId,
        ...context.req.valid('json'),
      });
    } catch (error) {
      if (isConnectionError(error))
        return dependencyUnavailable(context, 'Private Blob upload authorization');
      throw error;
    }

    const response = uploadTokenResponseSchema.parse(authorization);
    return context.json(response, 201);
  });
  app.openapi(deleteDraftDocumentRoute, async (context) => {
    const { draftId, documentId } = context.req.valid('param');
    await registry.services.claimDrafts.assertActive(
      draftId,
      context.req.valid('header')['X-Draft-Token'],
    );
    try {
      await registry.services.documents.scheduleDraftDocumentDeletion(draftId, documentId);
    } catch (error) {
      if (isConnectionError(error))
        return dependencyUnavailable(context, 'Draft document deletion');
      throw error;
    }

    return context.body(null, 204);
  });
  app.openapi(submitClaimRoute, async (context) => {
    await registry.services.cases.submit({
      campaignSlug: context.req.valid('param').slug,
      idempotencyKey: context.req.valid('header')['Idempotency-Key'],
      body: context.req.valid('json'),
    });
    return notImplemented(context, 'Recall claim submission');
  });

  app.get('/internal/jobs/outbox', (context) =>
    context.json(problem(context.get('requestId'), 'Outbox processing'), 501, {
      'Content-Type': 'application/problem+json',
    }),
  );
  app.get('/internal/jobs/cleanup-drafts', (context) =>
    context.json(problem(context.get('requestId'), 'Draft cleanup'), 501, {
      'Content-Type': 'application/problem+json',
    }),
  );
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
      // @ts-expect-error duplex is required by undici to stream a body to Request
      duplex: 'half',
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

  app.doc('/openapi.json', openApiConfig);

  app.notFound((context) =>
    context.json(
      {
        type: 'https://api.example.invalid/problems/not-found',
        title: 'Not Found',
        status: 404,
        detail: 'The requested API route does not exist.',
        instance: new URL(context.req.url).pathname,
        requestId: context.get('requestId'),
      },
      404,
      { 'Content-Type': 'application/problem+json' },
    ),
  );

  app.onError((error, context) => {
    if (error instanceof NotImplementedServiceError) {
      return context.json(problem(context.get('requestId'), error.capability), 501, {
        'Content-Type': 'application/problem+json',
      });
    }
    if (error instanceof HttpProblemError) {
      const status = error.status as ContentfulStatusCode;
      return context.json(
        {
          type: error.type,
          title: error.title,
          status: error.status,
          detail: error.message,
          requestId: context.get('requestId'),
        },
        status,
        { 'Content-Type': 'application/problem+json' },
      );
    }
    consoleSafeLogger.error('Unhandled API error', {
      requestId: context.get('requestId'),
      errorCode: error.name,
    });
    return context.json(
      {
        type: 'https://api.example.invalid/problems/internal-error',
        title: 'Internal Server Error',
        status: 500,
        detail: 'The server could not complete the request.',
        requestId: context.get('requestId'),
      },
      500,
      { 'Content-Type': 'application/problem+json' },
    );
  });

  return app;
}
