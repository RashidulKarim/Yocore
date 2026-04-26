import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportJWK, type JWK } from 'jose';
import { JwtKeyring, type JwtKeyRecord } from './jwt-keyring.js';

async function makeKey(kid: string): Promise<{ publicJwk: JWK; privateJwk: JWK }> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  publicJwk.kid = kid;
  privateJwk.kid = kid;
  return { publicJwk, privateJwk };
}

describe('lib/jwt-keyring', () => {
  it('loads exactly one active key + verifying keys; skips retired and expired', async () => {
    const k1 = await makeKey('k1');
    const k2 = await makeKey('k2');
    const k3 = await makeKey('k3');
    const k4 = await makeKey('k4');

    const now = new Date('2026-01-01T00:00:00Z');
    const records: JwtKeyRecord[] = [
      { kid: 'k1', status: 'active', alg: 'EdDSA', publicJwk: k1.publicJwk, privateJwk: k1.privateJwk },
      {
        kid: 'k2',
        status: 'verifying',
        alg: 'EdDSA',
        publicJwk: k2.publicJwk,
        verifyUntil: new Date(now.getTime() + 60_000),
      },
      {
        kid: 'k3',
        status: 'verifying',
        alg: 'EdDSA',
        publicJwk: k3.publicJwk,
        verifyUntil: new Date(now.getTime() - 60_000),
      },
      { kid: 'k4', status: 'retired', alg: 'EdDSA', publicJwk: k4.publicJwk },
    ];

    const ring = new JwtKeyring(async () => records);
    const snap = await ring.reload(now);

    expect(snap.active?.kid).toBe('k1');
    expect(ring.getVerify('k1')).toBeDefined();
    expect(ring.getVerify('k2')).toBeDefined();
    expect(ring.getVerify('k3')).toBeUndefined();
    expect(ring.getVerify('k4')).toBeUndefined();
    expect(ring.loadedAt()).toEqual(now);
  });

  it('throws if more than one active key is loaded', async () => {
    const a = await makeKey('a');
    const b = await makeKey('b');
    const ring = new JwtKeyring(async () => [
      { kid: 'a', status: 'active', alg: 'EdDSA', publicJwk: a.publicJwk, privateJwk: a.privateJwk },
      { kid: 'b', status: 'active', alg: 'EdDSA', publicJwk: b.publicJwk, privateJwk: b.privateJwk },
    ]);
    await expect(ring.reload()).rejects.toThrow(/more than one active/);
  });

  it('throws if active key has no privateJwk', async () => {
    const a = await makeKey('a');
    const ring = new JwtKeyring(async () => [
      { kid: 'a', status: 'active', alg: 'EdDSA', publicJwk: a.publicJwk },
    ]);
    await expect(ring.reload()).rejects.toThrow(/missing privateJwk/);
  });

  it('__reset() clears the snapshot', async () => {
    const a = await makeKey('a');
    const ring = new JwtKeyring(async () => [
      { kid: 'a', status: 'active', alg: 'EdDSA', publicJwk: a.publicJwk, privateJwk: a.privateJwk },
    ]);
    await ring.reload();
    expect(ring.getActive()).toBeDefined();
    ring.__reset();
    expect(ring.getActive()).toBeUndefined();
  });

  it('handles empty keyring gracefully', async () => {
    const ring = new JwtKeyring(async () => []);
    const snap = await ring.reload();
    expect(snap.active).toBeUndefined();
    expect(snap.verify.size).toBe(0);
  });
});
