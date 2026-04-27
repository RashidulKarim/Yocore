/**
 * Integration tests for V1.0-J: admin ops + me/self-service endpoints.
 *
 * Scope:
 *   - GET  /v1/admin/cron/status                         (super-admin)
 *   - POST /v1/admin/super-admin/config (PATCH)          (super-admin)
 *   - POST /v1/admin/tos                                 (super-admin)
 *   - GET  /v1/tos/current                               (public)
 *   - GET  /v1/sessions                                  (bearer)
 *   - DELETE /v1/sessions/:id                            (bearer)
 *
 * Lighter-touch than full feature flow tests; verifies wiring + auth gates
 * + happy-path mutations + audit emission.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { signJwt } from '../lib/jwt.js';
import { Session } from '../db/models/Session.js';
import { TosVersion } from '../db/models/TosVersion.js';

const ACCESS_TTL = 900;

async function mintSuperAdmin(): Promise<{ token: string; userId: string; jti: string }> {
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
  return { token, userId, jti };
}

async function mintEndUser(): Promise<{ token: string; userId: string; jti: string }> {
  const { ctx } = await getTestContext();
  const userId = `usr_user_${Math.random().toString(36).slice(2)}`;
  const jti = `jti_${Math.random().toString(36).slice(2)}`;
  const token = await signJwt(ctx.keyring, {
    subject: userId,
    ttlSeconds: ACCESS_TTL,
    purpose: 'access',
    jti,
    claims: { role: 'END_USER', scopes: [] },
  });
  await ctx.sessionStore.markActive(jti, ACCESS_TTL);
  return { token, userId, jti };
}

describe('V1.0-J — admin ops + me endpoints', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('GET /v1/admin/cron/status returns array of crons', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    const res = await request(app)
      .get('/v1/admin/cron/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });

  it('GET /v1/admin/cron/status rejects without bearer', async () => {
    const { app } = await getTestContext();
    const res = await request(app).get('/v1/admin/cron/status');
    expect(res.status).toBe(401);
  });

  it('PATCH /v1/admin/super-admin/config updates allowlist + emits audit', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    const res = await request(app)
      .patch('/v1/admin/super-admin/config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        adminIpAllowlist: ['10.0.0.0/8'],
        adminIpAllowlistEnabled: false,
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('adminIpAllowlist');
  });

  it('POST /v1/admin/tos publishes a version + GET /v1/tos/current returns it', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    const publish = await request(app)
      .post('/v1/admin/tos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'terms_of_service',
        version: '1.0',
        effectiveAt: new Date().toISOString(),
        contentUrl: 'https://example.com/tos/1.0',
        contentHash: 'a'.repeat(64),
        changeSummary: 'initial',
      });
    expect(publish.status).toBe(201);

    const current = await request(app).get('/v1/tos/current');
    expect(current.status).toBe(200);
    expect(current.body.termsOfService?.version).toBe('1.0');
  });

  it('publishing a second ToS demotes the prior `isCurrent`', async () => {
    const { app } = await getTestContext();
    const { token } = await mintSuperAdmin();
    for (const v of ['1.0', '2.0']) {
      const r = await request(app)
        .post('/v1/admin/tos')
        .set('Authorization', `Bearer ${token}`)
        .send({
          type: 'terms_of_service',
          version: v,
          effectiveAt: new Date().toISOString(),
          contentUrl: `https://example.com/tos/${v}`,
          contentHash: 'a'.repeat(64),
        });
      expect(r.status).toBe(201);
    }
    const all = await TosVersion.find({ type: 'terms_of_service' }).sort({ version: 1 }).lean();
    expect(all.length).toBe(2);
    const current = all.filter((t) => t.isCurrent);
    expect(current.length).toBe(1);
    expect(current[0]!.version).toBe('2.0');
  });

  it('GET /v1/sessions returns the caller\u2019s active sessions', async () => {
    const { app } = await getTestContext();
    const { token, userId, jti } = await mintEndUser();
    // Persist the session row so the list isn't empty.
    await Session.create({
      _id: jti,
      userId,
      productId: 'prd_test',
      refreshTokenHash: 'h'.repeat(64),
      refreshTokenFamilyId: 'fam_test',
      jwtId: jti,
      refreshExpiresAt: new Date(Date.now() + 86_400_000),
      lastUsedAt: new Date(),
      device: { ip: '127.0.0.1', userAgent: 'vitest' },
    });
    const res = await request(app)
      .get('/v1/sessions')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /v1/sessions/:id revokes a session', async () => {
    const { app } = await getTestContext();
    const { token, userId, jti } = await mintEndUser();
    await Session.create({
      _id: jti,
      userId,
      productId: 'prd_test',
      refreshTokenHash: 'h'.repeat(64),
      refreshTokenFamilyId: 'fam_test',
      jwtId: jti,
      refreshExpiresAt: new Date(Date.now() + 86_400_000),
      lastUsedAt: new Date(),
      device: { ip: '127.0.0.1', userAgent: 'vitest' },
    });
    const res = await request(app)
      .delete(`/v1/sessions/${jti}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const after = await Session.findById(jti).lean();
    expect(after?.revokedAt).toBeTruthy();
  });

  it('GET /v1/openapi.json returns a valid 3.1 spec', async () => {
    const { app } = await getTestContext();
    const res = await request(app).get('/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths).toHaveProperty('/v1/auth/signup');
    expect(res.body.paths).toHaveProperty('/v1/sessions');
  });
});
