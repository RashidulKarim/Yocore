/**
 * V1.2 — Role + Product-Admin handlers (SUPER_ADMIN only).
 *
 *   /v1/admin/products/:id/roles            (V1.2-A: Custom Role CRUD)
 *   /v1/admin/products/:id/admins           (V1.2-C: PRODUCT_ADMIN grant/revoke)
 *
 * All endpoints require a SUPER_ADMIN session. The router mounts `requireJwt`
 * upstream; each handler calls `requireSuperAdmin(req)` itself.
 */
import type { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import {
  AppError,
  ErrorCode,
  createRoleRequestSchema,
  updateRoleRequestSchema,
  grantProductAdminRequestSchema,
} from '@yocore/types';
import * as roleRepo from '../repos/role.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as userRepo from '../repos/user.repo.js';
import { requireSuperAdmin } from '../middleware/jwt-auth.js';
import { asyncHandler } from './index.js';
import type { AppContext } from '../context.js';

const idParam = z.string().min(1).max(60);

export interface RolesAdminHandlers {
  // Custom role CRUD
  listRoles: RequestHandler;
  createRole: RequestHandler;
  updateRole: RequestHandler;
  deleteRole: RequestHandler;
  permissionsCatalog: RequestHandler;
  // Product admins
  listProductAdmins: RequestHandler;
  grantProductAdmin: RequestHandler;
  revokeProductAdmin: RequestHandler;
}

function serializeRole(
  r: roleRepo.RoleLean,
  memberCount?: number,
): Record<string, unknown> {
  return {
    id: r._id,
    productId: r.productId,
    slug: r.slug,
    name: r.name,
    description: r.description ?? null,
    isPlatform: r.isPlatform,
    isDefault: r.isDefault,
    permissions: [...r.permissions],
    inheritsFrom: r.inheritsFrom ?? null,
    memberCount: memberCount ?? 0,
    createdAt:
      (r as { createdAt?: Date }).createdAt?.toISOString() ?? null,
    updatedAt:
      (r as { updatedAt?: Date }).updatedAt?.toISOString() ?? null,
  };
}

export function rolesAdminHandlerFactory(ctx: AppContext): RolesAdminHandlers {
  return {
    // ── Custom Role CRUD ─────────────────────────────────────────────
    listRoles: asyncHandler(async (req: Request, res: Response) => {
      requireSuperAdmin(req);
      const productId = idParam.parse(req.params['id']);
      const [roles, counts] = await Promise.all([
        ctx.role.list(productId),
        ctx.role.memberCounts(productId),
      ]);
      res.json({
        roles: roles.map((r) => serializeRole(r, counts[r._id] ?? 0)),
      });
    }),

    createRole: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireSuperAdmin(req);
      const productId = idParam.parse(req.params['id']);
      const body = createRoleRequestSchema.parse(req.body);
      const created = await ctx.role.create({
        productId,
        slug: body.slug,
        name: body.name,
        description: body.description,
        permissions: body.permissions,
        inheritsFrom: body.inheritsFrom,
        isDefault: body.isDefault,
      });
      await req.audit?.({
        action: 'role.created',
        outcome: 'success',
        productId,
        resource: { type: 'role', id: created._id },
        metadata: {
          slug: created.slug,
          permissions: created.permissions.length,
          inheritsFrom: created.inheritsFrom ?? null,
        },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(201).json({ role: serializeRole(created, 0) });
    }),

    updateRole: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireSuperAdmin(req);
      const productId = idParam.parse(req.params['id']);
      const roleId = idParam.parse(req.params['roleId']);
      const body = updateRoleRequestSchema.parse(req.body);
      const updated = await ctx.role.update({
        productId,
        roleId,
        patch: body,
      });
      await req.audit?.({
        action: 'role.updated',
        outcome: 'success',
        productId,
        resource: { type: 'role', id: roleId },
        metadata: { fields: Object.keys(body) },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.json({ role: serializeRole(updated) });
    }),

    deleteRole: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireSuperAdmin(req);
      const productId = idParam.parse(req.params['id']);
      const roleId = idParam.parse(req.params['roleId']);
      await ctx.role.delete(productId, roleId);
      await req.audit?.({
        action: 'role.deleted',
        outcome: 'success',
        productId,
        resource: { type: 'role', id: roleId },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(204).end();
    }),

    permissionsCatalog: asyncHandler(async (req: Request, res: Response) => {
      requireSuperAdmin(req);
      const productId = idParam.parse(req.params['id']);
      const out = await ctx.permission.catalog(productId);
      res.json(out);
    }),

    // ── Product Admins (System Design §5.15 / GAP-03) ────────────────
    listProductAdmins: asyncHandler(async (req: Request, res: Response) => {
      requireSuperAdmin(req);
      const productId = idParam.parse(req.params['id']);
      const rows = await productUserRepo.listByProductRole(productId, 'PRODUCT_ADMIN');
      const userIds = rows.map((r) => r.userId);
      const users = userIds.length
        ? await userRepo.findManyByIds(userIds)
        : [];
      const userById = new Map(users.map((u) => [u._id, u]));
      res.json({
        admins: rows.map((p) => ({
          userId: p.userId,
          email: userById.get(p.userId)?.email ?? null,
          displayName: p.name?.display ?? null,
          status: p.status,
          joinedAt: (p.joinedAt as Date | undefined)?.toISOString() ?? null,
          lastLoginAt:
            (p.lastLoginAt as Date | null | undefined)?.toISOString() ?? null,
        })),
      });
    }),

    grantProductAdmin: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireSuperAdmin(req);
      const productId = idParam.parse(req.params['id']);
      const body = grantProductAdminRequestSchema.parse(req.body);
      const existing = await productUserRepo.findByUserAndProduct(productId, body.userId);
      if (!existing) {
        throw new AppError(
          ErrorCode.USER_NOT_FOUND,
          'User is not a member of this product',
        );
      }
      if (existing.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Target productUser is not ACTIVE',
        );
      }
      await productUserRepo.setProductRole(productId, body.userId, 'PRODUCT_ADMIN');
      await req.audit?.({
        action: 'product_admin.granted',
        outcome: 'success',
        productId,
        resource: { type: 'product_user', id: body.userId },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({ userId: body.userId, productRole: 'PRODUCT_ADMIN' });
    }),

    revokeProductAdmin: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireSuperAdmin(req);
      const productId = idParam.parse(req.params['id']);
      const userId = idParam.parse(req.params['userId']);
      const existing = await productUserRepo.findByUserAndProduct(productId, userId);
      if (!existing) {
        throw new AppError(
          ErrorCode.USER_NOT_FOUND,
          'User is not a member of this product',
        );
      }
      if (existing.productRole !== 'PRODUCT_ADMIN') {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'User is not a PRODUCT_ADMIN',
        );
      }
      await productUserRepo.setProductRole(productId, userId, 'END_USER');
      await req.audit?.({
        action: 'product_admin.revoked',
        outcome: 'success',
        productId,
        resource: { type: 'product_user', id: userId },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(204).end();
    }),
  };
}
