import { describe, it, expect } from 'vitest';
import {
  bootstrapRequestSchema,
  signinRequestSchema,
  signinResponseSchema,
  refreshRequestSchema,
  mfaEnrolVerifyRequestSchema,
  signupRequestSchema,
} from './auth.js';

describe('auth schemas', () => {
  describe('bootstrapRequestSchema', () => {
    it('accepts a strong password and lowercases the email', () => {
      const out = bootstrapRequestSchema.parse({
        email: '  Admin@YoCore.io ',
        password: 'StrongP@ssw0rd!',
      });
      expect(out.email).toBe('admin@yocore.io');
      expect(out.password).toBe('StrongP@ssw0rd!');
    });

    it('rejects weak passwords', () => {
      expect(() =>
        bootstrapRequestSchema.parse({ email: 'a@b.io', password: 'weakpass' }),
      ).toThrow();
      expect(() =>
        bootstrapRequestSchema.parse({ email: 'a@b.io', password: 'NoNumbers!!' }),
      ).toThrow();
      expect(() =>
        bootstrapRequestSchema.parse({ email: 'a@b.io', password: 'NoSymbols123' }),
      ).toThrow();
    });
  });

  describe('signinRequestSchema', () => {
    it('defaults rememberMe to false', () => {
      const out = signinRequestSchema.parse({
        email: 'user@example.com',
        password: 'whatever',
      });
      expect(out.rememberMe).toBe(false);
    });

    it('accepts an MFA challenge follow-up', () => {
      const out = signinRequestSchema.parse({
        email: 'user@example.com',
        password: 'x',
        mfaChallengeId: 'mfac_abc',
        mfaCode: '123456',
      });
      expect(out.mfaChallengeId).toBe('mfac_abc');
    });
  });

  describe('signinResponseSchema', () => {
    it('parses the signed_in branch', () => {
      const ok = signinResponseSchema.parse({
        status: 'signed_in',
        userId: 'usr_1',
        role: 'SUPER_ADMIN',
        productId: null,
        tokens: {
          accessToken: 'at',
          refreshToken: 'rt',
          expiresIn: 900,
          tokenType: 'Bearer',
        },
      });
      expect(ok.status).toBe('signed_in');
    });

    it('parses the mfa_required branch', () => {
      const ok = signinResponseSchema.parse({
        status: 'mfa_required',
        mfaChallengeId: 'mfac_xyz',
        factors: ['totp', 'recovery_code'],
      });
      expect(ok.status).toBe('mfa_required');
    });
  });

  describe('refreshRequestSchema', () => {
    it('rejects short tokens', () => {
      expect(() => refreshRequestSchema.parse({ refreshToken: 'short' })).toThrow();
    });
  });

  describe('mfaEnrolVerifyRequestSchema', () => {
    it('only accepts digit codes', () => {
      expect(() =>
        mfaEnrolVerifyRequestSchema.parse({ enrolmentId: 'enr_1', code: 'abcdef' }),
      ).toThrow();
      const ok = mfaEnrolVerifyRequestSchema.parse({ enrolmentId: 'enr_1', code: '123456' });
      expect(ok.code).toBe('123456');
    });
  });

  describe('signupRequestSchema', () => {
    it('lower-cases email + product slug and defaults marketingOptIn', () => {
      const out = signupRequestSchema.parse({
        email: ' Foo@Bar.IO ',
        password: 'StrongP@ssw0rd!',
        productSlug: ' YoPM ',
      });
      expect(out.email).toBe('foo@bar.io');
      expect(out.productSlug).toBe('yopm');
      expect(out.marketingOptIn).toBe(false);
    });

    it('rejects malformed product slugs', () => {
      expect(() =>
        signupRequestSchema.parse({
          email: 'a@b.io',
          password: 'StrongP@ssw0rd!',
          productSlug: '-leading',
        }),
      ).toThrow();
    });

    it('rejects weak passwords (FIX-AUTH-TIMING precondition)', () => {
      expect(() =>
        signupRequestSchema.parse({
          email: 'a@b.io',
          password: 'weak',
          productSlug: 'yopm',
        }),
      ).toThrow();
    });

    it('accepts an optional name pair', () => {
      const out = signupRequestSchema.parse({
        email: 'a@b.io',
        password: 'StrongP@ssw0rd!',
        productSlug: 'yopm',
        name: { first: 'Ada', last: 'Lovelace' },
      });
      expect(out.name?.first).toBe('Ada');
    });
  });
});
