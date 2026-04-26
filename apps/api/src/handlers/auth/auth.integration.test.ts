/**
 * Flow A — Super Admin bootstrap + signin + MFA enrol/verify (integration).
 *
 * Exercises the full HTTP path through Express → middleware → handler →
 * service → repo → in-memory Mongo + Redis (no mocks).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { getTestContext, resetDatabase } from '../../../test/integration-setup.js';

describe('Flow A — Super Admin bootstrap + signin + MFA', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  const SECRET = process.env.BOOTSTRAP_SECRET!;
  const EMAIL = 'admin@yocore.io';
  const PASSWORD = 'StrongP@ssw0rd!';

  it('rejects bootstrap without the secret header', async () => {
    const { app } = await getTestContext();
    const res = await request(app)
      .post('/v1/admin/bootstrap')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AUTH_BOOTSTRAP_SECRET_INVALID');
  });

  it('rejects bootstrap with a wrong-length secret', async () => {
    const { app } = await getTestContext();
    const res = await request(app)
      .post('/v1/admin/bootstrap')
      .set('x-bootstrap-secret', 'wrong')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AUTH_BOOTSTRAP_SECRET_INVALID');
  });

  it('bootstraps the SUPER_ADMIN exactly once', async () => {
    const { app } = await getTestContext();
    const r1 = await request(app)
      .post('/v1/admin/bootstrap')
      .set('x-bootstrap-secret', SECRET)
      .send({ email: EMAIL, password: PASSWORD });
    expect(r1.status).toBe(201);
    expect(r1.body.email).toBe(EMAIL);
    expect(r1.body.mfaEnrolmentRequired).toBe(true);

    const r2 = await request(app)
      .post('/v1/admin/bootstrap')
      .set('x-bootstrap-secret', SECRET)
      .send({ email: 'other@yocore.io', password: PASSWORD });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('AUTH_BOOTSTRAP_ALREADY_DONE');
  });

  it('rejects signin with bad credentials', async () => {
    const { app } = await getTestContext();
    await request(app)
      .post('/v1/admin/bootstrap')
      .set('x-bootstrap-secret', SECRET)
      .send({ email: EMAIL, password: PASSWORD });

    const res = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('signs in with valid credentials when MFA not yet enrolled (issues tokens)', async () => {
    const { app } = await getTestContext();
    await request(app)
      .post('/v1/admin/bootstrap')
      .set('x-bootstrap-secret', SECRET)
      .send({ email: EMAIL, password: PASSWORD });

    const res = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('signed_in');
    expect(res.body.role).toBe('SUPER_ADMIN');
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toBeTruthy();
    expect(res.body.tokens.tokenType).toBe('Bearer');
  });

  it('full enrol → verify → MFA-challenged signin flow', async () => {
    const { app } = await getTestContext();
    await request(app)
      .post('/v1/admin/bootstrap')
      .set('x-bootstrap-secret', SECRET)
      .send({ email: EMAIL, password: PASSWORD });

    // Initial signin (no MFA → tokens directly).
    const first = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD });
    expect(first.status).toBe(200);
    const accessToken = first.body.tokens.accessToken as string;

    // Enrol TOTP.
    const enrol = await request(app)
      .post('/v1/auth/mfa/enrol')
      .set('authorization', `Bearer ${accessToken}`)
      .send({});
    expect(enrol.status).toBe(200);
    expect(enrol.body.enrolmentId).toBeTruthy();
    expect(enrol.body.secret).toBeTruthy();

    // Verify TOTP enrolment.
    const totp = authenticator.generate(enrol.body.secret);
    const verify = await request(app)
      .post('/v1/auth/mfa/enrol/verify')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ enrolmentId: enrol.body.enrolmentId, code: totp });
    expect(verify.status).toBe(200);
    expect(verify.body.enrolled).toBe(true);
    expect(verify.body.recoveryCodes).toHaveLength(10);

    // Status now reports enrolled.
    const status = await request(app)
      .get('/v1/auth/mfa/status')
      .set('authorization', `Bearer ${accessToken}`);
    expect(status.status).toBe(200);
    expect(status.body.enrolled).toBe(true);
    expect(status.body.recoveryCodesRemaining).toBe(10);

    // New signin attempt now triggers MFA challenge.
    const challenge = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD });
    expect(challenge.status).toBe(200);
    expect(challenge.body.status).toBe('mfa_required');
    expect(challenge.body.mfaChallengeId).toBeTruthy();

    // Second leg: provide TOTP. Use a fresh code (advance one step).
    const secondTotp = authenticator.generate(enrol.body.secret);
    const second = await request(app)
      .post('/v1/auth/signin')
      .send({
        email: EMAIL,
        password: PASSWORD,
        mfaChallengeId: challenge.body.mfaChallengeId,
        mfaCode: secondTotp,
      });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('signed_in');

    // Recovery code path.
    const challenge2 = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD });
    expect(challenge2.body.status).toBe('mfa_required');

    const recoveryCode = (verify.body.recoveryCodes as string[])[0]!;
    const recoveryRes = await request(app)
      .post('/v1/auth/signin')
      .send({
        email: EMAIL,
        password: PASSWORD,
        mfaChallengeId: challenge2.body.mfaChallengeId,
        mfaCode: recoveryCode,
      });
    expect(recoveryRes.status).toBe(200);
    expect(recoveryRes.body.status).toBe('signed_in');

    // Recovery codes remaining decremented.
    const access2 = recoveryRes.body.tokens.accessToken as string;
    const status2 = await request(app)
      .get('/v1/auth/mfa/status')
      .set('authorization', `Bearer ${access2}`);
    expect(status2.body.recoveryCodesRemaining).toBe(9);
  });

  it('refresh rotates the token and detects reuse', async () => {
    const { app } = await getTestContext();
    await request(app)
      .post('/v1/admin/bootstrap')
      .set('x-bootstrap-secret', SECRET)
      .send({ email: EMAIL, password: PASSWORD });

    const first = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD });
    const refresh1 = first.body.tokens.refreshToken as string;

    const r1 = await request(app).post('/v1/auth/refresh').send({ refreshToken: refresh1 });
    expect(r1.status).toBe(200);
    const refresh2 = r1.body.refreshToken as string;
    expect(refresh2).not.toBe(refresh1);

    // Old refresh used again → reuse detected.
    const r2 = await request(app).post('/v1/auth/refresh').send({ refreshToken: refresh1 });
    expect(r2.status).toBe(401);
    expect(r2.body.error).toBe('AUTH_REFRESH_REUSED');

    // The new refresh is now also revoked because we revoked the family.
    const r3 = await request(app).post('/v1/auth/refresh').send({ refreshToken: refresh2 });
    expect(r3.status).toBe(401);
  });

  it('logout revokes the access token immediately', async () => {
    const { app } = await getTestContext();
    await request(app)
      .post('/v1/admin/bootstrap')
      .set('x-bootstrap-secret', SECRET)
      .send({ email: EMAIL, password: PASSWORD });
    const signin = await request(app)
      .post('/v1/auth/signin')
      .send({ email: EMAIL, password: PASSWORD });
    const accessToken = signin.body.tokens.accessToken as string;

    const out = await request(app)
      .post('/v1/auth/logout')
      .set('authorization', `Bearer ${accessToken}`)
      .send({ scope: 'session' });
    expect(out.status).toBe(204);

    // Subsequent authenticated call → AUTH_TOKEN_REVOKED.
    const after = await request(app)
      .get('/v1/auth/mfa/status')
      .set('authorization', `Bearer ${accessToken}`);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('AUTH_TOKEN_REVOKED');
  });
});
