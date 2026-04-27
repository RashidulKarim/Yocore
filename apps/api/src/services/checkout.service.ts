/**
 * Checkout service — Phase 3.4 Wave 2 (Flow J1 — Stripe).
 *
 * Initiates a subscribe flow. Resolves the gateway from
 * `product.billingConfig.gatewayRouting[plan.currency]` (fallback to `default`)
 * and dispatches to the provider-specific path. Wave 2 implements **Stripe**;
 * SSLCommerz lands in Wave 3.
 *
 * Flow J1 highlights:
 *   - J1.2b — Stripe customer dedup via `lock:gateway:customer:<userId>:stripe`
 *     (Redis SET NX EX 30) + look up an existing `gatewayRefs.stripeCustomerId`
 *     across this user's prior subscriptions before creating a new customer.
 *   - The actual subscription row is NOT created here — the webhook
 *     `checkout.session.completed` (Wave 2 stripe-webhook.service) inserts it.
 *
 * Stripe HTTP calls are abstracted behind a `StripeApi` interface so tests
 * (and future providers) can inject stubs.
 */
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { createBreaker } from '../lib/circuit-breaker.js';
import { env } from '../config/env.js';
import * as planRepo from '../repos/billing-plan.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as workspaceRepo from '../repos/workspace.repo.js';
import * as memberRepo from '../repos/workspace-member.repo.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import { logger } from '../lib/logger.js';
import {
  defaultSslcommerzApi,
  type SslcommerzGatewayApi,
} from './sslcommerz-api.js';
import type { CheckoutRequest, CheckoutSessionResponse } from '@yocore/types';

// ── Stripe API surface (injectable) ─────────────────────────────────────
export interface StripeApi {
  /** Search customers by metadata.yocoreUserId. Returns customer id or null. */
  findCustomerByYocoreUserId(args: {
    secretKey: string;
    yocoreUserId: string;
  }): Promise<string | null>;
  createCustomer(args: {
    secretKey: string;
    email: string | null;
    name?: string | null;
    yocoreUserId: string;
    yocoreProductId: string;
  }): Promise<{ id: string }>;
  createCheckoutSession(args: {
    secretKey: string;
    customerId: string;
    priceId: string;
    quantity: number;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    subscriptionMetadata: Record<string, string>;
    trialDays?: number;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string }>;
}

export interface CreateCheckoutContext {
  userId: string;
  email: string | null;
  displayName?: string | null;
  productId: string;
}

export interface CheckoutOverrides {
  /** Force a specific target gateway (overrides product gateway routing). Used by gateway migration. */
  forceGateway?: 'stripe' | 'sslcommerz' | 'paypal' | 'paddle';
  /** Skip the single-active-subscription guard (caller is migrating an existing sub). */
  skipActiveGuard?: boolean;
}

export interface CheckoutService {
  createCheckout(
    actor: CreateCheckoutContext,
    input: CheckoutRequest,
    overrides?: CheckoutOverrides,
  ): Promise<CheckoutSessionResponse>;
}

export interface CreateCheckoutServiceOptions {
  redis?: Redis;
  stripeApi?: StripeApi;
  sslcommerzApi?: SslcommerzGatewayApi;
  /** Override the public API base used for SSLCommerz `ipn_url` (tests). */
  publicApiBaseUrl?: string;
}

// ── Default Stripe HTTP client (Node 20 fetch) ──────────────────────────
const STRIPE_BASE = 'https://api.stripe.com/v1';

function form(values: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    u.set(k, String(v));
  }
  return u.toString();
}

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

const defaultStripeApi: StripeApi = {
  async findCustomerByYocoreUserId({ secretKey, yocoreUserId }) {
    const url = new URL(`${STRIPE_BASE}/customers/search`);
    url.searchParams.set('query', `metadata['yocoreUserId']:'${yocoreUserId}'`);
    url.searchParams.set('limit', '1');
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-06-20' },
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'Stripe customers.search failed',
      );
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return json.data?.[0]?.id ?? null;
  },
  async createCustomer({ secretKey, email, name, yocoreUserId, yocoreProductId }) {
    const body = form({
      email: email ?? undefined,
      name: name ?? undefined,
      'metadata[yocoreUserId]': yocoreUserId,
      'metadata[yocoreProductId]': yocoreProductId,
    });
    const j = (await stripePost(
      '/customers',
      secretKey,
      body,
      `yocore:cust:${yocoreProductId}:${yocoreUserId}`,
    )) as { id: string };
    return { id: j.id };
  },
  async createCheckoutSession(args) {
    const body = new URLSearchParams();
    body.set('mode', 'subscription');
    body.set('customer', args.customerId);
    body.set('line_items[0][price]', args.priceId);
    body.set('line_items[0][quantity]', String(args.quantity));
    body.set('success_url', args.successUrl);
    body.set('cancel_url', args.cancelUrl);
    if (args.trialDays && args.trialDays > 0) {
      body.set('subscription_data[trial_period_days]', String(args.trialDays));
    }
    for (const [k, v] of Object.entries(args.metadata)) {
      body.set(`metadata[${k}]`, v);
    }
    for (const [k, v] of Object.entries(args.subscriptionMetadata)) {
      body.set(`subscription_data[metadata][${k}]`, v);
    }
    const j = (await stripePost(
      '/checkout/sessions',
      args.secretKey,
      body.toString(),
      args.idempotencyKey,
    )) as { id: string; url: string };
    return { id: j.id, url: j.url };
  },
};

// ── Service factory ─────────────────────────────────────────────────────

const CUSTOMER_LOCK_TTL_SECONDS = 30;

export function createCheckoutService(
  opts: CreateCheckoutServiceOptions = {},
): CheckoutService {
  const stripe = opts.stripeApi ?? defaultStripeApi;
  const sslc = opts.sslcommerzApi ?? defaultSslcommerzApi;
  const publicApiBase = opts.publicApiBaseUrl ?? env.PUBLIC_API_BASE_URL;

  // Wrap each Stripe call in a circuit breaker (Phase 1.7 / addendum #4).
  const stripeCustomerSearch = createBreaker(stripe.findCustomerByYocoreUserId, {
    name: 'stripe.customers.search',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const stripeCustomerCreate = createBreaker(stripe.createCustomer, {
    name: 'stripe.customers.create',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const stripeCheckoutCreate = createBreaker(stripe.createCheckoutSession, {
    name: 'stripe.checkout.sessions.create',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  // SSLCommerz-flow breakers (Wave 3 — Flow J4).
  const sslcStripeCustomer = createBreaker(sslc.findOrCreateStripeCalendarCustomer, {
    name: 'sslcommerz.stripe.customer',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const sslcStripeSubscription = createBreaker(sslc.createStripeCalendarSubscription, {
    name: 'sslcommerz.stripe.subscription',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const sslcSession = createBreaker(sslc.createSslcommerzSession, {
    name: 'sslcommerz.session.create',
    timeoutMs: 15_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  /** Resolve gateway provider for a plan's currency, with `default` fallback. */
  function resolveGateway(
    product: productRepo.ProductLean,
    currency: string,
  ): subscriptionRepo.GatewayName {
    const routing = (product.billingConfig?.gatewayRouting ?? {}) as Record<string, string>;
    const explicit = routing[currency.toLowerCase()];
    const fallback = routing['default'];
    const chosen = (explicit ?? fallback ?? 'stripe') as subscriptionRepo.GatewayName;
    if (!['stripe', 'sslcommerz', 'paypal', 'paddle'].includes(chosen)) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        `Unsupported gateway in routing config: ${chosen}`,
      );
    }
    return chosen;
  }

  /**
   * J1.2b — find or create a Stripe customer for this user. Uses Redis
   * `lock:gateway:customer:<userId>:stripe` (SET NX EX 30) to dedup
   * concurrent checkouts. On lock failure: wait briefly + re-read existing
   * `stripeCustomerId` from prior subscriptions.
   */
  async function findOrCreateStripeCustomer(args: {
    secretKey: string;
    productId: string;
    userId: string;
    email: string | null;
    displayName: string | null;
  }): Promise<string> {
    // Fast-path: already linked from a prior subscription.
    const existing = await subscriptionRepo.findStripeCustomerForUser(
      args.productId,
      args.userId,
    );
    if (existing) return existing;

    // Acquire dedup lock (best-effort — without redis we just proceed).
    const lockKey = `lock:gateway:customer:${args.userId}:stripe`;
    let lockAcquired = false;
    if (opts.redis) {
      const got = await opts.redis.set(lockKey, '1', 'EX', CUSTOMER_LOCK_TTL_SECONDS, 'NX');
      lockAcquired = got === 'OK';
      if (!lockAcquired) {
        // Another request is creating a customer for this user — wait briefly
        // then re-read.
        await new Promise((r) => setTimeout(r, 1000));
        const retry = await subscriptionRepo.findStripeCustomerForUser(
          args.productId,
          args.userId,
        );
        if (retry) return retry;
        // Fall through to create regardless — Stripe customer.create is also
        // idempotency-keyed below, so duplicates collapse to one.
      }
    }

    try {
      // Search Stripe by metadata first to recover from rare lost-write cases.
      const found = await stripeCustomerSearch.fire({
        secretKey: args.secretKey,
        yocoreUserId: args.userId,
      });
      if (found) return found;
      const created = await stripeCustomerCreate.fire({
        secretKey: args.secretKey,
        email: args.email,
        name: args.displayName,
        yocoreUserId: args.userId,
        yocoreProductId: args.productId,
      });
      return created.id;
    } finally {
      if (lockAcquired && opts.redis) {
        await opts.redis.del(lockKey).catch(() => undefined);
      }
    }
  }

  /**
   * SSLCommerz checkout (Flow J4):
   *   1. Load both Stripe (calendar) + SSLCommerz gateway credentials.
   *   2. Stripe: find-or-create customer + `subscription.create` w/
   *      `collection_method:"send_invoice"` (no auto-charge).
   *   3. Insert subscription row {gateway:'sslcommerz', status:'INCOMPLETE',
   *      gatewayRefs:{stripe*..., sslcommerzTranId:uuid()}}.
   *   4. Create SSLCommerz session pointing at our IPN URL.
   *   5. Return GatewayPageURL.
   */
  async function sslcommerzCheckout(args: {
    actor: CreateCheckoutContext;
    plan: planRepo.BillingPlanLean;
    subjectType: 'user' | 'workspace';
    subjectUserId: string | null;
    subjectWorkspaceId: string | null;
    input: CheckoutRequest;
    subjectMeta: Record<string, string>;
  }): Promise<CheckoutSessionResponse> {
    const { actor, plan, subjectType, subjectUserId, subjectWorkspaceId, input, subjectMeta } = args;

    // ── Load Stripe (calendar) gateway ───────────────────────────────
    const stripeGw =
      (await gatewayRepo.findOne(actor.productId, 'stripe', 'live')) ??
      (await gatewayRepo.findOne(actor.productId, 'stripe', 'test'));
    if (!stripeGw || stripeGw.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe gateway (billing calendar) not configured for this product',
      );
    }
    const stripeEnc = stripeGw.credentialsEncrypted as
      | Record<string, { token: string }>
      | undefined;
    const wrappedStripeKey = stripeEnc?.['secretKey']?.token;
    if (!wrappedStripeKey) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe credentials missing',
      );
    }
    const stripeKey = decryptToString(wrappedStripeKey);
    const stripePriceId = (
      plan.gatewayPriceIds as Record<string, string | null> | undefined
    )?.['stripe'];
    if (!stripePriceId) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Plan has no Stripe (calendar) price id — re-publish the plan to sync',
      );
    }

    // ── Load SSLCommerz gateway ──────────────────────────────────────
    const sslGw =
      (await gatewayRepo.findOne(actor.productId, 'sslcommerz', 'live')) ??
      (await gatewayRepo.findOne(actor.productId, 'sslcommerz', 'test'));
    if (!sslGw || sslGw.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'SSLCommerz gateway not configured for this product',
      );
    }
    const sslEnc = sslGw.credentialsEncrypted as
      | Record<string, { token: string }>
      | undefined;
    const wrappedStoreId = sslEnc?.['storeId']?.token;
    const wrappedStorePasswd = sslEnc?.['storePasswd']?.token;
    if (!wrappedStoreId || !wrappedStorePasswd) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'SSLCommerz storeId / storePasswd missing',
      );
    }
    const storeId = decryptToString(wrappedStoreId);
    const storePasswd = decryptToString(wrappedStorePasswd);
    const sandbox = sslGw.mode !== 'live';

    // ── Stripe calendar: customer + subscription ─────────────────────
    const customer = await sslcStripeCustomer.fire({
      secretKey: stripeKey,
      yocoreUserId: actor.userId,
      yocoreProductId: actor.productId,
      email: actor.email,
      name: actor.displayName ?? null,
    });

    const calIdemKey = `yocore:sslc:calsub:${actor.productId}:${actor.userId}:${plan._id}:${subjectWorkspaceId ?? 'self'}`;
    const calSub = await sslcStripeSubscription.fire({
      secretKey: stripeKey,
      customerId: customer.id,
      priceId: stripePriceId,
      quantity: input.quantity,
      metadata: subjectMeta,
      idempotencyKey: calIdemKey,
    });

    // ── Mint a YoCore-owned tran_id (eventId for IPN dedup) ──────────
    const tranId = `yc_${randomUUID().replace(/-/g, '')}`;

    // ── Insert pending subscription row ──────────────────────────────
    await subscriptionRepo.createSslcommerzPending({
      productId: actor.productId,
      planId: plan._id,
      subjectType,
      subjectUserId: subjectType === 'user' ? subjectUserId : null,
      subjectWorkspaceId: subjectType === 'workspace' ? subjectWorkspaceId : null,
      amount: plan.amount ?? 0,
      currency: plan.currency ?? 'bdt',
      quantity: input.quantity,
      stripeCustomerId: customer.id,
      stripeSubscriptionId: calSub.id,
      stripeLatestInvoiceId: calSub.latest_invoice,
      sslcommerzTranId: tranId,
      currentPeriodStart: calSub.current_period_start
        ? new Date(calSub.current_period_start * 1000)
        : null,
      currentPeriodEnd: calSub.current_period_end
        ? new Date(calSub.current_period_end * 1000)
        : null,
    });

    // ── Create SSLCommerz hosted-checkout session ────────────────────
    // SSLCommerz expects MAJOR currency units (e.g. BDT 300.00). Plan amount
    // is stored in MINOR units (paisa) — divide by 100.
    const totalMajor = (plan.amount ?? 0) / 100;
    const ipnUrl = `${publicApiBase.replace(/\/$/, '')}/v1/webhooks/sslcommerz`;

    const session = await sslcSession.fire({
      storeId,
      storePasswd,
      sandbox,
      tranId,
      totalAmount: totalMajor,
      currency: (plan.currency ?? 'bdt').toUpperCase(),
      successUrl: input.successUrl,
      failUrl: input.cancelUrl,
      cancelUrl: input.cancelUrl,
      ipnUrl,
      cusName: actor.displayName ?? actor.email ?? 'Customer',
      cusEmail: actor.email ?? 'no-reply@yocore.io',
    });

    logger.info(
      {
        productId: actor.productId,
        userId: actor.userId,
        planId: plan._id,
        gateway: 'sslcommerz',
        tranId,
        stripeSubscriptionId: calSub.id,
      },
      'sslcommerz.session.created',
    );

    return {
      url: session.GatewayPageURL,
      sessionId: tranId,
      gateway: 'sslcommerz',
    };
  }

  return {
    async createCheckout(actor, input, overrides) {
      // ── Load plan + product ────────────────────────────────────────
      const plan = await planRepo.findPlanById(actor.productId, input.planId);
      if (!plan) throw new AppError(ErrorCode.PLAN_NOT_FOUND, 'Plan not found');
      if (plan.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.BILLING_PLAN_NOT_PUBLISHED, 'Plan not published');
      }
      if (plan.isFree || (plan.amount ?? 0) === 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Cannot checkout for a free plan; provision directly via the entitlement API',
        );
      }

      const product = await productRepo.findProductById(actor.productId);
      if (!product) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');
      if (product.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not active');
      }

      // ── Subject (workspace vs user) + membership check ─────────────
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
        const workspace = await workspaceRepo.findById(actor.productId, input.workspaceId);
        if (!workspace) {
          throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, 'Workspace not found');
        }
        // Caller must be an active member with billing rights — owner is sufficient.
        // (Granular permission check is wired in Wave 6 once entitlement is built.)
        const member = await memberRepo.findMember(
          actor.productId,
          workspace._id,
          actor.userId,
        );
        if (!member || member.status !== 'ACTIVE') {
          throw new AppError(ErrorCode.PERMISSION_DENIED, 'Not a member of this workspace');
        }
        if (member.roleSlug !== 'OWNER' && member.roleSlug !== 'ADMIN') {
          throw new AppError(
            ErrorCode.PERMISSION_DENIED,
            'Only OWNER or ADMIN can subscribe a workspace',
          );
        }
        subjectWorkspaceId = workspace._id;
      } else {
        subjectUserId = actor.userId;
      }

      // ── Single-active subscription guard ───────────────────────────
      if (!overrides?.skipActiveGuard) {
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
      }

      // ── Resolve gateway ────────────────────────────────────────────
      const gateway =
        overrides?.forceGateway ?? resolveGateway(product, plan.currency ?? 'usd');

      // Common helper: subject metadata propagated to gateway sessions.
      const subjectMeta: Record<string, string> = {
        yocoreUserId: actor.userId,
        yocoreProductId: actor.productId,
        yocorePlanId: plan._id,
        yocoreSubjectType: subjectType,
      };
      if (subjectWorkspaceId) subjectMeta['yocoreSubjectWorkspaceId'] = subjectWorkspaceId;

      // ── SSLCommerz path (Flow J4 / ADR-005) ───────────────────────
      if (gateway === 'sslcommerz') {
        return await sslcommerzCheckout({
          actor,
          plan,
          subjectType,
          subjectWorkspaceId,
          subjectUserId,
          input,
          subjectMeta,
        });
      }

      if (gateway !== 'stripe') {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          `Gateway ${gateway} not yet supported`,
        );
      }

      const stripeGw =
        (await gatewayRepo.findOne(actor.productId, 'stripe', 'live')) ??
        (await gatewayRepo.findOne(actor.productId, 'stripe', 'test'));
      if (!stripeGw || stripeGw.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          'Stripe gateway not configured for this product',
        );
      }
      const enc = stripeGw.credentialsEncrypted as
        | Record<string, { token: string }>
        | undefined;
      const wrapped = enc?.['secretKey']?.token;
      if (!wrapped) {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          'Stripe credentials missing',
        );
      }
      const secretKey = decryptToString(wrapped);

      const stripePriceId = (
        plan.gatewayPriceIds as Record<string, string | null> | undefined
      )?.['stripe'];
      if (!stripePriceId) {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          'Plan has no Stripe price id — re-publish the plan to sync',
        );
      }

      // ── Customer dedup + checkout session ──────────────────────────
      const customerId = await findOrCreateStripeCustomer({
        secretKey,
        productId: actor.productId,
        userId: actor.userId,
        email: actor.email,
        displayName: actor.displayName ?? null,
      });

      const idemKey = `yocore:checkout:${actor.productId}:${actor.userId}:${plan._id}:${subjectWorkspaceId ?? 'self'}`;
      const session = await stripeCheckoutCreate.fire({
        secretKey,
        customerId,
        priceId: stripePriceId,
        quantity: input.quantity,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        metadata: subjectMeta,
        subscriptionMetadata: subjectMeta,
        ...(plan.trialDays && plan.trialDays > 0 ? { trialDays: plan.trialDays } : {}),
        idempotencyKey: idemKey,
      });

      logger.info(
        {
          productId: actor.productId,
          userId: actor.userId,
          planId: plan._id,
          gateway: 'stripe',
          sessionId: session.id,
        },
        'checkout.session.created',
      );

      return { url: session.url, sessionId: session.id, gateway: 'stripe' };
    },
  };
}
