import { describe, expect, it } from 'vitest';

import {
  generateCaseReference,
  hashCanonicalRequest,
  normalizeAddress,
  normalizeEmail,
  normalizeOrderNumber,
} from '../src/modules/cases/normalization.js';

describe('case normalization helpers', () => {
  it('normalizes lookup values', () => {
    expect(normalizeEmail('  Taylor@Example.COM ')).toBe('taylor@example.com');
    expect(normalizeOrderNumber(' order-1001 ')).toBe('ORDER-1001');
    expect(
      normalizeAddress({
        line1: ' 100 Example Street ',
        city: ' Austin ',
        state: ' TX ',
        postalCode: ' 78701 ',
        countryCode: 'us',
      }),
    ).toBe(
      '{"city":"Austin","countryCode":"US","line1":"100 Example Street","postalCode":"78701","state":"TX"}',
    );
  });

  it('hashes object keys canonically while preserving array order', () => {
    expect(hashCanonicalRequest({ b: 2, a: 1 })).toBe(hashCanonicalRequest({ a: 1, b: 2 }));
    expect(hashCanonicalRequest({ values: [1, 2] })).not.toBe(
      hashCanonicalRequest({ values: [2, 1] }),
    );
  });

  it('generates contract-valid case references', () => {
    expect(generateCaseReference()).toMatch(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/);
  });
});
