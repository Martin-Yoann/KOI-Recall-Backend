import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { createDefaultRegistry, type ApplicationRegistry } from './composition.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { openApiConfig } from './contracts/toc.js';
import {
  allowAllRateLimiter,
  rateLimitMiddleware,
  type RateLimiter,
} from './middleware/rate-limit.js';
import { requestContext, type AppEnv } from './middleware/request-context.js';
import { consoleSafeLogger } from './platform/observability/logger.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerClaimRoutes } from './routes/claims.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerInternalJobRoutes } from './routes/internal-jobs.js';
import { registerProductCheckRoutes } from './routes/product-checks.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { problem } from './routes/shared.js';
import { HttpProblemError, NotImplementedServiceError } from './shared/errors.js';

export interface AppDependencies {
  config?: AppConfig;
  rateLimiter?: RateLimiter;
  registry?: ApplicationRegistry;
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

  // Route handlers live in src/routes/*; app.ts only wires them in declaration
  // order so the OpenAPI path listing and registration stay centralized here.
  registerCampaignRoutes(app, registry);
  registerProductCheckRoutes(app, registry);
  registerDocumentRoutes(app, registry);
  registerClaimRoutes(app, registry);
  registerInternalJobRoutes(app);
  registerWebhookRoutes(app, registry);

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
