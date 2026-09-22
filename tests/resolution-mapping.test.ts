// The remedy vocabulary a campaign uses and the resolution vocabulary this
// ledger tracks are not the same thing, and the gap between them is where a
// disposal instruction used to become an expected shipment.
import { describe, expect, it } from 'vitest';

import { resolutionTypeForRemedyCode } from '../src/modules/resolutions/drizzle-case-resolution-service.js';
import { ClaimValidationError } from '../src/shared/errors.js';

describe('resolutionTypeForRemedyCode', () => {
  it('keeps refund a refund', () => {
    expect(resolutionTypeForRemedyCode('refund')).toBe('refund');
  });

  it.each(['replacement', 'repair', 'voucher'])(
    'fulfils %s by posting something, so it normalises to replacement',
    (code) => {
      expect(resolutionTypeForRemedyCode(code)).toBe('replacement');
    },
  );

  it('refuses a disposal instruction rather than recording it as a shipment', () => {
    // The recorded residue: this mapping used to answer `replacement` for every
    // code that was not a refund, so a campaign offering disposal instructions
    // produced a case waiting to post a product the consumer had been told to
    // dispose of. Consumer disposal belongs to the disposal task surface, which
    // gates it on eligibility, approved instructions and an issued permission.
    expect(() => resolutionTypeForRemedyCode('disposal_instruction')).toThrow(ClaimValidationError);
  });

  it('refuses an unrecognised code instead of classifying it', () => {
    expect(() => resolutionTypeForRemedyCode('something_new')).toThrow(ClaimValidationError);
  });

  it('refuses as a validation problem, so the caller sees 422 rather than 500', () => {
    try {
      resolutionTypeForRemedyCode('disposal_instruction');
      expect.unreachable('the mapping must refuse this code');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimValidationError);
      expect((error as ClaimValidationError).status).toBe(422);
    }
  });
});
