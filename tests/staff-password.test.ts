import { describe, expect, it } from 'vitest';

import { hashPassword, needsRehash, verifyPassword } from '../src/modules/staff/password.js';

describe('staff password (node:crypto.scrypt)', () => {
  it('round-trips a valid password', async () => {
    const envelope = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', envelope)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const envelope = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', envelope)).resolves.toBe(false);
  });

  it('produces a fresh envelope each call (random salt)', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it('encodes the envelope with the scrypt.<N>.<r>.<p>.<salt>.<digest> shape', async () => {
    const envelope = await hashPassword('a-strong-password');
    expect(envelope.startsWith('scrypt.')).toBe(true);
    const parts = envelope.split('.');
    expect(parts).toHaveLength(6);
    expect(Number(parts[1])).toBeGreaterThan(0);
    expect(Number(parts[2])).toBeGreaterThan(0);
    expect(Number(parts[3])).toBeGreaterThan(0);
  });

  it('handles unicode passwords', async () => {
    const envelope = await hashPassword('пароль-🔑-安全');
    await expect(verifyPassword('пароль-🔑-安全', envelope)).resolves.toBe(true);
    await expect(verifyPassword('пароль-🔑-不安全', envelope)).resolves.toBe(false);
  });

  it('is constant-time-ish: wrong-password failure does not throw', async () => {
    const envelope = await hashPassword('something-secure');
    // Just ensure it resolves to false rather than rejecting — timing is
    // delegated to timingSafeEqual on the derived digest.
    await expect(verifyPassword('nope', envelope)).resolves.toBe(false);
  });

  it('rejects empty password at hash time', async () => {
    await expect(hashPassword('')).rejects.toThrow(/empty/i);
  });

  it('rejects passwords shorter than twelve characters at hash time', async () => {
    await expect(hashPassword('too-short')).rejects.toThrow(/12/i);
  });

  it('rejects implausibly long password at hash time', async () => {
    await expect(hashPassword('x'.repeat(1025))).rejects.toThrow(/1024/i);
  });

  it('throws on a malformed envelope at verify time', async () => {
    await expect(verifyPassword('x', 'not-an-envelope')).rejects.toThrow(/malformed/i);
    await expect(verifyPassword('x', 'bcrypt.16.8.1.aa.bb')).rejects.toThrow(/malformed/i);
  });

  it('reports needsRehash true for malformed envelopes', () => {
    expect(needsRehash('garbage')).toBe(true);
  });

  it('reports needsRehash false for a freshly hashed envelope', async () => {
    const envelope = await hashPassword('a-strong-password');
    expect(needsRehash(envelope)).toBe(false);
  });

  it('reports needsRehash true when params drift from defaults', () => {
    // Craft an envelope with non-default N to simulate a legacy hash.
    const envelope = 'scrypt.1024.8.1.AAAA.BBBB';
    expect(needsRehash(envelope)).toBe(true);
  });
});
