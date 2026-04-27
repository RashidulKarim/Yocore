/**
 * Refund service — Phase 3.4 Wave 9 (Flow AD).
 *
 * Admin-only `POST /v1/admin/products/:id/refund` triggers a refund on the
 * latest paid invoice of a subscription. Stripe path uses the REST refunds
 * endpoint with the latest charge id; SSLCommerz has no API refund and is
 * recorded as `refundPending` for manual operator follow-up.
 *
 * Outbound webhook: `subscription.refunded`.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { createBreaker } from '../lib/circuit-breaker.js';
import { logger } from '../lib/logger.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as invoiceRepo from '../repos/invoice.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import type { RefundRequest, RefundResponse } from '@yocore/types';

export interface StripeRefundApi {
  retrieveLatestCharge(args: {
    secretKey: string;
    paymentIntentId: string;
  }): Promise<{ chargeId: string; amount: number; currency: string }>;
  createRefund(args: {
    secretKey: string;
    chargeId: string;
    amount?: number;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: string; amount: number }>;
  retrieveInvoice(args: {
    secretKey: string;
    invoiceId: string;
  }): Promise<{ paymentIntentId: string | null; chargeId: string | null }>;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';

const defaultStripeRefundApi: StripeRefundApi = {
  async retrieveInvoice({ secretKey, invoiceId }) {
    const res = await fetch(`${STRIPE_BASE}/invoices/${invoiceId}`, {
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-06-20' },
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'Stripe invoice retrieve failed',
      );
    }
    const j = (await res.json()) as { payment_intent?: string | null; charge?: string | null };
    return { paymentIntentId: j.payment_intent ?? null, chargeId: j.charge ?? null };
  },
  async retrieveLatestCharge({ secretKey, paymentIntentId }) {
    const res = await fetch(`${STRIPE_BASE}/payment_intents/${paymentIntentId}`, {
      headers: { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': '2024-06-20' },
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_UNAVAILABLE,
        'Stripe payment intent retrieve failed',
      );
    }
    const j = (await res.json()) as {
      latest_charge?: string;
      amount_received?: number;
      currency?: string;
    };
    if (!j.latest_charge) {
      throw new AppError(
        ErrorCode.BILLING_REFUND_INELIGIBLE,
        'No charge found for this payment intent',
      );
    }
    return {
      chargeId: j.latest_charge,
      amount: j.amount_received ?? 0,
      currency: (j.currency ?? 'usd').toLowerCase(),
    };
  },
  async createRefund({ secretKey, chargeId, amount, reason, idempotencyKey }) {
    const body = new URLSearchParams();
    body.set('charge', chargeId);
    if (amount != null) body.set('amount', String(amount));
    body.set('reason', mapReason(reason));
    const res = await fetch(`${STRIPE_BASE}/refunds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
        'Idempotency-Key': idempotencyKey,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new AppError(ErrorCode.BILLING_REFUND_FAILED, 'Stripe refund failed');
    }
    const j = (await res.json()) as { id: string; status: string; amount: number };
    return j;
  },
};

function mapReason(reason: string): string {
  switch (reason) {
    case 'duplicate':
      return 'duplicate';
    case 'fraudulent':
      return 'fraudulent';
    default:
      return 'requested_by_customer';
  }
}

export interface RefundService {
  refund(productId: string, input: RefundRequest, actorUserId: string): Promise<RefundResponse>;
}

export interface CreateRefundServiceOptions {
  stripeRefundApi?: StripeRefundApi;
}

export function createRefundService(opts: CreateRefundServiceOptions = {}): RefundService {
  const stripe = opts.stripeRefundApi ?? defaultStripeRefundApi;
  const stripeRetrieveInvoice = createBreaker(stripe.retrieveInvoice, {
    name: 'stripe.invoices.retrieve',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const stripeRetrieveCharge = createBreaker(stripe.retrieveLatestCharge, {
    name: 'stripe.payment_intents.retrieve',
    timeoutMs: 10_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });
  const stripeRefund = createBreaker(stripe.createRefund, {
    name: 'stripe.refunds.create',
    timeoutMs: 15_000,
    errorThresholdPercentage: 75,
    resetTimeoutMs: 30_000,
    volumeThreshold: 5,
  });

  async function loadStripeSecret(productId: string): Promise<string> {
    const gw =
      (await gatewayRepo.findOne(productId, 'stripe', 'live')) ??
      (await gatewayRepo.findOne(productId, 'stripe', 'test'));
    if (!gw || gw.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
        'Stripe gateway not configured',
      );
    }
    const enc = gw.credentialsEncrypted as Record<string, { token: string }> | undefined;
    const wrapped = enc?.['secretKey']?.token;
    if (!wrapped) {
      throw new AppError(ErrorCode.BILLING_GATEWAY_CONFIG_MISSING, 'Stripe secret missing');
    }
    return decryptToString(wrapped);
  }

  return {
    async refund(productId, input, actorUserId) {
      const sub = await subscriptionRepo.findById(productId, input.subscriptionId);
      if (!sub) {
        throw new AppError(ErrorCode.SUBSCRIPTION_NOT_FOUND, 'Subscription not found');
      }
      if (sub.refundedAt) {
        throw new AppError(
          ErrorCode.BILLING_REFUND_INELIGIBLE,
          'Subscription has already been refunded',
        );
      }
      const product = await productRepo.findProductById(productId);
      if (!product) throw new AppError(ErrorCode.PRODUCT_NOT_FOUND, 'Product not found');

      const latestInvoice = await invoiceRepo.findLatestPaidForSubscription(
        productId,
        sub._id,
      );

      // ── Stripe path ─────────────────────────────────────────────
      if (sub.gateway === 'stripe') {
        if (!latestInvoice) {
          throw new AppError(
            ErrorCode.BILLING_REFUND_INELIGIBLE,
            'No paid invoice found to refund',
          );
        }
        const secret = await loadStripeSecret(productId);
        const inv = await stripeRetrieveInvoice.fire({
          secretKey: secret,
          invoiceId: latestInvoice.gatewayInvoiceId,
        });
        let chargeId = inv.chargeId;
        if (!chargeId && inv.paymentIntentId) {
          const pi = await stripeRetrieveCharge.fire({
            secretKey: secret,
            paymentIntentId: inv.paymentIntentId,
          });
          chargeId = pi.chargeId;
        }
        if (!chargeId) {
          throw new AppError(
            ErrorCode.BILLING_REFUND_INELIGIBLE,
            'Could not resolve a charge to refund',
          );
        }

        const refundResult = await stripeRefund.fire({
          secretKey: secret,
          chargeId,
          ...(input.amount != null ? { amount: input.amount } : {}),
          reason: input.reason,
          idempotencyKey: `yocore:refund:${sub._id}:${input.amount ?? 'full'}`,
        });

        await subscriptionRepo.recordRefund({
          productId,
          subscriptionId: sub._id,
          amount: refundResult.amount,
          reason: input.reason,
          refundedAt: new Date(),
        });
        await invoiceRepo.markRefunded(productId, latestInvoice._id);

        await emitWebhook(product, 'subscription.refunded', sub._id);
        logger.info(
          { subscriptionId: sub._id, refundId: refundResult.id, actor: actorUserId },
          'refund.stripe.succeeded',
        );

        return {
          subscriptionId: sub._id,
          refundId: refundResult.id,
          amount: refundResult.amount,
          currency: latestInvoice.currency,
          status: refundResult.status === 'succeeded' ? 'succeeded' : 'pending',
        };
      }

      // ── SSLCommerz / null gateway: mark pending for manual ───────
      const amount = input.amount ?? latestInvoice?.amountPaid ?? sub.amount ?? 0;
      const refundId = `manual_${sub._id}_${Date.now()}`;
      await subscriptionRepo.recordRefund({
        productId,
        subscriptionId: sub._id,
        amount,
        reason: input.reason,
        refundedAt: new Date(),
      });
      if (latestInvoice) {
        await invoiceRepo.markRefunded(productId, latestInvoice._id);
      }
      await emitWebhook(product, 'subscription.refunded', sub._id);
      logger.warn(
        { subscriptionId: sub._id, gateway: sub.gateway, actor: actorUserId },
        'refund.manual.pending',
      );
      return {
        subscriptionId: sub._id,
        refundId,
        amount,
        currency: sub.currency ?? 'usd',
        status: 'pending',
      };
    },
  };
}

async function emitWebhook(
  product: productRepo.ProductLean,
  event: string,
  subscriptionId: string,
): Promise<void> {
  if (!product.webhookUrl) return;
  await deliveryRepo
    .enqueueDelivery({
      productId: product._id,
      event,
      eventId: `evt_refund_${subscriptionId}_${Date.now()}`,
      url: product.webhookUrl,
      payloadRef: subscriptionId,
    })
    .catch(() => undefined);
}
