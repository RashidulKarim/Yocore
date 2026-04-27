/**
 * Billing handlers — Phase 3.4 Wave 2 (Flow J1).
 *
 * - `POST /v1/billing/checkout` — initiate a subscribe flow. Returns the
 *   provider's hosted-checkout URL. Requires Idempotency-Key header (mounted
 *   in router) and the user must be authenticated + scoped to a product.
 */
import type { RequestHandler } from 'express';
import {
  checkoutRequestSchema,
  startTrialRequestSchema,
  changePlanRequestSchema,
  changePlanPreviewQuerySchema,
  changeSeatsRequestSchema,
  pauseSubscriptionRequestSchema,
  resumeSubscriptionRequestSchema,
  validateCouponQuerySchema,
  gatewayMigrateRequestSchema,
  listInvoicesQuerySchema,
  upsertTaxProfileRequestSchema,
  bundleCheckoutRequestSchema,
} from '@yocore/types';
import { AppError, ErrorCode } from '../lib/errors.js';
import { requireAuth } from '../middleware/jwt-auth.js';
import { asyncHandler } from './index.js';
import * as userRepo from '../repos/user.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as invoiceRepo from '../repos/invoice.repo.js';
import * as productRepo from '../repos/product.repo.js';
import type { AppContext } from '../context.js';

export interface BillingHandlers {
  checkout: RequestHandler;
  startTrial: RequestHandler;
  previewChangePlan: RequestHandler;
  applyChangePlan: RequestHandler;
  changeSeats: RequestHandler;
  pauseSubscription: RequestHandler;
  resumeSubscription: RequestHandler;
  validateCoupon: RequestHandler;
  gatewayMigrate: RequestHandler;
  listInvoices: RequestHandler;
  getTaxProfile: RequestHandler;
  upsertTaxProfile: RequestHandler;
  bundleCheckout: RequestHandler;
  cancelBundleSubscription: RequestHandler;
}

export function billingHandlerFactory(ctx: AppContext): BillingHandlers {
  return {
    checkout: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Checkout requires a product-scoped session',
        );
      }
      const body = checkoutRequestSchema.parse(req.body);

      // Pull email + display name for Stripe customer creation.
      const user = await userRepo.findUserById(auth.userId);
      const productUser = await productUserRepo.findByUserAndProduct(
        auth.productId,
        auth.userId,
      );
      const display =
        productUser?.name?.display ??
        ([productUser?.name?.first, productUser?.name?.last].filter(Boolean).join(' ') ||
          null);

      const result = await ctx.checkout.createCheckout(
        {
          userId: auth.userId,
          productId: auth.productId,
          email: user?.email ?? null,
          displayName: display,
        },
        body,
      );

      await req.audit?.({
        action: 'billing.checkout.initiated',
        outcome: 'success',
        productId: auth.productId,
        resource: { type: 'checkout_session', id: result.sessionId },
        metadata: { gateway: result.gateway, planId: body.planId },
      });

      res.status(200).json(result);
    }),

    startTrial: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Trial start requires a product-scoped session',
        );
      }
      const body = startTrialRequestSchema.parse(req.body);
      const result = await ctx.trial.startFreeTrial(
        { userId: auth.userId, productId: auth.productId },
        body,
      );
      await req.audit?.({
        action: 'subscription.trial_started',
        outcome: 'success',
        productId: auth.productId,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        resource: { type: 'subscription', id: result.subscriptionId },
        metadata: { planId: body.planId, trialEndsAt: result.trialEndsAt },
      });
      res.status(201).json(result);
    }),

    previewChangePlan: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Plan change requires a product-scoped session',
        );
      }
      const query = changePlanPreviewQuerySchema.parse(req.query);
      const result = await ctx.changePlan.preview(
        { userId: auth.userId, productId: auth.productId },
        query,
      );
      res.status(200).json(result);
    }),

    applyChangePlan: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Plan change requires a product-scoped session',
        );
      }
      const body = changePlanRequestSchema.parse(req.body);
      const result = await ctx.changePlan.apply(
        { userId: auth.userId, productId: auth.productId },
        body,
      );
      await req.audit?.({
        action: 'subscription.plan_changed',
        outcome: 'success',
        productId: auth.productId,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        resource: { type: 'subscription', id: result.subscription.id },
        metadata: {
          fromPlanId: result.subscription.planId,
          toPlanId: body.newPlanId,
          scheduled: result.scheduled,
          effectiveAt: result.effectiveAt,
          gateway: result.subscription.gateway,
        },
      });
      res.status(200).json(result);
    }),

    // ── Wave 6: change seats ────────────────────────────────────────
    changeSeats: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Seat change requires a product-scoped session',
        );
      }
      const body = changeSeatsRequestSchema.parse(req.body);
      const result = await ctx.seatChange.changeSeats(
        { userId: auth.userId, productId: auth.productId },
        body,
      );
      await req.audit?.({
        action: 'subscription.seats_changed',
        outcome: 'success',
        productId: auth.productId,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        resource: { type: 'subscription', id: result.subscription.id },
        metadata: { quantity: body.quantity, scheduled: result.scheduled },
      });
      res.status(200).json(result);
    }),

    // ── Wave 7: pause / resume ───────────────────────────────────────
    pauseSubscription: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Pause requires a product-scoped session',
        );
      }
      const body = pauseSubscriptionRequestSchema.parse(req.body);
      const result = await ctx.pauseResume.pause(
        { userId: auth.userId, productId: auth.productId },
        body,
      );
      await req.audit?.({
        action: 'subscription.paused',
        outcome: 'success',
        productId: auth.productId,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        resource: { type: 'subscription', id: result.subscription.id },
        metadata: { reason: body.reason ?? null },
      });
      res.status(200).json(result);
    }),

    resumeSubscription: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Resume requires a product-scoped session',
        );
      }
      const body = resumeSubscriptionRequestSchema.parse(req.body);
      const result = await ctx.pauseResume.resume(
        { userId: auth.userId, productId: auth.productId },
        body,
      );
      await req.audit?.({
        action: 'subscription.resumed',
        outcome: 'success',
        productId: auth.productId,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        resource: { type: 'subscription', id: result.subscription.id },
        metadata: {},
      });
      res.status(200).json(result);
    }),

    // ── Wave 8: validate coupon (customer-facing) ────────────────────
    validateCoupon: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Coupon validation requires a product-scoped session',
        );
      }
      const query = validateCouponQuerySchema.parse(req.query);
      // Resolve plan amount/currency for discount calculation.
      let planAmount = 0;
      let planCurrency = 'usd';
      if (query.planId) {
        const plan = await planRepo.findPlanById(auth.productId, query.planId);
        if (plan) {
          planAmount = plan.amount ?? 0;
          planCurrency = plan.currency ?? 'usd';
        }
      }
      const result = await ctx.coupon.validate(
        auth.productId,
        { ...query, userId: auth.userId },
        planAmount,
        planCurrency,
      );
      res.status(200).json(result);
    }),

    // ── Wave 10: gateway migration ─────────────────────────────────────
    gatewayMigrate: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Gateway migration requires a product-scoped session',
        );
      }
      const body = gatewayMigrateRequestSchema.parse(req.body);
      const user = await userRepo.findUserById(auth.userId);
      const productUser = await productUserRepo.findByUserAndProduct(
        auth.productId,
        auth.userId,
      );
      const display =
        productUser?.name?.display ??
        ([productUser?.name?.first, productUser?.name?.last].filter(Boolean).join(' ') ||
          null);
      const result = await ctx.gatewayMigration.migrate(
        {
          userId: auth.userId,
          productId: auth.productId,
          email: user?.email ?? null,
          displayName: display,
        },
        body,
      );
      await req.audit?.({
        action: 'subscription.gateway_migrated',
        outcome: 'success',
        productId: auth.productId,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        resource: { type: 'subscription', id: result.oldSubscriptionId },
        metadata: { targetGateway: body.targetGateway, sessionId: result.sessionId },
      });
      res.status(200).json(result);
    }),

    // ── Wave 12: list invoices ────────────────────────────────────────
    listInvoices: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Invoices require a product-scoped session',
        );
      }
      const query = listInvoicesQuerySchema.parse(req.query);
      const product = await productRepo.findProductById(auth.productId);
      if (!product) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      const subjectType: 'user' | 'workspace' =
        product.billingScope === 'user' ? 'user' : 'workspace';
      const rows = await invoiceRepo.listForSubject({
        productId: auth.productId,
        subjectType,
        ...(subjectType === 'user' ? { subjectUserId: auth.userId } : {}),
        ...(subjectType === 'workspace' && query.workspaceId
          ? { subjectWorkspaceId: query.workspaceId }
          : {}),
        limit: query.limit,
      });
      res.status(200).json({
        invoices: rows.map((i) => ({
          id: i._id,
          productId: i.productId,
          subscriptionId: i.subscriptionId,
          gateway: i.gateway,
          gatewayInvoiceId: i.gatewayInvoiceId,
          invoiceNumber: i.invoiceNumber ?? null,
          status: i.status,
          amountSubtotal: i.amountSubtotal,
          amountTax: i.amountTax,
          amountTotal: i.amountTotal,
          amountPaid: i.amountPaid,
          currency: i.currency,
          periodStart: i.periodStart ? new Date(i.periodStart).toISOString() : null,
          periodEnd: i.periodEnd ? new Date(i.periodEnd).toISOString() : null,
          issuedAt: new Date(i.issuedAt ?? new Date()).toISOString(),
          paidAt: i.paidAt ? new Date(i.paidAt).toISOString() : null,
          downloadUrl: i.downloadUrl ?? null,
        })),
      });
    }),

    // ── Wave 13: tax profile ─────────────────────────────────────────
    getTaxProfile: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Tax profile requires a product-scoped session',
        );
      }
      const workspaceId =
        typeof req.query['workspaceId'] === 'string' ? req.query['workspaceId'] : undefined;
      const profile = await ctx.taxProfile.get(
        { userId: auth.userId, productId: auth.productId },
        workspaceId,
      );
      if (!profile) {
        throw new AppError(ErrorCode.TAX_PROFILE_NOT_FOUND, 'Tax profile not found');
      }
      res.status(200).json({ profile });
    }),

    upsertTaxProfile: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      if (!auth.productId) {
        throw new AppError(
          ErrorCode.WRONG_PRODUCT_SCOPE,
          'Tax profile requires a product-scoped session',
        );
      }
      const body = upsertTaxProfileRequestSchema.parse(req.body);
      const profile = await ctx.taxProfile.upsert(
        { userId: auth.userId, productId: auth.productId },
        body,
      );
      await req.audit?.({
        action: 'billing.tax_profile.upserted',
        outcome: 'success',
        productId: auth.productId,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
        resource: { type: 'tax_profile', id: profile.id },
        metadata: { taxIdType: body.taxIdType },
      });
      res.status(200).json({ profile });
    }),

    // ── Bundle checkout (Phase 3.5 — Flow T) ──────────────────────────
    bundleCheckout: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      const body = bundleCheckoutRequestSchema.parse(req.body);
      const user = await userRepo.findUserById(auth.userId);
      const result = await ctx.bundleCheckout.createBundleCheckout(
        {
          userId: auth.userId,
          email: user?.email ?? null,
          displayName: user?.email ?? null,
        },
        body,
      );
      await req.audit?.({
        action: 'bundle.checkout.initiated',
        outcome: 'success',
        resource: { type: 'checkout_session', id: result.sessionId },
        metadata: { bundleId: body.bundleId, currency: body.currency, gateway: result.gateway },
      });
      res.status(200).json(result);
    }),

    // ── Cancel bundle subscription (Phase 3.5 — Flow AK trigger) ─────
    cancelBundleSubscription: asyncHandler(async (req, res) => {
      const auth = requireAuth(req);
      const id = req.params['id'] ?? '';
      const result = await ctx.bundleCheckout.cancelBundleSubscription(
        { userId: auth.userId },
        id,
      );
      await req.audit?.({
        action: 'bundle.subscription.canceled',
        outcome: 'success',
        resource: { type: 'subscription', id: result.bundleSubscriptionId },
        metadata: { status: result.status, cascadeScheduled: result.cascadeScheduled },
      });
      res.status(200).json(result);
    }),
  };
}
