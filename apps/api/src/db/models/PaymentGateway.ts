import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.11 `paymentGateways` — Per-product gateway config (encrypted credentials). */
const paymentGatewaySchema = new Schema(
  {
    _id: { type: String, default: idDefault('pg') },
    productId: { type: String, required: true },
    provider: { type: String, enum: ['stripe', 'sslcommerz', 'paypal', 'paddle'], required: true },
    mode: { type: String, enum: ['live', 'test'], default: 'test' },
    status: {
      type: String,
      enum: ['ACTIVE', 'DISABLED', 'INVALID_CREDENTIALS'],
      default: 'ACTIVE',
    },
    displayName: { type: String, default: null },

    /**
     * Encrypted credentials. Each value is an envelope-encrypted token string
     * produced by `lib/encryption.ts`. The shape is provider-specific.
     */
    credentialsEncrypted: { type: Schema.Types.Mixed, default: {} },

    lastVerifiedAt: { type: Date, default: null },
    lastVerificationStatus: { type: String, enum: ['ok', 'failed', null], default: null },
    lastVerificationError: { type: String, default: null },

    createdBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'paymentGateways' },
);

paymentGatewaySchema.index({ productId: 1, provider: 1, mode: 1 }, { unique: true });
paymentGatewaySchema.index({ productId: 1, status: 1 });

export type PaymentGatewayDoc = InferSchemaType<typeof paymentGatewaySchema> & { _id: string };
export const PaymentGateway: Model<PaymentGatewayDoc> = model<PaymentGatewayDoc>(
  'PaymentGateway',
  paymentGatewaySchema,
);
