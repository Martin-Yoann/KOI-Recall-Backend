import { z } from 'zod';

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
  CRON_SECRET: z.string().optional(),
  /** Single-role Admin API key (T8/O10). When absent, admin routes are 501. */
  ADMIN_API_KEY: z.string().optional(),
  FIELD_ENCRYPTION_KEY: z.string().optional(),
  HASH_PEPPER: z.string().optional(),
  /** Stable production domain used in Problem Details URIs (T6.5/O6). */
  PROBLEM_BASE_URL: z.string().url().default('https://api.example.invalid'),
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
