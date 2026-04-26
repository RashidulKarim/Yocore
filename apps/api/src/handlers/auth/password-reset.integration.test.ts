/**
 * Flow O — forgot password + reset (integration).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';
import { Product } from '../../db/models/Product.js';
import { EmailQueue } from '../../db/models/EmailQueue.js';
import { Session } from '../../db/models/Session.js';
import { hash as hashPassword } from '../../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const NEW_PASSWORD = 'EvenStr0ngerP@ss!';
const EMAIL = 'reset@example.com';
const SLUG = 'yopm';

async function product(): Promise<string> {
  const apiSecretHash = await hashPassword('dummy');
  const doc = await Product.create({
    name: 'P',
    slug: SLUG,
    status: 'ACTIVE',
    apiKey: `pk_test_${Math.random().toString(36).slice(2)}`,
    apiSecretHash,
  });
  return doc._id;
}

async function signupAndVerify(): Promise<void> {
  const { app } = await getTestContext();
  await product();
  await request(app)
    .post('/v1/auth/signup')
    .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
  const queued = await EmailQueue.findOne({
    toAddress: EMAIL,
    templateId: 'auth.email_verify',
  }).lean();
  const token = (queued!.templateData as { verifyToken: string }).verifyToken;
  await request(app).get('/v1/auth/verify-email').query({ token });
}

describe('Flow O — forgot + reset password', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('queues a reset email for an existing product user (constant-time response)', async () => {
    const { app } = await getTestContext();
    await signupAndVerify();

    const r = await request(app)
      .post('/v1/auth/forgot-password')
      .send({ email: EMAIL, productSlug: SLUG });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('reset_email_sent');

    const queued = await EmailQueue.findOne({
      toAddress: EMAIL,
      templateId: 'auth.password_reset',
    }).lean();
    expect(queued).not.toBeNull();
    expect((queued!.templateData as { resetToken: string }).resetToken).toBeTruthy();
  });

  it('returns the same shape for an unknown email (no enumeration)', async () => {
    const { app } = await getTestContext();
    await product();
    const r = await request(app)
      .post('/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com', productSlug: SLUG });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('reset_email_sent');
    expect(
      await EmailQueue.countDocuments({ templateId: 'auth.password_reset' }),
    ).toBe(0);
  });

  it('reset-password sets a new password, revokes sessions, and the new password works', async () => {
    const { app } = await getTestContext();
    await signupAndVerify();

    // Sign in to create a session that should later be revoked.
    const sessionRes = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
    expect(sessionRes.status).toBe(200);
    expect(await Session.countDocuments({ revokedAt: null })).toBeGreaterThanOrEqual(1);

    // Request reset and grab token.
    await request(app)
      .post('/v1/auth/forgot-password')
      .send({ email: EMAIL, productSlug: SLUG });
    const queued = await EmailQueue.findOne({
      toAddress: EMAIL,
      templateId: 'auth.password_reset',
    }).lean();
    const token = (queued!.templateData as { resetToken: string }).resetToken;

    const reset = await request(app)
      .post('/v1/auth/reset-password')
      .send({ token, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    expect(reset.body.status).toBe('password_reset');

    // All sessions revoked.
    expect(await Session.countDocuments({ revokedAt: null })).toBe(0);

    // Old password no longer works.
    const old = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
    expect(old.status).toBe(401);

    // New password works.
    const fresh = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: NEW_PASSWORD, productSlug: SLUG });
    expect(fresh.status).toBe(200);
  });

  it('rejects an invalid or expired reset token', async () => {
    const { app } = await getTestContext();
    await product();
    const r = await request(app)
      .post('/v1/auth/reset-password')
      .send({ token: 'this-token-does-not-exist-but-is-long-enough', password: NEW_PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('AUTH_INVALID_TOKEN');
  });
});
