/**
 * Flow H1 — per-product end-user signin (integration).
 *
 * Builds a real product + verified end-user via the public signup +
 * verify-email pipeline, then drives `POST /v1/auth/signin` with a
 * `productSlug`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';
import { Product } from '../../db/models/Product.js';
import { EmailQueue } from '../../db/models/EmailQueue.js';
import { ProductUser } from '../../db/models/ProductUser.js';
import { hash as hashPassword } from '../../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const EMAIL = 'h1@example.com';
const SLUG = 'yopm';

async function createActiveProduct(slug = SLUG): Promise<string> {
  const apiSecretHash = await hashPassword('dummy-secret-not-used-in-this-test');
  const doc = await Product.create({
    name: 'YoPM',
    slug,
    status: 'ACTIVE',
    apiKey: `pk_test_${Math.random().toString(36).slice(2)}`,
    apiSecretHash,
  });
  return doc._id;
}

async function signupAndVerify(): Promise<void> {
  const { app } = await getTestContext();
  await createActiveProduct();
  await request(app)
    .post('/v1/auth/signup')
    .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
  const queued = await EmailQueue.findOne({ toAddress: EMAIL, templateId: 'auth.email_verify' }).lean();
  const token = (queued!.templateData as { verifyToken: string }).verifyToken;
  await request(app).get('/v1/auth/verify-email').query({ token });
}

describe('Flow H1 — per-product end-user signin', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('signs in a verified end user with productSlug and issues tokens', async () => {
    const { app } = await getTestContext();
    await signupAndVerify();

    const res = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('signed_in');
    expect(res.body.role).toBe('END_USER');
    expect(res.body.productId).toBeTruthy();
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toBeTruthy();
  });

  it('rejects signin with the wrong password and locks after 5 failed attempts', async () => {
    const { app } = await getTestContext();
    await signupAndVerify();

    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/v1/auth/signin')
        .send({ email: EMAIL, password: 'WrongPass1!', productSlug: SLUG });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('AUTH_INVALID_CREDENTIALS');
    }

    // Sixth attempt — even with correct password — should be locked.
    const locked = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
    expect(locked.status).toBe(423);
    expect(locked.body.error).toBe('AUTH_ACCOUNT_LOCKED');
  });

  it('rejects unverified end users with AUTH_EMAIL_NOT_VERIFIED', async () => {
    const { app } = await getTestContext();
    await createActiveProduct();
    await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
    // Skip verification.

    const res = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AUTH_EMAIL_NOT_VERIFIED');
  });

  it('returns AUTH_INVALID_CREDENTIALS for an unknown product slug (constant-time)', async () => {
    const { app } = await getTestContext();
    await signupAndVerify();
    const res = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD, productSlug: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('returns AUTH_ACCOUNT_BANNED when productUser status is BANNED', async () => {
    const { app } = await getTestContext();
    await signupAndVerify();
    await ProductUser.updateOne({}, { $set: { status: 'BANNED' } });
    const res = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('AUTH_ACCOUNT_BANNED');
  });
});
