import { describe, expect, it } from 'vitest';

import {
  evaluateProductCheck,
  type MatcherLotRow,
  type MatcherProductRow,
} from '../src/modules/product-checks/matcher.js';

const PRODUCT_ID = '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5';

function product(
  id: string,
  attributes: Record<string, unknown> = { flavors: ['Peach'], shapes: ['Bear'] },
): MatcherProductRow {
  return { id, attributes };
}

function lot(
  campaignProductId: string,
  lotCode: string,
  dateCode: string,
  eligibilityStatus: MatcherLotRow['eligibilityStatus'] = 'affected',
): MatcherLotRow {
  return { campaignProductId, lotCode, dateCode, eligibilityStatus };
}

const input = { shape: 'Bear', flavor: 'Peach', lotCode: 'ML-2406-A', dateCode: '06/2024' };

describe('product check matcher', () => {
  it('returns a potential match when shape, flavor and an affected lot all align', () => {
    const result = evaluateProductCheck(
      input,
      [product(PRODUCT_ID)],
      [lot(PRODUCT_ID, 'ML-2406-A', '06/2024')],
    );
    expect(result.result).toBe('potential_match');
    expect(result.message).toBeTypeOf('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('matches case-insensitively across shape, flavor, lot and date codes', () => {
    const result = evaluateProductCheck(
      { shape: 'bear', flavor: 'PEACH', lotCode: 'ml-2406-a', dateCode: '06/2024' },
      [product(PRODUCT_ID)],
      [lot(PRODUCT_ID, 'ML-2406-A', '06/2024')],
    );
    expect(result.result).toBe('potential_match');
  });

  it('returns not matched when the lot/date code is unknown', () => {
    const result = evaluateProductCheck(
      input,
      [product(PRODUCT_ID)],
      [lot(PRODUCT_ID, 'ML-9999-Z', '12/2024')],
    );
    expect(result.result).toBe('not_matched');
  });

  it('returns not matched when the lot exists but is not affected', () => {
    const result = evaluateProductCheck(
      input,
      [product(PRODUCT_ID)],
      [lot(PRODUCT_ID, 'ML-2406-A', '06/2024', 'not_affected')],
    );
    expect(result.result).toBe('not_matched');
  });

  it('returns not matched when the shape is not listed for the product', () => {
    const result = evaluateProductCheck(
      { ...input, shape: 'Dinosaur' },
      [product(PRODUCT_ID, { flavors: ['Peach'], shapes: ['Bear'] })],
      [lot(PRODUCT_ID, 'ML-2406-A', '06/2024')],
    );
    expect(result.result).toBe('not_matched');
  });

  it('returns not matched when the flavor is not listed for the product', () => {
    const result = evaluateProductCheck(
      { ...input, flavor: 'Strawberry' },
      [product(PRODUCT_ID, { flavors: ['Peach'], shapes: ['Bear'] })],
      [lot(PRODUCT_ID, 'ML-2406-A', '06/2024')],
    );
    expect(result.result).toBe('not_matched');
  });

  it('matches when any one of several products fully aligns', () => {
    const other = product('00000000-0000-4000-8000-000000000001', {
      flavors: ['Mint'],
      shapes: ['Star'],
    });
    const result = evaluateProductCheck(
      input,
      [other, product(PRODUCT_ID)],
      [lot(other.id, 'ML-2406-A', '06/2024'), lot(PRODUCT_ID, 'ML-2406-A', '06/2024')],
    );
    expect(result.result).toBe('potential_match');
  });

  it('returns not matched when there are no products', () => {
    const result = evaluateProductCheck(input, [], []);
    expect(result.result).toBe('not_matched');
  });

  it('ignores malformed attributes and treats them as empty', () => {
    const result = evaluateProductCheck(
      input,
      [product(PRODUCT_ID, { flavors: 'not-an-array', shapes: undefined })],
      [lot(PRODUCT_ID, 'ML-2406-A', '06/2024')],
    );
    expect(result.result).toBe('not_matched');
  });

  it('keeps a lot of a different product from influencing the match', () => {
    const other = product('00000000-0000-4000-8000-000000000001', {
      flavors: ['Mint'],
      shapes: ['Star'],
    });
    const result = evaluateProductCheck(
      input,
      [product(PRODUCT_ID), other],
      [lot(other.id, 'ML-2406-A', '06/2024')],
    );
    expect(result.result).toBe('not_matched');
  });
});
