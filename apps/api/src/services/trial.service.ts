/**
 * Trial service — Phase 3.4 Wave 4 (Flow G — Path 2: Free trial).
 *
 * Two responsibilities:
 *   1. `startFreeTrial` — provision a TRIALING subscription with no gateway
 *      attached. The plan must declare `trialDays > 0`. Single-active
 *      guard same as checkout. Resets the workspace's trial-warning
 *      bookkeeping.
 *   2. `runTrialTick` — invoked by the `billing.trial.tick` cron. Scans
 *      TRIALING subs and:
 *        - sends 3-day / 1-day warning emails (idempotent via
 *          `workspaces.trialWarningSent.{days3,days1}`)
 *        - on `trialEndsAt ≤ now` for gateway-less trials, cancels the
 *          subscription (`cancelReason: 'trial_no_payment_method'`) and
 *          suspends the workspace (`suspensionReason: 'trial_expired'`).
 *
 * Stripe-managed trials (where `gateway === 'stripe'`) are converted by
 * Stripe-side `customer.subscription.updated` webhooks and are skipped by
 * the cron expiry branch. The cron still emits warning emails for them.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as workspaceRepo from '../repos/workspace.repo.js';
import * as memberRepo from '../repos/workspace-member.repo.js';
import * as productUserRepo from '../repos/product-user.repo.js';
import * as userRepo from '../repos/user.repo.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import { enqueueEmail } from '../repos/email-queue.repo.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import {
  computeAuditHash,
  type AuditLogStore,
  type AuditLogRecord,
} from '../middleware/audit-log.js';
import type { StartTrialRequest, StartTrialResponse } from '@yocore/types';

const DAY_MS = 86_400_000;
const WARN_3D_MS = 3 * DAY_MS;
const WARN_1D_MS = 1 * DAY_MS;

export interface StartTrialContext {
  userId: string;
  productId: string;
}

export interface TrialService {
  startFreeTrial(actor: StartTrialContext, input: StartTrialRequest): Promise<StartTrialResponse>;
  runTrialTick(opts?: { now?: Date }): Promise<TrialTickReport>;
}

export interface TrialTickReport {
  scanned: number;
  warned3d: number;
  warned1d: number;
  expired: number;
  errors: number;
}

export interface CreateTrialServiceOptions {
  auditStore: AuditLogStore;
  defaultFromAddress?: string;
}

export function createTrialService(opts: CreateTrialServiceOptions): TrialService {
  const fromAddress = opts.defaultFromAddress ?? env.EMAIL_FROM_DEFAULT;
  const auditStore = opts.auditStore;

  return {
    async startFreeTrial(actor, input) {
      // ── Plan + product ────────────────────────────────────────────
      const plan = await planRepo.findPlanById(actor.productId, input.planId);
      if (!plan) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Plan not found');
      if (plan.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.BILLING_PLAN_NOT_PUBLISHED, 'Plan not published');
      }
      if (!plan.trialDays || plan.trialDays <= 0) {
        throw new AppError(
          ErrorCode.BILLING_TRIAL_INELIGIBLE,
          'Plan does not offer a trial period',
          { field: 'planId' },
        );
      }
      if (plan.isFree) {
        throw new AppError(
          ErrorCode.BILLING_TRIAL_INELIGIBLE,
          'Free plans cannot have a trial',
        );
      }

      const product = await productRepo.findProductById(actor.productId);
      if (!product) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      if (product.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not active');
      }

      // ── Subject (workspace vs user) ───────────────────────────────
      const subjectType: 'user' | 'workspace' =
        product.billingScope === 'user' ? 'user' : 'workspace';
      let subjectWorkspaceId: string | null = null;
      let subjectUserId: string | null = null;

      if (subjectType === 'workspace') {
        if (!input.workspaceId) {
          throw new AppError(
            ErrorCode.VALIDATION_FAILED,
            'workspaceId is required for workspace-scoped products',
            { field: 'workspaceId' },
          );
        }
        const ws = await workspaceRepo.findById(actor.productId, input.workspaceId);
        if (!ws) throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
        if (ws.status !== 'ACTIVE') {
          throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not active');
        }
        const member = await memberRepo.findMember(actor.productId, ws._id, actor.userId);
        if (!member || member.status !== 'ACTIVE') {
          throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a member of this workspace');
        }
        if (member.roleSlug !== 'OWNER' && member.roleSlug !== 'ADMIN') {
          throw new AppError(
            ErrorCode.PERMISSION_DENIED,
            'Only OWNER or ADMIN can start a trial',
          );
        }
        subjectWorkspaceId = ws._id;
      } else {
        subjectUserId = actor.userId;
      }

      // ── Single-active subscription guard ──────────────────────────
      const existing = await subscriptionRepo.findActiveBySubject({
        productId: actor.productId,
        subjectType,
        subjectUserId,
        subjectWorkspaceId,
      });
      if (existing) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'An active subscription already exists for this subject',
          { subscriptionId: existing._id },
        );
      }

      // ── Insert TRIALING subscription ──────────────────────────────
      const now = new Date();
      const trialEndsAt = new Date(now.getTime() + plan.trialDays * DAY_MS);
      const sub = await subscriptionRepo.createTrialing({
        productId: actor.productId,
        planId: plan._id,
        subjectType,
        subjectUserId,
        subjectWorkspaceId,
        amount: plan.amount ?? 0,
        currency: plan.currency ?? 'usd',
        trialStartsAt: now,
        trialEndsAt,
      });

      // ── Reset workspace warning bookkeeping (workspace-scoped only) ─
      if (subjectType === 'workspace' && subjectWorkspaceId) {
        await workspaceRepo.resetTrialWarnings(actor.productId, subjectWorkspaceId);
      }

      logger.info(
        {
          productId: actor.productId,
          userId: actor.userId,
          planId: plan._id,
          subscriptionId: sub._id,
          trialEndsAt,
        },
        'trial.started',
      );

      return {
        subscriptionId: sub._id,
        status: 'TRIALING',
        trialEndsAt: trialEndsAt.toISOString(),
      };
    },

    async runTrialTick({ now: nowOverride } = {}) {
      const now = nowOverride ?? new Date();
      const horizon = new Date(now.getTime() + WARN_3D_MS);
      const subs = await subscriptionRepo.listTrialingDueBefore(horizon);

      const report: TrialTickReport = {
        scanned: subs.length,
        warned3d: 0,
        warned1d: 0,
        expired: 0,
        errors: 0,
      };

      for (const sub of subs) {
        try {
          const trialEndsAt = sub.trialEndsAt;
          if (!trialEndsAt) continue;
          const msUntil = trialEndsAt.getTime() - now.getTime();
          const expired = msUntil <= 0;

          // Resolve workspace (only workspace-scoped subs get warnings).
          const ws =
            sub.subjectType === 'workspace' && sub.subjectWorkspaceId
              ? await workspaceRepo.findById(sub.productId, sub.subjectWorkspaceId)
              : null;

          // ── Expiry (Scenario B — no payment method) ─────────────
          if (expired && (sub.gateway === null || sub.gateway === undefined)) {
            const canceled = await subscriptionRepo.cancelTrialNoPaymentMethod(sub._id, now);
            if (!canceled) continue; // raced to another worker

            if (ws) {
              await workspaceRepo.suspendForTrialExpiry(sub.productId, ws._id, now);
            }

            // Outbound webhook (delivery worker is Phase 3.8).
            const product = await productRepo.findProductById(sub.productId);
            if (product?.webhookUrl) {
              await deliveryRepo
                .enqueueDelivery({
                  productId: sub.productId,
                  event: 'subscription.trial_expired',
                  eventId: `evt_trial_exp_${sub._id}`,
                  url: product.webhookUrl,
                  payloadRef: sub._id,
                })
                .catch(() => undefined);
            }

            // Audit (cron actor).
            await appendCronAudit(auditStore, {
              action: 'subscription.trial_expired',
              outcome: 'success',
              productId: sub.productId,
              workspaceId: ws?._id ?? null,
              resource: { type: 'subscription', id: sub._id },
              reason: 'trial_no_payment_method',
              metadata: { workspaceId: ws?._id ?? null },
            }).catch(() => undefined);

            report.expired += 1;
            continue;
          }

          // ── 1-day warning ───────────────────────────────────────
          if (
            !expired &&
            msUntil <= WARN_1D_MS &&
            ws &&
            !ws.trialWarningSent?.days1
          ) {
            await sendTrialWarning({
              productId: sub.productId,
              workspaceId: ws._id,
              subscriptionId: sub._id,
              userId: ws.billingContactUserId,
              bucket: 'days1',
              trialEndsAt,
              fromAddress,
            });
            await workspaceRepo.markTrialWarningSent(sub.productId, ws._id, 'days1');
            report.warned1d += 1;
            continue;
          }

          // ── 3-day warning ───────────────────────────────────────
          if (
            !expired &&
            msUntil <= WARN_3D_MS &&
            ws &&
            !ws.trialWarningSent?.days3
          ) {
            await sendTrialWarning({
              productId: sub.productId,
              workspaceId: ws._id,
              subscriptionId: sub._id,
              userId: ws.billingContactUserId,
              bucket: 'days3',
              trialEndsAt,
              fromAddress,
            });
            await workspaceRepo.markTrialWarningSent(sub.productId, ws._id, 'days3');
            report.warned3d += 1;
            continue;
          }
        } catch (err) {
          report.errors += 1;
          logger.error(
            { err, subscriptionId: sub._id, productId: sub.productId },
            'trial.tick.error',
          );
        }
      }

      logger.info({ event: 'trial.tick', ...report }, 'billing.trial.tick complete');
      return report;
    },
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

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
      id: 'cron:billing.trial.tick',
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

async function sendTrialWarning(args: {
  productId: string;
  workspaceId: string;
  subscriptionId: string;
  userId: string;
  bucket: 'days3' | 'days1';
  trialEndsAt: Date;
  fromAddress: string;
}): Promise<void> {
  const productUser = await productUserRepo.findByUserAndProduct(args.productId, args.userId);
  const user = productUser ? await userRepo.findUserById(args.userId) : null;
  if (!user?.email) return;

  await enqueueEmail({
    productId: args.productId,
    userId: args.userId,
    toAddress: user.email,
    fromAddress: args.fromAddress,
    subject:
      args.bucket === 'days1'
        ? 'Your trial ends in 1 day'
        : 'Your trial ends in 3 days',
    templateId: `billing.trial.warning_${args.bucket}`,
    templateData: {
      trialEndsAt: args.trialEndsAt.toISOString(),
      workspaceId: args.workspaceId,
      subscriptionId: args.subscriptionId,
    },
    priority: 'normal',
    category: 'billing',
  });
}
