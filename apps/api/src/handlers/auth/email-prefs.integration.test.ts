/**
 * Flow AI — email preferences + RFC 8058 unsubscribe (integration).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';
import { Product } from '../../db/models/Product.js';
import { EmailQueue } from '../../db/models/EmailQueue.js';
import { ProductUser } from '../../db/models/ProductUser.js';
import { hash as hashPassword } from '../../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const EMAIL = 'prefs@example.com';
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

async function signedInSession(): Promise<{ accessToken: string }> {
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
  const verified = await request(app).get('/v1/auth/verify-email').query({ token });
  return { accessToken: verified.body.tokens.accessToken as string };
}

describe('Flow AI — email preferences + unsubscribe', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('GET returns the default preferences', async () => {
    const { app } = await getTestContext();
    const { accessToken } = await signedInSession();
    const r = await request(app)
      .get('/v1/users/me/email-preferences')
      .set('authorization', `Bearer ${accessToken}`);
    expect(r.status).toBe(200);
    expect(r.body.emailPreferences).toMatchObject({
      marketing: false,
      productUpdates: true,
      billing: true,
      security: true,
    });
  });

  it('PATCH can opt out of marketing but NOT security (PERMISSION_DENIED)', async () => {
    const { app } = await getTestContext();
    const { accessToken } = await signedInSession();

    const ok = await request(app)
      .patch('/v1/users/me/email-preferences')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ marketing: true });
    expect(ok.status).toBe(200);
    expect(ok.body.emailPreferences.marketing).toBe(true);
    expect(ok.body.emailPreferences.security).toBe(true);

    const denied = await request(app)
      .patch('/v1/users/me/email-preferences')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ security: false });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('PERMISSION_DENIED');
  });

  it('unsubscribe via signed token (POST and GET) flips marketing off', async () => {
    const { app, ctx } = await getTestContext();
    await signedInSession();

    const productDoc = await Product.findOne({ slug: SLUG }).lean();
    const pu = await ProductUser.findOne({ productId: productDoc!._id }).lean();
    const token = ctx.emailPrefs.buildUnsubscribeToken({
      userId: pu!.userId,
      productId: productDoc!._id,
      category: 'marketing',
    });

    // RFC 8058 List-Unsubscribe-Post via POST.
    const post = await request(app)
      .post('/v1/email/unsubscribe')
      .send({ token });
    expect(post.status).toBe(200);
    expect(post.body.status).toBe('unsubscribed');

    const after = await ProductUser.findById(pu!._id).lean();
    expect(after!.emailPreferences!.marketing).toBe(false);
    expect(after!.emailPreferences!.security).toBe(true);

    // GET form (one-click) still works.
    const get = await request(app).get('/v1/email/unsubscribe').query({ token });
    expect(get.status).toBe(200);
  });

  it('unsubscribe refuses category=security', async () => {
    const { app, ctx } = await getTestContext();
    await signedInSession();
    const productDoc = await Product.findOne({ slug: SLUG }).lean();
    const pu = await ProductUser.findOne({ productId: productDoc!._id }).lean();
    const token = ctx.emailPrefs.buildUnsubscribeToken({
      userId: pu!.userId,
      productId: productDoc!._id,
      category: 'security',
    });
    const r = await request(app).post('/v1/email/unsubscribe').send({ token });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('PERMISSION_DENIED');
  });

  it('unsubscribe rejects a tampered token', async () => {
    const { app } = await getTestContext();
    const r = await request(app)
      .post('/v1/email/unsubscribe')
      .send({ token: 'not.a.valid.token' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('AUTH_INVALID_TOKEN');
  });
});
