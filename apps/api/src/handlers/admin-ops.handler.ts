/**
 * Super-Admin operational handlers (V1.0-B/C/D):
 *   - Subscription force-status / credit (V1.0-D)
 *   - Cron status / force-run (V1.0-D)
 *   - Webhook deliveries list/retry (V1.0-D)
 *   - JWT key rotate (V1.0-C / Flow Y)
 *   - Super-Admin config (IP allowlist) (V1.0-C / B-18)
 *   - ToS / Privacy publish (V1.0-B / B-05)
 *
 * All require SUPER_ADMIN session (validated inline). Mounted under
 * `/v1/admin/*` so the IP-allowlist middleware also gates them.
 */
import type { Request, Response, RequestHandler } from 'express';
import { Types } from 'mongoose';
import {
  forceSubscriptionStatusRequestSchema,
  applySubscriptionCreditRequestSchema,
  forceCronRunRequestSchema,
  listWebhookDeliveriesQuerySchema,
  updateSuperAdminConfigRequestSchema,
  publishTosVersionRequestSchema,
  resetEmailDeliverabilityRequestSchema,
  extendTrialRequestSchema,
  extendGraceRequestSchema,
  exportAuditLogQuerySchema,
} from '@yocore/types';
import { AppError, ErrorCode } from '../lib/errors.js';
import { requireSuperAdmin } from '../middleware/jwt-auth.js';
import { asyncHandler } from './index.js';
import { SuperAdminConfig } from '../db/models/SuperAdminConfig.js';
import { TosVersion } from '../db/models/TosVersion.js';
import { Subscription } from '../db/models/Subscription.js';
import { AuditLog } from '../db/models/AuditLog.js';
import { SUPER_ADMIN_CONFIG_RELOAD_CHANNEL } from '../middleware/super-admin-ip.js';
import type { AppContext } from '../context.js';

export interface AdminOpsHandlers {
  forceSubscriptionStatus: RequestHandler;
  applySubscriptionCredit: RequestHandler;
  cronStatus: RequestHandler;
  forceCronRun: RequestHandler;
  listWebhookDeliveries: RequestHandler;
  retryWebhookDelivery: RequestHandler;
  rotateJwtKey: RequestHandler;
  getSuperAdminConfig: RequestHandler;
  updateSuperAdminConfig: RequestHandler;
  publishTosVersion: RequestHandler;
  listTosVersions: RequestHandler;
  resetEmailDeliverability: RequestHandler;
  extendTrial: RequestHandler;
  extendGrace: RequestHandler;
  exportAuditLog: RequestHandler;
}

export function adminOpsHandlerFactory(ctx: AppContext): AdminOpsHandlers {
  return {
    // ── Subscriptions ───────────────────────────────────────────────────
    forceSubscriptionStatus: asyncHandler(async (req: Request, res: Response) => {
      const auth = requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const productId = req.params['productId'] ?? '';
      const body = forceSubscriptionStatusRequestSchema.parse(req.body);
      const result = await ctx.adminOps.forceSubscriptionStatus({
        productId,
        subscriptionId: id,
        status: body.status,
        reason: body.reason,
        actorId: auth.userId,
      });
      await req.audit?.({
        action: 'subscription.force_status',
        outcome: 'success',
        productId,
        resource: { type: 'subscription', id },
        metadata: { status: body.status, reason: body.reason },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json(result);
    }),

    applySubscriptionCredit: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const productId = req.params['productId'] ?? '';
      const body = applySubscriptionCreditRequestSchema.parse(req.body);
      const result = await ctx.adminOps.applySubscriptionCredit({
        productId,
        subscriptionId: id,
        deltaMinor: body.deltaMinor,
        reason: body.reason,
        actorId: auth.userId,
      });
      await req.audit?.({
        action: 'subscription.credit_adjust',
        outcome: 'success',
        productId,
        resource: { type: 'subscription', id },
        metadata: { deltaMinor: body.deltaMinor, reason: body.reason },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json(result);
    }),

    // ── Cron ────────────────────────────────────────────────────────────
    cronStatus: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const result = await ctx.adminOps.cronStatus();
      res.status(200).json(result);
    }),

    forceCronRun: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const body = forceCronRunRequestSchema.parse(req.body);
      let result: unknown;
      switch (body.jobName) {
        case 'webhook.delivery.tick':
          result = await ctx.adminOps.runWebhookDeliveryBatch();
          break;
        case 'jwt.key.retire':
          result = await ctx.jwtRotation.retireExpiredVerifyingKeys();
          break;
        case 'gdpr.deletion.tick':
          result = await ctx.gdprDeletion.runDeletionTick();
          break;
        case 'gdpr.dataExport.tick':
          result = await ctx.dataExport.runExportTick();
          break;
        case 'email.deliverability.review':
          result = await ctx.emailDeliverability.runReviewTick();
          break;
        case 'webhook.archive.tick':
          result = await ctx.webhookArchive.runArchiveTick();
          break;
        default:
          // billing/bundle ticks go through the cron registry directly.
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            `Job ${body.jobName} cannot be force-run via this endpoint`,
          );
      }
      await req.audit?.({
        action: 'cron.force_run',
        outcome: 'success',
        resource: { type: 'cron', id: body.jobName },
        metadata: { jobName: body.jobName },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({ jobName: body.jobName, result });
    }),

    // ── Webhook deliveries ──────────────────────────────────────────────
    listWebhookDeliveries: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const query = listWebhookDeliveriesQuerySchema.parse(req.query);
      const result = await ctx.adminOps.listWebhookDeliveries(query);
      res.status(200).json(result);
    }),

    retryWebhookDelivery: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const id = req.params['id'] ?? '';
      const result = await ctx.adminOps.retryWebhookDelivery(id);
      await req.audit?.({
        action: 'webhook.delivery.retry',
        outcome: 'success',
        resource: { type: 'webhook_delivery', id },
        metadata: {},
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json(result);
    }),

    // ── JWT key rotation ────────────────────────────────────────────────
    rotateJwtKey: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const result = await ctx.jwtRotation.rotateActiveKey({
        type: 'super_admin',
        id: auth.userId,
      });
      res.status(200).json({
        newKid: result.newKid,
        oldKid: result.oldKid,
        verifyUntil: result.verifyUntil.toISOString(),
      });
    }),

    // ── Super-Admin config (IP allowlist) ───────────────────────────────
    getSuperAdminConfig: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const doc = await SuperAdminConfig.findById('super_admin_config').lean<{
        _id: string;
        adminIpAllowlist?: string[];
        adminIpAllowlistEnabled?: boolean;
      } | null>();
      res.status(200).json({
        adminIpAllowlist: doc?.adminIpAllowlist ?? [],
        adminIpAllowlistEnabled: doc?.adminIpAllowlistEnabled ?? false,
      });
    }),

    updateSuperAdminConfig: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const body = updateSuperAdminConfigRequestSchema.parse(req.body);
      const update: Record<string, unknown> = { _id: 'super_admin_config' };
      if (body.adminIpAllowlist !== undefined) update['adminIpAllowlist'] = body.adminIpAllowlist;
      if (body.adminIpAllowlistEnabled !== undefined)
        update['adminIpAllowlistEnabled'] = body.adminIpAllowlistEnabled;
      const doc = await SuperAdminConfig.findOneAndUpdate(
        { _id: 'super_admin_config' },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean<{
        adminIpAllowlist?: string[];
        adminIpAllowlistEnabled?: boolean;
      } | null>();
      // Broadcast cache-invalidation to peer pods.
      try {
        await ctx.redis.publish(SUPER_ADMIN_CONFIG_RELOAD_CHANNEL, '1');
      } catch {
        /* non-fatal */
      }
      await req.audit?.({
        action: 'super_admin.config.updated',
        outcome: 'success',
        resource: { type: 'super_admin_config', id: 'super_admin_config' },
        metadata: {
          fields: Object.keys(body),
          enabled: body.adminIpAllowlistEnabled ?? doc?.adminIpAllowlistEnabled ?? false,
          cidrCount: body.adminIpAllowlist?.length ?? doc?.adminIpAllowlist?.length ?? 0,
        },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({
        adminIpAllowlist: doc?.adminIpAllowlist ?? [],
        adminIpAllowlistEnabled: doc?.adminIpAllowlistEnabled ?? false,
      });
    }),

    // ── ToS publish ─────────────────────────────────────────────────────
    publishTosVersion: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const body = publishTosVersionRequestSchema.parse(req.body);
      // Demote previous current of same type, then insert new isCurrent:true.
      const session = await TosVersion.startSession();
      let created: { _id: string; type: string; version: string; effectiveAt: Date } | null = null;
      try {
        await session.withTransaction(async () => {
          await TosVersion.updateMany(
            { type: body.type, isCurrent: true },
            { $set: { isCurrent: false } },
            { session },
          );
          const docs = await TosVersion.create(
            [
              {
                type: body.type,
                version: body.version,
                effectiveAt: new Date(body.effectiveAt),
                contentUrl: body.contentUrl,
                contentHash: body.contentHash,
                changeSummary: body.changeSummary ?? null,
                publishedBy: auth.userId,
                isCurrent: true,
              },
            ],
            { session },
          );
          const first = docs[0];
          if (!first) throw new AppError(ErrorCode.INTERNAL_ERROR, 'TosVersion not created');
          created = {
            _id: first._id,
            type: first.type,
            version: first.version,
            effectiveAt: first.effectiveAt,
          };
        });
      } catch (e) {
        // Detect duplicate version for type.
        if (
          e instanceof Error &&
          'code' in e &&
          (e as { code?: number }).code === 11000
        ) {
          throw new AppError(
            ErrorCode.RESOURCE_CONFLICT,
            `${body.type} version ${body.version} already exists`,
          );
        }
        throw e;
      } finally {
        await session.endSession();
      }
      const out = created as unknown as { _id: string; type: string; version: string; effectiveAt: Date };
      await req.audit?.({
        action: 'tos.published',
        outcome: 'success',
        resource: { type: 'tos_version', id: out._id },
        metadata: { type: out.type, version: out.version },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(201).json({
        id: out._id,
        type: out.type,
        version: out.version,
        effectiveAt: out.effectiveAt.toISOString(),
      });
    }),

    listTosVersions: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const type = String(req.query['type'] ?? '');
      const filter: Record<string, unknown> = {};
      if (type === 'terms_of_service' || type === 'privacy_policy') filter['type'] = type;
      const rows = await TosVersion.find(filter)
        .sort({ publishedAt: -1 })
        .limit(50)
        .lean<
          Array<{
            _id: string;
            type: string;
            version: string;
            effectiveAt: Date;
            publishedAt: Date;
            isCurrent: boolean;
            contentUrl: string;
            contentHash: string;
            changeSummary: string | null;
          }>
        >();
      res.status(200).json({
        versions: rows.map((r) => ({
          id: r._id,
          type: r.type,
          version: r.version,
          effectiveAt: r.effectiveAt.toISOString(),
          publishedAt: r.publishedAt.toISOString(),
          isCurrent: r.isCurrent,
          contentUrl: r.contentUrl,
          contentHash: r.contentHash,
          changeSummary: r.changeSummary,
        })),
      });
    }),

    // ── Email deliverability admin reset (V1.1-A / addendum #8) ───────
    resetEmailDeliverability: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const userId = req.params['id'] ?? '';
      const body = resetEmailDeliverabilityRequestSchema.parse(req.body ?? {});
      const result = await ctx.emailDeliverability.manualReset({
        userId,
        productId: body.productId,
        actorId: auth.userId,
        reason: body.reason,
      });
      res.status(200).json({ updated: result.updated });
    }),

    // ── V1.1-C admin: extend trial ───────────────────────────────
    extendTrial: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const productId = req.params['productId'] ?? '';
      const subscriptionId = req.params['id'] ?? '';
      const body = extendTrialRequestSchema.parse(req.body);
      const sub = await Subscription.findOne({ _id: subscriptionId, productId })
        .select('_id status trialEndsAt')
        .lean<{ _id: string; status: string; trialEndsAt: Date | null } | null>();
      if (!sub) throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
      if (sub.status !== 'TRIALING') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Subscription is not TRIALING');
      }
      const base = sub.trialEndsAt ?? new Date();
      const newEnd = new Date(base.getTime() + body.additionalDays * 86_400_000);
      await Subscription.updateOne({ _id: subscriptionId }, { $set: { trialEndsAt: newEnd } });
      await req.audit?.({
        action: 'subscription.trial_extended',
        outcome: 'success',
        productId,
        resource: { type: 'subscription', id: subscriptionId },
        metadata: {
          additionalDays: body.additionalDays,
          newTrialEndsAt: newEnd.toISOString(),
          reason: body.reason,
        },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({
        subscriptionId,
        trialEndsAt: newEnd.toISOString(),
        additionalDays: body.additionalDays,
      });
    }),

    // ── V1.1-C admin: extend grace (shift paymentFailedAt earlier so the
    //                              D+1/D+5/D+7 ladder fires later) ────────
    extendGrace: asyncHandler(async (req, res) => {
      const auth = requireSuperAdmin(req);
      const productId = req.params['productId'] ?? '';
      const subscriptionId = req.params['id'] ?? '';
      const body = extendGraceRequestSchema.parse(req.body);
      const sub = await Subscription.findOne({ _id: subscriptionId, productId })
        .select('_id status paymentFailedAt')
        .lean<{ _id: string; status: string; paymentFailedAt: Date | null } | null>();
      if (!sub) throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
      if (sub.status !== 'PAST_DUE') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Subscription is not PAST_DUE');
      }
      const base = sub.paymentFailedAt ?? new Date();
      const shifted = new Date(base.getTime() + body.additionalDays * 86_400_000);
      await Subscription.updateOne(
        { _id: subscriptionId },
        { $set: { paymentFailedAt: shifted } },
      );
      await req.audit?.({
        action: 'subscription.grace_extended',
        outcome: 'success',
        productId,
        resource: { type: 'subscription', id: subscriptionId },
        metadata: {
          additionalDays: body.additionalDays,
          newPaymentFailedAt: shifted.toISOString(),
          reason: body.reason,
        },
        actor: { type: 'super_admin', id: auth.userId },
      });
      res.status(200).json({
        subscriptionId,
        paymentFailedAt: shifted.toISOString(),
        additionalDays: body.additionalDays,
      });
    }),

    // ── V1.1-C admin: audit-log export (GAP-21) ──────────────────────
    exportAuditLog: asyncHandler(async (req, res) => {
      requireSuperAdmin(req);
      const q = exportAuditLogQuerySchema.parse(req.query);
      const filter: Record<string, unknown> = {};
      if (q.productId) filter['productId'] = q.productId;
      if (q.actorId) filter['actor.id'] = q.actorId;
      if (q.action) filter['action'] = q.action;
      if (q.from || q.to) {
        const ts: Record<string, Date> = {};
        if (q.from) ts['$gte'] = new Date(q.from);
        if (q.to) ts['$lte'] = new Date(q.to);
        filter['ts'] = ts;
      }
      const cursor = AuditLog.find(filter).sort({ ts: -1 }).limit(q.limit).cursor();
      if (q.format === 'ndjson') {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Content-Disposition', 'attachment; filename="audit-log.ndjson"');
        for await (const doc of cursor) {
          const o = (doc as { toObject: () => Record<string, unknown> }).toObject();
          res.write(JSON.stringify(o) + '\n');
        }
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.json"');
      const rows: unknown[] = [];
      for await (const doc of cursor) {
        rows.push((doc as { toObject: () => Record<string, unknown> }).toObject());
      }
      res.status(200).json({ count: rows.length, rows });
    }),
  };
}

// Mongoose Types import preserved for ObjectId checks elsewhere if needed.
void Types;
