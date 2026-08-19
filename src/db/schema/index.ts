/**
 * Barrel export for the database schema. Table definitions are split by
 * aggregate (campaigns, claims, documents, incidents, operations); this file
 * only re-exports so `drizzle.config.ts` (which points here) and existing
 * `import * as schema` callers keep working unchanged. Migrations remain
 * generated solely by Drizzle.
 */
export * from './campaigns.js';
export * from './claims.js';
export * from './consumers.js';
export * from './documents.js';
export * from './incidents.js';
export * from './operations.js';
export * from './resolutions.js';
export * from './refund-exports.js';
export * from './staff.js';
