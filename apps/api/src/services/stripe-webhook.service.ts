/**
 * Stripe webhook service — Phase 3.4 Wave 2 (Flow J1.6).
 *
 * Handles inbound Stripe events for YoCore-managed subscriptions.
 *
 * Pipeline per request (FIX-G1, ADR-009):
 *   1. Verify signature (`Stripe-Signature: t=<unix>,v1=<hex>`) using the
 *      product's payment-gateway `webhookSecret`. Constant-time, 5-min skew.
 *   2. Resolve `productId` from event metadata (set on customer/session/sub).
 *   3. Insert `webhookEventsProcessed{provider:'stripe', eventId:event.id}` —
 *      E11000 → noop 200 (deduped).
 *   4. Dispatch by `event.type`. Wave 2 supports `checkout.session.completed`.
 *   5. Persist subscription via repo upsert + enqueue outbound webhook
 *      (`subscription.activated`) + audit log.
 *
 * Stripe's signing convention is the same shape as our `lib/webhook-signature.ts`
 * (`t=<unix>,v1=<hmac-hex>`) but with HMAC of `${t}.${rawBody}` using the
 * gateway-stored `whsec_*` secret. We reuse `verifyWebhook` for the math.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { verifyWebhook } from '../lib/webhook-signature.js';
import { logger } from '../lib/logger.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as dedupRepo from '../repos/webhook-event-processed.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import type { AuditEmitter } from '../middleware/audit-log.js';

// ── Minimal Stripe event shapes we depend on ────────────────────────────

interface StripeCheckoutSession {
  id: string;
  customer: string;
  subscription: string | null;
  mode: 'subscription' | 'payment' | 'setup';
  status?: string;
  metadata?: Record<string, string>;
  amount_total?: number | null;
  currency?: string | null;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status:
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'unpaid'
    | 'paused';
  current_period_start: number | null;
  current_period_end: number | null;
  trial_end: number | null;
  metadata?: Record<string, string>;
  items: { data: Array<{ price: { id: string; unit_amount: number | null; currency: string } }> };
  latest_invoice?: string | null;
}

export interface StripeWebhookApi {
  /** Fetch a subscription (used to enrich the checkout.session payload). */
  retrieveSubscription(args: {
    secretKey: string;
    subscriptionId: string;
  }): Promise<StripeSubscription>;
}

export interface StripeWebhookService {
  process(args: {
    rawBody: string;
    signatureHeader: string | undefined;
    audit?: AuditEmitter;
  }): Promise<{ deduped: boolean; handled: string | null }>;
}

export interface CreateStripeWebhookOptions {
  stripeApi?: StripeWebhookApi;
  /** Override clock for tests (passed to verifyWebhook). */
  now?: () => Date;
}

// ── Default Stripe HTTP api ─────────────────────────────────────────────
const STRIPE_BASE = 'https://api.stripe.com/v1';

const defaultStripeWebhookApi: StripeWebhookApi = {
  async retrieveSubscription({ secretKey, subscriptionId }) {
    const res = await fetch(`${STRIPE_BASE}/subscriptions/${subscriptionId}`, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': '2024-06-20',
      },
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'Stripe subscriptions.retrieve failed',
      );
    }
    return (await res.json()) as StripeSubscription;
  },
};

// ── Status mapping ──────────────────────────────────────────────────────
function mapStripeStatus(s: StripeSubscription['status']): subscriptionRepo.SubscriptionStatus {
  switch (s) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELED';
    case 'paused':
      return 'PAUSED';
    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
    default:
      return 'INCOMPLETE';
  }
}

export function createStripeWebhookService(
  opts: CreateStripeWebhookOptions = {},
): StripeWebhookService {
  const stripe = opts.stripeApi ?? defaultStripeWebhookApi;

  async function loadGatewayForProduct(productId: string): Promise<{
    secretKey: string;
    webhookSecret: string;
  }> {
    const gw =
      (await gatewayRepo.findOne(productId, 'stripe', 'live')) ??
      (await gatewayRepo.findOne(productId, 'stripe', 'test'));
    if (!gw || gw.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe gateway not configured for this product',
      );
    }
    const enc = gw.credentialsEncrypted as Record<string, { token: string }> | undefined;
    const wrappedSecret = enc?.['secretKey']?.token;
    const wrappedWh = enc?.['webhookSecret']?.token;
    if (!wrappedSecret || !wrappedWh) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe credentials/webhook secret missing',
      );
    }
    return {
      secretKey: decryptToString(wrappedSecret),
      webhookSecret: decryptToString(wrappedWh),
    };
  }

  return {
    async process({ rawBody, signatureHeader, audit }) {
      // ── Parse the event envelope (we still need productId BEFORE we can
      //    verify the signature). The envelope is JSON; signature verification
      //    happens against the raw bytes — so a forged envelope can't slip past
      //    once we re-verify with the resolved gateway's webhookSecret.
      let event: {
        id: string;
        type: string;
        data: { object: Record<string, unknown> };
      };
      try {
        event = JSON.parse(rawBody);
      } catch {
        throw new AppError(ErrorCode.WEBHOOK_PAYLOAD_INVALID, 'Invalid JSON');
      }
      if (!event.id || !event.type || !event.data?.object) {
        throw new AppError(ErrorCode.WEBHOOK_PAYLOAD_INVALID, 'Missing envelope fields');
      }

      // ── Resolve productId from event metadata. We attach `yocoreProductId`
      //    on every Stripe object we create (customer / session / subscription).
      const obj = event.data.object as Record<string, unknown>;
      const meta = (obj['metadata'] as Record<string, string> | undefined) ?? {};
      const productId = meta['yocoreProductId'];
      if (!productId) {
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'Missing yocoreProductId in event metadata',
        );
      }

      // ── Load gateway credentials (for signature + Stripe REST calls) ─
      const { secretKey, webhookSecret } = await loadGatewayForProduct(productId);

      // ── Verify signature (5-min skew, timing-safe) ───────────────────
      verifyWebhook(rawBody, signatureHeader, webhookSecret, {
        ...(opts.now ? { now: opts.now() } : {}),
      });

      // ── Dedup via webhookEventsProcessed insertOne (FIX-G1) ──────────
      const claim = await dedupRepo.recordEvent({
        provider: 'stripe',
        eventId: event.id,
        productId,
        handlerAction: event.type,
      });
      if (!claim.fresh) {
        logger.info(
          { eventId: event.id, type: event.type, productId },
          'stripe.webhook.deduped',
        );
        return { deduped: true, handled: null };
      }

      // ── Dispatch ─────────────────────────────────────────────────────
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted({
            event,
            session: obj as unknown as StripeCheckoutSession,
            productId,
            secretKey,
            audit,
          });
          return { deduped: false, handled: event.type };
        default:
          logger.info(
            { eventId: event.id, type: event.type },
            'stripe.webhook.unhandled_type',
          );
          return { deduped: false, handled: null };
      }
    },
  };

  // ── Handlers ──────────────────────────────────────────────────────────

  async function handleCheckoutSessionCompleted(args: {
    event: { id: string; type: string };
    session: StripeCheckoutSession;
    productId: string;
    secretKey: string;
    audit?: AuditEmitter;
  }): Promise<void> {
    const { session, productId, secretKey, event, audit } = args;
    if (session.mode !== 'subscription') {
      logger.info(
        { sessionId: session.id, mode: session.mode },
        'stripe.checkout.session.completed: skipping non-subscription mode',
      );
      return;
    }
    if (!session.subscription) {
      throw new AppError(
        ErrorCode.WEBHOOK_PAYLOAD_INVALID,
        'checkout.session.completed missing subscription id',
      );
    }
    const meta = session.metadata ?? {};
    const planId = meta['yocorePlanId'];
    const subjectType = meta['yocoreSubjectType'] as 'user' | 'workspace' | undefined;
    const subjectUserId = meta['yocoreUserId'] ?? null;
    const subjectWorkspaceId = meta['yocoreSubjectWorkspaceId'] ?? null;
    if (!planId || !subjectType) {
      throw new AppError(
        ErrorCode.WEBHOOK_PAYLOAD_INVALID,
        'Session metadata missing planId/subjectType',
      );
    }

    // Validate plan still exists for this product (defensive).
    const plan = await planRepo.findPlanById(productId, planId);
    if (!plan) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Plan not found');

    // Pull the live subscription details from Stripe.
    const sub = await stripe.retrieveSubscription({
      secretKey,
      subscriptionId: session.subscription,
    });
    const item = sub.items?.data?.[0];
    const amount = item?.price.unit_amount ?? plan.amount ?? 0;
    const currency = (item?.price.currency ?? plan.currency ?? 'usd').toLowerCase();

    const upserted = await subscriptionRepo.upsertFromStripeSession({
      productId,
      planId,
      subjectType,
      subjectUserId: subjectType === 'user' ? subjectUserId : null,
      subjectWorkspaceId: subjectType === 'workspace' ? subjectWorkspaceId : null,
      stripeCustomerId: session.customer,
      stripeSubscriptionId: sub.id,
      stripeLatestInvoiceId: sub.latest_invoice ?? null,
      status: mapStripeStatus(sub.status),
      amount,
      currency,
      currentPeriodStart: sub.current_period_start
        ? new Date(sub.current_period_start * 1000)
        : null,
      currentPeriodEnd: sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : null,
      lastWebhookEventId: event.id,
    });

    // Enqueue outbound product webhook (delivery worker is Phase 3.8).
    const product = await productRepo.findProductById(productId);
    if (product?.webhookUrl) {
      await deliveryRepo.enqueueDelivery({
        productId,
        event: 'subscription.activated',
        eventId: `evt_sub_act_${upserted._id}_${event.id}`,
        url: product.webhookUrl,
        payloadRef: event.id,
      });
    }

    await audit?.({
      action: 'subscription.created',
      outcome: 'success',
      productId,
      resource: { type: 'subscription', id: upserted._id },
      metadata: {
        gateway: 'stripe',
        stripeSubscriptionId: sub.id,
        stripeEventId: event.id,
        planId,
      },
      actor: { type: 'webhook', id: 'stripe' },
    });
  }
}
