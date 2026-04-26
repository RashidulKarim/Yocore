import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, decryptToString } from './encryption.js';

describe('lib/encryption', () => {
  it('round-trips a string through envelope encryption', () => {
    const env = encrypt('hello yocore');
    expect(env.token.startsWith('v1.')).toBe(true);
    expect(decryptToString(env.token)).toBe('hello yocore');
  });

  it('round-trips a Buffer', () => {
    const buf = Buffer.from([1, 2, 3, 4, 5, 6]);
    const env = encrypt(buf);
    expect(decrypt(env.token).equals(buf)).toBe(true);
  });

  it('produces a different token for the same plaintext (random DEK + IVs)', () => {
    const a = encrypt('same').token;
    const b = encrypt('same').token;
    expect(a).not.toEqual(b);
    expect(decryptToString(a)).toBe('same');
    expect(decryptToString(b)).toBe('same');
  });

  it('throws on malformed token', () => {
    expect(() => decrypt('not.a.token')).toThrow(/malformed/);
    // @ts-expect-error testing runtime guard
    expect(() => decrypt(123)).toThrow(/string/);
  });

  it('throws on unsupported version', () => {
    const env = encrypt('x');
    const broken = env.token.replace(/^v1/, 'v9');
    expect(() => decrypt(broken)).toThrow(/version/);
  });

  it('throws on tampered ciphertext (auth tag fails)', () => {
    const env = encrypt('payload');
    // Flip a char in the ciphertext segment (index 5).
    const parts = env.token.split('.');
    const ct = parts[5]!;
    const tampered = ct[0] === 'A' ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    parts[5] = tampered;
    expect(() => decrypt(parts.join('.'))).toThrow();
  });

  it('throws on empty segment', () => {
    const env = encrypt('payload');
    const parts = env.token.split('.');
    parts[1] = '';
    expect(() => decrypt(parts.join('.'))).toThrow(/empty segment/);
  });
});
