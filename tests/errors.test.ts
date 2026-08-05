import { describe, expect, it } from 'vitest';

import { isConnectionError } from '../src/shared/errors.js';

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
