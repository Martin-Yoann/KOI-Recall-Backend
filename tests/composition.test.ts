import { describe, expect, it } from 'vitest';

import {
  createApplicationRegistry,
  createDefaultRegistry,
  createPlaceholderRegistry,
} from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { Database, DatabaseHandle } from '../src/db/client.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import type { ClaimSubmissionCommand } from '../src/modules/cases/service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import { NotImplementedServiceError } from '../src/shared/errors.js';

const encryptionKey = Buffer.alloc(32, 1).toString('base64');
const hashPepper = Buffer.alloc(32, 2).toString('base64');

const fakeHandle: DatabaseHandle = {
  db: {} as Database,
  driver: 'node-postgres',
  transaction: () =>
    Promise.reject(new Error('The fake database must not be used by composition tests.')),
  close: () => Promise.resolve(),
};

const validCommand: ClaimSubmissionCommand = {
  campaignSlug: 'music-lollipop-demo-2026',
  idempotencyKey: 'composition-test-key-0123456789',
  body: {
    draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
    draftToken: 'one-time-secret-with-at-least-32-characters',
    locale: 'en-US',
    consumer: {
      firstName: 'Taylor',
      lastName: 'Example',
      email: 'taylor@example.com',
      currentDeliveryAddress: {
        line1: '100 Example Street',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        countryCode: 'US',
      },
    },
    products: [
      {
        campaignProductId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
        quantity: 1,
        shape: 'Bear',
        flavor: 'Peach',
        lotCode: 'ML-2406-A',
        dateCode: '06/2024',
        identificationMode: 'product_identifiers',
        purchaseChannel: 'amazon',
      },
    ],
    remedyCode: 'replacement',
    documentIds: [],
    consents: [
      { type: 'privacy_notice', textVersion: '2026-08-04', accepted: true },
      { type: 'information_accuracy', textVersion: '2026-08-04', accepted: true },
    ],
    incidentAnswer: 'no',
  },
};

function configuredConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({
    CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
    DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/koi',
    FIELD_ENCRYPTION_KEY: encryptionKey,
    HASH_PEPPER: hashPepper,
    ...overrides,
  });
}

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

  it('keeps Claim unavailable when crypto secrets are missing', async () => {
    const registry = createApplicationRegistry(fakeHandle);

    await expect(registry.services.cases.submit(validCommand)).rejects.toBeInstanceOf(
      NotImplementedServiceError,
    );
  });

  it('registers the Drizzle Case service when crypto is configured', () => {
    const crypto = new NodeSensitiveDataCrypto(encryptionKey, hashPepper);
    const registry = createApplicationRegistry(fakeHandle, undefined, crypto);

    expect(registry.services.cases).toBeInstanceOf(DrizzleCaseService);
    expect(registry.platform.crypto).toBe(crypto);
  });

  it.each([
    ['FIELD_ENCRYPTION_KEY', { FIELD_ENCRYPTION_KEY: undefined }],
    ['HASH_PEPPER', { HASH_PEPPER: undefined }],
  ])(
    'keeps Claim unavailable when %s is absent from default configuration',
    async (_, overrides) => {
      const registry = createDefaultRegistry(configuredConfig(overrides));

      await expect(registry.services.cases.submit(validCommand)).rejects.toBeInstanceOf(
        NotImplementedServiceError,
      );
    },
  );

  it.each([
    ['postgresql', 'postgresql://user:password@127.0.0.1:5432/koi'],
    ['postgres', 'postgres://user:password@127.0.0.1:5432/koi'],
  ])('registers the Drizzle Case service for a valid %s database URL', (_, databaseUrl) => {
    const registry = createDefaultRegistry(configuredConfig({ DATABASE_URL: databaseUrl }));

    expect(registry.services.cases).toBeInstanceOf(DrizzleCaseService);
    expect(registry.platform.crypto).toBeInstanceOf(NodeSensitiveDataCrypto);
  });

  it('registers the Drizzle Case service for a pooled Neon database URL without querying it', () => {
    const registry = createDefaultRegistry(
      configuredConfig({
        DATABASE_URL:
          'postgresql://user:password@ep-koi-test-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
      }),
    );

    expect(registry.services.cases).toBeInstanceOf(DrizzleCaseService);
    expect(registry.platform.crypto).toBeInstanceOf(NodeSensitiveDataCrypto);
  });

  it('fails closed for a direct Neon database URL without exposing it', () => {
    const databaseUrl =
      'postgresql://sensitive-user:sensitive-password@ep-koi-test.us-east-2.aws.neon.tech/neondb';
    let thrown: unknown;
    try {
      createDefaultRegistry(configuredConfig({ DATABASE_URL: databaseUrl }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('pooled Neon connection string');
    expect((thrown as Error).message).not.toContain(databaseUrl);
    expect((thrown as Error).message).not.toContain('sensitive-password');
  });

  it.each([
    ['empty encryption key', { FIELD_ENCRYPTION_KEY: '' }],
    ['empty hash pepper', { HASH_PEPPER: '' }],
    ['non-Base64 encryption key', { FIELD_ENCRYPTION_KEY: 'not:a:base64:key' }],
    ['short encryption key', { FIELD_ENCRYPTION_KEY: Buffer.alloc(31, 3).toString('base64') }],
    ['short hash pepper', { HASH_PEPPER: Buffer.alloc(31, 4).toString('base64') }],
    ['identical encryption key and hash pepper', { HASH_PEPPER: encryptionKey }],
  ])('fails safely for %s', (_, overrides) => {
    const suppliedSecrets = Object.values(overrides).filter(
      (value): value is string => value !== undefined && value.length > 0,
    );

    let thrown: unknown;
    try {
      createDefaultRegistry(configuredConfig(overrides));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    for (const secret of suppliedSecrets) {
      expect((thrown as Error).message).not.toContain(secret);
    }
  });

  it.each([
    [
      'an invalid encryption key when HASH_PEPPER is absent',
      { FIELD_ENCRYPTION_KEY: 'not:a:base64:key', HASH_PEPPER: undefined },
      'not:a:base64:key',
    ],
    [
      'an invalid hash pepper when FIELD_ENCRYPTION_KEY is absent',
      { FIELD_ENCRYPTION_KEY: undefined, HASH_PEPPER: 'not:a:base64:pepper' },
      'not:a:base64:pepper',
    ],
  ])('fails safely for %s', (_, overrides, suppliedSecret) => {
    let thrown: unknown;
    try {
      createDefaultRegistry(configuredConfig(overrides));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(suppliedSecret);
  });

  it.each([
    ['a blank database URL', '   '],
    ['a malformed database URL', 'not-a-url'],
    ['a non-PostgreSQL database URL', 'mysql://user:password@127.0.0.1:3306/koi'],
  ])('fails safely for %s', (_, databaseUrl) => {
    let thrown: unknown;
    try {
      createDefaultRegistry(configuredConfig({ DATABASE_URL: databaseUrl }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(databaseUrl);
  });
});
