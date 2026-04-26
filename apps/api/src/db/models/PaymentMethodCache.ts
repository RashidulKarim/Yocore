import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.33 v1.7 `paymentMethodsCache` — Denormalised card details (24h TTL). */
const paymentMethodCacheSchema = new Schema(
  {
    _id: { type: String, default: idDefault('pmc') },
    userId: { type: String, required: true },
    productId: { type: String, required: true },
    gateway: { type: String, required: true },

    gatewayPaymentMethodId: { type: String, required: true },
    isDefault: { type: Boolean, default: false },

    brand: { type: String, default: null },
    last4: { type: String, default: null },
    expiryMonth: { type: Number, default: null },
    expiryYear: { type: Number, default: null },
    holderName: { type: String, default: null },
    funding: { type: String, default: null },

    cachedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true },

    _v: { type: Number, default: 1 },
  },
  { collection: 'paymentMethodsCache' },
);

paymentMethodCacheSchema.index({ userId: 1, productId: 1, gateway: 1 });
paymentMethodCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type PaymentMethodCacheDoc = InferSchemaType<typeof paymentMethodCacheSchema> & {
  _id: string;
};
export const PaymentMethodCache: Model<PaymentMethodCacheDoc> = model<PaymentMethodCacheDoc>(
  'PaymentMethodCache',
  paymentMethodCacheSchema,
);
