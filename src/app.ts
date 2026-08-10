import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { createDefaultRegistry, type ApplicationRegistry } from './composition.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { buildOpenApiConfig } from './contracts/toc.js';
import {
  bodyLimit,
  DEFAULT_JSON_BODY_LIMIT,
  DEFAULT_WEBHOOK_BODY_LIMIT,
} from './middleware/body-limit.js';
import {
  InMemoryRateLimiter,
  rateLimitMiddleware,
  type RateLimiter,
} from './middleware/rate-limit.js';
import { requestContext, type AppEnv } from './middleware/request-context.js';
import { consoleSafeLogger } from './platform/observability/logger.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerClaimRoutes } from './routes/claims.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { notImplementedJobHandler, registerInternalJobRoutes } from './routes/internal-jobs.js';
import { registerProductCheckRoutes } from './routes/product-checks.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { problem } from './routes/shared.js';
import {
  configureProblemTypeBase,
  HttpProblemError,
  NotImplementedServiceError,
  problemType,
} from './shared/errors.js';

export interface AppDependencies {
  config?: AppConfig;
  rateLimiter?: RateLimiter;
  registry?: ApplicationRegistry;
  /**
   * Liveness/readiness probe. Defaults to checking that the required
   * configuration (DATABASE_URL) is present; deployments may inject a real
   * database connectivity check (O6/T6.3).
   */
  readyCheck?: () => Promise<boolean>;
}

export function createApp(dependencies: AppDependencies = {}) {
  const config = dependencies.config ?? loadConfig();
  const registry = dependencies.registry ?? createDefaultRegistry(config);
  // T6.5 (O6): Problem Details type URIs carry the deployment's stable domain.
  configureProblemTypeBase(`${config.PROBLEM_BASE_URL.replace(/\/$/, '')}/problems/`);
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, context) => {
      if (result.success) return;
      return context.json(
        {
          type: problemType('validation-error'),
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
  // T6.1 (O6): default to a real fixed-window limiter keyed on the hashed
  // client source + route category; tests may inject a custom limiter.
  app.use('/v1/*', rateLimitMiddleware(dependencies.rateLimiter ?? new InMemoryRateLimiter()));
  // T6.2 (O6): strict body caps — JSON/claim bodies are small; provider
  // webhooks get a slightly larger allowance. Attachments never pass through
  // here (they go straight to Private Blob).
  app.use('/v1/*', bodyLimit(DEFAULT_JSON_BODY_LIMIT));
  app.use('/webhooks/*', bodyLimit(DEFAULT_WEBHOOK_BODY_LIMIT));

  // T6.3 (O6): liveness no longer claims a skeleton phase; readiness checks
  // the required configuration (and, when injected, real connectivity).
  app.get('/health/live', (context) => context.json({ status: 'ok', service: 'koi-recall-api' }));
  const readyCheck =
    dependencies.readyCheck ?? (() => Promise.resolve(config.DATABASE_URL !== undefined));
  app.get('/health/ready', async (context) => {
    const ready = await readyCheck();
    return ready
      ? context.json({ status: 'ok', service: 'koi-recall-api' }, 200)
      : context.json(
          {
            type: problemType('dependency-unavailable'),
            title: 'Not Ready',
            status: 503,
            detail: 'Required configuration or dependencies are not ready.',
            requestId: context.get('requestId'),
          },
          503,
          { 'Content-Type': 'application/problem+json' },
        );
  });

  // Route handlers live in src/routes/*; app.ts only wires them in declaration
  // order so the OpenAPI path listing and registration stay centralized here.
  registerAdminRoutes(app, registry, config.ADMIN_API_KEY);
  registerCampaignRoutes(app, registry);
  registerProductCheckRoutes(app, registry);
  registerDocumentRoutes(app, registry);
  registerClaimRoutes(app, registry);
  registerInternalJobRoutes(app, config.CRON_SECRET, {
    drainOutbox: registry.jobs?.drainOutbox ?? notImplementedJobHandler('Outbox processing'),
    cleanupDrafts: registry.jobs?.cleanupDrafts ?? notImplementedJobHandler('Draft cleanup'),
  });
  registerWebhookRoutes(app, registry, config);

  app.doc('/openapi.json', buildOpenApiConfig(config.PROBLEM_BASE_URL));

  app.notFound((context) =>
    context.json(
      {
        type: problemType('not-found'),
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

  app.onError((error, context: Context<AppEnv>) => {
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
        type: problemType('internal-error'),
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
