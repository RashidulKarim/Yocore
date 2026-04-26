/**
 * SSLCommerz IPN handler — Phase 3.4 Wave 3 (Flow J4.8 → J4.11).
 *
 * IPN pipeline:
 *   1. Body is `application/x-www-form-urlencoded` — already parsed into
 *      `req.body` by express's urlencoded middleware.
 *   2. Read `tran_id` (the YoCore-minted `yc_<uuid>` from checkout) and
 *      look up the matching `subscriptions` row.
 *   3. **Dedup** via `webhookEventsProcessed{provider:'sslcommerz', eventId:tran_id}`
 *      (FIX-G1, ADR-009). Repeat IPNs (SSLCommerz CAN re-deliver) become 200 noops.
 *   4. **Verify signature** using the gateway's `storePasswd` (MD5 `verify_sign`
 *      or HMAC-SHA256 `verify_sign_sha2`).
 *   5. **Order Validation** call (`val_id` → SSLCommerz validator API). Confirm
 *      `status:"VALID"|"VALIDATED"`, amount + currency match.
 *   6. Activate subscription: `status='ACTIVE'`, store `sslcommerzValId`, set
 *      `currentPeriodEnd` (left as-is from the Stripe calendar).
 *   7. **Stripe `invoices.pay({paid_out_of_band:true})`** to close the loop.
 *      If this fails, mark subscription `PAST_DUE` and emit a
 *      `billing.sslcommerz_stripe_desync` audit event (Flow J4.11).
 *   8. Audit `subscription.created` + enqueue outbound `subscription.activated`.
 */
import { AppError, ErrorCode } from '../lib/errors.js';
import { decryptToString } from '../lib/encryption.js';
import { logger } from '../lib/logger.js';
import { verifySslcommerzIpn } from '../lib/sslcommerz-signature.js';
import * as gatewayRepo from '../repos/payment-gateway.repo.js';
import * as productRepo from '../repos/product.repo.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';
import * as dedupRepo from '../repos/webhook-event-processed.repo.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import { defaultSslcommerzApi, type SslcommerzGatewayApi } from './sslcommerz-api.js';
import type { AuditEmitter } from '../middleware/audit-log.js';

export interface SslcommerzWebhookService {
  process(args: {
    body: Record<string, string | undefined>;
    audit?: AuditEmitter;
  }): Promise<{ deduped: boolean; activated: boolean; subscriptionId: string | null }>;
}

export interface CreateSslcommerzWebhookOptions {
  sslcommerzApi?: SslcommerzGatewayApi;
}

export function createSslcommerzWebhookService(
  opts: CreateSslcommerzWebhookOptions = {},
): SslcommerzWebhookService {
  const sslc = opts.sslcommerzApi ?? defaultSslcommerzApi;

  return {
    async process({ body, audit }) {
      // ── Extract tran_id ───────────────────────────────────────────
      const tranId = body['tran_id'];
      const valId = body['val_id'];
      const ipnStatus = body['status']; // 'VALID' | 'VALIDATED' | 'FAILED' | 'CANCELLED'
      if (!tranId) {
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'Missing tran_id in IPN body',
        );
      }

      // ── Find the pending subscription row ─────────────────────────
      const sub = await subscriptionRepo.findBySslcommerzTranId(tranId);
      if (!sub) {
        // Unknown tran_id — could be a probe from another tenant. Refuse to
        // 200 (so SSLCommerz won't drop it) but don't leak which it is.
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'No subscription matches this tran_id',
        );
      }
      const productId = sub.productId;

      // ── Dedup ──────────────────────────────────────────────────────
      const claim = await dedupRepo.recordEvent({
        provider: 'sslcommerz',
        eventId: tranId,
        productId,
        handlerAction: 'ipn',
      });
      if (!claim.fresh) {
        logger.info({ tranId, productId }, 'sslcommerz.ipn.deduped');
        return { deduped: true, activated: false, subscriptionId: sub._id };
      }

      // ── Load gateway credentials ──────────────────────────────────
      const sslGw =
        (await gatewayRepo.findOne(productId, 'sslcommerz', 'live')) ??
        (await gatewayRepo.findOne(productId, 'sslcommerz', 'test'));
      if (!sslGw || sslGw.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.BILLING_GATEWAY_CONFIG_MISSING,
          'SSLCommerz gateway not configured',
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
          'SSLCommerz storeId/storePasswd missing',
        );
      }
      const storeId = decryptToString(wrappedStoreId);
      const storePasswd = decryptToString(wrappedStorePasswd);
      const sandbox = sslGw.mode !== 'live';

      // ── Verify signature ──────────────────────────────────────────
      try {
        verifySslcommerzIpn({ body, storePasswd });
      } catch (err) {
        await audit?.({
          action: 'subscription.ipn_validation_failed',
          outcome: 'failure',
          actor: { type: 'webhook', id: 'sslcommerz' },
          productId,
          metadata: { tranId, reason: 'signature' },
        });
        throw err;
      }

      // ── Cancelled / failed payment short-circuit ──────────────────
      if (ipnStatus && !['VALID', 'VALIDATED'].includes(ipnStatus.toUpperCase())) {
        await audit?.({
          action: 'subscription.ipn_payment_failed',
          outcome: 'failure',
          actor: { type: 'webhook', id: 'sslcommerz' },
          productId,
          metadata: { tranId, ipnStatus },
        });
        return { deduped: false, activated: false, subscriptionId: sub._id };
      }

      // ── Order Validation API ──────────────────────────────────────
      if (!valId) {
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'Missing val_id for VALID IPN',
        );
      }
      const validation = await sslc.validateSslcommerzTransaction({
        storeId,
        storePasswd,
        sandbox,
        valId,
      });
      const validStatus = ['VALID', 'VALIDATED'].includes(validation.status?.toUpperCase());
      const amountMatch =
        validation.amount !== undefined && validation.amount !== null
          ? Math.round(parseFloat(validation.amount) * 100) === sub.amount
          : true;
      const currencyMatch =
        validation.currency !== undefined && validation.currency !== null
          ? validation.currency.toUpperCase() === (sub.currency ?? '').toUpperCase()
          : true;
      if (!validStatus || !amountMatch || !currencyMatch) {
        await audit?.({
          action: 'subscription.ipn_validation_failed',
          outcome: 'failure',
          actor: { type: 'webhook', id: 'sslcommerz' },
          productId,
          metadata: {
            tranId,
            valId,
            validationStatus: validation.status,
            amountMatch,
            currencyMatch,
          },
        });
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'SSLCommerz Order Validation failed',
          { validationStatus: validation.status },
        );
      }

      // ── Activate subscription ─────────────────────────────────────
      const activated = await subscriptionRepo.activateSslcommerzSubscription({
        subscriptionId: sub._id,
        sslcommerzValId: valId,
        currentPeriodEnd: sub.currentPeriodEnd ?? null,
        lastWebhookEventId: tranId,
      });

      // ── Close the loop with Stripe (paid_out_of_band) ─────────────
      const stripeGw =
        (await gatewayRepo.findOne(productId, 'stripe', 'live')) ??
        (await gatewayRepo.findOne(productId, 'stripe', 'test'));
      const stripeEnc = stripeGw?.credentialsEncrypted as
        | Record<string, { token: string }>
        | undefined;
      const wrappedStripeKey = stripeEnc?.['secretKey']?.token;
      const stripeInvoiceId = (sub.gatewayRefs as { stripeLatestInvoiceId?: string } | undefined)
        ?.stripeLatestInvoiceId;
      if (wrappedStripeKey && stripeInvoiceId) {
        const stripeKey = decryptToString(wrappedStripeKey);
        try {
          await sslc.payStripeInvoiceOutOfBand({
            secretKey: stripeKey,
            invoiceId: stripeInvoiceId,
            idempotencyKey: `ik_ssl_${tranId}`,
          });
        } catch (err) {
          // Flow J4.11 — alert + mark PAST_DUE so the customer doesn't enter
          // a false grace-period storm. Background retry job is Wave 7.
          logger.error(
            { err, tranId, stripeInvoiceId, productId },
            'sslcommerz.stripe.invoice.pay_failed',
          );
          await subscriptionRepo.markPastDue(sub._id);
          await audit?.({
            action: 'billing.sslcommerz_stripe_desync',
            outcome: 'failure',
            actor: { type: 'webhook', id: 'sslcommerz' },
            productId,
            metadata: { tranId, stripeInvoiceId, severity: 'critical' },
          });
        }
      }

      // ── Outbound webhook + audit ──────────────────────────────────
      const product = await productRepo.findProductById(productId);
      if (product?.webhookUrl) {
        await deliveryRepo.enqueueDelivery({
          productId,
          event: 'subscription.activated',
          eventId: `evt_sub_act_${sub._id}_${tranId}`,
          url: product.webhookUrl,
          payloadRef: tranId,
        });
      }

      await audit?.({
        action: 'subscription.created',
        outcome: 'success',
        actor: { type: 'webhook', id: 'sslcommerz' },
        productId,
        metadata: { gateway: 'sslcommerz', tranId, valId },
      });

      return {
        deduped: false,
        activated: !!activated,
        subscriptionId: sub._id,
      };
    },
  };
}
