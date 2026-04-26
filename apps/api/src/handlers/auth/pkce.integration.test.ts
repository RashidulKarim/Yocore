/**
 * Flow U — PKCE issue + exchange (integration).
 *
 * The /authorize HTTP endpoint is intentionally NOT exposed by the API
 * (that lives in `apps/auth-web`); we drive `pkce.issueCode()` directly to
 * mint the code, then exercise the public `/v1/auth/pkce/exchange` route.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';
import { Product } from '../../db/models/Product.js';
import { ProductUser } from '../../db/models/ProductUser.js';
import { EmailQueue } from '../../db/models/EmailQueue.js';
import { hash as hashPassword } from '../../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const EMAIL = 'pkce@example.com';
const SLUG = 'yopm';
const REDIRECT = 'https://app.example.com/callback';

async function product(): Promise<{ id: string }> {
  const apiSecretHash = await hashPassword('dummy');
  const doc = await Product.create({
    name: 'P',
    slug: SLUG,
    status: 'ACTIVE',
    apiKey: `pk_test_${Math.random().toString(36).slice(2)}`,
    apiSecretHash,
    allowedRedirectUris: [REDIRECT],
  });
  return { id: doc._id };
}

async function setupVerifiedUser(): Promise<{ userId: string; productId: string }> {
  const { app } = await getTestContext();
  const { id: productId } = await product();
  await request(app)
    .post('/v1/auth/signup')
    .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
  const queued = await EmailQueue.findOne({
    toAddress: EMAIL,
    templateId: 'auth.email_verify',
  }).lean();
  const token = (queued!.templateData as { verifyToken: string }).verifyToken;
  await request(app).get('/v1/auth/verify-email').query({ token });
  const pu = await ProductUser.findOne({ productId }).lean();
  return { userId: pu!.userId, productId };
}

function challengeFor(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

describe('Flow U — PKCE exchange', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('exchanges a valid code+verifier for a session', async () => {
    const { app, ctx } = await getTestContext();
    const { userId, productId } = await setupVerifiedUser();

    const verifier = crypto.randomBytes(48).toString('base64url');
    const { code } = await ctx.pkce.issueCode({
      userId,
      productId,
      redirectUri: REDIRECT,
      codeChallenge: challengeFor(verifier),
      codeChallengeMethod: 'S256',
    });

    const r = await request(app)
      .post('/v1/auth/pkce/exchange')
      .send({ code, codeVerifier: verifier, redirectUri: REDIRECT });
    expect(r.status).toBe(200);
    expect(r.body.tokens.accessToken).toBeTruthy();
    expect(r.body.userId).toBe(userId);
    expect(r.body.productId).toBe(productId);
  });

  it('rejects mismatched verifier', async () => {
    const { app, ctx } = await getTestContext();
    const { userId, productId } = await setupVerifiedUser();
    const verifier = crypto.randomBytes(48).toString('base64url');
    const { code } = await ctx.pkce.issueCode({
      userId,
      productId,
      redirectUri: REDIRECT,
      codeChallenge: challengeFor(verifier),
      codeChallengeMethod: 'S256',
    });
    const wrong = crypto.randomBytes(48).toString('base64url');
    const r = await request(app)
      .post('/v1/auth/pkce/exchange')
      .send({ code, codeVerifier: wrong, redirectUri: REDIRECT });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('AUTH_PKCE_VERIFIER_MISMATCH');
  });

  it('rejects redirectUri mismatch', async () => {
    const { app, ctx } = await getTestContext();
    const { userId, productId } = await setupVerifiedUser();
    const verifier = crypto.randomBytes(48).toString('base64url');
    const { code } = await ctx.pkce.issueCode({
      userId,
      productId,
      redirectUri: REDIRECT,
      codeChallenge: challengeFor(verifier),
      codeChallengeMethod: 'S256',
    });
    const r = await request(app)
      .post('/v1/auth/pkce/exchange')
      .send({ code, codeVerifier: verifier, redirectUri: 'https://attacker.example/' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('AUTH_HOSTED_REDIRECT_NOT_ALLOWED');
  });

  it('rejects issueCode with a redirectUri not in the product allowlist', async () => {
    const { ctx } = await getTestContext();
    const { userId, productId } = await setupVerifiedUser();
    const verifier = crypto.randomBytes(48).toString('base64url');
    await expect(
      ctx.pkce.issueCode({
        userId,
        productId,
        redirectUri: 'https://attacker.example/',
        codeChallenge: challengeFor(verifier),
        codeChallengeMethod: 'S256',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_HOSTED_REDIRECT_NOT_ALLOWED' });
  });

  it('rejects code reuse (one-shot)', async () => {
    const { app, ctx } = await getTestContext();
    const { userId, productId } = await setupVerifiedUser();
    const verifier = crypto.randomBytes(48).toString('base64url');
    const { code } = await ctx.pkce.issueCode({
      userId,
      productId,
      redirectUri: REDIRECT,
      codeChallenge: challengeFor(verifier),
      codeChallengeMethod: 'S256',
    });

    const first = await request(app)
      .post('/v1/auth/pkce/exchange')
      .send({ code, codeVerifier: verifier, redirectUri: REDIRECT });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/v1/auth/pkce/exchange')
      .send({ code, codeVerifier: verifier, redirectUri: REDIRECT });
    expect(second.status).toBe(401);
  });
});
