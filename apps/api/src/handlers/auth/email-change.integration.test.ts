/**
 * Flow P — email change request + confirm (integration).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';
import { Product } from '../../db/models/Product.js';
import { EmailQueue } from '../../db/models/EmailQueue.js';
import { User } from '../../db/models/User.js';
import { Session } from '../../db/models/Session.js';
import { hash as hashPassword } from '../../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const EMAIL = 'p-old@example.com';
const NEW_EMAIL = 'p-new@example.com';
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

describe('Flow P — email change', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('queues a confirmation email to the NEW address (re-auth required)', async () => {
    const { app } = await getTestContext();
    const { accessToken } = await signedInSession();

    const r = await request(app)
      .post('/v1/auth/email/change-request')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ newEmail: NEW_EMAIL, password: PASSWORD });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('email_change_requested');

    const queued = await EmailQueue.findOne({
      toAddress: NEW_EMAIL,
      templateId: 'auth.email_change_confirm',
    }).lean();
    expect(queued).not.toBeNull();
    expect((queued!.templateData as { confirmToken: string }).confirmToken).toBeTruthy();
  });

  it('rejects with bad password (AUTH_INVALID_CREDENTIALS)', async () => {
    const { app } = await getTestContext();
    const { accessToken } = await signedInSession();

    const r = await request(app)
      .post('/v1/auth/email/change-request')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ newEmail: NEW_EMAIL, password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('confirm updates email + revokes ALL sessions', async () => {
    const { app } = await getTestContext();
    const { accessToken } = await signedInSession();

    await request(app)
      .post('/v1/auth/email/change-request')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ newEmail: NEW_EMAIL, password: PASSWORD });
    const queued = await EmailQueue.findOne({
      toAddress: NEW_EMAIL,
      templateId: 'auth.email_change_confirm',
    }).lean();
    const token = (queued!.templateData as { confirmToken: string }).confirmToken;

    const r = await request(app)
      .get('/v1/auth/email/change-confirm')
      .query({ token });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('email_changed');
    expect(r.body.newEmail).toBe(NEW_EMAIL);

    const u = await User.findOne({ email: NEW_EMAIL }).lean();
    expect(u).not.toBeNull();
    expect(u!.emailVerified).toBe(true);

    // Refresh sessions revoked (access tokens are stateless JWTs and stay valid until TTL expiry).
    expect(await Session.countDocuments({ revokedAt: null })).toBe(0);
  });

  it('rejects when newEmail equals current email', async () => {
    const { app } = await getTestContext();
    const { accessToken } = await signedInSession();
    const r = await request(app)
      .post('/v1/auth/email/change-request')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ newEmail: EMAIL, password: PASSWORD });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('RESOURCE_CONFLICT');
  });
});
