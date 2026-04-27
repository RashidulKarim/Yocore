/**
 * Entitlements handler — V1.1-C (Addendum #7).
 *
 * `GET /v1/entitlements/:workspaceId?includeGrandfatheringInfo=true`
 *
 * Returns the live limits for a workspace's active subscription. When the
 * `includeGrandfatheringInfo=true` flag is set we also surface the snapshot
 * captured at subscribe time (`planLimitsSnapshot`) and a derived
 * `grandfathered` boolean (snapshot exists AND plan visibility is
 * `grandfathered`).
 *
 * Per ADR-001: every read is productId-scoped — productId is taken from the
 * authenticated JWT (`req.auth.productId`).
 */
import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../lib/errors.js';
import { asyncHandler } from './index.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as workspaceRepo from '../repos/workspace.repo.js';

export interface EntitlementsHandlers {
  getEntitlements: RequestHandler;
}

export function entitlementsHandlerFactory(): EntitlementsHandlers {
  return {
    getEntitlements: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Authentication required');
      if (!auth.productId) {
        throw new AppError(ErrorCode.WRONG_PRODUCT_SCOPE, 'JWT must carry productId');
      }
      const workspaceId = req.params['workspaceId'] ?? '';
      const includeGrandfathering = req.query['includeGrandfatheringInfo'] === 'true';

      const ws = await workspaceRepo.findById(auth.productId, workspaceId);
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');

      const sub = await subscriptionRepo.findActiveBySubject({
        productId: auth.productId,
        subjectType: 'workspace',
        subjectWorkspaceId: workspaceId,
      });

      if (!sub) {
        res.status(200).json({
          workspaceId,
          productId: auth.productId,
          status: 'NONE',
          planId: null,
          limits: {},
          grandfathered: false,
          ...(includeGrandfathering ? { planLimitsSnapshot: null } : {}),
        });
        return;
      }

      const plan = await planRepo.findPlanById(auth.productId, sub.planId);
      const liveLimits = (plan?.limits ?? {}) as Record<string, unknown>;
      const snapshot = (sub.planLimitsSnapshot ?? null) as Record<string, unknown> | null;
      const grandfathered =
        plan?.visibility === 'grandfathered' && snapshot != null;

      res.status(200).json({
        workspaceId,
        productId: auth.productId,
        status: sub.status,
        planId: sub.planId,
        limits: grandfathered && snapshot ? snapshot : liveLimits,
        grandfathered,
        ...(includeGrandfathering
          ? {
              planLimitsSnapshot: snapshot,
              liveLimits,
              planVisibility: plan?.visibility ?? null,
            }
          : {}),
      });
    }),
  };
}
