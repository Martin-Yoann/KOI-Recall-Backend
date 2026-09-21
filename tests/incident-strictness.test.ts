import { describe, expect, it } from 'vitest';

import type { ClaimSubmissionRequest } from '../src/contracts/claims.js';
import { assertIncidentDetailsCompleteness } from '../src/modules/cases/incident-strictness.js';
import { ClaimValidationError } from '../src/shared/errors.js';

type IncidentDetails = NonNullable<ClaimSubmissionRequest['incidentDetails']>;

function bodyWith(
  incidentAnswer: ClaimSubmissionRequest['incidentAnswer'],
  incidentDetails?: IncidentDetails,
): ClaimSubmissionRequest {
  return {
    incidentAnswer,
    ...(incidentDetails ? { incidentDetails } : {}),
  } as ClaimSubmissionRequest;
}

const completeDetails: IncidentDetails = {
  eventTypes: ['injury'],
  narrative: 'A fictional minor injury occurred during use.',
  occurredDateUnknown: true,
  injurySeverity: 'minor',
  medicalTreatment: 'first_aid',
  usedAsIntended: 'yes',
  failureMode: 'body_rupture',
  injuryDescription: 'A fictional description of the reported injury.',
  medicalTreatmentReceived: 'yes',
  unitType: 'original',
};

describe('incident strict validation switch', () => {
  // Stage 1/2 behaviour. Nothing about the new fields is required yet.
  it('does not enforce anything while the switch is off', () => {
    expect(() =>
      assertIncidentDetailsCompleteness(
        bodyWith('yes', {
          eventTypes: ['injury'],
          narrative: 'A fictional minor injury occurred during use.',
          occurredDateUnknown: true,
        }),
        false,
      ),
    ).not.toThrow();
  });

  it('accepts a fully populated confirmed incident when the switch is on', () => {
    expect(() =>
      assertIncidentDetailsCompleteness(bodyWith('yes', completeDetails), true),
    ).not.toThrow();
  });

  it('lists every missing field in one message when the switch is on', () => {
    try {
      assertIncidentDetailsCompleteness(
        bodyWith('yes', {
          eventTypes: ['other'],
          narrative: 'A fictional hazard was observed but no injury occurred.',
          occurredDateUnknown: true,
        }),
        true,
      );
      throw new Error('expected the strict check to reject this payload');
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimValidationError);
      const message = (error as Error).message;
      // One message, not whack-a-mole: the client can fix all of them at once.
      expect(message).toContain('usedAsIntended');
      expect(message).toContain('unitType');
      expect(message).toContain('failureMode');
      expect(message).toContain('medicalTreatmentReceived');
      // injuryDescription is only required for injury/illness events.
      expect(message).not.toContain('injuryDescription');
    }
  });

  it('requires an injury description only for injury or illness events', () => {
    const details = { ...completeDetails, injuryDescription: undefined };
    expect(() => assertIncidentDetailsCompleteness(bodyWith('yes', details), true)).toThrow(
      ClaimValidationError,
    );

    const noInjury = {
      ...completeDetails,
      eventTypes: ['fire'] satisfies IncidentDetails['eventTypes'],
      injuryDescription: undefined,
    };
    expect(() => assertIncidentDetailsCompleteness(bodyWith('yes', noInjury), true)).not.toThrow();
  });

  // An `unsure` answer is the consumer saying they cannot confirm the details.
  // Enforcing here would suppress exactly the reports compliance needs to see,
  // which is the opposite of what P0 is for.
  it.each(['no', 'unsure'] as const)(
    'never enforces structured fields for a %s answer',
    (incidentAnswer) => {
      expect(() =>
        assertIncidentDetailsCompleteness(
          bodyWith(
            incidentAnswer,
            incidentAnswer === 'unsure'
              ? {
                  narrative: 'The consumer is unsure whether a safety incident occurred.',
                  occurredDateUnknown: true,
                }
              : undefined,
          ),
          true,
        ),
      ).not.toThrow();
    },
  );
});
