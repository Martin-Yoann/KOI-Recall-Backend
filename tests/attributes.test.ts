import { describe, expect, it } from 'vitest';

import {
  parseLotAttributes,
  parseProductAttributes,
} from '../src/modules/product-identification/attributes.js';

describe('product attributes domain types (T9b/O7)', () => {
  it('parses known fields and ignores unknown keys', () => {
    const parsed = parseProductAttributes({
      weight: '18g',
      flavors: ['Peach', 'Strawberry'],
      shapes: ['Bear', 'Dinosaur'],
      legacyExtra: 'kept',
    });
    expect(parsed.flavors).toEqual(['Peach', 'Strawberry']);
    expect(parsed.shapes).toEqual(['Bear', 'Dinosaur']);
    expect(parsed.weight).toBe('18g');
  });

  it('defaults absent optional fields to undefined', () => {
    const parsed = parseProductAttributes({});
    expect(parsed.flavors).toBeUndefined();
    expect(parsed.shapes).toBeUndefined();
  });

  it('tolerates null / undefined stored values', () => {
    expect(parseProductAttributes(null).flavors).toBeUndefined();
    expect(parseProductAttributes(undefined).shapes).toBeUndefined();
  });

  it('rejects a non-object product attributes payload', () => {
    expect(() => parseProductAttributes('oops')).toThrow();
  });

  it('parses lot attributes as an extensible empty shape', () => {
    const parsed = parseLotAttributes({ future: true });
    expect(parsed).toEqual({ future: true });
    expect(parseLotAttributes(null)).toEqual({});
  });
});
