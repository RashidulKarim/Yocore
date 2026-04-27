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
} from '@yocore/types';
import { AppError, ErrorCode } from '../lib/errors.js';
import { requireAuth } from '../middleware/jwt-auth.js';
import { asyncHandler } from './index.js';
import * as userRepo from '../repos/user.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import type { AppContext } from '../context.js';

export interface BillingHandlers {
  checkout: RequestHandler;
  startTrial: RequestHandler;
  previewChangePlan: RequestHandler;
  applyChangePlan: RequestHandler;
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
  };
}
