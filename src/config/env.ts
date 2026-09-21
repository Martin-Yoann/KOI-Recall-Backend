import { z } from 'zod';

/**
 * The single default for the consumer web app base URL. Used by the schema
 * below and by composition when no config is supplied (tests), so the
 * literal never spreads to call sites.
 */
export const DEFAULT_CONSUMER_WEB_BASE_URL = 'http://localhost:3000';

const environmentSchema = z.object({
  APP_ENV: z.enum(['local', 'preview', 'staging', 'production']).default('local'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().optional(),
  koi_DATABASE_URL: z.string().optional(),
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  BLOB_WEBHOOK_CALLBACK_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  MALWARE_SCAN_REQUIRED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Stage 3 of the structured-incident rollout. While false (the default) the
   * new incident fields are accepted but optional, so older clients keep
   * submitting; when true a confirmed incident must carry them. Turning it off
   * again is a complete rollback — no collected field is ever dropped.
   */
  INCIDENT_STRICT_VALIDATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CRON_SECRET: z.string().optional(),
  /** Single-role Admin API key (T8/O10). When absent, admin routes are 501. */
  ADMIN_API_KEY: z.string().optional(),
  FIELD_ENCRYPTION_KEY: z.string().optional(),
  HASH_PEPPER: z.string().optional(),
  /** Stable production domain used in Problem Details URIs (T6.5/O6). */
  PROBLEM_BASE_URL: z.string().url().default('https://api.example.invalid'),
  /** Consumer web app base URL; used for consumer-facing email links. */
  CONSUMER_WEB_BASE_URL: z.string().url().default(DEFAULT_CONSUMER_WEB_BASE_URL),
  /**
   * Full URL of the consumer web app's on-demand cache invalidation route, e.g.
   * https://koiimprtinc.com/api/revalidate. Optional: without it, published
   * campaigns simply expire on the web app's own revalidate window.
   */
  WEB_REVALIDATE_URL: z.string().url().optional(),
  /** Shared secret for WEB_REVALIDATE_URL; must match the web app's REVALIDATE_SECRET. */
  WEB_REVALIDATE_SECRET: z.string().optional(),
  /**
   * Upstash Redis REST credentials for cross-instance rate limiting.
   *
   * Two naming schemes are accepted because both are real: a direct Upstash
   * setup uses `UPSTASH_REDIS_REST_*`, while Vercel's marketplace integration
   * provisions the legacy Vercel-KV names (`KV_REST_API_*`) even though the
   * endpoint it hands back is an Upstash REST URL. Either pair works; without
   * one the app falls back to the per-instance in-memory limiter.
   */
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  KV_REST_API_URL: z.string().url().optional(),
  KV_REST_API_TOKEN: z.string().optional(),
});

type EnvironmentVariables = z.infer<typeof environmentSchema>;

export interface AppConfig extends EnvironmentVariables {
  readonly allowedOrigins: string[];
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(source);
  const databaseUrl = parsed.DATABASE_URL || parsed.koi_DATABASE_URL;
  const allowedOrigins = parsed.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowedOrigins.some((origin) => origin === '*')) {
    throw new Error('CORS_ALLOWED_ORIGINS must not contain a wildcard.');
  }

  return { ...parsed, DATABASE_URL: databaseUrl, allowedOrigins };
}
