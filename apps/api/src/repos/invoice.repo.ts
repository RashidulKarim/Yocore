/**
 * Invoice cache — `invoices` collection (B-10).
 *
 * Mirrors gateway-side invoice metadata so YoCore can list + serve invoices
 * without round-tripping the gateway on every request. Upserted by the Stripe
 * webhook handler on `invoice.paid` and `invoice.payment_failed`.
 */
import { Invoice, type InvoiceDoc } from '../db/models/Invoice.js';

export type InvoiceLean = InvoiceDoc;

export interface UpsertInvoiceInput {
  productId: string;
  subscriptionId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
  gateway: 'stripe' | 'sslcommerz' | 'paypal' | 'paddle';
  gatewayInvoiceId: string;
  invoiceNumber?: string | null;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | 'refunded';
  amountSubtotal: number;
  amountTax: number;
  amountTotal: number;
  amountPaid: number;
  currency: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  issuedAt?: Date | null;
  paidAt?: Date | null;
  voidedAt?: Date | null;
  lineItems?: unknown[];
  taxBreakdown?: unknown[];
  downloadUrl?: string | null;
  couponId?: string | null;
  discountAmount?: number;
}

export async function upsertInvoice(input: UpsertInvoiceInput): Promise<InvoiceLean> {
  const doc = await Invoice.findOneAndUpdate(
    { gateway: input.gateway, gatewayInvoiceId: input.gatewayInvoiceId },
    {
      $set: {
        productId: input.productId,
        subscriptionId: input.subscriptionId,
        subjectType: input.subjectType,
        subjectUserId: input.subjectUserId ?? null,
        subjectWorkspaceId: input.subjectWorkspaceId ?? null,
        gateway: input.gateway,
        invoiceNumber: input.invoiceNumber ?? null,
        status: input.status,
        amountSubtotal: input.amountSubtotal,
        amountTax: input.amountTax,
        amountTotal: input.amountTotal,
        amountPaid: input.amountPaid,
        currency: input.currency.toLowerCase(),
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        issuedAt: input.issuedAt ?? new Date(),
        paidAt: input.paidAt ?? null,
        voidedAt: input.voidedAt ?? null,
        lineItems: input.lineItems ?? [],
        taxBreakdown: input.taxBreakdown ?? [],
        downloadUrl: input.downloadUrl ?? null,
        couponId: input.couponId ?? null,
        discountAmount: input.discountAmount ?? 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean<InvoiceLean | null>();
  if (!doc) throw new Error('upsertInvoice returned null');
  return doc;
}

export async function findById(
  productId: string,
  invoiceId: string,
): Promise<InvoiceLean | null> {
  return Invoice.findOne({ productId, _id: invoiceId }).lean<InvoiceLean | null>();
}

export async function listForSubject(args: {
  productId: string;
  subjectType: 'user' | 'workspace';
  subjectUserId?: string | null;
  subjectWorkspaceId?: string | null;
  limit?: number;
}): Promise<InvoiceLean[]> {
  const q: Record<string, unknown> = { productId: args.productId };
  if (args.subjectType === 'workspace' && args.subjectWorkspaceId) {
    q['subjectWorkspaceId'] = args.subjectWorkspaceId;
  } else if (args.subjectType === 'user' && args.subjectUserId) {
    q['subjectUserId'] = args.subjectUserId;
  }
  return Invoice.find(q)
    .sort({ issuedAt: -1 })
    .limit(args.limit ?? 25)
    .lean<InvoiceLean[]>();
}

export async function findLatestPaidForSubscription(
  productId: string,
  subscriptionId: string,
): Promise<InvoiceLean | null> {
  return Invoice.findOne({ productId, subscriptionId, status: 'paid' })
    .sort({ paidAt: -1 })
    .lean<InvoiceLean | null>();
}

export async function markRefunded(
  productId: string,
  invoiceId: string,
): Promise<void> {
  await Invoice.updateOne(
    { productId, _id: invoiceId },
    { $set: { status: 'refunded' } },
  );
}
