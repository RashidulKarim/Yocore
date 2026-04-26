/**
 * Flow F10/F11/F12 — email verification + auto-login + finalize-onboarding
 * (integration). Exercises the full HTTP path end-to-end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';
import { Product } from '../../db/models/Product.js';
import { User } from '../../db/models/User.js';
import { ProductUser } from '../../db/models/ProductUser.js';
import { AuthToken } from '../../db/models/AuthToken.js';
import { EmailQueue } from '../../db/models/EmailQueue.js';
import { Workspace } from '../../db/models/Workspace.js';
import { WorkspaceMember } from '../../db/models/WorkspaceMember.js';
import { hash as hashPassword } from '../../lib/password.js';

const PASSWORD = 'StrongP@ssw0rd!';
const EMAIL = 'verify@example.com';
const SLUG = 'yopm';

async function createActiveProduct(): Promise<string> {
  const apiSecretHash = await hashPassword('dummy-secret-not-used-in-this-test');
  const doc = await Product.create({
    name: 'YoPM',
    slug: SLUG,
    status: 'ACTIVE',
    apiKey: `pk_test_${Math.random().toString(36).slice(2)}`,
    apiSecretHash,
  });
  return doc._id;
}

async function signupAndGetToken(): Promise<{ userId: string; productId: string; token: string }> {
  const { app } = await getTestContext();
  const productId = await createActiveProduct();
  const r = await request(app)
    .post('/v1/auth/signup')
    .send({ email: EMAIL, password: PASSWORD, productSlug: SLUG, name: { first: 'Ada' } });
  expect(r.status).toBe(202);

  // The raw token isn't returned by the API. We pull it from the queued email,
  // which is exactly how Resend's worker would.
  const queued = await EmailQueue.findOne({ toAddress: EMAIL }).lean();
  const token = (queued!.templateData as { verifyToken: string }).verifyToken;
  const user = await User.findOne({ email: EMAIL }).lean();
  return { userId: user!._id, productId, token };
}

describe('Flow F10/F11 — verify-email + auto-login', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('verifies a fresh token, marks user + productUser, and issues a session', async () => {
    const { app } = await getTestContext();
    const { userId, productId, token } = await signupAndGetToken();

    const res = await request(app).get('/v1/auth/verify-email').query({ token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('verified');
    expect(res.body.alreadyVerified).toBe(false);
    expect(res.body.userId).toBe(userId);
    expect(res.body.productId).toBe(productId);
    expect(res.body.onboarded).toBe(false);
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toBeTruthy();
    expect(res.body.tokens.tokenType).toBe('Bearer');

    const u = await User.findById(userId).lean();
    expect(u!.emailVerified).toBe(true);
    expect(u!.emailVerifiedMethod).toBe('email_link');

    const pu = await ProductUser.findOne({ productId, userId }).lean();
    expect(pu!.status).toBe('ACTIVE');

    const consumed = await AuthToken.findOne({ userId, type: 'email_verify' }).lean();
    expect(consumed!.usedAt).not.toBeNull();
  });

  it('is idempotent on re-click (alreadyVerified:true) and still issues a session', async () => {
    const { app } = await getTestContext();
    const { token } = await signupAndGetToken();

    const r1 = await request(app).get('/v1/auth/verify-email').query({ token });
    expect(r1.status).toBe(200);
    expect(r1.body.alreadyVerified).toBe(false);

    const r2 = await request(app).get('/v1/auth/verify-email').query({ token });
    expect(r2.status).toBe(200);
    expect(r2.body.alreadyVerified).toBe(true);
    expect(r2.body.tokens.accessToken).toBeTruthy();
  });

  it('returns 410 AUTH_TOKEN_EXPIRED for an expired token', async () => {
    const { app } = await getTestContext();
    const { userId, token } = await signupAndGetToken();

    // Force-expire the token row.
    await AuthToken.updateOne(
      { userId, type: 'email_verify' },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const res = await request(app).get('/v1/auth/verify-email').query({ token });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('returns 401 AUTH_INVALID_TOKEN for a bogus token', async () => {
    const { app } = await getTestContext();
    await createActiveProduct();
    const res = await request(app)
      .get('/v1/auth/verify-email')
      .query({ token: 'not-a-real-token-but-long-enough-to-pass-zod' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects missing token with 422 VALIDATION_FAILED', async () => {
    const { app } = await getTestContext();
    const res = await request(app).get('/v1/auth/verify-email');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('Flow F12 — finalize-onboarding', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function verifiedSession(): Promise<{
    accessToken: string;
    userId: string;
    productId: string;
  }> {
    const { app } = await getTestContext();
    const { userId, productId, token } = await signupAndGetToken();
    const verified = await request(app).get('/v1/auth/verify-email').query({ token });
    return { accessToken: verified.body.tokens.accessToken as string, userId, productId };
  }

  it('creates a workspace + OWNER member and flips onboarded=true', async () => {
    const { app } = await getTestContext();
    const { accessToken, userId, productId } = await verifiedSession();

    const res = await request(app)
      .post('/v1/auth/finalize-onboarding')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        workspaceName: "Ada's Team",
        timezone: 'Asia/Dhaka',
        timeFormat: '24h',
      });

    expect(res.status).toBe(201);
    expect(res.body.workspace.name).toBe("Ada's Team");
    expect(res.body.workspace.slug).toBe('adas-team');
    expect(res.body.productUser.onboarded).toBe(true);

    const ws = await Workspace.findById(res.body.workspace.id).lean();
    expect(ws!.productId).toBe(productId);
    expect(ws!.ownerUserId).toBe(userId);
    expect(ws!.timezone).toBe('Asia/Dhaka');

    const member = await WorkspaceMember.findOne({
      workspaceId: ws!._id,
      userId,
    }).lean();
    expect(member).not.toBeNull();
    expect(member!.roleSlug).toBe('OWNER');
    expect(member!.status).toBe('ACTIVE');

    const pu = await ProductUser.findOne({ productId, userId }).lean();
    expect(pu!.onboarded).toBe(true);
    expect(pu!.timezone).toBe('Asia/Dhaka');
    expect(pu!.timeFormat).toBe('24h');
  });

  it('rejects a second call with 409 AUTH_ONBOARDING_ALREADY_COMPLETE', async () => {
    const { app } = await getTestContext();
    const { accessToken } = await verifiedSession();

    const r1 = await request(app)
      .post('/v1/auth/finalize-onboarding')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ workspaceName: 'First WS' });
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post('/v1/auth/finalize-onboarding')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ workspaceName: 'Second WS' });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('AUTH_ONBOARDING_ALREADY_COMPLETE');
  });

  it('rejects without a bearer token', async () => {
    const { app } = await getTestContext();
    const res = await request(app)
      .post('/v1/auth/finalize-onboarding')
      .send({ workspaceName: 'X' });
    expect(res.status).toBe(401);
  });

  it('rejects bad payload with 422 VALIDATION_FAILED', async () => {
    const { app } = await getTestContext();
    const { accessToken } = await verifiedSession();
    const res = await request(app)
      .post('/v1/auth/finalize-onboarding')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ workspaceName: 'A' /* too short */ });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});
