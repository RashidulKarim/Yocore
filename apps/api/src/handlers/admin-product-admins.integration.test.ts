/**
 * V1.2-C — Product Admins (PRODUCT_ADMIN grant/revoke) integration.
 *
 * Drives:
 *   GET    /v1/admin/products/:id/admins
 *   POST   /v1/admin/products/:id/admins         { userId }
 *   DELETE /v1/admin/products/:id/admins/:userId
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { Product } from '../db/models/Product.js';
import { ProductUser } from '../db/models/ProductUser.js';
import { User } from '../db/models/User.js';

const ACCESS_TTL = 900;

async function mintSuperAdminToken(): Promise<{ token: string; userId: string }> {
  const { ctx } = await getTestContext();
  const userId = `usr_admin_${Math.random().toString(36).slice(2)}`;
  const jti = `jti_${Math.random().toString(36).slice(2)}`;
  const token = await signJwt(ctx.keyring, {
    subject: userId,
    ttlSeconds: ACCESS_TTL,
    purpose: 'access',
    jti,
    claims: { role: 'SUPER_ADMIN', scopes: [] },
  });
  await ctx.sessionStore.markActive(jti, ACCESS_TTL);
  return { token, userId };
}

async function seedProductAndUser(): Promise<{ productId: string; userId: string }> {
  const productId = `prod_${Math.random().toString(36).slice(2, 10)}`;
  await Product.create({
    _id: productId,
    name: 'P',
    slug: `p-${productId}`,
    status: 'ACTIVE',
    billingScope: 'workspace',
    apiKey: `yc_live_pk_${productId}`,
    apiSecretHash: '$argon2id$v=19$m=65536,t=3,p=4$x$x',
    webhookSecret: 'a'.repeat(64),
  });
  const userId = `usr_${Math.random().toString(36).slice(2)}`;
  await User.create({
    _id: userId,
    email: `${userId}@ex.com`,
    emailNormalized: `${userId}@ex.com`,
    role: 'END_USER',
    status: 'ACTIVE',
    emailVerified: true,
  });
  await ProductUser.create({
    productId,
    userId,
    name: { display: 'Test User' },
    status: 'ACTIVE',
    productRole: 'END_USER',
    joinedAt: new Date(),
  });
  return { productId, userId };
}

describe('V1.2-C — product admins (grant/revoke)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('grants PRODUCT_ADMIN, lists it, and revokes it', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const { productId, userId } = await seedProductAndUser();

    // List → empty.
    const before = await request(app)
      .get(`/v1/admin/products/${productId}/admins`)
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.admins).toEqual([]);

    // Grant.
    const grant = await request(app)
      .post(`/v1/admin/products/${productId}/admins`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId });
    expect(grant.status).toBe(200);
    expect(grant.body).toMatchObject({ userId, productRole: 'PRODUCT_ADMIN' });

    // List → contains user.
    const list = await request(app)
      .get(`/v1/admin/products/${productId}/admins`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.admins).toHaveLength(1);
    expect(list.body.admins[0]).toMatchObject({
      userId,
      email: `${userId}@ex.com`,
      displayName: 'Test User',
      status: 'ACTIVE',
    });

    // Verify mongo.
    const pu = await ProductUser.findOne({ productId, userId }).lean();
    expect(pu?.productRole).toBe('PRODUCT_ADMIN');

    // Revoke.
    const revoke = await request(app)
      .delete(`/v1/admin/products/${productId}/admins/${userId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(revoke.status).toBe(204);
    const after = await ProductUser.findOne({ productId, userId }).lean();
    expect(after?.productRole).toBe('END_USER');
  });

  it('rejects granting on a user who is not in the product (USER_NOT_FOUND)', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const { productId } = await seedProductAndUser();
    const res = await request(app)
      .post(`/v1/admin/products/${productId}/admins`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'usr_doesnotexist01' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('USER_NOT_FOUND');
  });

  it('rejects revoking a non-PRODUCT_ADMIN user (RESOURCE_CONFLICT)', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const { productId, userId } = await seedProductAndUser();
    const res = await request(app)
      .delete(`/v1/admin/products/${productId}/admins/${userId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('rejects non-SUPER_ADMIN callers (SUPER_ADMIN_ONLY)', async () => {
    const { app, ctx } = await getTestContext();
    const userId = `usr_eu_${Math.random().toString(36).slice(2)}`;
    const jti = `jti_${Math.random().toString(36).slice(2)}`;
    const token = await signJwt(ctx.keyring, {
      subject: userId,
      ttlSeconds: ACCESS_TTL,
      purpose: 'access',
      jti,
      claims: { role: 'END_USER', scopes: [] },
    });
    await ctx.sessionStore.markActive(jti, ACCESS_TTL);
    const { productId } = await seedProductAndUser();
    const res = await request(app)
      .get(`/v1/admin/products/${productId}/admins`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
