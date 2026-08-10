import { parseProductAttributes } from '../product-identification/attributes.js';

/**
 * Row shapes read by {@link DrizzleProductCheckService} and consumed by
 * {@link evaluateProductCheck}. Declared explicitly so the matcher is a pure,
 * database-free function that is trivial to unit-test with fixtures.
 */
export interface MatcherProductRow {
  id: string;
  attributes: Record<string, unknown>;
}

export interface MatcherLotRow {
  campaignProductId: string;
  lotCode: string;
  dateCode: string;
  eligibilityStatus: 'affected' | 'not_affected' | 'manual_review';
}

export interface ProductCheckEvaluation {
  result: 'potential_match' | 'manual_review' | 'not_matched';
  message: string;
}

const POTENTIAL_MATCH_MESSAGE = 'The product may be included in this recall.';
const MANUAL_REVIEW_MESSAGE = 'The product details require manual review.';
const NOT_MATCHED_MESSAGE =
  'No affected product matches the shape, flavor, and lot details provided.';

function normalize(value: string): string {
  return value.toLowerCase();
}

/**
 * Decides whether the consumer-supplied product details match the campaign's
 * affected products. The check is intentionally preliminary: it returns a
 * `potential_match` when an affected lot aligns, otherwise `manual_review`
 * when a matching lot requires review, and `not_matched` when neither applies.
 * Comparisons are case-insensitive to forgive user input. The result never
 * blocks a later claim submission, which re-checks eligibility.
 */
export function evaluateProductCheck(
  input: { shape: string; flavor: string; lotCode: string; dateCode: string },
  products: readonly MatcherProductRow[],
  lots: readonly MatcherLotRow[],
): ProductCheckEvaluation {
  const shape = normalize(input.shape);
  const flavor = normalize(input.flavor);
  const lotCode = normalize(input.lotCode);
  const dateCode = normalize(input.dateCode);

  let manualReview = false;
  for (const product of products) {
    const attributes = parseProductAttributes(product.attributes);
    const shapes = (attributes.shapes ?? []).map(normalize);
    const flavors = (attributes.flavors ?? []).map(normalize);
    if (!shapes.includes(shape) || !flavors.includes(flavor)) continue;

    for (const lot of lots) {
      if (
        lot.campaignProductId !== product.id ||
        normalize(lot.lotCode) !== lotCode ||
        normalize(lot.dateCode) !== dateCode
      ) {
        continue;
      }
      if (lot.eligibilityStatus === 'affected') {
        return { result: 'potential_match', message: POTENTIAL_MATCH_MESSAGE };
      }
      if (lot.eligibilityStatus === 'manual_review') manualReview = true;
    }
  }

  return {
    result: manualReview ? 'manual_review' : 'not_matched',
    message: manualReview ? MANUAL_REVIEW_MESSAGE : NOT_MATCHED_MESSAGE,
  };
}
