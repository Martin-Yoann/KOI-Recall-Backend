/**
 * Contract aggregation entry point. Domain schemas are split by aggregate
 * (common, campaigns, product-checks, documents, claims); routes and the
 * OpenAPI config live in routes.ts. This file only re-exports so it remains the
 * single import surface for services, tests, and OpenAPI generation. The
 * `openapi:check` drift guard continues to hold `toc.ts` as the source.
 */
export * from './common.js';
export * from './campaigns.js';
export * from './product-checks.js';
export * from './documents.js';
export * from './claims.js';
export * from './case-status-lookups.js';
export * from './consumer-auth.js';
export * from './routes.js';
