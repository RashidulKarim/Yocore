/**
 * Admin handlers — currently only the platform bootstrap endpoint.
 *
 * `POST /v1/admin/bootstrap` is gated by a header `X-Bootstrap-Secret` matching
 * `env.BOOTSTRAP_SECRET` (compared in constant time). It can only succeed once
 * — the global `users.role` partial unique index enforces a single SUPER_ADMIN.
 */
import type { Request, Response, RequestHandler } from 'express';
import { bootstrapRequestSchema } from '@yocore/types';
import { AppError, ErrorCode } from '../lib/errors.js';
import { safeEqual } from '../lib/tokens.js';
import { env } from '../config/env.js';
import { bootstrapSuperAdmin } from '../services/auth.service.js';
import { asyncHandler } from './index.js';
import type { AppContext } from '../context.js';

export interface AdminHandlers {
  bootstrap: RequestHandler;
}

export function adminHandlerFactory(_ctx: AppContext): AdminHandlers {
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
  };
}
