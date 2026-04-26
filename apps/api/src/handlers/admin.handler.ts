/**
 * Admin handlers — platform bootstrap + Phase 3.3 Product & Gateway management.
 *
 * Every endpoint except `bootstrap` requires a SUPER_ADMIN session
 * (enforced inline via `requireSuperAdmin(req)`). The router still mounts
 * `requireJwt` upstream so the auth context is populated.
 *
 * `bootstrap` is gated by a header `X-Bootstrap-Secret` matching
 * `env.BOOTSTRAP_SECRET` (compared in constant time). It can only succeed once
 * — the global `users.role` partial unique index enforces a single SUPER_ADMIN.
 */
import type { Request, Response, RequestHandler } from 'express';
import {
  addGatewayRequestSchema,
  bootstrapRequestSchema,
  createPlanRequestSchema,
  createProductRequestSchema,
  listPlansQuerySchema,
  rotateApiSecretResponseSchema,
  rotateWebhookSecretResponseSchema,
  updateBillingConfigRequestSchema,
  updatePlanRequestSchema,
  updateProductRequestSchema,
  updateProductStatusRequestSchema,
} from '@yocore/types';
import { AppError, ErrorCode } from '../lib/errors.js';
import { safeEqual } from '../lib/tokens.js';
import { env } from '../config/env.js';
import { bootstrapSuperAdmin } from '../services/auth.service.js';
import { requireSuperAdmin } from '../middleware/jwt-auth.js';
import { asyncHandler } from './index.js';
import type { AppContext } from '../context.js';

export interface AdminHandlers {
  bootstrap: RequestHandler;
  // Products (Flow B / AJ)
  createProduct: RequestHandler;
  listProducts: RequestHandler;
  getProduct: RequestHandler;
  updateProduct: RequestHandler;
  setProductStatus: RequestHandler;
  rotateApiSecret: RequestHandler;
  rotateWebhookSecret: RequestHandler;
  updateBillingConfig: RequestHandler;
  // Gateways (Flow C1–C5)
  addGateway: RequestHandler;
  listGateways: RequestHandler;
  removeGateway: RequestHandler;
  // Plans (Flow D / AO)
  createPlan: RequestHandler;
  listPlans: RequestHandler;
  getPlan: RequestHandler;
  updatePlan: RequestHandler;
  publishPlan: RequestHandler;
  archivePlan: RequestHandler;
}

export function adminHandlerFactory(ctx: AppContext): AdminHandlers {
  return {
    bootstrap: asyncHandler(async (req: Request, res: Response) => {
      const provided = req.get('x-bootstrap-secret') ?? '';
      if (!safeEqual(provided, env.BOOTSTRAP_SECRET)) {
        throw new AppError(ErrorCode.AUTH_BOOTSTRAP_SECRET_INVALID, 'Invalid bootstrap secret');
      }

      const body = bootstrapRequestSchema.parse(req.body);
      const result = await bootstrapSuperAdmin(body);

      await req.audit?.({
        action: 'super_admin.bootstrap',
        outcome: 'success',
        resource: { type: 'user', id: result.userId },
        metadata: { email: result.email },
        actor: { type: 'system' },
      });

      res.status(201).json({
        userId: result.userId,
        email: result.email,
        mfaEnrolmentRequired: true,
      });
    }),

    // ── Products ────────────────────────────────────────────────────────
    createProduct: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const body = createProductRequestSchema.parse(req.body);
      const result = await ctx.product.create(body, auth.userId);
      await req.audit?.({
        action: 'product.created',
        outcome: 'success',
        productId: result.product.id,
        resource: { type: 'product', id: result.product.id },
        metadata: { slug: result.product.slug, billingScope: result.product.billingScope },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(201).json(result);
    }),

    listProducts: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const products = await ctx.product.list();
      res.status(200).json({ products });
    }),

    getProduct: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const product = await ctx.product.get(id);
      res.status(200).json({
        product: {
          id: product._id,
          name: product.name,
          slug: product.slug,
          status: product.status,
          apiKey: product.apiKey,
          billingScope: product.billingScope,
          domain: product.domain ?? null,
          description: product.description ?? null,
          logoUrl: product.logoUrl ?? null,
          allowedOrigins: product.allowedOrigins ?? [],
          allowedRedirectUris: product.allowedRedirectUris ?? [],
          webhookUrl: product.webhookUrl ?? null,
          webhookEvents: product.webhookEvents ?? [],
          billingConfig: product.billingConfig ?? {},
          createdAt:
            (product as { createdAt?: Date }).createdAt?.toISOString() ?? null,
          updatedAt:
            (product as { updatedAt?: Date }).updatedAt?.toISOString() ?? null,
        },
      });
    }),

    updateProduct: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const body = updateProductRequestSchema.parse(req.body);
      const updated = await ctx.product.update(id, body);
      await req.audit?.({
        action: 'product.updated',
        outcome: 'success',
        productId: id,
        resource: { type: 'product', id },
        metadata: { fields: Object.keys(body) },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({ product: updated });
    }),

    setProductStatus: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const body = updateProductStatusRequestSchema.parse(req.body);
      const updated = await ctx.product.setStatus(id, body);
      await req.audit?.({
        action: 'product.status.changed',
        outcome: 'success',
        productId: id,
        resource: { type: 'product', id },
        metadata: { status: body.status },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({ product: updated });
    }),

    rotateApiSecret: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const result = await ctx.product.rotateApiSecret(id);
      await req.audit?.({
        action: 'product.api_secret.rotated',
        outcome: 'success',
        productId: id,
        resource: { type: 'product', id },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json(rotateApiSecretResponseSchema.parse(result));
    }),

    rotateWebhookSecret: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const result = await ctx.product.rotateWebhookSecret(id);
      await req.audit?.({
        action: 'product.webhook_secret.rotated',
        outcome: 'success',
        productId: id,
        resource: { type: 'product', id },
        metadata: { previousSecretExpiresAt: result.previousSecretExpiresAt },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json(rotateWebhookSecretResponseSchema.parse(result));
    }),

    updateBillingConfig: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const body = updateBillingConfigRequestSchema.parse(req.body);
      const updated = await ctx.product.updateBillingConfig(id, body);
      await req.audit?.({
        action: 'product.billing_config.updated',
        outcome: 'success',
        productId: id,
        resource: { type: 'product', id },
        metadata: { fields: Object.keys(body) },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({ billingConfig: updated.billingConfig });
    }),

    // ── Gateways ────────────────────────────────────────────────────────
    addGateway: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const body = addGatewayRequestSchema.parse(req.body);
      try {
        const gateway = await ctx.gateway.add(productId, body, auth.userId);
        await req.audit?.({
          action: 'gateway.created',
          outcome: 'success',
          productId,
          resource: { type: 'gateway', id: gateway.id },
          metadata: { provider: gateway.provider, mode: gateway.mode, status: gateway.status },
          actor: { type: 'super_admin', id: auth.userId },
        });
        res.status(201).json({ gateway });
      } catch (err) {
        if (err instanceof AppError && err.code === ErrorCode.GATEWAY_VERIFICATION_FAILED) {
          await req.audit?.({
            action: 'gateway.add_failed',
            outcome: 'failure',
            productId,
            resource: { type: 'gateway', id: 'pending' },
            reason: 'verification_failed',
            metadata: { provider: body.provider, mode: body.mode },
            actor: { type: 'super_admin', id: auth.userId },
          });
        }
        throw err;
      }
    }),

    listGateways: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const gateways = await ctx.gateway.list(productId);
      res.status(200).json({ gateways });
    }),

    removeGateway: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const gatewayId = req.params['gwId'] ?? '';
      await ctx.gateway.remove(productId, gatewayId);
      await req.audit?.({
        action: 'gateway.removed',
        outcome: 'success',
        productId,
        resource: { type: 'gateway', id: gatewayId },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(204).end();
    }),

    // ── Plans (Flow D / AO) ─────────────────────────────────
    createPlan: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const body = createPlanRequestSchema.parse(req.body);
      const plan = await ctx.plan.create(productId, body, auth.userId);
      await req.audit?.({
        action: 'plan.created',
        outcome: 'success',
        productId,
        resource: { type: 'billingPlan', id: plan.id },
        metadata: { slug: plan.slug, amount: plan.amount, currency: plan.currency },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(201).json({ plan });
    }),

    listPlans: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const filter = listPlansQuerySchema.parse(req.query);
      const plans = await ctx.plan.list(productId, filter);
      res.status(200).json({ plans });
    }),

    getPlan: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const planId = req.params['planId'] ?? '';
      const plan = await ctx.plan.get(productId, planId);
      res.status(200).json({ plan });
    }),

    updatePlan: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const planId = req.params['planId'] ?? '';
      const body = updatePlanRequestSchema.parse(req.body);
      const plan = await ctx.plan.update(productId, planId, body);
      await req.audit?.({
        action: 'plan.updated',
        outcome: 'success',
        productId,
        resource: { type: 'billingPlan', id: planId },
        metadata: { fields: Object.keys(body) },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({ plan });
    }),

    publishPlan: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const planId = req.params['planId'] ?? '';
      const plan = await ctx.plan.publish(productId, planId);
      await req.audit?.({
        action: 'plan.published',
        outcome: 'success',
        productId,
        resource: { type: 'billingPlan', id: planId },
        metadata: { stripePriceId: plan.gatewayPriceIds.stripe },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({ plan });
    }),

    archivePlan: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const productId = req.params['id'] ?? '';
      const planId = req.params['planId'] ?? '';
      const result = await ctx.plan.archive(productId, planId);
      await req.audit?.({
        action: 'plan.archived',
        outcome: 'success',
        productId,
        resource: { type: 'billingPlan', id: planId },
        metadata: { affectedSubscriptions: result.affectedSubscriptions },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json(result);
    }),
  };
}
