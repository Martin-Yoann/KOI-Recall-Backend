import { describe, expect, it } from 'vitest';
import { validatePublicationContent } from '../src/modules/campaigns/publication-content.js';

const content = () => ({
  title: 'Product recall',
  summary: 'Affected products and next steps.',
  hazard: 'Battery ingestion hazard.',
  immediateAction: 'Stop using the affected product.',
  remedySummary: 'Contact the recall team for the replacement process.',
  supportEmail: 'recall@koiimprtinc.com',
  supportPhone: '+1 800 234 6789',
  supportHours: 'Monday–Friday 9am–5pm ET',
});

describe('publication content gate', () => {
  it('accepts complete content without deciding approval or remedy availability', () => {
    expect(() => validatePublicationContent(content())).not.toThrow();
  });

  it.each(Object.keys(content()))('rejects whitespace-only %s', (field) => {
    expect(() => validatePublicationContent({ ...content(), [field]: '  ' })).toThrow(
      /Publication field/,
    );
  });

  it.each(['December DAY, 2026', '26-DRAFT', 'About [TOTAL UNITS]', 'TBD'])(
    'rejects draft copy: %s',
    (title) => {
      expect(() => validatePublicationContent({ ...content(), title })).toThrow(
        /draft placeholders/,
      );
    },
  );

  it.each(['1-800-555-SAFE', '800-555-0123', '(555) 010-2042', '123'])(
    'rejects placeholder phone %s',
    (supportPhone) => {
      expect(() => validatePublicationContent({ ...content(), supportPhone })).toThrow(
        /support phone/,
      );
    },
  );

  it.each(['not-an-email', 'recall@example.com', 'recall@test.com', 'demo-support@example.invalid'])(
    'rejects example/invalid email %s',
    (supportEmail) => {
      expect(() => validatePublicationContent({ ...content(), supportEmail })).toThrow(
        /support email/,
      );
    },
  );

  it('does not reject a real number merely because its digits include 555', () => {
    expect(() =>
      validatePublicationContent({ ...content(), supportPhone: '800-234-5556' }),
    ).not.toThrow();
  });
});
