/**
 * Phase 3.3 — Admin / Products / Gateways (integration).
 *
 * Drives Flow B (create product + rotate api secret), Flow AJ (rotate webhook
 * secret with 24h grace) and Flow C1–C5 (gateway add / list / remove with
 * encrypted credentials + live verification stub).
 *
 * SUPER_ADMIN session is minted directly via the keyring so we don't have to
 * walk the bootstrap → MFA enrol → signin path on every test (Phase 3.1
 * already covers that).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { createGatewayService } from '../services/gateway.service.js';
import { Product } from '../db/models/Product.js';
import { PaymentGateway } from '../db/models/PaymentGateway.js';

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

async function mintEndUserToken(): Promise<{ token: string; userId: string }> {
  const { ctx } = await getTestContext();
  const userId = `usr_end_${Math.random().toString(36).slice(2)}`;
  const jti = `jti_${Math.random().toString(36).slice(2)}`;
  const token = await signJwt(ctx.keyring, {
    subject: userId,
    ttlSeconds: ACCESS_TTL,
    purpose: 'access',
    jti,
    claims: { role: 'END_USER', scopes: [] },
  });
  await ctx.sessionStore.markActive(jti, ACCESS_TTL);
  return { token, userId };
}

describe('Phase 3.3 — admin products & gateways', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('Flow B — create product', () => {
    it('returns 201 with apiSecret + webhookSecret shown ONCE', async () => {
      const { app } = await getTestContext();
      const { token } = await mintSuperAdminToken();
      const res = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'My Product',
          slug: 'my-product',
          billingScope: 'workspace',
        });
      expect(res.status).toBe(201);
      expect(res.body.product).toMatchObject({
        slug: 'my-product',
        status: 'INACTIVE',
        billingScope: 'workspace',
      });
      expect(res.body.product.id).toMatch(/^prod_/);
      expect(res.body.product.apiKey).toMatch(/^yc_live_pk_/);
      expect(typeof res.body.apiSecret).toBe('string');
      expect(res.body.apiSecret.length).toBeGreaterThanOrEqual(32);
      expect(typeof res.body.webhookSecret).toBe('string');
      expect(res.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

      // Persisted with hashed apiSecret + plaintext webhookSecret.
      const stored = await Product.findById(res.body.product.id).lean();
      expect(stored?.apiSecretHash).toMatch(/^\$argon2/);
      expect(stored?.apiSecretHash).not.toBe(res.body.apiSecret);
      expect(stored?.webhookSecret).toBe(res.body.webhookSecret);

      // Platform roles seeded.
      const { Role } = await import('../db/models/Role.js');
      const roles = await Role.find({ productId: res.body.product.id }).lean();
      expect(roles.map((r) => r.slug).sort()).toEqual(['ADMIN', 'MEMBER', 'OWNER', 'VIEWER']);
    });

    it('rejects duplicate slug with 409 RESOURCE_CONFLICT', async () => {
      const { app } = await getTestContext();
      const { token } = await mintSuperAdminToken();
      await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'A', slug: 'dup-slug', billingScope: 'workspace' });
      const res = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'B', slug: 'dup-slug', billingScope: 'workspace' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('RESOURCE_CONFLICT');
    });

    it('rejects non-super-admin with 403 SUPER_ADMIN_ONLY', async () => {
      const { app } = await getTestContext();
      const { token } = await mintEndUserToken();
      const res = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'X', slug: 'x-slug', billingScope: 'workspace' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('SUPER_ADMIN_ONLY');
    });
  });

  describe('Flow B — rotate api secret', () => {
    it('issues a new secret and persists a new hash', async () => {
      const { app } = await getTestContext();
      const { token } = await mintSuperAdminToken();
      const create = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Rot', slug: 'rot-slug', billingScope: 'workspace' });
      const productId = create.body.product.id;
      const oldHash = (await Product.findById(productId).lean())?.apiSecretHash;

      const rot = await request(app)
        .post(`/v1/admin/products/${productId}/rotate-api-secret`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(rot.status).toBe(200);
      expect(typeof rot.body.apiSecret).toBe('string');
      expect(rot.body.apiSecret).not.toBe(create.body.apiSecret);
      const newHash = (await Product.findById(productId).lean())?.apiSecretHash;
      expect(newHash).not.toBe(oldHash);
    });
  });

  describe('Flow AJ — rotate webhook secret with 24h grace', () => {
    it('moves the old secret into webhookSecretPrevious for 24h', async () => {
      const { app } = await getTestContext();
      const { token } = await mintSuperAdminToken();
      const create = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Hook', slug: 'hook-slug', billingScope: 'workspace' });
      const productId = create.body.product.id;
      const oldSecret = create.body.webhookSecret as string;

      const rot = await request(app)
        .post(`/v1/admin/products/${productId}/rotate-webhook-secret`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(rot.status).toBe(200);
      expect(rot.body.webhookSecret).not.toBe(oldSecret);
      expect(rot.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      const expiresAt = new Date(rot.body.previousSecretExpiresAt).getTime();
      const now = Date.now();
      // Allow a generous 60s skew either side; window is exactly 24h.
      expect(expiresAt).toBeGreaterThan(now + 23 * 3600 * 1000);
      expect(expiresAt).toBeLessThan(now + 25 * 3600 * 1000);

      const stored = await Product.findById(productId).lean();
      expect(stored?.webhookSecret).toBe(rot.body.webhookSecret);
      expect(stored?.webhookSecretPrevious?.secret).toBe(oldSecret);
      expect(stored?.webhookSecretPrevious?.expiresAt).toBeTruthy();
    });
  });

  describe('Flow C1 — add Stripe gateway', () => {
    it('encrypts credentials, marks ACTIVE on successful verify', async () => {
      const { app, ctx } = await getTestContext();
      // Stub a successful verifier so we never hit api.stripe.com.
      ctx.gateway = createGatewayService({
        verify: async () => ({ ok: true }),
      });

      const { token } = await mintSuperAdminToken();
      const create = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'C1', slug: 'c1-slug', billingScope: 'workspace' });
      const productId = create.body.product.id;

      const add = await request(app)
        .post(`/v1/admin/products/${productId}/gateways`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          provider: 'stripe',
          mode: 'test',
          credentials: {
            secretKey: 'sk_test_dummy_value',
            webhookSecret: 'whsec_dummy',
          },
        });
      expect(add.status).toBe(201);
      expect(add.body.gateway).toMatchObject({
        provider: 'stripe',
        mode: 'test',
        status: 'ACTIVE',
        lastVerificationStatus: 'ok',
      });
      // Response NEVER carries plaintext credentials.
      expect(JSON.stringify(add.body)).not.toContain('sk_test_dummy_value');
      expect(JSON.stringify(add.body)).not.toContain('whsec_dummy');

      const stored = await PaymentGateway.findById(add.body.gateway.id).lean();
      const enc = stored?.credentialsEncrypted as Record<string, { token: string }>;
      expect(enc.secretKey?.token).toBeTruthy();
      // Envelope token starts with 'v1.' marker.
      expect(enc.secretKey.token.startsWith('v1.')).toBe(true);
      expect(enc.webhookSecret.token.startsWith('v1.')).toBe(true);
    });

    it('returns 502 GATEWAY_VERIFICATION_FAILED + writes audit on bad creds', async () => {
      const { app, ctx } = await getTestContext();
      ctx.gateway = createGatewayService({
        verify: async () => ({ ok: false, error: 'Stripe 401: invalid api key' }),
      });
      const { token } = await mintSuperAdminToken();
      const create = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'C1f', slug: 'c1f-slug', billingScope: 'workspace' });
      const productId = create.body.product.id;

      const add = await request(app)
        .post(`/v1/admin/products/${productId}/gateways`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          provider: 'stripe',
          mode: 'test',
          credentials: { secretKey: 'sk_bad_invalid_key', webhookSecret: 'whsec_bad_xx' },
        });
      expect(add.status).toBe(502);
      expect(add.body.error).toBe('GATEWAY_VERIFICATION_FAILED');

      // No row inserted.
      const all = await PaymentGateway.find({ productId }).lean();
      expect(all.length).toBe(0);

      // Audit `gateway.add_failed` written.
      const { AuditLog } = await import('../db/models/AuditLog.js');
      const failed = await AuditLog.findOne({
        productId,
        action: 'gateway.add_failed',
      }).lean();
      expect(failed).toBeTruthy();
      expect(failed?.outcome).toBe('failure');
    });

    it('rejects duplicate provider+mode with 409 RESOURCE_CONFLICT', async () => {
      const { app, ctx } = await getTestContext();
      ctx.gateway = createGatewayService({ verify: async () => ({ ok: true }) });
      const { token } = await mintSuperAdminToken();
      const create = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'C1d', slug: 'c1d-slug', billingScope: 'workspace' });
      const productId = create.body.product.id;
      const payload = {
        provider: 'stripe',
        mode: 'test',
        credentials: { secretKey: 'sk_aaaaaaaa', webhookSecret: 'whsec_aaaa' },
      };
      await request(app)
        .post(`/v1/admin/products/${productId}/gateways`)
        .set('Authorization', `Bearer ${token}`)
        .send(payload);
      const dup = await request(app)
        .post(`/v1/admin/products/${productId}/gateways`)
        .set('Authorization', `Bearer ${token}`)
        .send(payload);
      expect(dup.status).toBe(409);
      expect(dup.body.error).toBe('RESOURCE_CONFLICT');
    });
  });

  describe('Gateway list + remove', () => {
    it('lists and removes gateways without ever exposing credentials', async () => {
      const { app, ctx } = await getTestContext();
      ctx.gateway = createGatewayService({ verify: async () => ({ ok: true }) });
      const { token } = await mintSuperAdminToken();
      const create = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'CL', slug: 'cl-slug', billingScope: 'workspace' });
      const productId = create.body.product.id;

      const add = await request(app)
        .post(`/v1/admin/products/${productId}/gateways`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          provider: 'stripe',
          mode: 'test',
          credentials: { secretKey: 'sk_xxxxxxxx', webhookSecret: 'whsec_xxxx' },
        });
      const gwId = add.body.gateway.id;

      const list = await request(app)
        .get(`/v1/admin/products/${productId}/gateways`)
        .set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.gateways.length).toBe(1);
      expect(JSON.stringify(list.body)).not.toContain('sk_xxxxxxxx');

      const del = await request(app)
        .delete(`/v1/admin/products/${productId}/gateways/${gwId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(204);

      const after = await PaymentGateway.find({ productId }).lean();
      expect(after.length).toBe(0);
    });
  });

  describe('Status + billing-config updates', () => {
    it('activates a product and updates billing config', async () => {
      const { app } = await getTestContext();
      const { token } = await mintSuperAdminToken();
      const create = await request(app)
        .post('/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'BC', slug: 'bc-slug', billingScope: 'workspace' });
      const productId = create.body.product.id;

      const act = await request(app)
        .patch(`/v1/admin/products/${productId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'ACTIVE' });
      expect(act.status).toBe(200);
      expect(act.body.product.status).toBe('ACTIVE');

      const bc = await request(app)
        .patch(`/v1/admin/products/${productId}/billing-config`)
        .set('Authorization', `Bearer ${token}`)
        .send({ gracePeriodDays: 14, trialDefaultDays: 30 });
      expect(bc.status).toBe(200);
      expect(bc.body.billingConfig.gracePeriodDays).toBe(14);
      expect(bc.body.billingConfig.trialDefaultDays).toBe(30);
    });
  });
});
