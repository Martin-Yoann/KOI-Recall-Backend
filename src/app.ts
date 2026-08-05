import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { createDefaultRegistry, type ApplicationRegistry } from './composition.js';
import { loadConfig, type AppConfig } from './config/env.js';
import {
  campaignResponseSchema,
  createClaimDraftRoute,
  createUploadTokenRoute,
  deleteDraftDocumentRoute,
  getCampaignRoute,
  openApiConfig,
  productCheckRoute,
  submitClaimRoute,
} from './contracts/toc.js';
import {
  allowAllRateLimiter,
  rateLimitMiddleware,
  type RateLimiter,
} from './middleware/rate-limit.js';
import { requestContext, type AppEnv } from './middleware/request-context.js';
import { isConnectionError, NotImplementedServiceError } from './shared/errors.js';

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
    await registry.services.productChecks.check({
      campaignSlug: context.req.valid('param').slug,
      ...context.req.valid('json'),
    });
    return notImplemented(context, 'Product checking');
  });
  app.openapi(createClaimDraftRoute, async (context) => {
    await registry.services.claimDrafts.create(context.req.valid('param').slug);
    return notImplemented(context, 'Claim draft creation');
  });
  app.openapi(createUploadTokenRoute, async (context) => {
    const { draftId } = context.req.valid('param');
    await registry.services.claimDrafts.assertActive(
      draftId,
      context.req.valid('header')['X-Draft-Token'],
    );
    await registry.services.documents.authorizeUpload({
      draftId,
      ...context.req.valid('json'),
    });
    return notImplemented(context, 'Private Blob upload authorization');
  });
  app.openapi(deleteDraftDocumentRoute, async (context) => {
    const { draftId, documentId } = context.req.valid('param');
    await registry.services.claimDrafts.assertActive(
      draftId,
      context.req.valid('header')['X-Draft-Token'],
    );
    await registry.services.documents.scheduleDraftDocumentDeletion(draftId, documentId);
    return notImplemented(context, 'Draft document deletion');
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
  app.post('/webhooks/vercel-blob', (context) =>
    context.json(problem(context.get('requestId'), 'Vercel Blob callback processing'), 501, {
      'Content-Type': 'application/problem+json',
    }),
  );
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
    console.error('Unhandled API error', { requestId: context.get('requestId'), name: error.name });
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
