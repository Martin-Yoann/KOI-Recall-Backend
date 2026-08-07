import { createDatabase, type DatabaseHandle } from './db/client.js';
import { DrizzleCampaignService } from './modules/campaigns/drizzle-campaign-service.js';
import type { CampaignService } from './modules/campaigns/service.js';
import { DrizzleCaseService } from './modules/cases/drizzle-case-service.js';
import type { CaseService } from './modules/cases/service.js';
import { DrizzleClaimDraftService } from './modules/claim-drafts/drizzle-claim-draft-service.js';
import type { ClaimDraftService } from './modules/claim-drafts/service.js';
import type { CommunicationService } from './modules/communications/service.js';
import { DrizzleDocumentService } from './modules/documents/drizzle-document-service.js';
import type { DocumentService } from './modules/documents/service.js';
import type { IncidentService } from './modules/incidents/service.js';
import { DrizzleProductCheckService } from './modules/product-checks/drizzle-product-check-service.js';
import type { ProductCheckService } from './modules/product-checks/service.js';
import type { AppConfig } from './config/env.js';
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
import type { TransactionalEmailPort } from './platform/email/port.js';
import { NotImplementedServiceError } from './shared/errors.js';

export interface ApplicationServices {
  campaigns: CampaignService;
  productChecks: ProductCheckService;
  claimDrafts: ClaimDraftService;
  documents: DocumentService;
  cases: CaseService;
  incidents: IncidentService;
  communications: CommunicationService;
}

export interface PlatformAdapters {
  blob: PrivateBlobPort;
  email: TransactionalEmailPort;
  crypto: SensitiveDataCryptoPort;
}

export interface ApplicationRegistry {
  services: ApplicationServices;
  platform: PlatformAdapters;
}

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(new NotImplementedServiceError(capability));
}

export function createPlaceholderRegistry(): ApplicationRegistry {
  return {
    services: {
      campaigns: {
        getPublishedCampaign: () => unavailable('Published campaign retrieval'),
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
        reconcileCompletedUpload: () => unavailable('Private Blob upload callback reconciliation'),
      },
      cases: {
        submit: () => unavailable('Recall claim submission'),
      },
      incidents: {
        createPendingIncident: () => unavailable('Incident creation'),
      },
      communications: {
        queueClaimConfirmation: () => unavailable('Claim confirmation queueing'),
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
): ApplicationRegistry {
  const placeholder = createPlaceholderRegistry();
  return {
    services: {
      ...placeholder.services,
      campaigns: new DrizzleCampaignService(handle.db),
      productChecks: new DrizzleProductCheckService(handle.db),
      claimDrafts: new DrizzleClaimDraftService(handle.db),
      documents: new DrizzleDocumentService(handle.db, blob, (work) => handle.transaction(work)),
      ...(crypto instanceof NotImplementedCryptoAdapter
        ? {}
        : { cases: new DrizzleCaseService(handle, crypto) }),
    },
    platform: { ...placeholder.platform, blob, crypto },
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
 * adapter when a `BLOB_READ_WRITE_TOKEN` is configured; otherwise the
 * not-implemented stub so the service still constructs (blob operations will
 * surface 501/503 rather than crashing at startup).
 */
function createBlobAdapter(config: AppConfig): PrivateBlobPort {
  if (!config.BLOB_READ_WRITE_TOKEN) return new NotImplementedPrivateBlobAdapter();
  // An empty callback URL signals local dev where Vercel cannot reach the host;
  // the adapter omits the callback option in that case.
  return new VercelBlobAdapter(
    config.BLOB_WEBHOOK_CALLBACK_URL ?? '',
    config.BLOB_READ_WRITE_TOKEN,
  );
}

/**
 * Selects the default registry from configuration: a real database-backed
 * registry when `DATABASE_URL` is present (local Postgres or Neon, auto-detected
 * by the client), otherwise the all-placeholder skeleton registry.
 */
export function createDefaultRegistry(config: AppConfig): ApplicationRegistry {
  if (config.DATABASE_URL !== undefined) validateDatabaseUrl(config.DATABASE_URL);
  const crypto = createCryptoAdapter(config);
  if (config.DATABASE_URL === undefined) {
    const placeholder = createPlaceholderRegistry();
    return { ...placeholder, platform: { ...placeholder.platform, crypto } };
  }
  return createApplicationRegistry(
    createDatabase(config.DATABASE_URL),
    createBlobAdapter(config),
    crypto,
  );
}
