import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §7.3 `invoices` — Cached gateway invoice metadata (B-10). */
const invoiceSchema = new Schema(
  {
    _id: { type: String, default: idDefault('inv') },
    productId: { type: String, required: true },
    subscriptionId: { type: String, required: true },
    subjectType: { type: String, enum: ['user', 'workspace'], required: true },
    subjectWorkspaceId: { type: String, default: null },
    subjectUserId: { type: String, default: null },
    gateway: { type: String, enum: ['stripe', 'sslcommerz', 'paypal', 'paddle'], required: true },
    gatewayInvoiceId: { type: String, required: true },
    invoiceNumber: { type: String, default: null },
    status: {
      type: String,
      enum: ['draft', 'open', 'paid', 'void', 'uncollectible', 'refunded'],
      default: 'open',
    },
    amountSubtotal: { type: Number, default: 0 },
    amountTax: { type: Number, default: 0 },
    amountTotal: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    currency: { type: String, default: 'usd', lowercase: true },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    issuedAt: { type: Date, default: () => new Date() },
    paidAt: { type: Date, default: null },
    voidedAt: { type: Date, default: null },
    lineItems: { type: [Schema.Types.Mixed], default: [] },
    taxBreakdown: { type: [Schema.Types.Mixed], default: [] },
    downloadUrl: { type: String, default: null },
    couponId: { type: String, default: null },
    discountAmount: { type: Number, default: 0 },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'invoices' },
);

invoiceSchema.index({ gateway: 1, gatewayInvoiceId: 1 }, { unique: true });
invoiceSchema.index({ productId: 1, subjectWorkspaceId: 1, issuedAt: -1 });
invoiceSchema.index({ productId: 1, subjectUserId: 1, issuedAt: -1 });
invoiceSchema.index({ subscriptionId: 1, issuedAt: -1 });
invoiceSchema.index({ status: 1, issuedAt: -1 });

export type InvoiceDoc = InferSchemaType<typeof invoiceSchema> & { _id: string };
export const Invoice: Model<InvoiceDoc> = model<InvoiceDoc>('Invoice', invoiceSchema);
