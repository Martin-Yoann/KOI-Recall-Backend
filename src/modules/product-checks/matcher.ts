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
  result: 'potential_match' | 'not_matched';
  message: string;
}

const POTENTIAL_MATCH_MESSAGE = 'The product may be included in this recall.';
const NOT_MATCHED_MESSAGE =
  'No affected product matches the shape, flavor, and lot details provided.';

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalize(value: string): string {
  return value.toLowerCase();
}

/**
 * Decides whether the consumer-supplied product details match the campaign's
 * affected products. The check is intentionally preliminary: it returns a
 * `potential_match` only when some product lists the requested shape and flavor
 * and owns an affected lot with the same lot/date code; otherwise it returns
 * `not_matched`. Comparisons are case-insensitive to forgive user input. The
 * result never blocks a later claim submission, which re-checks eligibility.
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

  const matched = products.some((product) => {
    const attributes = product.attributes;
    const shapes = asStringArray(attributes.shapes).map(normalize);
    const flavors = asStringArray(attributes.flavors).map(normalize);
    if (!shapes.includes(shape) || !flavors.includes(flavor)) return false;

    return lots.some(
      (lot) =>
        lot.campaignProductId === product.id &&
        lot.eligibilityStatus === 'affected' &&
        normalize(lot.lotCode) === lotCode &&
        normalize(lot.dateCode) === dateCode,
    );
  });

  return {
    result: matched ? 'potential_match' : 'not_matched',
    message: matched ? POTENTIAL_MATCH_MESSAGE : NOT_MATCHED_MESSAGE,
  };
}
