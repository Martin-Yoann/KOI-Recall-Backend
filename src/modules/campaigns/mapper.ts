import type { CampaignView } from '../../contracts/toc.js';
import { parseProductAttributes } from '../product-identification/attributes.js';

/**
 * Row shapes read by {@link DrizzleCampaignService} and consumed by
 * {@link mapToCampaignView}. Defined explicitly so the mapper is a pure,
 * database-free function that is trivial to unit-test with fixtures.
 */

export interface CampaignSourceRow {
  slug: string;
  code: string;
  defaultLocale: string;
  versionNumber: number;
}

export interface CampaignLocalizationRow {
  locale: string;
  title: string;
  summary: string;
  hazard: string;
  immediateAction: string;
  remedySummary: string;
  supportEmail: string;
  supportPhone: string;
  supportHours: string;
}

export interface CampaignProductRow {
  id: string;
  sku: string;
  brand: string;
  name: string;
  attributes: Record<string, unknown>;
  sortOrder: number;
}

export interface CampaignLotRow {
  campaignProductId: string;
  lotCode: string;
  dateCode: string;
  eligibilityStatus: 'affected' | 'not_affected' | 'manual_review';
  attributes: Record<string, unknown>;
}

export interface CampaignRemedyRow {
  code: string;
  displayName: string;
  active: boolean;
  sortOrder: number;
}

export interface CampaignEvidenceRow {
  category: 'product_photo' | 'proof_of_purchase' | 'incident_evidence';
  required: boolean;
  minimumFiles: number;
  maximumFiles: number;
  allowedMimeTypes: string[];
  maximumFileSizeBytes: number;
  instructions: string;
}

export interface CampaignSource {
  campaign: CampaignSourceRow;
  localization: CampaignLocalizationRow;
  products: CampaignProductRow[];
  lots: CampaignLotRow[];
  remedies: CampaignRemedyRow[];
  evidence: CampaignEvidenceRow[];
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Maps raw campaign rows into the public {@link CampaignView}. Filtering
 * (affected lots, active remedies) and ordering happen here so the rules live
 * in one deterministic, side-effect-free place.
 */
export function mapToCampaignView(source: CampaignSource): CampaignView {
  const products = [...source.products]
    .sort((a, b) => a.sortOrder - b.sortOrder || compareString(a.id, b.id))
    .map((product) => {
      const affectedLots = source.lots
        .filter(
          (lot) => lot.campaignProductId === product.id && lot.eligibilityStatus === 'affected',
        )
        .sort(
          (a, b) => compareString(a.lotCode, b.lotCode) || compareString(a.dateCode, b.dateCode),
        )
        .map((lot) => ({
          lotCode: lot.lotCode,
          dateCode: lot.dateCode,
          attributes: lot.attributes,
        }));

      const attributes = parseProductAttributes(product.attributes);
      return {
        productId: product.id,
        sku: product.sku,
        brand: product.brand,
        name: product.name,
        flavors: attributes.flavors ?? [],
        shapes: attributes.shapes ?? [],
        affectedLots,
      };
    });

  const remedies = [...source.remedies]
    .filter((remedy) => remedy.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || compareString(a.code, b.code))
    .map((remedy) => ({ code: remedy.code, displayName: remedy.displayName }));

  const evidenceRequirements = [...source.evidence]
    .sort((a, b) => compareString(a.category, b.category))
    .map((evidence) => ({ ...evidence }));

  return {
    slug: source.campaign.slug,
    code: source.campaign.code,
    version: source.campaign.versionNumber,
    locale: source.localization.locale,
    defaultLocale: source.campaign.defaultLocale,
    title: source.localization.title,
    summary: source.localization.summary,
    hazard: source.localization.hazard,
    immediateAction: source.localization.immediateAction,
    remedySummary: source.localization.remedySummary,
    support: {
      email: source.localization.supportEmail,
      phone: source.localization.supportPhone,
      hours: source.localization.supportHours,
    },
    products,
    remedies,
    evidenceRequirements,
  };
}
