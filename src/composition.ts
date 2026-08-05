import { createDatabase, type DatabaseHandle } from './db/client.js';
import { DrizzleCampaignService } from './modules/campaigns/drizzle-campaign-service.js';
import type { CampaignService } from './modules/campaigns/service.js';
import type { CaseService } from './modules/cases/service.js';
import type { ClaimDraftService } from './modules/claim-drafts/service.js';
import type { CommunicationService } from './modules/communications/service.js';
import type { DocumentService } from './modules/documents/service.js';
import type { IncidentService } from './modules/incidents/service.js';
import { DrizzleProductCheckService } from './modules/product-checks/drizzle-product-check-service.js';
import type { ProductCheckService } from './modules/product-checks/service.js';
import type { AppConfig } from './config/env.js';
import { NotImplementedPrivateBlobAdapter } from './platform/blob/not-implemented.js';
import type { PrivateBlobPort } from './platform/blob/port.js';
import { NotImplementedCryptoAdapter } from './platform/crypto/not-implemented.js';
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
 * Builds a registry where campaign retrieval and product checks read from the
 * database; every other Phase 1 capability stays on the not-implemented
 * placeholder.
 */
export function createApplicationRegistry(handle: DatabaseHandle): ApplicationRegistry {
  const placeholder = createPlaceholderRegistry();
  return {
    services: {
      ...placeholder.services,
      campaigns: new DrizzleCampaignService(handle.db),
      productChecks: new DrizzleProductCheckService(handle.db),
    },
    platform: placeholder.platform,
  };
}

/**
 * Selects the default registry from configuration: a real database-backed
 * registry when `DATABASE_URL` is present (local Postgres or Neon, auto-detected
 * by the client), otherwise the all-placeholder skeleton registry.
 */
export function createDefaultRegistry(config: AppConfig): ApplicationRegistry {
  if (!config.DATABASE_URL) return createPlaceholderRegistry();
  return createApplicationRegistry(createDatabase(config.DATABASE_URL));
}
