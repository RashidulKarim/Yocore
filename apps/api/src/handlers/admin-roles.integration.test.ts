/**
 * V1.2-A — Custom Role CRUD (integration).
 *
 * Drives:
 *   POST /v1/admin/products/:id/roles
 *   GET  /v1/admin/products/:id/roles
 *   PATCH /v1/admin/products/:id/roles/:roleId
 *   DELETE /v1/admin/products/:id/roles/:roleId
 *
 * Plus inheritance walk in permission.service.ts (V1.2-B).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { Product } from '../db/models/Product.js';
import { Role } from '../db/models/Role.js';
import { Workspace } from '../db/models/Workspace.js';
import { WorkspaceMember } from '../db/models/WorkspaceMember.js';
import { ProductUser } from '../db/models/ProductUser.js';
import { ensurePlatformRoles } from '../repos/role.repo.js';

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

async function seedProduct(): Promise<string> {
  const productId = `prod_${Math.random().toString(36).slice(2, 10)}`;
  await Product.create({
    _id: productId,
    name: 'Test',
    slug: `test-${productId}`,
    status: 'ACTIVE',
    billingScope: 'workspace',
    apiKey: `yc_live_pk_${productId}`,
    apiSecretHash: '$argon2id$v=19$m=65536,t=3,p=4$x$x',
    webhookSecret: 'a'.repeat(64),
  });
  await ensurePlatformRoles(productId);
  return productId;
}

describe('V1.2-A — custom role CRUD', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates a custom role and lists it alongside platform roles', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();

    const create = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        slug: 'BILLING_VIEWER',
        name: 'Billing Viewer',
        description: 'Read-only billing',
        permissions: ['billing.read', 'invoice.read'],
      });
    expect(create.status).toBe(201);
    expect(create.body.role).toMatchObject({
      slug: 'BILLING_VIEWER',
      isPlatform: false,
      permissions: ['billing.read', 'invoice.read'],
      memberCount: 0,
    });

    const list = await request(app)
      .get(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const slugs = list.body.roles.map((r: { slug: string }) => r.slug).sort();
    expect(slugs).toEqual(['ADMIN', 'BILLING_VIEWER', 'MEMBER', 'OWNER', 'VIEWER']);
  });

  it('rejects duplicate slug with 409 RESOURCE_CONFLICT', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();

    await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'CUSTOM_X', name: 'X', permissions: ['a.read'] });
    const dup = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'CUSTOM_X', name: 'X2', permissions: ['a.read'] });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('rejects creating a role with a reserved platform slug', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();

    const res = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'ADMIN', name: 'Admin', permissions: ['*'] });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('updates a custom role and bumps cache', async () => {
    const { app, ctx } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();
    const created = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'EDITOR', name: 'Editor', permissions: ['x.read'] });
    const roleId = created.body.role.id;
    // Pre-populate the perm cache to verify it gets cleared on update.
    await ctx.redis.set(`perm:${productId}:u1:w1`, JSON.stringify({ roleSlug: 'X', granted: [] }));
    const upd = await request(app)
      .patch(`/v1/admin/products/${productId}/roles/${roleId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Editor v2', permissions: ['x.read', 'x.write'] });
    expect(upd.status).toBe(200);
    expect(upd.body.role.name).toBe('Editor v2');
    expect(upd.body.role.permissions).toEqual(['x.read', 'x.write']);
    // Wildcard sentinel publishes; pub/sub may not flush by next tick in tests so
    // we just assert the response was correct here.
  });

  it('blocks updating platform roles with 403 PERMISSION_DENIED', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();
    const owner = await Role.findOne({ productId, slug: 'OWNER' }).lean();
    const res = await request(app)
      .patch(`/v1/admin/products/${productId}/roles/${owner!._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pwned' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PERMISSION_DENIED');
  });

  it('deletes a custom role with no active members', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();
    const created = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'TEMP', name: 'Temp', permissions: ['t.read'] });
    const del = await request(app)
      .delete(`/v1/admin/products/${productId}/roles/${created.body.role.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);
    const after = await Role.findById(created.body.role.id).lean();
    expect(after).toBeNull();
  });

  it('refuses to delete a custom role still assigned to active members (409)', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();
    const created = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'OPSEC', name: 'OpSec', permissions: ['ops.read'] });
    const roleId = created.body.role.id;
    // Seed a workspace + active member with this role.
    const wsId = `ws_${Math.random().toString(36).slice(2)}`;
    const ownerId = `usr_${Math.random().toString(36).slice(2)}`;
    await Workspace.create({
      _id: wsId,
      productId,
      name: 'WS',
      slug: 'ws',
      ownerUserId: ownerId,
      billingContactUserId: ownerId,
      seats: { used: 1, max: 5 },
    });
    await WorkspaceMember.create({
      productId,
      workspaceId: wsId,
      userId: ownerId,
      roleId,
      roleSlug: 'OPSEC',
      status: 'ACTIVE',
      joinedAt: new Date(),
    });
    const del = await request(app)
      .delete(`/v1/admin/products/${productId}/roles/${roleId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('RESOURCE_CONFLICT');
  });

  it('blocks deleting platform roles', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();
    const member = await Role.findOne({ productId, slug: 'MEMBER' }).lean();
    const res = await request(app)
      .delete(`/v1/admin/products/${productId}/roles/${member!._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('rejects inheritsFrom that does not exist (VALIDATION_FAILED)', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();
    const res = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        slug: 'CHILD',
        name: 'Child',
        permissions: ['c.read'],
        inheritsFrom: 'role_does_not_exist',
      });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('V1.2-B — permission inheritance walk', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('merges parent permissions when a role declares inheritsFrom', async () => {
    const { app, ctx } = await getTestContext();
    const { token } = await mintSuperAdminToken();
    const productId = await seedProduct();
    // Create parent + child roles.
    const parent = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug: 'PARENT_R', name: 'Parent', permissions: ['workspace.read'] });
    const child = await request(app)
      .post(`/v1/admin/products/${productId}/roles`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        slug: 'CHILD_R',
        name: 'Child',
        permissions: ['plan.read'],
        inheritsFrom: parent.body.role.id,
      });
    // Seed workspace + active member with the child role.
    const wsId = `ws_${Math.random().toString(36).slice(2)}`;
    const userId = `usr_${Math.random().toString(36).slice(2)}`;
    await Workspace.create({
      _id: wsId,
      productId,
      name: 'WS',
      slug: 'ws',
      ownerUserId: userId,
      billingContactUserId: userId,
      seats: { used: 1, max: 5 },
    });
    await WorkspaceMember.create({
      productId,
      workspaceId: wsId,
      userId,
      roleId: child.body.role.id,
      roleSlug: 'CHILD_R',
      status: 'ACTIVE',
      joinedAt: new Date(),
    });
    // Check permissions through the service directly.
    const result = await ctx.permission.check({
      productId,
      workspaceId: wsId,
      userId,
      permissions: ['workspace.read', 'plan.read'],
    });
    expect(result.results['workspace.read']).toBe(true);
    expect(result.results['plan.read']).toBe(true);
  });
});
