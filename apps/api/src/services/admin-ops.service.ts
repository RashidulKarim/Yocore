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
import * as productRepo from '../repos/product.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as authTokenRepo from '../repos/auth-token.repo.js';
import * as emailQueueRepo from '../repos/email-queue.repo.js';
import type { WebhookDeliveryService } from './webhook-delivery.service.js';

/** 1 hour TTL — matches password-reset.service.ts. */
const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

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

  /**
   * Provision a user into a product without setting a password. Marks the
   * email verified (admin trust) and — when `sendPasswordResetEmail` is
   * true — issues a `password_reset` token and queues the reset email so
   * the user can set their own password.
   *
   * Idempotent on `(productId, email)`. If the productUser already exists,
   * `created` is false; the reset email is still re-issued when requested.
   */
  provisionProductUser(args: {
    productId: string;
    email: string;
    name?: { first?: string | undefined; last?: string | undefined } | undefined;
    sendPasswordResetEmail: boolean;
    actorId: string;
    ip: string | null;
    defaultFromAddress: string;
  }): Promise<{
    user: {
      id: string;
      email: string;
      productUserId: string;
      created: boolean;
      emailVerified: boolean;
    };
    resetEmailQueued: boolean;
  }>;
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

    async provisionProductUser(args) {
      const product = await productRepo.findProductById(args.productId);
      if (!product) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Product not found');
      }
      if (product.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Product is not ACTIVE',
          { productId: args.productId, status: product.status },
        );
      }

      // 1) Find or create the global user. END_USERs keep credentials in
      //    productUsers so the global user has no passwordHash.
      let user = await userRepo.findUserByEmail(args.email);
      if (!user) {
        user = await userRepo.createUser({
          email: args.email,
          passwordHash: null,
          role: 'END_USER',
          emailVerified: true,
          emailVerifiedMethod: 'admin_provisioned',
        });
      }

      // 2) Find or create the productUser (idempotent on productId+userId).
      let productUser = await productUserRepo.findByUserAndProduct(
        product._id,
        user._id,
      );
      const created = !productUser;
      if (!productUser) {
        productUser = await productUserRepo.createProductUser({
          productId: product._id,
          userId: user._id,
          passwordHash: null,
          ...(args.name !== undefined ? { name: args.name } : {}),
          active: true,
        });
      }

      // 3) Optionally issue a password-reset token + queue the email.
      let resetEmailQueued = false;
      if (args.sendPasswordResetEmail) {
        const issued = await authTokenRepo.issueToken({
          userId: user._id,
          productId: product._id,
          type: 'password_reset',
          ttlSeconds: PASSWORD_RESET_TTL_SECONDS,
          ip: args.ip,
        });
        const fromAddress = product.settings?.fromEmail ?? args.defaultFromAddress;
        const fromName = product.settings?.fromName ?? product.name;
        await emailQueueRepo.enqueueEmail({
          productId: product._id,
          userId: user._id,
          toAddress: user.email,
          fromAddress,
          fromName,
          subject: `Set your password for ${product.name}`,
          templateId: 'auth.password_reset',
          category: 'security',
          priority: 'critical',
          templateData: {
            productSlug: product.slug,
            productName: product.name,
            resetToken: issued.token,
            expiresAt: issued.expiresAt.toISOString(),
            adminProvisioned: true,
          },
        });
        resetEmailQueued = true;
      }

      return {
        user: {
          id: user._id,
          email: user.email,
          productUserId: productUser._id,
          created,
          emailVerified: user.emailVerified ?? true,
        },
        resetEmailQueued,
      };
    },
  };
}
