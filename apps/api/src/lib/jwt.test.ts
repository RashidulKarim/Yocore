import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, type JWK } from 'jose';
import { JwtKeyring, type JwtKeyRecord } from './jwt-keyring.js';
import { signJwt, verifyJwt } from './jwt.js';
import { AppError, ErrorCode } from './errors.js';

async function eddsaKey(kid: string): Promise<{ publicJwk: JWK; privateJwk: JWK }> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  return {
    publicJwk: { ...(await exportJWK(publicKey)), kid },
    privateJwk: { ...(await exportJWK(privateKey)), kid },
  };
}

let ring: JwtKeyring;

beforeAll(async () => {
  const k = await eddsaKey('active-1');
  const records: JwtKeyRecord[] = [
    { kid: 'active-1', status: 'active', alg: 'EdDSA', publicJwk: k.publicJwk, privateJwk: k.privateJwk },
  ];
  ring = new JwtKeyring(async () => records);
  await ring.reload();
});

describe('lib/jwt', () => {
  it('signs and verifies an access token', async () => {
    const token = await signJwt(ring, {
      subject: 'user_1',
      ttlSeconds: 60,
      purpose: 'access',
      claims: { productId: 'prod_1' },
    });
    const v = await verifyJwt(ring, token, { purpose: 'access' });
    expect(v.payload.sub).toBe('user_1');
    expect(v.payload['productId']).toBe('prod_1');
    expect(v.payload['typ']).toBe('access');
    expect(v.kid).toBe('active-1');
  });

  it('rejects token with wrong purpose', async () => {
    const token = await signJwt(ring, { subject: 's', ttlSeconds: 60, purpose: 'access' });
    await expect(verifyJwt(ring, token, { purpose: 'refresh' })).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_TOKEN,
    });
  });

  it('rejects empty / non-string token', async () => {
    await expect(verifyJwt(ring, '', { purpose: 'access' })).rejects.toBeInstanceOf(AppError);
    // @ts-expect-error testing runtime guard
    await expect(verifyJwt(ring, undefined, { purpose: 'access' })).rejects.toBeInstanceOf(AppError);
  });

  it('rejects malformed token', async () => {
    await expect(verifyJwt(ring, 'not.a.jwt', { purpose: 'access' })).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_TOKEN,
    });
  });

  it('rejects unknown kid', async () => {
    // Construct a header with a kid not in the ring.
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'ghost', typ: 'JWT' })).toString(
      'base64url',
    );
    const body = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    const sig = 'AAAA';
    await expect(verifyJwt(ring, `${header}.${body}.${sig}`, { purpose: 'access' })).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_TOKEN,
    });
  });

  it('rejects header missing kid', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
    await expect(verifyJwt(ring, `${header}.${body}.AAAA`, { purpose: 'access' })).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_TOKEN,
    });
  });

  it('rejects expired token', async () => {
    const token = await signJwt(ring, { subject: 's', ttlSeconds: -1, purpose: 'access' });
    await expect(verifyJwt(ring, token, { purpose: 'access' })).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_TOKEN,
    });
  });

  it('signs with audience and verifies it', async () => {
    const token = await signJwt(ring, {
      subject: 's',
      ttlSeconds: 60,
      purpose: 'access',
      audience: 'product:prod_1',
    });
    await expect(verifyJwt(ring, token, { purpose: 'access', audience: 'product:prod_1' })).resolves.toBeDefined();
    await expect(verifyJwt(ring, token, { purpose: 'access', audience: 'product:other' })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('throws INTERNAL_ERROR if no active key', async () => {
    const empty = new JwtKeyring(async () => []);
    await empty.reload();
    await expect(
      signJwt(empty, { subject: 's', ttlSeconds: 60, purpose: 'access' }),
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });
});
