/**
 * Self-service handlers for the authenticated user (V1.0-B):
 *   - DELETE /v1/users/me           — request self-deletion (Flow X)
 *   - POST   /v1/users/me/cancel-deletion
 *   - GET    /v1/users/me/deletion-requests
 *   - GET    /v1/sessions           — list active sessions
 *   - DELETE /v1/sessions/:id       — revoke session
 *
 * All routes require an authenticated JWT (mounted with `requireJwt`).
 */
import type { Request, Response, RequestHandler } from 'express';
import {
  requestSelfDeletionRequestSchema,
} from '@yocore/types';
import { AppError, ErrorCode } from '../lib/errors.js';
import { verify as verifyPassword, timingSafeDummyVerify } from '../lib/password.js';
import { asyncHandler } from './index.js';
import * as sessionRepo from '../repos/session.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as userRepo from '../repos/user.repo.js';
import type { AppContext } from '../context.js';

export interface MeHandlers {
  requestDeletion: RequestHandler;
  cancelDeletion: RequestHandler;
  listMyDeletionRequests: RequestHandler;
  listSessions: RequestHandler;
  revokeSession: RequestHandler;
}

export function meHandlerFactory(ctx: AppContext): MeHandlers {
  return {
    requestDeletion: asyncHandler(async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Authentication required');
      const body = requestSelfDeletionRequestSchema.parse(req.body);

      // Re-auth: verify password against the appropriate principal record.
      let passwordHash: string | null = null;
      if (body.scope === 'account') {
        const user = await userRepo.findUserById(auth.userId);
        passwordHash = user?.passwordHash ?? null;
      } else {
        if (!body.productId) {
          throw new AppError(ErrorCode.VALIDATION_FAILED, 'productId required for product scope');
        }
        const pu = await productUserRepo.findByUserAndProduct(body.productId, auth.userId);
        passwordHash = pu?.passwordHash ?? null;
      }
      if (!passwordHash) {
        await timingSafeDummyVerify();
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
      }
      const ok = await verifyPassword(passwordHash, body.password);
      if (!ok) {
        throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
      }

      const result = await ctx.gdprDeletion.requestDeletion({
        userId: auth.userId,
        scope: body.scope,
        ...(body.productId ? { productId: body.productId } : {}),
      });

      await req.audit?.({
        action: 'gdpr.deletion.requested',
        outcome: 'success',
        productId: result.productId,
        resource: { type: 'deletion_request', id: result.deletionRequestId },
        metadata: {
          scope: result.scope,
          finalizeAt: result.finalizeAt.toISOString(),
        },
        actor: { type: 'user', id: auth.userId },
      });

      res.status(202).json({
        deletionRequestId: result.deletionRequestId,
        scope: result.scope,
        productId: result.productId,
        finalizeAt: result.finalizeAt.toISOString(),
      });
    }),

    cancelDeletion: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Authentication required');
      const scope = (req.query['scope'] === 'product' ? 'product' : 'account') as
        | 'account'
        | 'product';
      const productId = typeof req.query['productId'] === 'string'
        ? (req.query['productId'] as string)
        : undefined;
      const result = await ctx.gdprDeletion.cancelDeletion({
        userId: auth.userId,
        scope,
        ...(productId ? { productId } : {}),
      });
      if (!result.canceled) {
        throw new AppError(
          ErrorCode.NOT_FOUND,
          'No pending deletion request found',
        );
      }
      await req.audit?.({
        action: 'gdpr.deletion.canceled',
        outcome: 'success',
        productId: productId ?? null,
        resource: { type: 'deletion_request', id: 'self' },
        metadata: { scope },
        actor: { type: 'user', id: auth.userId },
      });
      res.status(200).json({ canceled: true });
    }),

    listMyDeletionRequests: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Authentication required');
      const rows = await ctx.gdprDeletion.listForUser(auth.userId);
      res.status(200).json({
        deletionRequests: rows.map((r) => ({
          id: r.id,
          scope: r.scope,
          productId: r.productId,
          status: r.status,
          requestedAt: r.requestedAt.toISOString(),
          finalizeAt: r.finalizeAt.toISOString(),
        })),
      });
    }),

    // ── Sessions ────────────────────────────────────────────────────────
    listSessions: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Authentication required');
      const rows = await sessionRepo.listActiveByUser(auth.userId);
      res.status(200).json({
        sessions: rows.map((s) => ({
          id: s._id,
          productId: s.productId ?? null,
          createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : null,
          lastUsedAt: s.lastUsedAt instanceof Date ? s.lastUsedAt.toISOString() : null,
          ip: s.device?.ip ?? null,
          userAgent: s.device?.userAgent ?? null,
          isCurrent: s._id === auth.sessionId,
        })),
      });
    }),

    revokeSession: asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Authentication required');
      const id = req.params['id'] ?? '';
      const target = await sessionRepo.findById(id);
      if (!target || target.userId !== auth.userId) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Session not found');
      }
      if (target.revokedAt) {
        res.status(200).json({ revoked: true, alreadyRevoked: true });
        return;
      }
      await sessionRepo.revokeSession(id, 'user_logout');
      await req.audit?.({
        action: 'session.revoked',
        outcome: 'success',
        productId: target.productId ?? null,
        resource: { type: 'session', id },
        metadata: { reason: 'user_request', isSelf: id === auth.sessionId },
        actor: { type: 'user', id: auth.userId },
      });
      res.status(200).json({ revoked: true });
    }),
  };
}
