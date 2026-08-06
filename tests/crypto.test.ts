import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const pepper = Buffer.alloc(32, 9).toString('base64');

describe('NodeSensitiveDataCrypto', () => {
  it('round-trips authenticated ciphertext without deterministic encryption', async () => {
    const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);
    const first = await crypto.encrypt('Taylor 示例');
    const second = await crypto.encrypt('Taylor 示例');

    expect(first.keyVersion).toBe('v1');
    expect(first.value).not.toBe(second.value);
    await expect(crypto.decrypt(first)).resolves.toBe('Taylor 示例');
    await expect(crypto.decrypt(second)).resolves.toBe('Taylor 示例');
  });

  it('rejects tampered ciphertext', async () => {
    const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);
    const encrypted = await crypto.encrypt('secret');
    const replacement = encrypted.value.endsWith('A') ? 'Q' : 'A';
    const tampered = { ...encrypted, value: `${encrypted.value.slice(0, -1)}${replacement}` };

    await expect(crypto.decrypt(tampered)).rejects.toThrow();
  });

  it('rejects a Base64URL authentication-tag alias that decodes to the same bytes', async () => {
    const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);
    let encrypted;

    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = await crypto.encrypt('secret');
      if (candidate.value.endsWith('w')) {
        encrypted = candidate;
        break;
      }
    }

    if (encrypted === undefined) {
      throw new Error('Unable to create test ciphertext with a w tag suffix.');
    }

    const tampered = { ...encrypted, value: `${encrypted.value.slice(0, -1)}x` };
    await expect(crypto.decrypt(tampered)).rejects.toThrow();
  });

  it.each([
    { keyVersion: 'v1', value: 'not-an-envelope' },
    { keyVersion: 'v2', value: 'enc.v2.aes-256-gcm.a.b.c' },
  ])('rejects malformed or unknown-version ciphertext', async (ciphertext) => {
    const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);

    await expect(crypto.decrypt(ciphertext)).rejects.toThrow();
  });

  it('creates stable lookup hashes', async () => {
    const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);

    await expect(crypto.lookupHash('taylor@example.com')).resolves.toBe(
      await crypto.lookupHash('taylor@example.com'),
    );
    expect(await crypto.lookupHash('other@example.com')).not.toBe(
      await crypto.lookupHash('taylor@example.com'),
    );
  });

  it.each([
    ['', pepper],
    [Buffer.alloc(31).toString('base64'), pepper],
    [encryptionKey, Buffer.alloc(31).toString('base64')],
    [encryptionKey, encryptionKey],
  ])('rejects unsafe secret configuration', (key, hashPepper) => {
    expect(() => new NodeSensitiveDataCrypto(key, hashPepper)).toThrow();
  });

  it('rejects a noncanonical Base64 secret alias', () => {
    const aliasedKey = `${encryptionKey.slice(0, -2)}d=`;

    expect(Buffer.from(aliasedKey, 'base64')).toEqual(Buffer.from(encryptionKey, 'base64'));
    expect(() => new NodeSensitiveDataCrypto(aliasedKey, pepper)).toThrow();
  });
});
