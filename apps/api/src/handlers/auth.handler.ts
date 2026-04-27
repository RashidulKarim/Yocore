/**
 * Auth handlers — sign-in, refresh, sign-out, MFA enrol/verify, MFA status.
 *
 * Layer rule: handlers parse + validate, call exactly one service, format the
 * response. They never touch Mongo. They emit audit logs via `req.audit`.
 */
import type { Request, Response, RequestHandler } from 'express';
import {
  signinRequestSchema,
  refreshRequestSchema,
  logoutRequestSchema,
  mfaEnrolVerifyRequestSchema,
  signupRequestSchema,
  verifyEmailRequestSchema,
  finalizeOnboardingRequestSchema,
  confirmJoinRequestSchema,
  forgotPasswordRequestSchema,
  resetPasswordRequestSchema,
  emailChangeRequestSchema,
  emailChangeConfirmRequestSchema,
  emailPreferencesPatchSchema,
  unsubscribeRequestSchema,
  exchangeRequestSchema,
  authorizeRequestSchema,
} from '@yocore/types';
import { AppError, ErrorCode } from '../lib/errors.js';
import { signinDuration } from '../lib/metrics.js';
import * as mfaService from '../services/mfa.service.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import { finalizeOnboarding as finalizeOnboardingService } from '../services/finalize-onboarding.service.js';
import { requireAuth, requireSuperAdmin } from '../middleware/jwt-auth.js';
import { asyncHandler } from './index.js';
import type { AppContext } from '../context.js';

export interface AuthHandlers {
  signup: RequestHandler;
  verifyEmail: RequestHandler;
  confirmJoin: RequestHandler;
  finalizeOnboarding: RequestHandler;
  signin: RequestHandler;
  refresh: RequestHandler;
  logout: RequestHandler;
  forgotPassword: RequestHandler;
  resetPassword: RequestHandler;
  emailChangeRequest: RequestHandler;
  emailChangeConfirm: RequestHandler;
  emailPrefsGet: RequestHandler;
  emailPrefsPatch: RequestHandler;
  emailUnsubscribe: RequestHandler;
  pkceIssue: RequestHandler;
  pkceExchange: RequestHandler;
  mfaEnrolStart: RequestHandler;
  mfaEnrolVerify: RequestHandler;
  mfaStatus: RequestHandler;
  mfaRegenerateRecovery: RequestHandler;
}

export function authHandlerFactory(ctx: AppContext): AuthHandlers {
  return {
    signup: asyncHandler(async (req: Request, res: Response) => {
      const body = signupRequestSchema.parse(req.body);
      const outcome = await ctx.signup.signup({
        email: body.email,
        password: body.password,
        productSlug: body.productSlug,
        name: body.name,
        marketingOptIn: body.marketingOptIn,
        ip: req.ip ?? null,
        acceptedTosVersion: body.acceptedTosVersion,
        acceptedPrivacyVersion: body.acceptedPrivacyVersion,
      });

      // Audit only when something was actually created. The fixed response
      // shape preserves FIX-AUTH-TIMING.
      if (outcome.created) {
        await req.audit?.({
          action: 'user.created',
          outcome: 'success',
          productId: outcome.created.productId,
          resource: { type: 'user', id: outcome.created.userId },
          actor: { type: 'system' },
        });
      }

      res.status(202).json({ status: outcome.status });
    }),
    verifyEmail: asyncHandler(async (req: Request, res: Response) => {
      // Token arrives in the query string from email links.
      const { token } = verifyEmailRequestSchema.parse(req.query);
      const outcome = await ctx.verifyEmail.verifyEmail({
        token,
        device: { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
      });

      await req.audit?.({
        action: outcome.alreadyVerified
          ? 'user.email_verified.replay'
          : 'user.email_verified',
        outcome: 'success',
        productId: outcome.productId,
        resource: { type: 'user', id: outcome.userId },
        actor: { type: 'user', id: outcome.userId },
      });

      res.status(200).json({
        status: 'verified',
        alreadyVerified: outcome.alreadyVerified,
        userId: outcome.userId,
        productId: outcome.productId,
        onboarded: outcome.onboarded,
        tokens: outcome.tokens,
      });
    }),

    finalizeOnboarding: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      if (auth.role !== 'END_USER' || !auth.productId) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'Onboarding requires an end-user session scoped to a product',
        );
      }
      const body = finalizeOnboardingRequestSchema.parse(req.body);
      const outcome = await finalizeOnboardingService({
        userId: auth.userId,
        productId: auth.productId,
        workspaceName: body.workspaceName,
        ...(body.workspaceSlug !== undefined ? { workspaceSlug: body.workspaceSlug } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
        ...(body.dateFormat !== undefined ? { dateFormat: body.dateFormat } : {}),
        ...(body.timeFormat !== undefined ? { timeFormat: body.timeFormat } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.acceptedTosVersion !== undefined
          ? { acceptedTosVersion: body.acceptedTosVersion }
          : {}),
        ...(body.acceptedPrivacyVersion !== undefined
          ? { acceptedPrivacyVersion: body.acceptedPrivacyVersion }
          : {}),
      });

      await req.audit?.({
        action: 'workspace.created',
        outcome: 'success',
        productId: auth.productId,
        resource: { type: 'workspace', id: outcome.workspace.id },
        actor: { type: 'user', id: auth.userId },
      });

      res.status(201).json(outcome);
    }),
    signin: asyncHandler(async (req: Request, res: Response) => {
      const body = signinRequestSchema.parse(req.body);
      const start = process.hrtime.bigint();
      let outcomeLabel = 'failed';
      try {
        const result = await ctx.auth.signin({
        email: body.email,
        password: body.password,
        ...(body.productSlug !== undefined ? { productSlug: body.productSlug } : {}),
        ...(body.mfaChallengeId !== undefined ? { mfaChallengeId: body.mfaChallengeId } : {}),
        ...(body.mfaCode !== undefined ? { mfaCode: body.mfaCode } : {}),
        rememberMe: body.rememberMe ?? false,
        device: {
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        },
      });

      if (result.kind === 'mfa_required') {
        outcomeLabel = 'mfa_required';
        await req.audit?.({
          action: 'auth.signin.mfa_required',
          outcome: 'success',
          metadata: { email: body.email },
          actor: { type: 'system' },
        });
        res.status(200).json({
          status: 'mfa_required',
          mfaChallengeId: result.mfaChallengeId,
          factors: result.factors,
        });
        return;
      }

      await req.audit?.({
        action: 'auth.signin',
        outcome: 'success',
        resource: { type: 'user', id: result.userId },
        actor: { type: result.role === 'SUPER_ADMIN' ? 'super_admin' : 'user', id: result.userId },
      });

      res.status(200).json({
        status: 'signed_in',
        userId: result.userId,
        role: result.role,
        productId: result.productId,
        tokens: result.tokens,
      });
      outcomeLabel = 'success';
      } finally {
        const dur = Number(process.hrtime.bigint() - start) / 1e9;
        signinDuration.labels(outcomeLabel).observe(dur);
      }
    }),

    refresh: asyncHandler(async (req: Request, res: Response) => {
      const body = refreshRequestSchema.parse(req.body);
      const tokens = await ctx.auth.refresh(body.refreshToken);
      res.status(200).json(tokens);
    }),

    logout: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const body = logoutRequestSchema.parse(req.body ?? {});
      await ctx.auth.signout({
        jti: auth.jti,
        userId: auth.userId,
        scope: body.scope ?? 'session',
      });
      await req.audit?.({
        action: body.scope === 'all' ? 'auth.logout.all' : 'auth.logout',
        outcome: 'success',
        resource: { type: 'user', id: auth.userId },
      });
      res.status(204).end();
    }),

    // ─── MFA ─────────────────────────────────────────────────────────────────

    mfaEnrolStart: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const result = await mfaService.startTotpEnrolment({
        userId: auth.userId,
        productId: auth.productId,
        accountLabel: auth.userId, // Phase 3 will replace with email lookup once enriched
      });
      await req.audit?.({
        action: 'mfa.enrol.start',
        outcome: 'success',
        resource: { type: 'user', id: auth.userId },
      });
      res.status(200).json(result);
    }),

    mfaEnrolVerify: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const body = mfaEnrolVerifyRequestSchema.parse(req.body);
      const result = await mfaService.verifyTotpEnrolment({
        userId: auth.userId,
        productId: auth.productId,
        enrolmentId: body.enrolmentId,
        code: body.code,
      });
      await req.audit?.({
        action: 'mfa.enrol.verify',
        outcome: 'success',
        resource: { type: 'user', id: auth.userId },
      });
      res.status(200).json({ enrolled: true, recoveryCodes: result.recoveryCodes });
    }),

    mfaStatus: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const enrolled = await mfaService.isMfaEnrolled(auth.userId, auth.productId);
      const remaining = enrolled
        ? await mfaService.countUnusedRecovery(auth.userId, auth.productId)
        : 0;
      res.status(200).json({
        enrolled,
        type: enrolled ? 'totp' : null,
        enrolledAt: null, // populated when we read the verifiedAt — Phase 3 enrichment
        recoveryCodesRemaining: remaining,
      });
    }),

    mfaRegenerateRecovery: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireSuperAdmin(req);
      const codes = await mfaService.regenerateRecoveryCodes(auth.userId, auth.productId);
      await req.audit?.({
        action: 'mfa.recovery.regenerate',
        outcome: 'success',
        resource: { type: 'user', id: auth.userId },
      });
      res.status(200).json({ recoveryCodes: codes });
    }),

    confirmJoin: asyncHandler(async (req: Request, res: Response) => {
      const { token } = confirmJoinRequestSchema.parse(req.query);
      const outcome = await ctx.confirmJoin.confirmJoin({
        token,
        device: { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
      });
      await req.audit?.({
        action: outcome.alreadyJoined ? 'user.product_join.replay' : 'user.product_join',
        outcome: 'success',
        productId: outcome.productId,
        resource: { type: 'user', id: outcome.userId },
        actor: { type: 'user', id: outcome.userId },
      });
      res.status(200).json({
        status: 'joined',
        alreadyJoined: outcome.alreadyJoined,
        userId: outcome.userId,
        productId: outcome.productId,
        onboarded: outcome.onboarded,
        tokens: outcome.tokens,
      });
    }),

    forgotPassword: asyncHandler(async (req: Request, res: Response) => {
      const body = forgotPasswordRequestSchema.parse(req.body);
      const outcome = await ctx.passwordReset.request({
        email: body.email,
        ...(body.productSlug !== undefined ? { productSlug: body.productSlug } : {}),
        ip: req.ip ?? null,
      });
      // No audit: not a state change visible to the user, and we cannot
      // attribute to a userId without leaking existence.
      res.status(202).json(outcome);
    }),

    resetPassword: asyncHandler(async (req: Request, res: Response) => {
      const body = resetPasswordRequestSchema.parse(req.body);
      const outcome = await ctx.passwordReset.reset({
        token: body.token,
        password: body.password,
      });
      await req.audit?.({
        action: 'auth.password_reset',
        outcome: 'success',
        actor: { type: 'system' },
      });
      res.status(200).json(outcome);
    }),

    emailChangeRequest: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      const body = emailChangeRequestSchema.parse(req.body);
      const outcome = await ctx.emailChange.request({
        userId: auth.userId,
        productId: auth.productId,
        newEmail: body.newEmail,
        password: body.password,
        ip: req.ip ?? null,
      });
      await req.audit?.({
        action: 'auth.email_change.request',
        outcome: 'success',
        resource: { type: 'user', id: auth.userId },
      });
      res.status(202).json(outcome);
    }),

    emailChangeConfirm: asyncHandler(async (req: Request, res: Response) => {
      const { token } = emailChangeConfirmRequestSchema.parse(req.query);
      const outcome = await ctx.emailChange.confirm({ token });
      await req.audit?.({
        action: 'auth.email_change.confirm',
        outcome: 'success',
        actor: { type: 'system' },
      });
      res.status(200).json(outcome);
    }),

    emailPrefsGet: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'Email preferences require a product-scoped session',
        );
      }
      const pu = await productUserRepo.findByUserAndProduct(auth.productId, auth.userId);
      if (!pu) throw new AppError(ErrorCode.NOT_FOUND, 'Product user not found');
      res.status(200).json({
        emailPreferences: pu.emailPreferences ?? {
          marketing: false,
          productUpdates: true,
          billing: true,
          security: true,
        },
      });
    }),

    emailPrefsPatch: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'Email preferences require a product-scoped session',
        );
      }
      const patch = emailPreferencesPatchSchema.parse(req.body);
      const outcome = await ctx.emailPrefs.patch({
        userId: auth.userId,
        productId: auth.productId,
        patch,
      });
      await req.audit?.({
        action: 'user.email_prefs.update',
        outcome: 'success',
        productId: auth.productId,
        resource: { type: 'user', id: auth.userId },
      });
      res.status(200).json(outcome);
    }),

    emailUnsubscribe: asyncHandler(async (req: Request, res: Response) => {
      // Accept body OR query for RFC 8058 List-Unsubscribe-Post tolerance.
      const source = (req.body && Object.keys(req.body).length > 0 ? req.body : req.query) as Record<string, unknown>;
      const { token } = unsubscribeRequestSchema.parse(source);
      const outcome = await ctx.emailPrefs.unsubscribe(token);
      res.status(200).json(outcome);
    }),

    pkceIssue: asyncHandler(async (req: Request, res: Response) => {
      // Caller is an authenticated user (typically the hosted auth-web). We
      // mint a one-time PKCE auth code bound to their session.
      const auth = requireAuth(req);
      const body = authorizeRequestSchema.parse(req.body);
      // Resolve product by slug — service expects productId.
      const productRepo = await import('../repos/product.repo.js');
      const product = await productRepo.findProductBySlug(body.productSlug);
      if (!product || product.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
      }
      const issued = await ctx.pkce.issueCode({
        userId: auth.userId,
        productId: product._id,
        redirectUri: body.redirectUri,
        codeChallenge: body.codeChallenge,
        codeChallengeMethod: body.codeChallengeMethod,
      });
      await req.audit?.({
        action: 'auth.pkce.issued',
        outcome: 'success',
        productId: product._id,
        resource: { type: 'user', id: auth.userId },
      });
      res.status(200).json({
        code: issued.code,
        state: body.state,
        expiresAt: issued.expiresAt.toISOString(),
      });
    }),

    pkceExchange: asyncHandler(async (req: Request, res: Response) => {
      const body = exchangeRequestSchema.parse(req.body);
      const outcome = await ctx.pkce.exchange({
        code: body.code,
        codeVerifier: body.codeVerifier,
        redirectUri: body.redirectUri,
        device: { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
      });
      await req.audit?.({
        action: 'auth.pkce.exchange',
        outcome: 'success',
        productId: outcome.productId,
        resource: { type: 'user', id: outcome.userId },
      });
      res.status(200).json({
        status: 'exchanged',
        userId: outcome.userId,
        productId: outcome.productId,
        tokens: outcome.tokens,
      });
    }),
  };
}

// re-export AppError so consumers can throw at the route boundary if needed
export { AppError, ErrorCode };
