import { describe, expect, it } from 'vitest';

import { createPlaceholderRegistry } from '../src/composition.js';
import { NotImplementedServiceError } from '../src/shared/errors.js';

describe('application composition', () => {
  it('registers all Phase 1 domain services and provider adapters', () => {
    const registry = createPlaceholderRegistry();

    expect(Object.keys(registry.services).sort()).toEqual([
      'campaigns',
      'cases',
      'claimDrafts',
      'communications',
      'documents',
      'incidents',
      'productChecks',
    ]);
    expect(Object.keys(registry.platform).sort()).toEqual(['blob', 'crypto', 'email']);
  });

  it('uses explicit not-implemented adapters without external I/O', async () => {
    const registry = createPlaceholderRegistry();

    await expect(registry.platform.blob.delete('private/test/path')).rejects.toBeInstanceOf(
      NotImplementedServiceError,
    );
    await expect(
      registry.platform.email.send({
        messageKey: 'test',
        to: 'nobody@example.invalid',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      }),
    ).rejects.toBeInstanceOf(NotImplementedServiceError);
  });
});
