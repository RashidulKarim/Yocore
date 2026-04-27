/**
 * Invoice sync service — Phase 3.4 Wave 12 (B-10).
 *
 * Pure mapper that converts Stripe invoice payloads to YoCore `invoices`
 * upserts. Called from `stripe-webhook.service.ts` on `invoice.paid`,
 * `invoice.payment_failed`, `invoice.created`, `invoice.finalized`.
 *
 * Maps Stripe's invoice status enum to ours:
 *   draft → draft, open → open, paid → paid, void → void,
 *   uncollectible → uncollectible.
 */
import * as invoiceRepo from '../repos/invoice.repo.js';
import * as subscriptionRepo from '../repos/subscription.repo.js';

export interface StripeInvoicePayload {
  id: string;
  number?: string | null;
  status?: string;
  subscription?: string | null;
  subtotal?: number;
  tax?: number;
  total?: number;
  amount_paid?: number;
  currency?: string;
  period_start?: number | null;
  period_end?: number | null;
  created?: number;
  status_transitions?: { paid_at?: number | null; voided_at?: number | null };
  hosted_invoice_url?: string | null;
  lines?: { data?: unknown[] };
  total_discount_amounts?: Array<{ amount: number }>;
}

export interface InvoiceSyncService {
  upsertFromStripeInvoice(
    productId: string,
    stripeInvoice: StripeInvoicePayload,
  ): Promise<invoiceRepo.InvoiceLean | null>;
}

const STATUS_MAP: Record<string, invoiceRepo.UpsertInvoiceInput['status']> = {
  draft: 'draft',
  open: 'open',
  paid: 'paid',
  void: 'void',
  uncollectible: 'uncollectible',
};

export function createInvoiceSyncService(): InvoiceSyncService {
  return {
    async upsertFromStripeInvoice(productId, stripeInvoice) {
      // Resolve YoCore subscription from stripe sub id.
      if (!stripeInvoice.subscription) return null;
      const sub = await subscriptionRepo.findByStripeSubscriptionId(
        stripeInvoice.subscription,
      );
      if (!sub) return null;
      // Tenant guard: ensure productId matches the stored sub.
      if (sub.productId !== productId) return null;

      const status = STATUS_MAP[stripeInvoice.status ?? 'open'] ?? 'open';
      const discount =
        (stripeInvoice.total_discount_amounts ?? []).reduce((s, d) => s + (d.amount ?? 0), 0) ?? 0;

      return invoiceRepo.upsertInvoice({
        productId,
        subscriptionId: sub._id,
        subjectType: sub.subjectType,
        ...(sub.subjectUserId ? { subjectUserId: sub.subjectUserId } : {}),
        ...(sub.subjectWorkspaceId ? { subjectWorkspaceId: sub.subjectWorkspaceId } : {}),
        gateway: 'stripe',
        gatewayInvoiceId: stripeInvoice.id,
        invoiceNumber: stripeInvoice.number ?? null,
        status,
        amountSubtotal: stripeInvoice.subtotal ?? 0,
        amountTax: stripeInvoice.tax ?? 0,
        amountTotal: stripeInvoice.total ?? 0,
        amountPaid: stripeInvoice.amount_paid ?? 0,
        currency: stripeInvoice.currency ?? 'usd',
        periodStart: stripeInvoice.period_start
          ? new Date(stripeInvoice.period_start * 1000)
          : null,
        periodEnd: stripeInvoice.period_end
          ? new Date(stripeInvoice.period_end * 1000)
          : null,
        issuedAt: stripeInvoice.created ? new Date(stripeInvoice.created * 1000) : new Date(),
        paidAt: stripeInvoice.status_transitions?.paid_at
          ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
          : null,
        voidedAt: stripeInvoice.status_transitions?.voided_at
          ? new Date(stripeInvoice.status_transitions.voided_at * 1000)
          : null,
        lineItems: stripeInvoice.lines?.data ?? [],
        downloadUrl: stripeInvoice.hosted_invoice_url ?? null,
        discountAmount: discount,
      });
    },
  };
}
