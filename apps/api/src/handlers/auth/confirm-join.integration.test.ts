/**
 * Flow I — cross-product join (integration).
 *
 * Same global email signs up for two different products. The second signup
 * detects the existing user, queues a `product_join_confirm` email, and the
 * confirm endpoint creates the new productUser + auto-logs in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';
import { Product } from '../../db/models/Product.js';
import { ProductUser } from '../../db/models/ProductUser.js';
import { EmailQueue } from '../../db/models/EmailQueue.js';
import { hash as hashPassword } from '../../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const EMAIL = 'multi@example.com';

async function product(slug: string): Promise<string> {
  const apiSecretHash = await hashPassword('dummy');
  const doc = await Product.create({
    name: `P-${slug}`,
    slug,
    status: 'ACTIVE',
    apiKey: `pk_test_${Math.random().toString(36).slice(2)}`,
    apiSecretHash,
  });
  return doc._id;
}

async function signupAndVerify(slug: string): Promise<void> {
  const { app } = await getTestContext();
  await request(app)
    .post('/v1/auth/signup')
    .send({ email: EMAIL, password: PASSWORD, productSlug: slug });
  const queued = await EmailQueue.findOne({
    toAddress: EMAIL,
    templateId: 'auth.email_verify',
  })
    .sort({ createdAt: -1 })
    .lean();
  const token = (queued!.templateData as { verifyToken: string }).verifyToken;
  await request(app).get('/v1/auth/verify-email').query({ token });
}

describe('Flow I — cross-product join', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('queues a product_join_confirm email when an existing user signs up for a 2nd product', async () => {
    const { app } = await getTestContext();
    await product('app-a');
    await product('app-b');

    await signupAndVerify('app-a');
    expect(await ProductUser.countDocuments({})).toBe(1);

    const r = await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: PASSWORD, productSlug: 'app-b' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('verification_sent');

    // Still only 1 productUser row (app-a). The new one only appears AFTER confirm.
    expect(await ProductUser.countDocuments({})).toBe(1);

    const join = await EmailQueue.findOne({
      toAddress: EMAIL,
      templateId: 'auth.product_join_confirm',
    }).lean();
    expect(join).not.toBeNull();
    expect((join!.templateData as { joinToken: string }).joinToken).toBeTruthy();
  });

  it('confirm-join creates the new productUser and issues a session', async () => {
    const { app } = await getTestContext();
    await product('app-a');
    const productBId = await product('app-b');

    await signupAndVerify('app-a');
    await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: PASSWORD, productSlug: 'app-b' });

    const join = await EmailQueue.findOne({
      toAddress: EMAIL,
      templateId: 'auth.product_join_confirm',
    }).lean();
    const token = (join!.templateData as { joinToken: string }).joinToken;

    const res = await request(app).get('/v1/auth/confirm-join').query({ token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('joined');
    expect(res.body.alreadyJoined).toBe(false);
    expect(res.body.productId).toBe(productBId);
    expect(res.body.tokens.accessToken).toBeTruthy();

    expect(await ProductUser.countDocuments({})).toBe(2);
    const pu = await ProductUser.findOne({ productId: productBId }).lean();
    expect(pu!.status).toBe('ACTIVE');
    expect(pu!.passwordHash).toBeTruthy();

    // Re-click — idempotent.
    const replay = await request(app).get('/v1/auth/confirm-join').query({ token });
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyJoined).toBe(true);
  });

  it('does NOT queue join email when the user is already a member of the product', async () => {
    const { app } = await getTestContext();
    await product('app-a');
    await signupAndVerify('app-a');

    // Re-signup against same product.
    await request(app)
      .post('/v1/auth/signup')
      .send({ email: EMAIL, password: PASSWORD, productSlug: 'app-a' });
    expect(
      await EmailQueue.countDocuments({ templateId: 'auth.product_join_confirm' }),
    ).toBe(0);
  });
});
