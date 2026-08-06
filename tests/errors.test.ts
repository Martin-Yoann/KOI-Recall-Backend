import { describe, expect, it } from 'vitest';

import {
  DraftExpiredOrInvalidError,
  EvidenceRulesViolationError,
  HttpProblemError,
  isConnectionError,
  isUniqueViolation,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from '../src/shared/errors.js';

function codedError(code: string, cause?: unknown): Error & { code: string } {
  const error = cause === undefined ? new Error(code) : new Error(code, { cause });
  return Object.assign(error, { code });
}

describe('database connection error classification', () => {
  it.each(['08000', '08003', '08006', '57P01', '57P02', '57P03', '53300'])(
    'recognizes PostgreSQL availability code %s',
    (code) => expect(isConnectionError(codedError(code))).toBe(true),
  );

  it('recognizes a network error nested through multiple causes', () => {
    const error = new Error('outer', {
      cause: new Error('middle', { cause: codedError('ECONNRESET') }),
    });
    expect(isConnectionError(error)).toBe(true);
  });

  it('recognizes connection errors inside AggregateError', () => {
    expect(isConnectionError(new AggregateError([codedError('ETIMEDOUT')], 'pool failed'))).toBe(
      true,
    );
  });

  it.each(['28P01', '42501', '23503', '42P01'])(
    'does not treat non-availability SQLSTATE %s as retryable',
    (code) => expect(isConnectionError(codedError(code))).toBe(false),
  );

  it('handles cyclic causes without looping', () => {
    const error = new Error('cycle');
    Object.assign(error, { cause: error });
    expect(isConnectionError(error)).toBe(false);
  });
});

describe('unique-violation classification', () => {
  it('recognizes a direct SQLSTATE 23505 unique violation', () => {
    expect(isUniqueViolation(codedError('23505'))).toBe(true);
  });

  it('recognizes a unique violation nested through a cause', () => {
    const error = new Error('insert failed', { cause: codedError('23505') });
    expect(isUniqueViolation(error)).toBe(true);
  });

  it.each(['23503', '23502', '42P01', 'ECONNREFUSED'])(
    'does not treat non-unique SQLSTATE %s as a unique violation',
    (code) => expect(isUniqueViolation(codedError(code))).toBe(false),
  );
});

describe('typed business errors', () => {
  it.each([
    [DraftExpiredOrInvalidError, 410, 'Gone'],
    [PayloadTooLargeError, 413, 'Payload Too Large'],
    [UnsupportedMediaTypeError, 415, 'Unsupported Media Type'],
    [EvidenceRulesViolationError, 422, 'Unprocessable Entity'],
  ])('%s maps to the expected status and title', (ErrorClass, status, title) => {
    const error = new ErrorClass('detail');
    expect(error).toBeInstanceOf(HttpProblemError);
    expect(error.status).toBe(status);
    expect(error.title).toBe(title);
    expect(error.message).toBe('detail');
    expect(error.type).toMatch(/^https:\/\/api\.example\.invalid\/problems\/.+$/);
  });
});
