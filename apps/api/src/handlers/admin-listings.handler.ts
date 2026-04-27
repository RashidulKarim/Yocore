/**
 * Admin listings + Announcements handlers — V1.1-D screens 3, 4, 5, 6, 10, 12.
 *
 * Provides paginated listings the admin-web SPA needs:
 *   - Product users (Screen 3) + user detail (Screen 4)
 *   - Product workspaces (Screen 5) + workspace detail (Screen 6)
 *   - Global user search (Screen 10)
 *   - Announcement CRUD + publish/archive (Screen 12)
 *
 * All endpoints require a verified Super-Admin (enforced inline via
 * `requireSuperAdmin(req)`); the router additionally mounts `requireJwt`.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '@yocore/types';
import {
  adminListQuerySchema,
  searchAllUsersQuerySchema,
  createAnnouncementRequestSchema,
  updateAnnouncementRequestSchema,
  listAnnouncementsQuerySchema,
} from '@yocore/types';
import { asyncHandler } from './index.js';
import { requireSuperAdmin } from '../middleware/jwt-auth.js';
import {
  ProductUser,
  User,
  Workspace,
  Subscription,
  Announcement,
} from '../db/index.js';

const idParam = z.string().min(1).max(60);

export interface AdminListingsHandlers {
  listProductUsers: RequestHandler;
  getProductUserDetail: RequestHandler;
  listProductWorkspaces: RequestHandler;
  getWorkspaceDetail: RequestHandler;
  searchAllUsers: RequestHandler;
  // Announcements
  listAnnouncements: RequestHandler;
  createAnnouncement: RequestHandler;
  updateAnnouncement: RequestHandler;
  publishAnnouncement: RequestHandler;
  archiveAnnouncement: RequestHandler;
}

export function adminListingsHandlerFactory(): AdminListingsHandlers {
  return {
    // ── Screen 3: Product users ──────────────────────────────────────
    listProductUsers: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const productId = idParam.parse(req.params['productId']);
      const q = adminListQuerySchema.parse(req.query);

      const filter: Record<string, unknown> = { productId };
      if (q.status) filter['status'] = q.status.toUpperCase();
      if (q.cursor) filter['_id'] = { $lt: q.cursor };

      const rows = await ProductUser.find(filter)
        .sort({ _id: -1 })
        .limit(q.limit + 1)
        .lean();

      const hasMore = rows.length > q.limit;
      const items = hasMore ? rows.slice(0, q.limit) : rows;

      // hydrate global emails
      const userIds = items.map((r) => r.userId);
      const users = userIds.length
        ? await User.find({ _id: { $in: userIds } })
            .select({ _id: 1, email: 1, emailVerified: 1 })
            .lean()
        : [];
      const userById = new Map(users.map((u) => [u._id, u]));

      res.json({
        users: items.map((p) => ({
          id: p._id,
          userId: p.userId,
          email: userById.get(p.userId)?.email ?? null,
          emailVerified: userById.get(p.userId)?.emailVerified ?? false,
          status: p.status,
          productRole: p.productRole,
          name: p.name,
          lastLoginAt: p.lastLoginAt,
          lastActiveAt: p.lastActiveAt,
          joinedAt: p.joinedAt,
          mfaEnrolledAt: p.mfaEnrolledAt,
          emailDeliverable: p.emailDeliverable,
        })),
        nextCursor: hasMore && items.length > 0 ? items[items.length - 1]?._id ?? null : null,
      });
    }),

    // ── Screen 4: Product user detail ────────────────────────────────
    getProductUserDetail: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const productId = idParam.parse(req.params['productId']);
      const userId = idParam.parse(req.params['userId']);

      const [productUser, user, subs] = await Promise.all([
        ProductUser.findOne({ productId, userId }).lean(),
        User.findById(userId).select({ passwordHash: 0 }).lean(),
        Subscription.find({ productId, $or: [{ subjectUserId: userId }] })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean(),
      ]);
      if (!productUser || !user) {
        throw new AppError(ErrorCode.USER_NOT_FOUND, 'User not found in product');
      }

      res.json({
        user: {
          id: user._id,
          email: user.email,
          emailVerified: user.emailVerified,
          createdAt: user['createdAt'],
        },
        productUser: {
          id: productUser._id,
          status: productUser.status,
          productRole: productUser.productRole,
          name: productUser.name,
          locale: productUser.locale,
          timezone: productUser.timezone,
          lastLoginAt: productUser.lastLoginAt,
          lastLoginIp: productUser.lastLoginIp,
          lastActiveAt: productUser.lastActiveAt,
          joinedAt: productUser.joinedAt,
          onboarded: productUser.onboarded,
          mfaEnrolledAt: productUser.mfaEnrolledAt,
          emailPreferences: productUser.emailPreferences,
          emailDeliverable: productUser.emailDeliverable,
          failedLoginAttempts: productUser.failedLoginAttempts,
          lockedUntil: productUser.lockedUntil,
        },
        subscriptions: subs.map((s) => ({
          id: s._id,
          status: s.status,
          planId: s.planId,
          subjectType: s.subjectType,
          currentPeriodEnd: s.currentPeriodEnd,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          isBundleParent: s.isBundleParent,
        })),
      });
    }),

    // ── Screen 5: Product workspaces ─────────────────────────────────
    listProductWorkspaces: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const productId = idParam.parse(req.params['productId']);
      const q = adminListQuerySchema.parse(req.query);

      const filter: Record<string, unknown> = { productId };
      if (q.status) filter['status'] = q.status.toUpperCase();
      if (q.q) filter['name'] = { $regex: q.q, $options: 'i' };
      if (q.cursor) filter['_id'] = { $lt: q.cursor };

      const rows = await Workspace.find(filter)
        .sort({ _id: -1 })
        .limit(q.limit + 1)
        .lean();
      const hasMore = rows.length > q.limit;
      const items = hasMore ? rows.slice(0, q.limit) : rows;

      res.json({
        workspaces: items.map((w) => ({
          id: w._id,
          name: w.name,
          slug: w.slug,
          status: w.status,
          ownerUserId: w.ownerUserId,
          billingContactUserId: w.billingContactUserId,
          suspended: w.suspended,
          suspensionReason: w.suspensionReason,
          trialConverted: w.trialConverted,
          dataDeleted: w.dataDeleted,
          voluntaryDeletionFinalizesAt: w.voluntaryDeletionFinalizesAt,
          createdAt: w['createdAt'],
        })),
        nextCursor: hasMore && items.length > 0 ? items[items.length - 1]?._id ?? null : null,
      });
    }),

    // ── Screen 6: Workspace detail ───────────────────────────────────
    getWorkspaceDetail: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const productId = idParam.parse(req.params['productId']);
      const workspaceId = idParam.parse(req.params['workspaceId']);

      const ws = await Workspace.findOne({ productId, _id: workspaceId }).lean();
      if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');

      const [subs, owner] = await Promise.all([
        Subscription.find({ productId, subjectWorkspaceId: workspaceId })
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),
        User.findById(ws.ownerUserId).select({ email: 1 }).lean(),
      ]);

      res.json({
        workspace: {
          id: ws._id,
          name: ws.name,
          slug: ws.slug,
          logoUrl: ws.logoUrl,
          status: ws.status,
          suspended: ws.suspended,
          suspensionDate: ws.suspensionDate,
          suspensionReason: ws.suspensionReason,
          ownerUserId: ws.ownerUserId,
          ownerEmail: owner?.email ?? null,
          billingContactUserId: ws.billingContactUserId,
          timezone: ws.timezone,
          settings: ws.settings,
          trialConverted: ws.trialConverted,
          dataDeleted: ws.dataDeleted,
          dataDeletedAt: ws.dataDeletedAt,
          voluntaryDeletionRequestedAt: ws.voluntaryDeletionRequestedAt,
          voluntaryDeletionFinalizesAt: ws.voluntaryDeletionFinalizesAt,
          createdAt: ws['createdAt'],
        },
        subscriptions: subs.map((s) => ({
          id: s._id,
          status: s.status,
          planId: s.planId,
          bundleId: s.bundleId,
          isBundleParent: s.isBundleParent,
          currentPeriodEnd: s.currentPeriodEnd,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        })),
      });
    }),

    // ── Screen 10: Global user search ────────────────────────────────
    searchAllUsers: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const q = searchAllUsersQuerySchema.parse(req.query);

      // emails are stored lowercase; q is matched case-insensitively
      const emailMatch = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const users = await User.find({ email: emailMatch })
        .select({ passwordHash: 0 })
        .limit(q.limit)
        .lean();

      // counts of products per user
      const ids = users.map((u) => u._id);
      const productCounts = ids.length
        ? await ProductUser.aggregate<{ _id: string; count: number }>([
            { $match: { userId: { $in: ids } } },
            { $group: { _id: '$userId', count: { $sum: 1 } } },
          ])
        : [];
      const countByUser = new Map(productCounts.map((r) => [r._id, r.count]));

      res.json({
        users: users.map((u) => ({
          id: u._id,
          email: u.email,
          emailVerified: u.emailVerified,
          createdAt: u['createdAt'],
          productCount: countByUser.get(u._id) ?? 0,
        })),
      });
    }),

    // ── Screen 12: Announcements ─────────────────────────────────────
    listAnnouncements: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const q = listAnnouncementsQuerySchema.parse(req.query);
      const filter: Record<string, unknown> = {};
      if (q.productId) filter['productId'] = q.productId;
      if (!q.includeArchived) filter['archivedAt'] = null;
      const rows = await Announcement.find(filter)
        .sort({ createdAt: -1 })
        .limit(q.limit)
        .lean();
      res.json({
        announcements: rows.map((a) => ({
          id: a._id,
          productId: a.productId,
          title: a.title,
          body: a.body,
          severity: a.severity,
          audience: a.audience,
          publishedAt: a.publishedAt,
          expiresAt: a.expiresAt,
          publishedBy: a.publishedBy,
          archivedAt: a.archivedAt,
          createdAt: a['createdAt'],
        })),
      });
    }),

    createAnnouncement: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const body = createAnnouncementRequestSchema.parse(req.body);
      const doc = await Announcement.create({
        productId: body.productId ?? null,
        title: body.title,
        body: body.body,
        severity: body.severity,
        audience: body.audience,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      await req.audit?.({
        action: 'announcement.created',
        outcome: 'success',
        ...(body.productId ? { productId: body.productId } : {}),
        resource: { type: 'announcement', id: doc._id },
        metadata: { title: body.title, severity: body.severity },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(201).json({ id: doc._id });
    }),

    updateAnnouncement: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = idParam.parse(req.params['id']);
      const body = updateAnnouncementRequestSchema.parse(req.body);
      const update: Record<string, unknown> = {};
      if (body.title !== undefined) update['title'] = body.title;
      if (body.body !== undefined) update['body'] = body.body;
      if (body.severity !== undefined) update['severity'] = body.severity;
      if (body.audience !== undefined) update['audience'] = body.audience;
      if (body.expiresAt !== undefined)
        update['expiresAt'] = body.expiresAt ? new Date(body.expiresAt) : null;
      const updated = await Announcement.findByIdAndUpdate(id, update, { new: true }).lean();
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, 'Announcement not found');
      await req.audit?.({
        action: 'announcement.updated',
        outcome: 'success',
        ...(updated.productId ? { productId: updated.productId } : {}),
        resource: { type: 'announcement', id },
        metadata: update,
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.json({ id: updated._id });
    }),

    publishAnnouncement: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = idParam.parse(req.params['id']);
      const updated = await Announcement.findByIdAndUpdate(
        id,
        { publishedAt: new Date(), publishedBy: auth.userId, archivedAt: null },
        { new: true },
      ).lean();
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, 'Announcement not found');
      await req.audit?.({
        action: 'announcement.published',
        outcome: 'success',
        ...(updated.productId ? { productId: updated.productId } : {}),
        resource: { type: 'announcement', id },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.json({ id: updated._id, publishedAt: updated.publishedAt });
    }),

    archiveAnnouncement: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = idParam.parse(req.params['id']);
      const updated = await Announcement.findByIdAndUpdate(
        id,
        { archivedAt: new Date() },
        { new: true },
      ).lean();
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, 'Announcement not found');
      await req.audit?.({
        action: 'announcement.archived',
        outcome: 'success',
        ...(updated.productId ? { productId: updated.productId } : {}),
        resource: { type: 'announcement', id },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.json({ id: updated._id });
    }),
  };
}
