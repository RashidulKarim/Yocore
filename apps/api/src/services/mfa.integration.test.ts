/**
 * Unit tests for `mfa.service`. Uses a per-test in-memory mongoose connection
 * (re-uses the integration MongoMemoryReplSet) so the repos exercise real
 * Mongo behaviour for indexes (the partial-unique TOTP index in particular).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { authenticator } from 'otplib';
import { MfaFactor } from '../db/models/MfaFactor.js';
import * as mfaService from './mfa.service.js';
import { AppError } from '../lib/errors.js';
import { resetDatabase } from '../../test/integration-setup.js';

describe('mfa.service', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('startTotpEnrolment creates a pending row and returns secret + uri', async () => {
    const out = await mfaService.startTotpEnrolment({
      userId: 'usr_1',
      productId: null,
      accountLabel: 'admin@yocore.io',
    });
    expect(out.enrolmentId).toMatch(/^mfa_/);
    expect(out.otpauthUri).toContain('otpauth://totp/');
    expect(out.secret).toMatch(/^[A-Z2-7]+$/);

    const row = await MfaFactor.findById(out.enrolmentId).lean();
    expect(row).not.toBeNull();
    expect(row!.verifiedAt).toBeNull();
  });

  it('startTotpEnrolment refuses if a verified TOTP already exists', async () => {
    const a = await mfaService.startTotpEnrolment({
      userId: 'usr_2',
      productId: null,
      accountLabel: 'a@b.io',
    });
    await mfaService.verifyTotpEnrolment({
      userId: 'usr_2',
      productId: null,
      enrolmentId: a.enrolmentId,
      code: authenticator.generate(a.secret),
    });

    await expect(
      mfaService.startTotpEnrolment({ userId: 'usr_2', productId: null, accountLabel: 'a@b.io' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('verifyTotpEnrolment rejects bad codes', async () => {
    const a = await mfaService.startTotpEnrolment({
      userId: 'usr_3',
      productId: null,
      accountLabel: 'a@b.io',
    });
    await expect(
      mfaService.verifyTotpEnrolment({
        userId: 'usr_3',
        productId: null,
        enrolmentId: a.enrolmentId,
        code: '000000',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('verifyMfaCode accepts a recovery code exactly once', async () => {
    const a = await mfaService.startTotpEnrolment({
      userId: 'usr_4',
      productId: null,
      accountLabel: 'a@b.io',
    });
    const v = await mfaService.verifyTotpEnrolment({
      userId: 'usr_4',
      productId: null,
      enrolmentId: a.enrolmentId,
      code: authenticator.generate(a.secret),
    });
    const code = v.recoveryCodes[0]!;
    await mfaService.verifyMfaCode({ userId: 'usr_4', productId: null, code });
    await expect(
      mfaService.verifyMfaCode({ userId: 'usr_4', productId: null, code }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('regenerateRecoveryCodes wipes old + issues 10 new', async () => {
    const a = await mfaService.startTotpEnrolment({
      userId: 'usr_5',
      productId: null,
      accountLabel: 'a@b.io',
    });
    const v = await mfaService.verifyTotpEnrolment({
      userId: 'usr_5',
      productId: null,
      enrolmentId: a.enrolmentId,
      code: authenticator.generate(a.secret),
    });
    const oldCode = v.recoveryCodes[0]!;
    const fresh = await mfaService.regenerateRecoveryCodes('usr_5', null);
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(oldCode);
    // Old code no longer valid.
    await expect(
      mfaService.verifyMfaCode({ userId: 'usr_5', productId: null, code: oldCode }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
