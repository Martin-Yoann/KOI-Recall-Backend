import 'dotenv/config';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);

const app = createApp();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[dev] KOI Recall API listening on http://localhost:${info.port}`);
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`[dev] received ${signal}, closing server`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
