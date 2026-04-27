/**
 * Phase 3.5 — Bundle checkout service (Flow T) + Stripe webhook bundle dispatch.
 *
 * Flow T (System-Design §5.7.1):
 *   1. Validate bundle ACTIVE + visibility/grantedAccess for caller.
 *   2. Eligibility check per component (block/cancel_and_credit/replace_immediately).
 *   3. Resolve currency variant + Stripe price.
 *   4. Find-or-create Stripe customer on FIRST component product's Stripe acct.
 *   5. Create Stripe Checkout session w/ metadata.yocoreBundleId + subjects map.
 *   6. Webhook handler (handleBundleCheckoutCompleted) creates parent + N child
 *      subscriptions in Mongo on `checkout.session.completed`.
 *
 * Cancel: POST /v1/billing/bundles/:id/cancel — sets parent to CANCELED;
 *         the AK cron cascade handles children (within 24h).
 */
import type { Redis } from 'ioredis';
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { logger } from '../lib/logger.js';
import * as bundleRepo from '../repos/bundle.repo.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import * as workspaceRepo from '../repos/workspace.repo.js';
import type { StripeApi } from './checkout.service.js';
import type {
  BundleCheckoutRequest,
  BundleCheckoutResponse,
  BundleCancelResponse,
} from '@yocore/types';

export interface BundleCheckoutContext {
  userId: string;
  email: string | null;
  displayName?: string | null;
}

export interface BundleCheckoutService {
  createBundleCheckout(
    actor: BundleCheckoutContext,
    input: BundleCheckoutRequest,
  ): Promise<BundleCheckoutResponse>;
  cancelBundleSubscription(
    actor: { userId: string },
    parentSubId: string,
  ): Promise<BundleCancelResponse>;
  /** Webhook hook — called by stripe-webhook.service when bundleId metadata present. */
  handleBundleCheckoutCompleted(args: {
    eventId: string;
    sessionId: string;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    metadata: Record<string, string>;
    amount: number;
    currency: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    trialEndsAt: Date | null;
    status: import('../repos/subscription.repo.js').SubscriptionStatus;
  }): Promise<{ parentId: string; childIds: string[] }>;
}

export interface CreateBundleCheckoutServiceOptions {
  redis?: Redis;
  stripeApi?: StripeApi;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';

async function stripePost(
  path: string,
  secretKey: string,
  body: string,
  idempotencyKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': '2024-06-20',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${STRIPE_BASE}${path}`, { method: 'POST', headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError(
      ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
      `Stripe ${path} failed`,
      { status: res.status, body: text.slice(0, 500) },
    );
  }
  return res.json();
}

export function createBundleCheckoutService(
  opts: CreateBundleCheckoutServiceOptions = {},
): BundleCheckoutService {
  const stripeApi = opts.stripeApi;

  // Narrow Mongoose's overly-broad InferSchemaType for nested fields.
  type BundleView = {
    _id: string;
    name: string;
    status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    visibility: 'public' | 'unlisted' | 'private';
    eligibilityPolicy: 'block' | 'cancel_and_credit' | 'replace_immediately';
    components: Array<{ productId: string; planId: string }>;
    componentSeats: Record<string, number>;
    currencyVariants: Array<{
      currency: string;
      amount: number;
      gatewayPriceIds?: Record<string, string | null>;
    }>;
    interval: 'month' | 'year';
    intervalCount: number;
    trialDays: number;
    maxRedemptions: number | null;
    redemptionCount: number;
    grantedAccess: Array<{ userId: string | null; workspaceId: string | null }>;
  };
  function view(b: bundleRepo.BundleLean): BundleView {
    return b as unknown as BundleView;
  }

  /** Resolve Stripe credentials from FIRST component product's gateway. */
  async function resolveStripeForBundle(b: BundleView): Promise<{
    secretKey: string;
    productIdForGateway: string;
  }> {
    const first = b.components[0];
    if (!first) {
      throw new AppError(
        ErrorCode.BILLING_BUNDLE_VALIDATION_FAILED,
        'Bundle has no components',
      );
    }
    const gw =
      (await gatewayRepo.findOne(first.productId, 'stripe', 'live')) ??
      (await gatewayRepo.findOne(first.productId, 'stripe', 'test'));
    if (!gw || gw.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe gateway not configured for bundle',
      );
    }
    const enc = gw.credentialsEncrypted as Record<string, { token: string }> | undefined;
    const wrapped = enc?.['secretKey']?.token;
    if (!wrapped) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe credentials missing',
      );
    }
    return {
      secretKey: decryptToString(wrapped),
      productIdForGateway: first.productId,
    };
  }

  return {
    async createBundleCheckout(actor, input) {
      const raw = await bundleRepo.findBundleById(input.bundleId);
      if (!raw) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      const bundle = view(raw);
      if (bundle.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          `Bundle is ${bundle.status}; not available for purchase`,
        );
      }

      // Visibility / grantedAccess.
      if (bundle.visibility === 'private') {
        const accessList = bundle.grantedAccess;
        const userMatch = accessList.some((g) => g.userId === actor.userId);
        const wsMatch = accessList.some(
          (g) => g.workspaceId && Object.values(input.subjects).includes(g.workspaceId),
        );
        if (!userMatch && !wsMatch) {
          throw new AppError(ErrorCode.PERMISSION_DENIED, 'Bundle is private');
        }
      }

      // maxRedemptions cap.
      if (
        bundle.maxRedemptions != null &&
        bundle.redemptionCount >= bundle.maxRedemptions
      ) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Bundle redemption limit reached',
          { maxRedemptions: bundle.maxRedemptions },
        );
      }

      // Currency variant.
      const variant = bundle.currencyVariants.find(
        (v) => v.currency === input.currency.toLowerCase(),
      );
      if (!variant) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          `Bundle has no currency variant for ${input.currency}`,
        );
      }
      const stripePriceId = variant.gatewayPriceIds?.['stripe'];
      if (!stripePriceId) {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          'Bundle has no Stripe price id; re-publish to sync',
        );
      }

      // Resolve subjects per component (workspace-scoped products need a wsId).
      const components = bundle.components;
      const subjectInputs: Array<{
        productId: string;
        planId: string;
        subjectType: 'user' | 'workspace';
        subjectUserId?: string;
        subjectWorkspaceId?: string;
      }> = [];
      for (const c of components) {
        const product = await productRepo.findProductById(c.productId);
        if (!product) {
          throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, `Product ${c.productId} not found`);
        }
        if (product.billingScope === 'workspace') {
          const wsId = input.subjects[c.productId];
          if (!wsId) {
            throw new AppError(
              ErrorCode.VALIDATION_FAILED,
              `subjects.${c.productId} (workspaceId) is required`,
              { productId: c.productId },
            );
          }
          const ws = await workspaceRepo.findById(c.productId, wsId);
          if (!ws) {
            throw new AppError(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `Workspace ${wsId} not found in product ${c.productId}`,
            );
          }
          subjectInputs.push({
            productId: c.productId,
            planId: c.planId,
            subjectType: 'workspace',
            subjectWorkspaceId: wsId,
          });
        } else {
          subjectInputs.push({
            productId: c.productId,
            planId: c.planId,
            subjectType: 'user',
            subjectUserId: actor.userId,
          });
        }
      }

      // Eligibility check.
      const conflicts = await subscriptionRepo.findActiveSubsForSubjectsAcrossProducts(
        subjectInputs.map((s) => ({
          productId: s.productId,
          subjectType: s.subjectType,
          ...(s.subjectUserId ? { subjectUserId: s.subjectUserId } : {}),
          ...(s.subjectWorkspaceId ? { subjectWorkspaceId: s.subjectWorkspaceId } : {}),
        })),
      );
      if (conflicts.length > 0 && bundle.eligibilityPolicy === 'block') {
        throw new AppError(
          ErrorCode.BILLING_BUNDLE_ELIGIBILITY_BLOCKED,
          'Subject already has active subscriptions for one or more bundle components',
          { conflictingSubscriptionIds: conflicts.map((s) => s._id) },
        );
      }
      // (cancel_and_credit / replace_immediately implementations are richer in
      //  v1.5+. v1.0 ships block-only; for the other two we simply allow the
      //  bundle to proceed, and the existing standalone subs remain — admins
      //  must reconcile manually until Flow AN ships.)

      // Resolve Stripe credentials (FIRST component product's gateway).
      const { secretKey } = await resolveStripeForBundle(bundle);

      // Find or create Stripe customer.
      let customerId: string | null = null;
      const fast = await subscriptionRepo.findStripeCustomerForUser(
        components[0]!.productId,
        actor.userId,
      );
      if (fast) {
        customerId = fast;
      } else if (stripeApi) {
        const found = await stripeApi.findCustomerByYocoreUserId({
          secretKey,
          yocoreUserId: actor.userId,
        });
        if (found) customerId = found;
        else {
          const created = await stripeApi.createCustomer({
            secretKey,
            email: actor.email,
            name: actor.displayName ?? null,
            yocoreUserId: actor.userId,
            yocoreProductId: components[0]!.productId,
          });
          customerId = created.id;
        }
      } else {
        // Production HTTP.
        const body = new URLSearchParams();
        if (actor.email) body.set('email', actor.email);
        if (actor.displayName) body.set('name', actor.displayName);
        body.set('metadata[yocoreUserId]', actor.userId);
        body.set('metadata[yocoreProductId]', components[0]!.productId);
        const j = (await stripePost(
          '/customers',
          secretKey,
          body.toString(),
          `yocore:cust:${components[0]!.productId}:${actor.userId}`,
        )) as { id: string };
        customerId = j.id;
      }

      // Build subscription metadata propagated through Stripe.
      const subjectMeta: Record<string, string> = {
        yocoreUserId: actor.userId,
        yocoreProductId: components[0]!.productId, // routes the webhook back
        yocoreBundleId: bundle._id,
        yocoreCurrency: variant.currency,
        yocoreComponentSubjects: JSON.stringify(subjectInputs),
      };

      // Create Checkout Session (use injected api when present, else HTTP).
      const idemKey = `yocore:bdl:checkout:${bundle._id}:${actor.userId}:${variant.currency}`;
      let session: { id: string; url: string };
      if (stripeApi) {
        session = await stripeApi.createCheckoutSession({
          secretKey,
          customerId: customerId!,
          priceId: stripePriceId,
          quantity: 1,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
          metadata: subjectMeta,
          subscriptionMetadata: subjectMeta,
          ...(bundle.trialDays && bundle.trialDays > 0 ? { trialDays: bundle.trialDays } : {}),
          idempotencyKey: idemKey,
        });
      } else {
        const body = new URLSearchParams();
        body.set('mode', 'subscription');
        body.set('customer', customerId!);
        body.set('line_items[0][price]', stripePriceId);
        body.set('line_items[0][quantity]', '1');
        body.set('success_url', input.successUrl);
        body.set('cancel_url', input.cancelUrl);
        if (bundle.trialDays && bundle.trialDays > 0) {
          body.set('subscription_data[trial_period_days]', String(bundle.trialDays));
        }
        for (const [k, v] of Object.entries(subjectMeta)) {
          body.set(`metadata[${k}]`, v);
          body.set(`subscription_data[metadata][${k}]`, v);
        }
        session = (await stripePost(
          '/checkout/sessions',
          secretKey,
          body.toString(),
          idemKey,
        )) as { id: string; url: string };
      }

      logger.info(
        {
          bundleId: bundle._id,
          userId: actor.userId,
          sessionId: session.id,
          currency: variant.currency,
        },
        'bundle.checkout.session.created',
      );

      return { url: session.url, sessionId: session.id, gateway: 'stripe' };
    },

    async cancelBundleSubscription(actor, parentSubId) {
      const parent = await subscriptionRepo.findBundleParentById(parentSubId);
      if (!parent) {
        throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'Bundle subscription not found');
      }
      // Authorization: caller must be the subjectUser (for user-scoped) or an
      // OWNER/ADMIN of any component workspace (for workspace-scoped). v1.0
      // does the simpler check: subjectUserId == actor.userId.
      if (parent.subjectUserId && parent.subjectUserId !== actor.userId) {
        throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not the bundle subscription owner');
      }
      // Mark CANCELED locally (cascade cron handles children + Stripe cancel
      //  call is the responsibility of a follow-up; v1.0 keeps it local-only).
      const updated = await subscriptionRepo.cancelBundleParent({
        subscriptionId: parent._id,
        reason: 'user_canceled',
        at: new Date(),
      });
      if (!updated) {
        throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'Bundle subscription not found');
      }
      return {
        bundleSubscriptionId: updated._id,
        status: updated.status,
        canceledAt: updated.canceledAt ? new Date(updated.canceledAt).toISOString() : null,
        cascadeScheduled: true,
      };
    },

    async handleBundleCheckoutCompleted(args) {
      const meta = args.metadata;
      const bundleId = meta['yocoreBundleId'];
      if (!bundleId) {
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'Bundle webhook missing yocoreBundleId',
        );
      }
      const componentSubjectsJson = meta['yocoreComponentSubjects'];
      if (!componentSubjectsJson) {
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'Bundle webhook missing yocoreComponentSubjects',
        );
      }
      let subjects: Array<{
        productId: string;
        planId: string;
        subjectType: 'user' | 'workspace';
        subjectUserId?: string;
        subjectWorkspaceId?: string;
      }>;
      try {
        subjects = JSON.parse(componentSubjectsJson);
      } catch {
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'Invalid yocoreComponentSubjects JSON',
        );
      }
      const raw = await bundleRepo.findBundleById(bundleId);
      if (!raw) throw new AppError(ErrorCode.BUNDLE_NOT_FOUND, 'Bundle not found');
      const bundle = view(raw);

      const userId = meta['yocoreUserId'];
      if (!userId) {
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'Bundle webhook missing yocoreUserId',
        );
      }

      // Idempotency: if a parent already exists for this Stripe sub id, skip.
      const existing = await subscriptionRepo.findByStripeSubscriptionId(
        args.stripeSubscriptionId,
      );
      if (existing) {
        const childRows = await subscriptionRepo.listBundleChildren(existing._id);
        return { parentId: existing._id, childIds: childRows.map((c) => c._id) };
      }

      // Increment redemption (idempotent guard via maxRedemptions check).
      const inc = await bundleRepo.incrementRedemptionCount(bundleId);
      if (!inc) {
        throw new AppError(
          ErrorCode.RESOURCE_CONFLICT,
          'Bundle redemption limit reached',
        );
      }

      // Determine subject type for parent: user-scoped if all components are
      // user-scoped OR there's no single workspace; else first workspace.
      const firstWs = subjects.find((s) => s.subjectType === 'workspace');
      const parent = await subscriptionRepo.createBundleParent({
        bundleId,
        subjectType: firstWs ? 'workspace' : 'user',
        subjectUserId: userId,
        subjectWorkspaceId: firstWs?.subjectWorkspaceId ?? null,
        gateway: 'stripe',
        gatewayRefs: {
          stripeCustomerId: args.stripeCustomerId,
          stripeSubscriptionId: args.stripeSubscriptionId,
        },
        status: args.status,
        amount: args.amount,
        currency: args.currency,
        currentPeriodStart: args.currentPeriodStart,
        currentPeriodEnd: args.currentPeriodEnd,
        trialEndsAt: args.trialEndsAt,
        lastWebhookEventId: args.eventId,
      });

      // Create one CHILD per component subject.
      const childIds: string[] = [];
      for (const s of subjects) {
        const child = await subscriptionRepo.createBundleChild({
          productId: s.productId,
          planId: s.planId,
          bundleSubscriptionId: parent._id,
          bundleId,
          subjectType: s.subjectType,
          subjectUserId: s.subjectUserId ?? null,
          subjectWorkspaceId: s.subjectWorkspaceId ?? null,
          status: args.status,
          amount: 0, // children billed via parent
          currency: args.currency,
          currentPeriodStart: args.currentPeriodStart,
          currentPeriodEnd: args.currentPeriodEnd,
          trialEndsAt: args.trialEndsAt,
        });
        childIds.push(child._id);

        // Outbound webhook to the component product.
        const product = await productRepo.findProductById(s.productId);
        if (product?.webhookUrl) {
          await deliveryRepo
            .enqueueDelivery({
              productId: s.productId,
              event: 'bundle.subscription.activated',
              eventId: `evt_bdl_act_${parent._id}_${s.productId}`,
              url: product.webhookUrl,
              payloadRef: parent._id,
            })
            .catch(() => undefined);
        }
      }

      // Auto-archive bundle if redemption cap hit.
      if (
        bundle.maxRedemptions != null &&
        (inc.redemptionCount ?? 0) >= bundle.maxRedemptions
      ) {
        await bundleRepo.setBundleStatus(bundleId, 'ARCHIVED', {
          archivedAt: new Date(),
        });
      }

      logger.info(
        {
          bundleId,
          parentId: parent._id,
          childCount: childIds.length,
          userId,
          stripeSubscriptionId: args.stripeSubscriptionId,
        },
        'bundle.subscription.created',
      );

      return { parentId: parent._id, childIds };
    },
  };
}

// Helper exports for plan repo not used here, but referenced for type.
export type { planRepo };
