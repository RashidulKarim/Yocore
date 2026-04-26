import { describe, it, expect, afterEach } from 'vitest';
import {
  hash,
  verify,
  timingSafeDummyVerify,
  __resetDummyHashForTests,
} from './password.js';

describe('lib/password', () => {
  afterEach(() => __resetDummyHashForTests());

  it('hash() produces a verifiable Argon2id digest', async () => {
    const h = await hash('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verify(h, 'correct horse battery staple')).toBe(true);
  });

  it('verify() returns false on wrong password', async () => {
    const h = await hash('hunter2');
    expect(await verify(h, 'hunter3')).toBe(false);
  });

  it('verify() returns false (does not throw) on malformed hash', async () => {
    expect(await verify('not-a-real-hash', 'whatever')).toBe(false);
  });

  it('verify() returns false on empty inputs', async () => {
    expect(await verify('', 'x')).toBe(false);
    expect(await verify('x', '')).toBe(false);
  });

  it('timingSafeDummyVerify() resolves without throwing (cold + warm)', async () => {
    await expect(timingSafeDummyVerify()).resolves.toBeUndefined();
    await expect(timingSafeDummyVerify()).resolves.toBeUndefined();
  });

  it('hash() produces different digests for the same input (random salt)', async () => {
    const a = await hash('same');
    const b = await hash('same');
    expect(a).not.toEqual(b);
    expect(await verify(a, 'same')).toBe(true);
    expect(await verify(b, 'same')).toBe(true);
  });
});
