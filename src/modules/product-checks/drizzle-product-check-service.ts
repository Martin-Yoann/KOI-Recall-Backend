import type { Database } from '../../db/client.js';
import { DrizzleCampaignSnapshotReader } from '../product-identification/drizzle-snapshot-reader.js';
import { DrizzleProductIdentificationService } from '../product-identification/service.js';
import type { ProductCheckService } from './service.js';

/**
 * Reads the published campaign snapshot and evaluates the shared
 * ProductIdentificationPolicy (ADR-0002). The injected {@link Database} is the
 * dual-adapter union, so the same code runs against Neon Serverless Pool in
 * production and node-postgres locally with no branching.
 */
export class DrizzleProductCheckService implements ProductCheckService {
  private readonly inner: DrizzleProductIdentificationService;

  constructor(db: Database) {
    this.inner = new DrizzleProductIdentificationService(new DrizzleCampaignSnapshotReader(db));
  }

  check: ProductCheckService['check'] = (input) => this.inner.check(input);
}
