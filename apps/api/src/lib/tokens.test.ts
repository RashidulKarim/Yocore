import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateToken,
  hashToken,
  safeEqual,
  generateTokenWithHash,
} from './tokens.js';

describe('lib/tokens', () => {
  it('generateToken() returns base64url string of expected entropy', () => {
    const t = generateToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes -> 43 base64url chars (no padding).
    expect(t.length).toBe(43);
  });

  it('generateToken() respects byteLength', () => {
    const t = generateToken(16);
    // 16 bytes -> 22 chars.
    expect(t.length).toBe(22);
  });

  it('generateToken() rejects out-of-range byteLength', () => {
    expect(() => generateToken(8)).toThrow(RangeError);
    expect(() => generateToken(257)).toThrow(RangeError);
    // @ts-expect-error testing runtime guard
    expect(() => generateToken(1.5)).toThrow(RangeError);
  });

  it('generateToken() returns unique values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateToken());
    expect(seen.size).toBe(100);
  });

  it('hashToken() matches sha256 hex of the input', () => {
    const expected = createHash('sha256').update('abc', 'utf8').digest('hex');
    expect(hashToken('abc')).toBe(expected);
  });

  it('safeEqual() is true for equal strings, false otherwise', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    // Different lengths must be false (and not throw).
    expect(safeEqual('abc', 'abcd')).toBe(false);
    // Non-strings → false.
    // @ts-expect-error testing runtime guard
    expect(safeEqual(1, 'x')).toBe(false);
  });

  it('generateTokenWithHash() pairs match', () => {
    const { token, tokenHash } = generateTokenWithHash();
    expect(tokenHash).toBe(hashToken(token));
  });
});
