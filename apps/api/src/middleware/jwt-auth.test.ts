import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateKeyPair, exportJWK, type JWK } from 'jose';
import { JwtKeyring, type JwtKeyRecord } from '../lib/jwt-keyring.js';
import { signJwt } from '../lib/jwt.js';
import { jwtAuthMiddleware } from './jwt-auth.js';
import { errorHandler } from './error-handler.js';

let ring: JwtKeyring;

async function eddsaKey(kid: string): Promise<{ publicJwk: JWK; privateJwk: JWK }> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  return {
    publicJwk: { ...(await exportJWK(publicKey)), kid },
    privateJwk: { ...(await exportJWK(privateKey)), kid },
  };
}

beforeAll(async () => {
  const k = await eddsaKey('k1');
  const records: JwtKeyRecord[] = [
    { kid: 'k1', status: 'active', alg: 'EdDSA', publicJwk: k.publicJwk, privateJwk: k.privateJwk },
  ];
  ring = new JwtKeyring(async () => records);
  await ring.reload();
});

function build(opts: Parameters<typeof jwtAuthMiddleware>[0]) {
  const app = express();
  app.use(jwtAuthMiddleware(opts));
  app.get('/x', (req, res) => res.json({ auth: req.auth ?? null }));
  app.use(errorHandler);
  return app;
}

describe('middleware/jwt-auth', () => {
  it('rejects missing bearer with AUTH_INVALID_TOKEN', async () => {
    const app = build({ keyring: ring });
    const res = await request(app).get('/x');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects malformed bearer', async () => {
    const app = build({ keyring: ring });
    const res = await request(app).get('/x').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AUTH_INVALID_TOKEN');
  });

  it('passes through with optional + missing token', async () => {
    const app = build({ keyring: ring, optional: true });
    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
    expect(res.body.auth).toBeNull();
  });

  it('attaches req.auth on valid token', async () => {
    const token = await signJwt(ring, {
      subject: 'usr_1',
      ttlSeconds: 60,
      purpose: 'access',
      claims: { pid: 'prod_1', role: 'END_USER', scopes: ['read'] },
    });
    const app = build({ keyring: ring });
    const res = await request(app).get('/x').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.auth.userId).toBe('usr_1');
    expect(res.body.auth.productId).toBe('prod_1');
    expect(res.body.auth.role).toBe('END_USER');
    expect(res.body.auth.scopes).toEqual(['read']);
  });

  it('returns AUTH_TOKEN_REVOKED when sessionStore reports inactive', async () => {
    const token = await signJwt(ring, { subject: 'u', ttlSeconds: 60, purpose: 'access' });
    const app = build({ keyring: ring, sessionStore: { isActive: async () => false } });
    const res = await request(app).get('/x').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AUTH_TOKEN_REVOKED');
  });
});
