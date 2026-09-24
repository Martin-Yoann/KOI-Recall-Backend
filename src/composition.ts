import { createDatabase, type DatabaseHandle } from './db/client.js';
import { DrizzleCampaignService } from './modules/campaigns/drizzle-campaign-service.js';
import type { CampaignService } from './modules/campaigns/service.js';
import { DrizzleCaseService } from './modules/cases/drizzle-case-service.js';
import type { CaseService } from './modules/cases/service.js';
import { DrizzleDisposalService } from './modules/disposal/drizzle-disposal-service.js';
import type { DisposalService } from './modules/disposal/service.js';
import { DrizzleCaseStatusLookupService } from './modules/cases/drizzle-case-status-lookup-service.js';
import type { CaseStatusLookupService } from './modules/cases/case-status-lookup-service.js';
import { DrizzleAdminService } from './modules/admin/drizzle-admin-service.js';
import type { AdminService } from './modules/admin/service.js';
import { DrizzleCaseResolutionService } from './modules/resolutions/drizzle-case-resolution-service.js';
import { EmailTriggerService } from './modules/communications/email-trigger-service.js';
import {
  DrizzleCommunicationQueueService,
  type CommunicationQueueService,
} from './modules/communications/queue-service.js';
import { DrizzleStaffService } from './modules/staff/drizzle-staff-service.js';
import { DrizzleAuditService } from './modules/staff/drizzle-audit-service.js';
import type { StaffService } from './modules/staff/service.js';
import { RefundExportService } from './modules/refund-exports/service.js';
import type { AuditService } from './modules/staff/audit-service.js';
import { DrizzleClaimDraftService } from './modules/claim-drafts/drizzle-claim-draft-service.js';
import type { ClaimDraftService } from './modules/claim-drafts/service.js';
import { DrizzleCommunicationService } from './modules/communications/drizzle-communication-service.js';
import type { CommunicationService } from './modules/communications/service.js';
import { DrizzleDocumentService } from './modules/documents/drizzle-document-service.js';
import type { DocumentService } from './modules/documents/service.js';
import { DrizzleProductCheckService } from './modules/product-checks/drizzle-product-check-service.js';
import type { ProductCheckService } from './modules/product-checks/service.js';
import { DEFAULT_CONSUMER_WEB_BASE_URL, type AppConfig } from './config/env.js';
import { DrizzleDraftCleanupWorker } from './jobs/draft-cleanup-worker.js';
import { DrizzleOutboxWorker } from './jobs/drizzle-outbox-worker.js';
import type { DraftCleanupResult } from './routes/internal-jobs.js';
import type { OutboxJobResult } from './jobs/outbox.js';
import { LocalFilesystemBlobAdapter } from './platform/blob/local-filesystem.js';
import { NotImplementedPrivateBlobAdapter } from './platform/blob/not-implemented.js';
import type { PrivateBlobPort } from './platform/blob/port.js';
import { VercelBlobAdapter } from './platform/blob/vercel-blob.js';
import { NotImplementedCryptoAdapter } from './platform/crypto/not-implemented.js';
import {
  NodeSensitiveDataCrypto,
  validateFieldEncryptionKey,
  validateHashPepper,
} from './platform/crypto/node-sensitive-data-crypto.js';
import type { SensitiveDataCryptoPort } from './platform/crypto/port.js';
import { NotImplementedEmailAdapter } from './platform/email/not-implemented.js';
import { ResendEmailAdapter } from './platform/email/resend.js';
import { NotConfiguredCacheInvalidator } from './platform/cache-invalidation/not-configured.js';
import type { CampaignCacheInvalidator } from './platform/cache-invalidation/port.js';
import { WebRevalidateCacheInvalidator } from './platform/cache-invalidation/web-revalidate.js';
import { consoleSafeLogger } from './platform/observability/logger.js';
import { InMemoryRateLimiter, type RateLimiter } from './middleware/rate-limit.js';
import type { TransactionalEmailPort } from './platform/email/port.js';
import { NotImplementedServiceError } from './shared/errors.js';

export interface ApplicationServices {
  campaigns: CampaignService;
  productChecks: ProductCheckService;
  claimDrafts: ClaimDraftService;
  documents: DocumentService;
  cases: CaseService;
  caseStatusLookups: CaseStatusLookupService;
  communications: CommunicationService;
  admin?: AdminService;
  /** ADR-0004: staff identity, sessions, and audit (B-end RBAC). */
  staff?: StaffService;
  audit?: AuditService;
  refundExports?: RefundExportService;
  /** Consumer product disposal: eligibility, evidence review, authorization. */
  disposal?: DisposalService;
  adminTransactions?: AdminTransactionRunner;
}

export interface AdminTransactionServices {
  admin: AdminService;
  staff: StaffService;
  audit: AuditService;
  disposal: DisposalService;
}

export interface AdminTransactionRunner {
  run<T>(work: (services: AdminTransactionServices) => Promise<T>): Promise<T>;
}

export interface PlatformAdapters {
  blob: PrivateBlobPort;
  email: TransactionalEmailPort;
  crypto: SensitiveDataCryptoPort;
}

export interface ApplicationRegistry {
  services: ApplicationServices;
  platform: PlatformAdapters;
  jobs?: {
    drainOutbox: () => Promise<OutboxJobResult>;
    cleanupDrafts: () => Promise<DraftCleanupResult>;
  };
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new NotImplementedServiceError(capability));
}

/**
 * Builds the disposal service for either executor path. Retention days come from
 * configuration; null means no configured expiry, which is the conservative
 * default until the business names a retention period.
 */
export function createDisposalService(
  handle: DatabaseHandle,
  evidenceRetentionDays: number | null,
  notifications?: CommunicationQueueService,
): DisposalService {
  return new DrizzleDisposalService({ handle, evidenceRetentionDays, notifications });
}

export function createPlaceholderRegistry(): ApplicationRegistry {
  return {
    services: {
      campaigns: {
        getPublishedCampaign: () => unavailable('Published campaign retrieval'),
        publishVersion: () => unavailable('Campaign version publishing'),
      },
      productChecks: {
        check: () => unavailable('Product checking'),
      },
      claimDrafts: {
        create: () => unavailable('Claim draft creation'),
        assertActive: () => unavailable('Claim draft authentication'),
      },
      documents: {
        authorizeUpload: () => unavailable('Private Blob upload authorization'),
        scheduleDraftDocumentDeletion: () => unavailable('Draft document deletion'),
        listDraftDocuments: () => unavailable('Draft document listing'),
        reconcileCompletedUpload: () => unavailable('Private Blob upload callback reconciliation'),
      },
      cases: {
        submit: () => unavailable('Recall claim submission'),
      },
      caseStatusLookups: {
        lookup: () => unavailable('Case status lookup'),
      },
      communications: {
        recordDeliveryEvent: () => unavailable('Provider delivery event recording'),
      },
    },
    platform: {
      blob: new NotImplementedPrivateBlobAdapter(),
      email: new NotImplementedEmailAdapter(),
      crypto: new NotImplementedCryptoAdapter(),
    },
  };
}

/**
 * Builds a registry where campaign retrieval, product checks, anonymous draft
 * creation, and draft document uploads read from the database. Claim submission
 * additionally requires a configured crypto adapter; otherwise it remains a
 * not-implemented capability. The blob adapter defaults to the not-implemented
 * stub so callers without a configured Private Blob store still get a usable
 * (501-on-blob-ops) registry.
 */
export function createApplicationRegistry(
  handle: DatabaseHandle,
  blob: PrivateBlobPort = new NotImplementedPrivateBlobAdapter(),
  crypto: SensitiveDataCryptoPort = new NotImplementedCryptoAdapter(),
  email: TransactionalEmailPort = new NotImplementedEmailAdapter(),
  // The outbox queue is plain DB persistence with no external dependency, so
  // claim submission stays available even where email (Resend) is not
  // configured — the outbox worker drains it once email exists. Tests inject
  // fakes through this parameter.
  communicationQueue: CommunicationQueueService = new DrizzleCommunicationQueueService(),
  malwareScanRequired = false,
  consumerWebBaseUrl = DEFAULT_CONSUMER_WEB_BASE_URL,
  // Publishing a campaign expires the web app's cached copy of it. Absent
  // configuration leaves this as a no-op rather than an error, because the
  // public read still expires on its own revalidate window.
  cacheInvalidator: CampaignCacheInvalidator = new NotConfiguredCacheInvalidator(),
  // Stage 3 of the structured-incident rollout; off by default so a deployed
  // backend never starts rejecting payloads an older web app still sends.
  incidentStrictValidation = false,
  /** Disposal evidence retention in days; null keeps evidence until released. */
  evidenceRetentionDays: number | null = null,
): ApplicationRegistry {
  const placeholder = createPlaceholderRegistry();
  // Built once so the case service and the registry share the same instance.
  const disposalService = createDisposalService(handle, evidenceRetentionDays, communicationQueue);
  const emailTrigger = new EmailTriggerService(communicationQueue);
  return {
    services: {
      ...placeholder.services,
      campaigns: new DrizzleCampaignService(handle, cacheInvalidator),
      productChecks: new DrizzleProductCheckService(handle.db),
      claimDrafts: new DrizzleClaimDraftService(handle.db),
      documents: new DrizzleDocumentService(
        handle.db,
        blob,
        (work) => handle.transaction(work),
        malwareScanRequired,
      ),
      communications: new DrizzleCommunicationService(handle.db),
      ...(crypto instanceof NotImplementedCryptoAdapter
        ? {}
        : {
            cases: new DrizzleCaseService(
              handle,
              crypto,
              new DrizzleCaseResolutionService(handle, crypto, emailTrigger),
              undefined,
              undefined,
              malwareScanRequired,
              communicationQueue,
              incidentStrictValidation,
              disposalService,
              consumerWebBaseUrl,
            ),
            caseStatusLookups: new DrizzleCaseStatusLookupService(handle.db, crypto),
            admin: new DrizzleAdminService({
              db: handle.db,
              crypto,
              resolutions: new DrizzleCaseResolutionService(handle, crypto, emailTrigger),
              blob,
              emailTrigger,
              consumerWebBaseUrl,
            }),
            staff: new DrizzleStaffService(handle.db, crypto),
            audit: new DrizzleAuditService(handle.db),
            refundExports: new RefundExportService(handle),
            disposal: disposalService,
            adminTransactions: {
              run: (work) =>
                handle.transaction((tx) =>
                  work({
                    admin: new DrizzleAdminService({
                      db: tx,
                      crypto,
                      resolutions: new DrizzleCaseResolutionService(
                        {
                          db: tx as never,
                          driver: handle.driver,
                          transaction: async (work) => work(tx),
                          close: async () => {},
                        },
                        crypto,
                        emailTrigger,
                      ),
                      emailTrigger,
                      consumerWebBaseUrl,
                    }),
                    staff: new DrizzleStaffService(tx, crypto),
                    audit: new DrizzleAuditService(tx),
                    disposal: createDisposalService(
                      {
                        db: tx as never,
                        driver: handle.driver,
                        transaction: async (work) => work(tx),
                        close: async () => {},
                      },
                      evidenceRetentionDays,
                    ),
                  }),
                ),
            },
          }),
    },
    platform: { ...placeholder.platform, blob, crypto, email },
    jobs: {
      drainOutbox:
        crypto instanceof NotImplementedCryptoAdapter || email instanceof NotImplementedEmailAdapter
          ? () => unavailable('Outbox processing')
          : () => new DrizzleOutboxWorker(handle.db, email, crypto).runBatch(),
      cleanupDrafts:
        blob instanceof NotImplementedPrivateBlobAdapter
          ? () => unavailable('Draft cleanup')
          : () => new DrizzleDraftCleanupWorker(handle.db, blob).runBatch(),
    },
  };
}

function createCryptoAdapter(config: AppConfig): SensitiveDataCryptoPort {
  const encryptionKey = config.FIELD_ENCRYPTION_KEY;
  const hashPepper = config.HASH_PEPPER;
  if (encryptionKey !== undefined && hashPepper !== undefined) {
    return new NodeSensitiveDataCrypto(encryptionKey, hashPepper);
  }
  if (encryptionKey !== undefined) validateFieldEncryptionKey(encryptionKey);
  if (hashPepper !== undefined) validateHashPepper(hashPepper);
  return new NotImplementedCryptoAdapter();
}

function validateDatabaseUrl(databaseUrl: string): void {
  try {
    const parsed = new URL(databaseUrl);
    if (
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
      parsed.hostname.length === 0
    ) {
      throw new Error('Invalid database URL.');
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection string.');
  }
}

/**
 * Builds a Private Blob adapter from configuration. Returns the real Vercel
 * adapter when a `BLOB_READ_WRITE_TOKEN` is configured OR when running on
 * Vercel — on the serverless runtime the Blob SDK authenticates via OIDC
 * (`VERCEL_OIDC_TOKEN`) without a static token, so the adapter must be wired
 * even when the legacy token is absent. Locally, where neither is available,
 * the not-implemented stub keeps blob operations at 501 rather than crashing.
 */
function createBlobAdapter(config: AppConfig): PrivateBlobPort {
  // Explicitly naming a local directory is what selects the filesystem adapter.
  // Without it nothing changes, so no existing environment behaves differently
  // because this exists — and a deployment that never sets LOCAL_BLOB_DIR cannot
  // reach it.
  const localBlobDir = process.env.LOCAL_BLOB_DIR;
  if (localBlobDir) return new LocalFilesystemBlobAdapter({ root: localBlobDir });

  const onVercel = process.env.VERCEL === '1';
  if (!config.BLOB_READ_WRITE_TOKEN && !onVercel) return new NotImplementedPrivateBlobAdapter();
  // An empty callback URL signals local dev where Vercel cannot reach the host;
  // the adapter omits the callback option in that case. On Vercel the token is
  // undefined and the SDK resolves auth via OIDC automatically.
  return new VercelBlobAdapter(
    config.BLOB_WEBHOOK_CALLBACK_URL ?? '',
    config.BLOB_READ_WRITE_TOKEN,
  );
}

export function createEmailAdapter(config: AppConfig): TransactionalEmailPort {
  if (!config.RESEND_API_KEY || !config.RESEND_FROM_EMAIL) return new NotImplementedEmailAdapter();
  return new ResendEmailAdapter(config.RESEND_API_KEY, config.RESEND_FROM_EMAIL);
}

/**
 * Selects the default registry from configuration: a real database-backed
 * registry when `DATABASE_URL` is present (local Postgres or Neon, auto-detected
 * by the client), otherwise the all-placeholder skeleton registry.
 */
export function createDefaultRegistry(config: AppConfig): ApplicationRegistry {
  if (config.DATABASE_URL !== undefined) validateDatabaseUrl(config.DATABASE_URL);
  const crypto = createCryptoAdapter(config);
  const communicationQueue = new DrizzleCommunicationQueueService();

  if (config.DATABASE_URL === undefined) {
    const placeholder = createPlaceholderRegistry();
    return { ...placeholder, platform: { ...placeholder.platform, crypto } };
  }
  return createApplicationRegistry(
    createDatabase(config.DATABASE_URL),
    createBlobAdapter(config),
    crypto,
    createEmailAdapter(config),
    communicationQueue,
    config.MALWARE_SCAN_REQUIRED,
    config.CONSUMER_WEB_BASE_URL,
    createCacheInvalidator(config),
    config.INCIDENT_STRICT_VALIDATION,
    config.DISPOSAL_EVIDENCE_RETENTION_DAYS ?? null,
  );
}

/**
 * Builds the published-campaign cache invalidator. Both the endpoint and its
 * shared secret are required: a URL with no secret would be rejected by the web
 * app anyway, so that combination is treated as unconfigured.
 */
export function createCacheInvalidator(config: AppConfig): CampaignCacheInvalidator {
  if (!config.WEB_REVALIDATE_URL || !config.WEB_REVALIDATE_SECRET) {
    return new NotConfiguredCacheInvalidator();
  }
  return new WebRevalidateCacheInvalidator(config.WEB_REVALIDATE_URL, config.WEB_REVALIDATE_SECRET);
}

/**
 * Resolves the Redis REST credentials from either naming scheme, preferring the
 * Upstash-native pair. Split out so the preference is directly testable rather
 * than inferred from which adapter gets constructed.
 *
 * A lone URL or lone token is not usable — the REST API needs both — so an
 * incomplete pair resolves to null and the caller falls back.
 */
export function resolveRateLimitCredentials(
  config: AppConfig,
): { url: string; token: string } | null {
  const url = config.UPSTASH_REDIS_REST_URL ?? config.KV_REST_API_URL;
  const token = config.UPSTASH_REDIS_REST_TOKEN ?? config.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Selects the rate limiter. With a Redis store configured the quotas are
 * enforced across every instance; without one the in-memory limiter only bounds
 * a single instance, which is worth saying out loud at startup because the
 * difference is invisible from the outside.
 *
 * Both credential namings are accepted: a direct Upstash setup uses
 * `UPSTASH_REDIS_REST_*`, while Vercel's marketplace integration provisions the
 * legacy Vercel-KV names even though the endpoint it hands back is an Upstash
 * REST URL.
 */
export function createRateLimiter(config: AppConfig): RateLimiter {
  const credentials = resolveRateLimitCredentials(config);
  if (!credentials) {
    consoleSafeLogger.info(
      'Rate limiting is per-instance: no Redis REST credentials are configured.',
    );
    return new InMemoryRateLimiter();
  }
  // The Upstash client is loaded on first use rather than at module load. The
  // packages are only needed when a store is actually configured, and importing
  // them statically made their absence a startup crash for every deployment —
  // including the ones that never configured a store and would use the in-memory
  // limiter anyway.
  let loaded: Promise<RateLimiter> | null = null;
  const store = (): Promise<RateLimiter> => {
    loaded ??= import('./platform/rate-limit/upstash-rate-limiter.js').then(
      ({ UpstashRateLimiter }) =>
        UpstashRateLimiter.fromCredentials(credentials.url, credentials.token, consoleSafeLogger),
    );
    return loaded;
  };

  return { check: (key) => store().then((limiter) => limiter.check(key)) };
}
