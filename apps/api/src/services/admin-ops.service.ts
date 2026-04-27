/**
 * Admin operations service — Super-Admin-only utilities for v1.0:
 *  - Force a subscription status (recovery from billing-state corruption).
 *  - Apply a credit/debit adjustment to a subscription.
 *  - Cron job status snapshot + manual force-run.
 *  - Webhook delivery monitor: list / retry.
 *
 * Permissions are enforced upstream by the handler (`requireSuperAdmin`).
 * IP-allowlist enforcement happens in middleware (`super-admin-ip.ts`).
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as cronLockRepo from '../repos/cron-lock.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import type { WebhookDeliveryService } from './webhook-delivery.service.js';

const ALLOWED_FORCE_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'INCOMPLETE',
  'PAUSED',
] as const;
type AllowedForceStatus = (typeof ALLOWED_FORCE_STATUSES)[number];

export interface AdminOpsService {
  forceSubscriptionStatus(args: {
    productId: string;
    subscriptionId: string;
    status: string;
    reason: string;
    actorId: string;
  }): Promise<subscriptionRepo.SubscriptionLean>;

  applySubscriptionCredit(args: {
    productId: string;
    subscriptionId: string;
    deltaMinor: number;
    reason: string;
    actorId: string;
  }): Promise<subscriptionRepo.SubscriptionLean>;

  cronStatus(): Promise<{
    jobs: Array<{
      jobName: string;
      lastDateKey: string | null;
      lastLockedAt: Date | null;
      lastCompletedAt: Date | null;
      lastInstanceId: string | null;
    }>;
  }>;

  runWebhookDeliveryBatch(now?: Date): Promise<{
    attempted: number;
    delivered: number;
    retried: number;
    dead: number;
    skipped: number;
  }>;

  listWebhookDeliveries(query: {
    productId?: string;
    status?: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD';
    event?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    items: Array<deliveryRepo.WebhookDeliveryLean>;
    nextCursor: string | null;
  }>;

  retryWebhookDelivery(id: string): Promise<deliveryRepo.WebhookDeliveryLean>;
}

export interface CreateAdminOpsServiceOptions {
  webhookDelivery: WebhookDeliveryService;
}

export function createAdminOpsService(opts: CreateAdminOpsServiceOptions): AdminOpsService {
  return {
    async forceSubscriptionStatus(args) {
      if (!ALLOWED_FORCE_STATUSES.includes(args.status as AllowedForceStatus)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid status', {
          status: args.status,
          allowed: ALLOWED_FORCE_STATUSES,
        });
      }
      const updated = await subscriptionRepo.forceStatus({
        productId: args.productId,
        subscriptionId: args.subscriptionId,
        status: args.status as AllowedForceStatus,
        reason: args.reason,
        changedBy: args.actorId,
      });
      if (!updated) {
        throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
      }
      return updated;
    },

    async applySubscriptionCredit(args) {
      if (!Number.isInteger(args.deltaMinor) || args.deltaMinor === 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'deltaMinor must be a non-zero integer',
          { deltaMinor: args.deltaMinor },
        );
      }
      const updated = await subscriptionRepo.applyCredit({
        productId: args.productId,
        subscriptionId: args.subscriptionId,
        deltaMinor: args.deltaMinor,
        reason: args.reason,
        changedBy: args.actorId,
      });
      if (!updated) {
        throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
      }
      return updated;
    },

    async cronStatus() {
      const rows = await cronLockRepo.listLatestLocks();
      return { jobs: rows };
    },

    async runWebhookDeliveryBatch(now) {
      const out = await opts.webhookDelivery.processBatch(
        now ? { now } : {},
      );
      return out;
    },

    async listWebhookDeliveries(query) {
      const filtered: Parameters<typeof deliveryRepo.listDeliveries>[0] = {
        ...(query.productId !== undefined ? { productId: query.productId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.event !== undefined ? { event: query.event } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      };
      return deliveryRepo.listDeliveries(filtered);
    },

    async retryWebhookDelivery(id) {
      const reset = await opts.webhookDelivery.retryNow(id);
      if (!reset) throw new AppError(ErrorCode.NOT_FOUND, 'Webhook delivery not found');
      return reset;
    },
  };
}
