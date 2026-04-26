/**
 * Workspace + member + invitation + permission handlers (Phase 3.2).
 *
 * All endpoints listed in `packages/types/src/schemas/workspaces.ts`.
 *
 * Authentication assumptions:
 *   - All `/v1/workspaces*`, `/v1/invitations*`, `/v1/permissions/check`
 *     endpoints require an authenticated end-user (`req.auth.role==='END_USER'`)
 *     with a `productId` claim. The router enforces this via
 *     `requireAuth+requireProductScoped`.
 *   - `/v1/permissions/catalog` requires the API key middleware (Phase 3.3) —
 *     for now we accept any authenticated context.
 */
import type { Request, Response, RequestHandler } from 'express';
import {
  createWorkspaceRequestSchema,
  updateWorkspaceRequestSchema,
  deleteWorkspaceRequestSchema,
  transferOwnershipRequestSchema,
  switchWorkspaceRequestSchema,
  changeMemberRoleRequestSchema,
  createInvitationRequestSchema,
  acceptInvitationRequestSchema,
  acceptInvitationNewRequestSchema,
  permissionsCheckRequestSchema,
  type WorkspaceSummary,
  type MemberSummary as MemberSummarySchema,
} from '@yocore/types';
import { AppError, ErrorCode } from '../lib/errors.js';
import { asyncHandler } from './index.js';
import type { AppContext } from '../context.js';
import * as productRepo from '../repos/product.repo.js';

function requireProductScopedAuth(req: Request): { userId: string; productId: string; jti: string } {
  const auth = req.auth;
  if (!auth) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Auth context missing');
  if (auth.role !== 'END_USER' || !auth.productId) {
    throw new AppError(
      ErrorCode.WRONG_PRODUCT_SCOPE,
      'Endpoint requires an end-user product-scoped session',
    );
  }
  return { userId: auth.userId, productId: auth.productId, jti: auth.jti };
}

function toSummary(ws: {
  _id: string;
  name: string;
  slug: string;
  status: string;
  suspended: boolean;
  ownerUserId: string;
  timezone: string;
  voluntaryDeletionFinalizesAt?: Date | null;
}): WorkspaceSummary {
  return {
    id: ws._id,
    name: ws.name,
    slug: ws.slug,
    status: ws.status as WorkspaceSummary['status'],
    suspended: ws.suspended,
    ownerUserId: ws.ownerUserId,
    timezone: ws.timezone,
    voluntaryDeletionFinalizesAt: ws.voluntaryDeletionFinalizesAt
      ? ws.voluntaryDeletionFinalizesAt.toISOString()
      : null,
  };
}

export interface WorkspaceHandlers {
  // Workspace
  create: RequestHandler;
  list: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  delete: RequestHandler;
  restore: RequestHandler;
  transferOwnership: RequestHandler;
  switchWorkspace: RequestHandler;
  // Members
  listMembers: RequestHandler;
  changeMemberRole: RequestHandler;
  removeMember: RequestHandler;
  // Invitations
  createInvitation: RequestHandler;
  listInvitations: RequestHandler;
  revokeInvitation: RequestHandler;
  previewInvitation: RequestHandler;
  acceptInvitation: RequestHandler;
  acceptInvitationNew: RequestHandler;
  // Permissions
  permissionsCheck: RequestHandler;
  permissionsCatalog: RequestHandler;
}

export function workspaceHandlerFactory(ctx: AppContext): WorkspaceHandlers {
  return {
    // ─── Workspace CRUD ─────────────────────────────────────────────
    create: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const body = createWorkspaceRequestSchema.parse(req.body);
      const ws = await ctx.workspace.create({
        productId,
        userId,
        name: body.name,
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.settings !== undefined ? { settings: body.settings } : {}),
      });
      await req.audit?.({
        action: 'workspace.created',
        outcome: 'success',
        productId,
        resource: { type: 'workspace', id: ws._id },
        actor: { type: 'user', id: userId },
      });
      res.status(201).json({ workspace: toSummary(ws) });
    }),

    list: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const rows = await ctx.workspace.list(productId, userId);
      res.json({
        workspaces: rows.map((r) => ({ ...toSummary(r), role: r.roleSlug })),
      });
    }),

    get: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const id = String(req.params['id']);
      const ws = await ctx.workspace.get(productId, userId, id);
      res.json({
        workspace: {
          ...toSummary(ws),
          settings: ws.settings ?? {},
          createdAt: (ws as unknown as { createdAt: Date }).createdAt.toISOString(),
          updatedAt: (ws as unknown as { updatedAt: Date }).updatedAt.toISOString(),
        },
      });
    }),

    update: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const body = updateWorkspaceRequestSchema.parse(req.body);
      const id = String(req.params['id']);
      const ws = await ctx.workspace.update({
        productId,
        userId,
        workspaceId: id,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.settings !== undefined ? { settings: body.settings } : {}),
      });
      await req.audit?.({
        action: 'workspace.updated',
        outcome: 'success',
        productId,
        resource: { type: 'workspace', id: ws._id },
        actor: { type: 'user', id: userId },
      });
      res.json({ workspace: toSummary(ws) });
    }),

    delete: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const body = deleteWorkspaceRequestSchema.parse(req.body);
      const id = String(req.params['id']);
      const ws = await ctx.workspace.voluntaryDelete({
        productId,
        userId,
        workspaceId: id,
        password: body.password,
        confirmName: body.confirmName,
      });
      await req.audit?.({
        action: 'workspace.voluntary_deletion_requested',
        outcome: 'success',
        productId,
        resource: { type: 'workspace', id: ws._id },
        actor: { type: 'user', id: userId },
      });
      res.json({ workspace: toSummary(ws) });
    }),

    restore: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const id = String(req.params['id']);
      const ws = await ctx.workspace.restore(productId, userId, id);
      await req.audit?.({
        action: 'workspace.voluntary_deletion_cancelled',
        outcome: 'success',
        productId,
        resource: { type: 'workspace', id: ws._id },
        actor: { type: 'user', id: userId },
      });
      res.json({ workspace: toSummary(ws) });
    }),

    transferOwnership: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const body = transferOwnershipRequestSchema.parse(req.body);
      const id = String(req.params['id']);
      const ws = await ctx.workspace.transferOwnership({
        productId,
        userId,
        workspaceId: id,
        newOwnerUserId: body.newOwnerUserId,
        password: body.password,
      });
      await req.audit?.({
        action: 'workspace.owner.transferred',
        outcome: 'success',
        productId,
        resource: { type: 'workspace', id: ws._id },
        actor: { type: 'user', id: userId },
        metadata: { previousOwnerId: userId, newOwnerId: body.newOwnerUserId },
      });
      res.json({ workspace: toSummary(ws) });
    }),

    switchWorkspace: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId, jti } = requireProductScopedAuth(req);
      const body = switchWorkspaceRequestSchema.parse(req.body);
      const out = await ctx.workspace.switchWorkspace({
        productId,
        userId,
        workspaceId: body.workspaceId,
        oldJti: jti,
      });
      res.json({
        status: 'switched',
        workspaceId: out.workspaceId,
        accessToken: out.accessToken,
        expiresIn: out.expiresIn,
        tokenType: 'Bearer',
      });
    }),

    // ─── Members ────────────────────────────────────────────────────
    listMembers: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const id = String(req.params['id']);
      const rows = await ctx.member.list(productId, userId, id);
      const members: MemberSummarySchema[] = rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        name: r.name,
        roleSlug: r.roleSlug,
        status: r.status,
        joinedAt: r.joinedAt.toISOString(),
      }));
      res.json({ members });
    }),

    changeMemberRole: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const body = changeMemberRoleRequestSchema.parse(req.body);
      const workspaceId = String(req.params['id']);
      const targetUserId = String(req.params['userId']);
      const summary = await ctx.member.changeRole({
        productId,
        callerId: userId,
        workspaceId,
        targetUserId,
        roleSlug: body.roleSlug,
      });
      await req.audit?.({
        action: 'workspace.member.role_changed',
        outcome: 'success',
        productId,
        resource: { type: 'workspace_member', id: targetUserId },
        actor: { type: 'user', id: userId },
        metadata: { roleSlug: body.roleSlug },
      });
      res.json({
        member: {
          userId: summary.userId,
          email: summary.email,
          name: summary.name,
          roleSlug: summary.roleSlug,
          status: summary.status,
          joinedAt: summary.joinedAt.toISOString(),
        },
      });
    }),

    removeMember: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const workspaceId = String(req.params['id']);
      const targetUserId = String(req.params['userId']);
      await ctx.member.remove({
        productId,
        callerId: userId,
        workspaceId,
        targetUserId,
      });
      await req.audit?.({
        action: 'workspace.member.removed',
        outcome: 'success',
        productId,
        resource: { type: 'workspace_member', id: targetUserId },
        actor: { type: 'user', id: userId },
      });
      res.status(204).end();
    }),

    // ─── Invitations ────────────────────────────────────────────────
    createInvitation: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const body = createInvitationRequestSchema.parse(req.body);
      const workspaceId = String(req.params['id']);
      const { invitation } = await ctx.invitation.create({
        productId,
        callerId: userId,
        workspaceId,
        email: body.email,
        roleSlug: body.roleSlug,
      });
      await req.audit?.({
        action: 'workspace.invitation.created',
        outcome: 'success',
        productId,
        resource: { type: 'invitation', id: invitation._id },
        actor: { type: 'user', id: userId },
      });
      res.status(201).json({
        invitation: {
          id: invitation._id,
          email: invitation.email,
          roleSlug: invitation.roleSlug,
          status: invitation.status,
          isExistingUser: invitation.isExistingUser,
          expiresAt: invitation.expiresAt.toISOString(),
          createdAt: (invitation as unknown as { createdAt: Date }).createdAt.toISOString(),
        },
      });
    }),

    listInvitations: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const workspaceId = String(req.params['id']);
      const rows = await ctx.invitation.list(productId, userId, workspaceId);
      res.json({
        invitations: rows.map((r) => ({
          id: r._id,
          email: r.email,
          roleSlug: r.roleSlug,
          status: r.status,
          isExistingUser: r.isExistingUser,
          expiresAt: r.expiresAt.toISOString(),
          createdAt: (r as unknown as { createdAt: Date }).createdAt.toISOString(),
        })),
      });
    }),

    revokeInvitation: asyncHandler(async (req: Request, res: Response) => {
      const { userId, productId } = requireProductScopedAuth(req);
      const workspaceId = String(req.params['id']);
      const invitationId = String(req.params['invId']);
      await ctx.invitation.revoke({
        productId,
        callerId: userId,
        workspaceId,
        invitationId,
      });
      await req.audit?.({
        action: 'workspace.invitation.revoked',
        outcome: 'success',
        productId,
        resource: { type: 'invitation', id: invitationId },
        actor: { type: 'user', id: userId },
      });
      res.status(204).end();
    }),

    previewInvitation: asyncHandler(async (req: Request, res: Response) => {
      const token = String(req.query['token'] ?? '');
      if (!token) throw new AppError(ErrorCode.VALIDATION_FAILED, 'token required');
      const preview = await ctx.invitation.preview(token);
      res.json({
        ...preview,
        expiresAt: preview.expiresAt.toISOString(),
      });
    }),

    acceptInvitation: asyncHandler(async (req: Request, res: Response) => {
      const { userId } = requireProductScopedAuth(req);
      const body = acceptInvitationRequestSchema.parse(req.body);
      const outcome = await ctx.invitation.accept({ token: body.token, userId });
      await req.audit?.({
        action: 'workspace.invitation.accepted',
        outcome: 'success',
        productId: outcome.productId,
        resource: { type: 'workspace', id: outcome.workspaceId },
        actor: { type: 'user', id: userId },
      });
      res.json({
        status: 'accepted',
        workspaceId: outcome.workspaceId,
        productId: outcome.productId,
        alreadyMember: outcome.alreadyMember,
      });
    }),

    acceptInvitationNew: asyncHandler(async (req: Request, res: Response) => {
      const body = acceptInvitationNewRequestSchema.parse(req.body);
      const { outcome, session } = await ctx.invitation.acceptNew({
        token: body.token,
        password: body.password,
        ...(body.name !== undefined ? { name: body.name } : {}),
        device: { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
      });
      await req.audit?.({
        action: 'user.created.via.invitation',
        outcome: 'success',
        productId: outcome.productId,
        resource: { type: 'user', id: outcome.userId },
        actor: { type: 'system' },
      });
      res.status(201).json({
        status: 'accepted',
        workspaceId: outcome.workspaceId,
        productId: outcome.productId,
        userId: outcome.userId,
        tokens: session.tokens,
      });
    }),

    // ─── Permissions ────────────────────────────────────────────────
    permissionsCheck: asyncHandler(async (req: Request, res: Response) => {
      const { productId } = requireProductScopedAuth(req);
      const body = permissionsCheckRequestSchema.parse(req.body);
      const out = await ctx.permission.check({
        productId,
        userId: body.userId,
        workspaceId: body.workspaceId,
        permissions: body.permissions,
      });
      res.json(out);
    }),

    permissionsCatalog: asyncHandler(async (req: Request, res: Response) => {
      // Catalog is product-scoped; support both API-key (productId from
      // middleware) and authenticated end-user contexts.
      const productId =
        req.auth?.productId ??
        ((req as unknown as { product?: { _id: string } }).product?._id ?? null);
      let resolvedProductId = productId;
      if (!resolvedProductId) {
        const slug = String(req.query['productSlug'] ?? '');
        if (!slug) throw new AppError(ErrorCode.VALIDATION_FAILED, 'productSlug required');
        const prod = await productRepo.findProductBySlug(slug);
        if (!prod) throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
        resolvedProductId = prod._id;
      }
      const out = await ctx.permission.catalog(resolvedProductId);
      res.json(out);
    }),
  };
}
