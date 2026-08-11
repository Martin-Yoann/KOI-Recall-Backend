import { describe, expect, it } from 'vitest';

import {
  maskAddress,
  maskEmail,
  maskName,
  maskPhone,
  type MaskableAddress,
} from '../src/modules/admin/pii-masking.js';

describe('maskEmail', () => {
  it('masks the local part and keeps a domain hint', () => {
    expect(maskEmail('jane.doe@example.com')).toMatch(/^j[^@]*@e[^.]*\.com$/);
  });

  it('keeps the tld intact', () => {
    expect(maskEmail('a@b.co')).toMatch(/\.co$/);
  });

  it('handles unicode local parts', () => {
    expect(maskEmail('José@ñandú.com')).toMatch(/^J[^@]*@[^@]+\.[^.]+$/);
  });

  it('returns a bullet for empty input', () => {
    expect(maskEmail('')).toBe('•');
  });

  it('returns a bullet for malformed input without an @', () => {
    expect(maskEmail('no-at-sign')).toBe('•');
  });
});

describe('maskPhone', () => {
  it('keeps the last 4 digits and masks the rest', () => {
    const masked = maskPhone('+15551234567');
    expect(masked).toMatch(/4567$/);
    expect(masked).toContain('•');
  });

  it('returns bullets for inputs shorter than 4 digits', () => {
    expect(maskPhone('123')).toBe('•••');
  });

  it('handles a parenthesized display number', () => {
    const masked = maskPhone('(555) 123-4567');
    expect(masked).toMatch(/4567$/);
  });

  it('returns a bullet for empty input', () => {
    expect(maskPhone('')).toBe('•');
  });
});

describe('maskName', () => {
  it('keeps only the first character and adds a bullet', () => {
    expect(maskName('Jane')).toBe('J•');
  });

  it('trims surrounding whitespace', () => {
    expect(maskName('  Jane  ')).toBe('J•');
  });

  it('returns a bullet for empty input', () => {
    expect(maskName('')).toBe('•');
  });

  it('handles a unicode name', () => {
    expect(maskName('Añijo')).toBe('A•');
  });
});

describe('maskAddress', () => {
  const full: MaskableAddress = {
    line1: '123 Secret Lane',
    line2: 'Apt 4',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62704',
    countryCode: 'US',
  };

  it('masks street line1 and postal code', () => {
    const masked = maskAddress(full);
    expect(masked.line1).toBe('••••');
    expect(masked.postalCode).toBe('•••••');
    expect(masked.line2).toBeUndefined();
  });

  it('keeps city, state, country for locality', () => {
    const masked = maskAddress(full);
    expect(masked.city).toBe('Springfield');
    expect(masked.state).toBe('IL');
    expect(masked.countryCode).toBe('US');
  });

  it('lets two regions be told apart while street is hidden', () => {
    const a = maskAddress({ ...full, city: 'A', state: 'NY' });
    const b = maskAddress({ ...full, city: 'B', state: 'CA' });
    expect(a.city).not.toBe(b.city);
    expect(a.state).not.toBe(b.state);
    expect(a.line1).toBe(b.line1); // both masked identically
  });

  it('returns empty object for null/undefined', () => {
    expect(maskAddress(null)).toEqual({});
    expect(maskAddress(undefined)).toEqual({});
  });

  it('handles a partial address missing street', () => {
    const masked = maskAddress({ city: 'X', state: 'Y', countryCode: 'US' });
    expect(masked.line1).toBeUndefined();
    expect(masked.city).toBe('X');
  });
});
