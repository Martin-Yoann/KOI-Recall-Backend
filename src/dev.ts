import 'dotenv/config';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { consoleSafeLogger } from './platform/observability/logger.js';

const port = Number(process.env.PORT ?? 3002);

const app = createApp();

const server = serve({ fetch: app.fetch, port }, (info) => {
  consoleSafeLogger.info('KOI Recall API listening', {
    path: `http://localhost:${info.port}`,
  });
});

const shutdown = (signal: NodeJS.Signals) => {
  consoleSafeLogger.info('Server shutting down', {
    errorCode: signal,
  });
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
