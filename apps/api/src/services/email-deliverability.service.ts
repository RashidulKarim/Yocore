/**
 * Email deliverability review service — addendum #8 (V1.1-A).
 *
 * Cron `email.deliverability.review` (daily, 03:00 UTC, idempotent via
 * cronLocks) re-enables previously-disabled productUsers when they have
 * had no NEW hard bounce in the trailing 90 days:
 *
 *   - Find productUsers where `emailDeliverable=false`
 *     AND `emailDeliverableUpdatedAt <= now - 90d`.
 *   - For each, query emailEvents for any `bounced` event with
 *     `bounceType='hard'` in the last 90d for the same `userId/productId`.
 *   - If none → flip `emailDeliverable=true`, push audit log entry.
 *   - If any → extend `emailDeliverableUpdatedAt = now` (defer re-eval 90d).
 *
 * Also exposes `manualReset({ userId, productId, actorId })` for the admin
 * override endpoint `POST /v1/admin/users/:id/email-deliverability/reset`.
 *
 * `emailDeliverable` is a v1.5 field on ProductUser; `emailDeliverableUpdatedAt`
 * is added (sparse) for this cron — when missing, treated as "very old".
 */
import { ProductUser } from '../db/models/ProductUser.js';
import { EmailEvent } from '../db/models/EmailEvent.js';
import {
  computeAuditHash,
  type AuditLogRecord,
  type AuditLogStore,
} from '../middleware/audit-log.js';
import { logger } from '../lib/logger.js';

export const DELIVERABILITY_REEVAL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface EmailDeliverabilityService {
  runReviewTick(now?: Date): Promise<{ reEnabled: number; deferred: number }>;
  manualReset(args: {
    userId: string;
    productId: string;
    actorId: string;
    reason?: string | undefined;
  }): Promise<{ updated: boolean }>;
}

export interface CreateEmailDeliverabilityServiceOptions {
  auditStore: AuditLogStore;
}

export function createEmailDeliverabilityService(
  opts: CreateEmailDeliverabilityServiceOptions,
): EmailDeliverabilityService {
  return {
    async runReviewTick(now) {
      const t = now ?? new Date();
      const cutoff = new Date(t.getTime() - DELIVERABILITY_REEVAL_WINDOW_MS);
      // Candidates: undeliverable users whose flag is older than 90d (or null).
      const candidates = await ProductUser.find({
        emailDeliverable: false,
        $or: [
          { emailDeliverableUpdatedAt: { $exists: false } },
          { emailDeliverableUpdatedAt: { $lte: cutoff } },
          { emailDeliverableUpdatedAt: null },
        ],
      })
        .select('_id userId productId')
        .limit(500)
        .lean<Array<{ _id: string; userId: string; productId: string }>>();

      let reEnabled = 0;
      let deferred = 0;
      for (const c of candidates) {
        const recentBounce = await EmailEvent.findOne({
          userId: c.userId,
          productId: c.productId,
          event: 'bounced',
          bounceType: 'hard',
          ts: { $gt: cutoff },
        })
          .select('_id')
          .lean<{ _id: string } | null>();

        if (recentBounce) {
          await ProductUser.updateOne(
            { _id: c._id },
            { $set: { emailDeliverableUpdatedAt: t } },
          );
          deferred++;
          continue;
        }

        await ProductUser.updateOne(
          { _id: c._id, emailDeliverable: false },
          { $set: { emailDeliverable: true, emailDeliverableUpdatedAt: t } },
        );
        try {
          await appendDeliverabilityAudit(opts.auditStore, {
            productId: c.productId,
            actor: { type: 'system', id: 'cron:email.deliverability.review' },
            action: 'email.deliverability.re_enabled',
            resource: { type: 'product_user', id: c._id },
            metadata: { userId: c.userId, reason: 'no_hard_bounce_90d' },
          });
        } catch (err) {
          logger.warn({ err, productUserId: c._id }, 'audit append failed (deliverability)');
        }
        reEnabled++;
      }
      return { reEnabled, deferred };
    },

    async manualReset({ userId, productId, actorId, reason }) {
      const res = await ProductUser.updateOne(
        { userId, productId, emailDeliverable: false },
        { $set: { emailDeliverable: true, emailDeliverableUpdatedAt: new Date() } },
      );
      if (res.modifiedCount === 0) return { updated: false };
      try {
        await appendDeliverabilityAudit(opts.auditStore, {
          productId,
          actor: { type: 'super_admin', id: actorId },
          action: 'email.deliverability.manual_reset',
          resource: { type: 'product_user', id: userId },
          metadata: { reason: reason ?? null },
        });
      } catch (err) {
        logger.warn({ err, userId, productId }, 'audit append failed (deliverability reset)');
      }
      return { updated: true };
    },
  };
}

async function appendDeliverabilityAudit(
  store: AuditLogStore,
  event: {
    productId: string | null;
    actor: { type: 'system' | 'super_admin' | 'user' | 'product' | 'webhook'; id: string };
    action: string;
    resource: { type: string; id: string };
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const body: Omit<AuditLogRecord, 'prevHash' | 'hash'> = {
    ts: new Date(),
    productId: event.productId,
    workspaceId: null,
    actor: {
      type: event.actor.type,
      id: event.actor.id,
      ip: null,
      userAgent: null,
      apiKeyId: null,
      sessionId: null,
      correlationId: null,
    },
    action: event.action,
    resource: event.resource,
    outcome: 'success',
    reason: null,
    metadata: event.metadata ?? {},
  };
  await store.append(body, (prev) => computeAuditHash(prev, body));
}
