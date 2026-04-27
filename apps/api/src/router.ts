import { Router } from 'express';
import {
  livenessHandler,
  readinessHandler,
  deepHealthHandler,
} from './handlers/health.handler.js';
import { adminHandlerFactory } from './handlers/admin.handler.js';
import { adminOpsHandlerFactory } from './handlers/admin-ops.handler.js';
import { meHandlerFactory } from './handlers/me.handler.js';
import { entitlementsHandlerFactory } from './handlers/entitlements.handler.js';
import { adminListingsHandlerFactory } from './handlers/admin-listings.handler.js';
import { authHandlerFactory } from './handlers/auth.handler.js';
import { workspaceHandlerFactory } from './handlers/workspace.handler.js';
import { publicPlansHandlerFactory } from './handlers/public-plans.handler.js';
import { billingHandlerFactory } from './handlers/billing.handler.js';
import { webhookHandlerFactory } from './handlers/webhooks.handler.js';
import { jwtAuthMiddleware } from './middleware/jwt-auth.js';
import { auditLogMiddleware } from './middleware/audit-log.js';
import * as tosService from './services/tos.service.js';
import { buildOpenApiDocument } from './openapi.js';
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

  // ─── OpenAPI ───────────────────────────────────────────────────────────
  router.get('/v1/openapi.json', (_req, res) => {
    res.json(buildOpenApiDocument());
  });

  // ─── ToS / Privacy (public) ─────────────────────────────────────────────
  router.get('/v1/tos/current', async (_req, res, next) => {
    try {
      const current = await tosService.getCurrent();
      const map = (d: typeof current.termsOfService) =>
        d
          ? {
              version: d.version,
              effectiveAt: d.effectiveAt.toISOString(),
              contentUrl: d.contentUrl,
              contentHash: d.contentHash,
            }
          : null;
      res.json({
        termsOfService: map(current.termsOfService),
        privacyPolicy: map(current.privacyPolicy),
      });
    } catch (err) {
      next(err);
    }
  });

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
  router.post('/v1/auth/pkce/issue', requireJwt, auth.pkceIssue);
  router.post('/v1/auth/finalize-onboarding', requireJwt, auth.finalizeOnboarding);
  router.post('/v1/auth/email/change-request', requireJwt, auth.emailChangeRequest);
  router.get('/v1/users/me/email-preferences', requireJwt, auth.emailPrefsGet);
  router.patch('/v1/users/me/email-preferences', requireJwt, auth.emailPrefsPatch);

  // ─── Admin: Products & Gateways (Phase 3.3, SUPER_ADMIN) ────────────────
  router.post('/v1/admin/products', requireJwt, admin.createProduct);
  router.get('/v1/admin/products', requireJwt, admin.listProducts);
  router.get('/v1/admin/products/:id', requireJwt, admin.getProduct);
  router.patch('/v1/admin/products/:id', requireJwt, admin.updateProduct);
  router.post('/v1/admin/products/:id/status', requireJwt, admin.setProductStatus);
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

  // ── Coupons (Phase 3.4 Wave 8) ─────────────────────────────────────
  router.post('/v1/admin/products/:id/coupons', requireJwt, admin.createCoupon);
  router.get('/v1/admin/products/:id/coupons', requireJwt, admin.listCoupons);
  router.post(
    '/v1/admin/products/:id/coupons/:couponId/disable',
    requireJwt,
    admin.disableCoupon,
  );
  router.delete(
    '/v1/admin/products/:id/coupons/:couponId',
    requireJwt,
    admin.deleteCoupon,
  );
  // ── Refund (Phase 3.4 Wave 9) ───────────────────────────────────────
  router.post('/v1/admin/products/:id/refund', requireJwt, admin.refundSubscription);

  // ── Bundles (Phase 3.5 — Flow AL) ───────────────────────────────────
  router.post('/v1/admin/bundles', requireJwt, admin.createBundle);
  router.get('/v1/admin/bundles', requireJwt, admin.listBundles);
  router.get('/v1/admin/bundles/:id', requireJwt, admin.getBundle);
  router.patch('/v1/admin/bundles/:id', requireJwt, admin.updateBundle);
  router.post('/v1/admin/bundles/:id/publish', requireJwt, admin.publishBundle);
  router.post('/v1/admin/bundles/:id/archive', requireJwt, admin.archiveBundle);
  router.delete('/v1/admin/bundles/:id', requireJwt, admin.deleteBundle);
  router.get('/v1/admin/bundles/:id/preview', requireJwt, admin.previewBundle);
  router.post('/v1/admin/bundles/:id/grant-access', requireJwt, admin.grantBundleAccess);
  // V1.1-B Flow AM
  router.post('/v1/admin/bundles/:id/swap-component', requireJwt, admin.swapBundleComponent);

  // ─── Public: Plans (no auth, cached 5min) ───────────────────────
  const publicPlans = publicPlansHandlerFactory(ctx);
  router.get('/v1/products/:slug/plans', publicPlans.listPublicPlans);

  // ─── Billing: Checkout (Phase 3.4 Wave 2 — Flow J1) ─────────────
  const billing = billingHandlerFactory(ctx);
  router.post('/v1/billing/checkout', requireJwt, billing.checkout);
  router.post('/v1/billing/trial/start', requireJwt, billing.startTrial);
  router.get(
    '/v1/billing/subscription/change-plan/preview',
    requireJwt,
    billing.previewChangePlan,
  );
  router.post(
    '/v1/billing/subscription/change-plan',
    requireJwt,
    billing.applyChangePlan,
  );
  // ── Wave 6: change seats ─────────────────────────────────────────────
  router.post('/v1/billing/subscription/seats', requireJwt, billing.changeSeats);
  // ── Wave 7: pause/resume ─────────────────────────────────────────────
  router.post('/v1/billing/subscription/pause', requireJwt, billing.pauseSubscription);
  router.post('/v1/billing/subscription/resume', requireJwt, billing.resumeSubscription);
  // ── Wave 8: validate coupon (customer-facing) ───────────────────────
  router.get('/v1/billing/coupons/validate', requireJwt, billing.validateCoupon);
  // ── Wave 10: gateway migration ─────────────────────────────────────
  router.post(
    '/v1/billing/subscription/migrate-gateway',
    requireJwt,
    billing.gatewayMigrate,
  );
  // ── Wave 12: invoices ────────────────────────────────────────────────
  router.get('/v1/billing/invoices', requireJwt, billing.listInvoices);
  // ── Wave 13: tax profile ─────────────────────────────────────────────
  router.get('/v1/billing/tax-profile', requireJwt, billing.getTaxProfile);
  router.put('/v1/billing/tax-profile', requireJwt, billing.upsertTaxProfile);

  // ── Bundle checkout + cancel (Phase 3.5 — Flow T / AK) ──────────────
  router.post('/v1/billing/bundle-checkout', requireJwt, billing.bundleCheckout);
  router.post(
    '/v1/billing/bundles/:id/cancel',
    requireJwt,
    billing.cancelBundleSubscription,
  );
  // V1.1-B Flow AN — Path A (standalone → bundle)
  router.post(
    '/v1/billing/subscription/migrate-to-bundle',
    requireJwt,
    billing.migrateToBundle,
  );
  // V1.1-B Flow AN — Path B (bundle → standalone)
  router.post(
    '/v1/billing/bundles/:id/downgrade-to-standalone',
    requireJwt,
    billing.downgradeToStandalone,
  );

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

  // ─── Admin Ops (Super-Admin) — V1.0-B/C/D ──────────────────────────────
  const adminOps = adminOpsHandlerFactory(ctx);
  router.post(
    '/v1/admin/products/:productId/subscriptions/:id/force-status',
    requireJwt,
    adminOps.forceSubscriptionStatus,
  );
  router.post(
    '/v1/admin/products/:productId/subscriptions/:id/apply-credit',
    requireJwt,
    adminOps.applySubscriptionCredit,
  );
  router.get('/v1/admin/cron/status', requireJwt, adminOps.cronStatus);
  router.post('/v1/admin/cron/run', requireJwt, adminOps.forceCronRun);
  router.get('/v1/admin/webhook-deliveries', requireJwt, adminOps.listWebhookDeliveries);
  router.post(
    '/v1/admin/webhook-deliveries/:id/retry',
    requireJwt,
    adminOps.retryWebhookDelivery,
  );
  router.post('/v1/admin/jwt/rotate-key', requireJwt, adminOps.rotateJwtKey);
  router.get('/v1/admin/super-admin/config', requireJwt, adminOps.getSuperAdminConfig);
  router.patch(
    '/v1/admin/super-admin/config',
    requireJwt,
    adminOps.updateSuperAdminConfig,
  );
  router.post('/v1/admin/tos', requireJwt, adminOps.publishTosVersion);
  router.get('/v1/admin/tos', requireJwt, adminOps.listTosVersions);
  // V1.1-A: deliverability manual reset
  router.post(
    '/v1/admin/users/:id/email-deliverability/reset',
    requireJwt,
    adminOps.resetEmailDeliverability,
  );
  // V1.1-C admin: trial / grace extension + audit-log export
  router.post(
    '/v1/admin/products/:productId/subscriptions/:id/extend-trial',
    requireJwt,
    adminOps.extendTrial,
  );
  router.post(
    '/v1/admin/products/:productId/subscriptions/:id/extend-grace',
    requireJwt,
    adminOps.extendGrace,
  );
  router.get('/v1/admin/audit-log/export', requireJwt, adminOps.exportAuditLog);

  // V1.1-D admin listings + announcements
  const adminList = adminListingsHandlerFactory();
  router.get(
    '/v1/admin/products/:productId/users',
    requireJwt,
    adminList.listProductUsers,
  );
  router.get(
    '/v1/admin/products/:productId/users/:userId',
    requireJwt,
    adminList.getProductUserDetail,
  );
  router.get(
    '/v1/admin/products/:productId/workspaces',
    requireJwt,
    adminList.listProductWorkspaces,
  );
  router.get(
    '/v1/admin/products/:productId/workspaces/:workspaceId',
    requireJwt,
    adminList.getWorkspaceDetail,
  );
  router.get('/v1/admin/users/search', requireJwt, adminList.searchAllUsers);
  router.get('/v1/admin/announcements', requireJwt, adminList.listAnnouncements);
  router.post('/v1/admin/announcements', requireJwt, adminList.createAnnouncement);
  router.patch(
    '/v1/admin/announcements/:id',
    requireJwt,
    adminList.updateAnnouncement,
  );
  router.post(
    '/v1/admin/announcements/:id/publish',
    requireJwt,
    adminList.publishAnnouncement,
  );
  router.post(
    '/v1/admin/announcements/:id/archive',
    requireJwt,
    adminList.archiveAnnouncement,
  );

  // ─── Me / self-service (V1.0-B) ───────────────────────────────────────
  const me = meHandlerFactory(ctx);
  router.delete('/v1/users/me', requireJwt, me.requestDeletion);
  router.post('/v1/users/me/cancel-deletion', requireJwt, me.cancelDeletion);
  router.get('/v1/users/me/deletion-requests', requireJwt, me.listMyDeletionRequests);
  router.get('/v1/sessions', requireJwt, me.listSessions);
  router.delete('/v1/sessions/:id', requireJwt, me.revokeSession);
  // ─── Data export (V1.1-A / Flow W) ───────────────────────────────────
  router.post('/v1/users/me/data-export', requireJwt, me.requestDataExport);
  router.get('/v1/users/me/data-exports', requireJwt, me.listDataExports);
  router.get(
    '/v1/users/me/data-exports/:id/download',
    requireJwt,
    me.downloadDataExport,
  );
  // V1.1-C: MFA status (Addendum #6)
  router.get('/v1/users/me/mfa/status', requireJwt, me.getMfaStatus);
  // V1.1-C: Entitlements (Addendum #7)
  const entitlements = entitlementsHandlerFactory();
  router.get('/v1/entitlements/:workspaceId', requireJwt, entitlements.getEntitlements);

  return router;
}
