/**
 * Failed-payment grace service — Phase 3.4 Wave 11 (Flow N).
 *
 * Cron `billing.grace.tick` (every 5 minutes, hourly Mongo lock keys) scans
 * all PAST_DUE subscriptions and walks the grace ladder:
 *
 *   D+1  → email "Your last payment failed" (bucket `day1`).
 *   D+5  → email reminder (bucket `day5`).
 *   D+7  → final email + suspendForBillingHold(workspace) +
 *          cancelForGrace(subscription) + emit `subscription.canceled`.
 *
 * Buckets are stored on the subscription doc in `graceEmailsSent.{day1,
 * day5, day7}` and reset whenever `markPaymentFailed` is called for a new
 * cycle. The cron is idempotent because we check the bucket flags before
 * sending.
 */
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as workspaceRepo from '../repos/workspace.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import { enqueueEmail } from '../repos/email-queue.repo.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import {
  computeAuditHash,
  type AuditLogRecord,
  type AuditLogStore,
} from '../middleware/audit-log.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const D1_MS = 1 * DAY_MS;
const D5_MS = 5 * DAY_MS;
const D7_MS = 7 * DAY_MS;

export interface GraceTickReport {
  scanned: number;
  emailedDay1: number;
  emailedDay5: number;
  emailedDay7: number;
  canceled: number;
  errors: number;
}

export interface GraceService {
  runGraceTick(opts?: { now?: Date }): Promise<GraceTickReport>;
}

export interface CreateGraceServiceOptions {
  auditStore: AuditLogStore;
  defaultFromAddress?: string;
}

export function createGraceService(opts: CreateGraceServiceOptions): GraceService {
  const fromAddress = opts.defaultFromAddress ?? env.EMAIL_FROM_DEFAULT;
  const auditStore = opts.auditStore;

  return {
    async runGraceTick({ now: nowOverride } = {}) {
      const now = nowOverride ?? new Date();
      const horizon = new Date(now.getTime() - D1_MS);
      const subs = await subscriptionRepo.listPastDueOlderThan(horizon);

      const report: GraceTickReport = {
        scanned: subs.length,
        emailedDay1: 0,
        emailedDay5: 0,
        emailedDay7: 0,
        canceled: 0,
        errors: 0,
      };

      for (const sub of subs) {
        try {
          if (!sub.paymentFailedAt) continue;
          const elapsed = now.getTime() - sub.paymentFailedAt.getTime();
          const flags = (sub.graceEmailsSent ?? {}) as {
            day1?: boolean;
            day5?: boolean;
            day7?: boolean;
          };

          // Resolve product + workspace + billing contact.
          const product = await productRepo.findProductById(sub.productId);
          if (!product) continue;
          const ws =
            sub.subjectType === 'workspace' && sub.subjectWorkspaceId
              ? await workspaceRepo.findById(sub.productId, sub.subjectWorkspaceId)
              : null;
          const contactUserId =
            ws?.billingContactUserId ?? sub.subjectUserId ?? null;
          const userEmail = contactUserId
            ? await resolveUserEmail(sub.productId, contactUserId)
            : null;

          // ── D+7 finalize ──────────────────────────────────────────
          if (elapsed >= D7_MS) {
            if (!flags.day7 && userEmail && contactUserId) {
              await enqueueEmail({
                productId: sub.productId,
                userId: contactUserId,
                toAddress: userEmail,
                fromAddress,
                subject: 'Your subscription has been canceled',
                templateId: 'billing.grace.day7',
                templateData: {
                  subscriptionId: sub._id,
                  ...(ws ? { workspaceId: ws._id } : {}),
                },
                priority: 'critical',
              }).catch(() => undefined);
              await subscriptionRepo.markGraceEmailSent(sub._id, 'day7');
              report.emailedDay7 += 1;
            }
            const canceled = await subscriptionRepo.cancelForGrace({
              subscriptionId: sub._id,
              reason: 'payment_failed_grace_expired',
              at: now,
            });
            if (canceled) {
              if (ws) {
                await workspaceRepo.suspendForBillingHold(sub.productId, ws._id, now);
              }
              if (product.webhookUrl) {
                await deliveryRepo
                  .enqueueDelivery({
                    productId: sub.productId,
                    event: 'subscription.canceled',
                    eventId: `evt_grace_cancel_${sub._id}`,
                    url: product.webhookUrl,
                    payloadRef: sub._id,
                  })
                  .catch(() => undefined);
              }
              await appendCronAudit(auditStore, {
                action: 'subscription.canceled',
                outcome: 'success',
                productId: sub.productId,
                workspaceId: ws?._id ?? null,
                resource: { type: 'subscription', id: sub._id },
                reason: 'payment_failed_grace_expired',
                metadata: {},
              }).catch(() => undefined);
              report.canceled += 1;
            }
            continue;
          }

          // ── D+5 reminder ──────────────────────────────────────────
          if (elapsed >= D5_MS && !flags.day5 && userEmail && contactUserId) {
            await enqueueEmail({
              productId: sub.productId,
              userId: contactUserId,
              toAddress: userEmail,
              fromAddress,
              subject: 'Reminder: payment failed — update your payment method',
              templateId: 'billing.grace.day5',
              templateData: {
                subscriptionId: sub._id,
                ...(ws ? { workspaceId: ws._id } : {}),
              },
              priority: 'critical',
            }).catch(() => undefined);
            await subscriptionRepo.markGraceEmailSent(sub._id, 'day5');
            report.emailedDay5 += 1;
            continue;
          }

          // ── D+1 first warning ─────────────────────────────────────
          if (elapsed >= D1_MS && !flags.day1 && userEmail && contactUserId) {
            await enqueueEmail({
              productId: sub.productId,
              userId: contactUserId,
              toAddress: userEmail,
              fromAddress,
              subject: 'We could not process your payment',
              templateId: 'billing.grace.day1',
              templateData: {
                subscriptionId: sub._id,
                ...(ws ? { workspaceId: ws._id } : {}),
              },
              priority: 'critical',
            }).catch(() => undefined);
            await subscriptionRepo.markGraceEmailSent(sub._id, 'day1');
            report.emailedDay1 += 1;
          }
        } catch (err) {
          report.errors += 1;
          logger.error(
            { err, subscriptionId: sub._id, productId: sub.productId },
            'grace.tick.error',
          );
        }
      }

      logger.info({ event: 'grace.tick', ...report }, 'billing.grace.tick complete');
      return report;
    },
  };
}

async function resolveUserEmail(
  productId: string,
  userId: string,
): Promise<string | null> {
  const productUser = await productUserRepo.findByUserAndProduct(productId, userId);
  if (!productUser) return null;
  const user = await userRepo.findUserById(userId);
  return user?.email ?? null;
}

async function appendCronAudit(
  store: AuditLogStore,
  event: {
    action: string;
    outcome: 'success' | 'failure';
    productId: string | null;
    workspaceId: string | null;
    resource?: { type: string; id: string };
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const body: Omit<AuditLogRecord, 'prevHash' | 'hash'> = {
    ts: new Date(),
    productId: event.productId,
    workspaceId: event.workspaceId,
    actor: {
      type: 'system',
      id: 'cron:billing.grace.tick',
      ip: null,
      userAgent: null,
      apiKeyId: null,
      sessionId: null,
      correlationId: null,
    },
    action: event.action,
    resource: { type: event.resource?.type ?? null, id: event.resource?.id ?? null },
    outcome: event.outcome,
    reason: event.reason ?? null,
    metadata: event.metadata ?? {},
  };
  await store.append(body, (prev) => computeAuditHash(prev, body));
}
