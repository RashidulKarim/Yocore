import { Router } from 'express';
import {
  livenessHandler,
  readinessHandler,
  deepHealthHandler,
} from './handlers/health.handler.js';
import { adminHandlerFactory } from './handlers/admin.handler.js';
import { authHandlerFactory } from './handlers/auth.handler.js';
import { jwtAuthMiddleware } from './middleware/jwt-auth.js';
import { auditLogMiddleware } from './middleware/audit-log.js';
import type { AppContext } from './context.js';

export interface BuildRouterOptions {
  ctx: AppContext;
}

export function buildRouter(opts: BuildRouterOptions): Router {
  const router = Router();
  const { ctx } = opts;

  // Audit-log emitter is attached to every request so handlers can call req.audit().
  router.use(auditLogMiddleware({ store: ctx.auditStore }));

  // ─── Health ──────────────────────────────────────────────────────────────
  router.get('/v1/health', livenessHandler);
  router.get('/v1/health/ready', readinessHandler);
  router.get('/v1/health/deep', deepHealthHandler);

  // ─── Admin / bootstrap ──────────────────────────────────────────────────
  const admin = adminHandlerFactory(ctx);
  router.post('/v1/admin/bootstrap', admin.bootstrap);

  // ─── Auth (public) ──────────────────────────────────────────────────────
  const auth = authHandlerFactory(ctx);
  router.post('/v1/auth/signup', auth.signup);
  router.get('/v1/auth/verify-email', auth.verifyEmail);
  router.get('/v1/auth/confirm-join', auth.confirmJoin);
  router.post('/v1/auth/signin', auth.signin);
  router.post('/v1/auth/refresh', auth.refresh);
  router.post('/v1/auth/forgot-password', auth.forgotPassword);
  router.post('/v1/auth/reset-password', auth.resetPassword);
  router.get('/v1/auth/email/change-confirm', auth.emailChangeConfirm);
  router.post('/v1/email/unsubscribe', auth.emailUnsubscribe);
  router.get('/v1/email/unsubscribe', auth.emailUnsubscribe);
  router.post('/v1/auth/pkce/exchange', auth.pkceExchange);

  // ─── Auth (authenticated) ───────────────────────────────────────────────
  const requireJwt = jwtAuthMiddleware({
    keyring: ctx.keyring,
    sessionStore: ctx.sessionStore,
  });
  router.post('/v1/auth/logout', requireJwt, auth.logout);
  router.post('/v1/auth/finalize-onboarding', requireJwt, auth.finalizeOnboarding);
  router.post('/v1/auth/email/change-request', requireJwt, auth.emailChangeRequest);
  router.get('/v1/users/me/email-preferences', requireJwt, auth.emailPrefsGet);
  router.patch('/v1/users/me/email-preferences', requireJwt, auth.emailPrefsPatch);

  // ─── MFA (authenticated) ────────────────────────────────────────────────
  router.post('/v1/auth/mfa/enrol', requireJwt, auth.mfaEnrolStart);
  router.post('/v1/auth/mfa/enrol/verify', requireJwt, auth.mfaEnrolVerify);
  router.get('/v1/auth/mfa/status', requireJwt, auth.mfaStatus);
  router.post('/v1/auth/mfa/recovery-codes', requireJwt, auth.mfaRegenerateRecovery);

  return router;
}
