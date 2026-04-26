import { Router } from 'express';
import {
  livenessHandler,
  readinessHandler,
  deepHealthHandler,
} from './handlers/health.handler.js';
import { adminHandlerFactory } from './handlers/admin.handler.js';
import { authHandlerFactory } from './handlers/auth.handler.js';
import { workspaceHandlerFactory } from './handlers/workspace.handler.js';
import { publicPlansHandlerFactory } from './handlers/public-plans.handler.js';
import { billingHandlerFactory } from './handlers/billing.handler.js';
import { webhookHandlerFactory } from './handlers/webhooks.handler.js';
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

  // ─── Admin: Products & Gateways (Phase 3.3, SUPER_ADMIN) ────────────────
  router.post('/v1/admin/products', requireJwt, admin.createProduct);
  router.get('/v1/admin/products', requireJwt, admin.listProducts);
  router.get('/v1/admin/products/:id', requireJwt, admin.getProduct);
  router.patch('/v1/admin/products/:id', requireJwt, admin.updateProduct);
  router.patch('/v1/admin/products/:id/status', requireJwt, admin.setProductStatus);
  router.post('/v1/admin/products/:id/rotate-api-secret', requireJwt, admin.rotateApiSecret);
  router.post(
    '/v1/admin/products/:id/rotate-webhook-secret',
    requireJwt,
    admin.rotateWebhookSecret,
  );
  router.patch(
    '/v1/admin/products/:id/billing-config',
    requireJwt,
    admin.updateBillingConfig,
  );
  router.post('/v1/admin/products/:id/gateways', requireJwt, admin.addGateway);
  router.get('/v1/admin/products/:id/gateways', requireJwt, admin.listGateways);
  router.delete(
    '/v1/admin/products/:id/gateways/:gwId',
    requireJwt,
    admin.removeGateway,
  );

  // ─── Admin: Plans (Phase 3.4 — Flow D / AO) ────────────────────
  router.post('/v1/admin/products/:id/plans', requireJwt, admin.createPlan);
  router.get('/v1/admin/products/:id/plans', requireJwt, admin.listPlans);
  router.get('/v1/admin/products/:id/plans/:planId', requireJwt, admin.getPlan);
  router.patch('/v1/admin/products/:id/plans/:planId', requireJwt, admin.updatePlan);
  router.post('/v1/admin/products/:id/plans/:planId/publish', requireJwt, admin.publishPlan);
  router.post('/v1/admin/products/:id/plans/:planId/archive', requireJwt, admin.archivePlan);

  // ─── Public: Plans (no auth, cached 5min) ───────────────────────
  const publicPlans = publicPlansHandlerFactory(ctx);
  router.get('/v1/products/:slug/plans', publicPlans.listPublicPlans);

  // ─── Billing: Checkout (Phase 3.4 Wave 2 — Flow J1) ─────────────
  const billing = billingHandlerFactory(ctx);
  router.post('/v1/billing/checkout', requireJwt, billing.checkout);

  // ─── Webhooks (Phase 3.4 Wave 2 — Flow J1.6 / Wave 3 — Flow J4.8) ─
  const webhooks = webhookHandlerFactory(ctx);
  router.post('/v1/webhooks/stripe', webhooks.stripe);
  router.post('/v1/webhooks/sslcommerz', webhooks.sslcommerz);

  // ─── MFA (authenticated) ────────────────────────────────────────────────
  router.post('/v1/auth/mfa/enrol', requireJwt, auth.mfaEnrolStart);
  router.post('/v1/auth/mfa/enrol/verify', requireJwt, auth.mfaEnrolVerify);
  router.get('/v1/auth/mfa/status', requireJwt, auth.mfaStatus);
  router.post('/v1/auth/mfa/recovery-codes', requireJwt, auth.mfaRegenerateRecovery);

  // ─── Workspaces / Members / Invitations / Permissions (Phase 3.2) ──────
  const ws = workspaceHandlerFactory(ctx);
  router.post('/v1/workspaces', requireJwt, ws.create);
  router.get('/v1/workspaces', requireJwt, ws.list);
  router.get('/v1/workspaces/:id', requireJwt, ws.get);
  router.patch('/v1/workspaces/:id', requireJwt, ws.update);
  router.delete('/v1/workspaces/:id', requireJwt, ws.delete);
  router.post('/v1/workspaces/:id/restore', requireJwt, ws.restore);
  router.post('/v1/workspaces/:id/transfer-ownership', requireJwt, ws.transferOwnership);
  router.post('/v1/auth/switch-workspace', requireJwt, ws.switchWorkspace);

  router.get('/v1/workspaces/:id/members', requireJwt, ws.listMembers);
  router.patch('/v1/workspaces/:id/members/:userId', requireJwt, ws.changeMemberRole);
  router.delete('/v1/workspaces/:id/members/:userId', requireJwt, ws.removeMember);

  router.post('/v1/workspaces/:id/invitations', requireJwt, ws.createInvitation);
  router.get('/v1/workspaces/:id/invitations', requireJwt, ws.listInvitations);
  router.delete('/v1/workspaces/:id/invitations/:invId', requireJwt, ws.revokeInvitation);
  router.get('/v1/invitations/preview', ws.previewInvitation);
  router.post('/v1/invitations/accept', requireJwt, ws.acceptInvitation);
  router.post('/v1/invitations/accept-new', ws.acceptInvitationNew);

  router.post('/v1/permissions/check', requireJwt, ws.permissionsCheck);
  router.get('/v1/permissions/catalog', requireJwt, ws.permissionsCatalog);

  return router;
}
