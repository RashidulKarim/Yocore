/**
 * Flow F — End-user signup integration tests.
 *
 * Exercises FIX-AUTH-TIMING (constant-time response across branches):
 *   1. Successful signup creates users + productUsers + authToken + emailQueue.
 *   2. Repeating the signup with the same email returns the SAME response shape
 *      and does NOT mutate state beyond the original creation.
 *   3. Wrong product slug → 404 NOT_FOUND.
 *   4. Inactive product → 404 NOT_FOUND.
 *   5. Invalid payload → 400 VALIDATION_FAILED.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';
import { Product } from '../../db/models/Product.js';
import { User } from '../../db/models/User.js';
import { ProductUser } from '../../db/models/ProductUser.js';
import { AuthToken } from '../../db/models/AuthToken.js';
import { EmailQueue } from '../../db/models/EmailQueue.js';
import { hash as hashPassword } from '../../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const EMAIL = 'signup@example.com';
const SLUG = 'yopm';

async function createActiveProduct(opts: {
  slug?: string;
  status?: 'INACTIVE' | 'ACTIVE' | 'MAINTENANCE' | 'ABANDONED';
} = {}): Promise<string> {
  const apiSecretHash = await hashPassword('dummy-secret-not-used-in-this-test');
  const doc = await Product.create({
    name: 'YoPM',
    slug: opts.slug ?? SLUG,
    status: opts.status ?? 'ACTIVE',
    apiKey: `pk_test_${Math.random().toString(36).slice(2)}`,
    apiSecretHash,
  });
  return doc._id;
}

describe('Flow F — end-user signup', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates user + productUser + verify token + queued email on first signup', async () => {
    const { app } = await getTestContext();
    const productId = await createActiveProduct();

    const res = await request(app)
      .post('/v1/auth/signup')
      .send({
        email: EMAIL,
        password: PASSWORD,
        productSlug: SLUG,
        name: { first: 'Ada', last: 'Lovelace' },
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'verification_sent' });

    const user = await User.findOne({ email: EMAIL }).lean();
    expect(user).not.toBeNull();
    expect(user!.role).toBe('END_USER');
    expect(user!.emailVerified).toBe(false);
    expect(user!.passwordHash).toBeNull(); // END_USER: creds live in productUsers

    const pu = await ProductUser.findOne({ productId, userId: user!._id }).lean();
    expect(pu).not.toBeNull();
    expect(pu!.status).toBe('UNVERIFIED');
    expect(pu!.passwordHash).toBeTruthy();
    expect(pu!.passwordHash).not.toBe(PASSWORD); // must be hashed

    const tokens = await AuthToken.find({ userId: user!._id, type: 'email_verify' }).lean();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.usedAt).toBeNull();

    const emails = await EmailQueue.find({ toAddress: EMAIL }).lean();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.templateId).toBe('auth.email_verify');
    expect(emails[0]!.status).toBe('PENDING');
    expect((emails[0]!.templateData as { verifyToken?: string }).verifyToken).toBeTruthy();
  });

  it('FIX-AUTH-TIMING: re-signup with same email returns same shape and does NOT duplicate state', async () => {
    const { app } = await getTestContext();
    await createActiveProduct();

    const r1 = await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
    expect(r1.status).toBe(202);
    expect(r1.body).toEqual({ status: 'verification_sent' });

    const r2 = await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG });
    expect(r2.status).toBe(202);
    expect(r2.body).toEqual({ status: 'verification_sent' });

    // Single user row, single productUser row, single token, single email.
    expect(await User.countDocuments({ email: EMAIL })).toBe(1);
    expect(await ProductUser.countDocuments({})).toBe(1);
    expect(await AuthToken.countDocuments({ type: 'email_verify' })).toBe(1);
    expect(await EmailQueue.countDocuments({ toAddress: EMAIL })).toBe(1);
  });

  it('returns 404 for an unknown product slug', async () => {
    const { app } = await getTestContext();
    const res = await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: PASSWORD, productSlug: 'does-not-exist' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(await User.countDocuments({})).toBe(0);
  });

  it('returns 404 when the product is not ACTIVE', async () => {
    const { app } = await getTestContext();
    await createActiveProduct({ slug: 'inactive-prod', status: 'INACTIVE' });
    const res = await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: PASSWORD, productSlug: 'inactive-prod' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 422 for a weak password (validation)', async () => {
    const { app } = await getTestContext();
    await createActiveProduct();
    const res = await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: 'weak', productSlug: SLUG });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});
