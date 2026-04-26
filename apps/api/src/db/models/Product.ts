import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** Encrypted blob produced by `lib/encryption.ts` (envelope-encrypted token string). */
const encryptedField = { type: String, default: null };

/** §1.4 + §7.1 `products` — Registered Yo products. */
const productSchema = new Schema(
  {
    _id: { type: String, default: idDefault('prod') },
    name: { type: String, required: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    domain: { type: String, default: null },
    allowedOrigins: { type: [String], default: [] },
    allowedRedirectUris: { type: [String], default: [] },
    logoUrl: { type: String, default: null },
    description: { type: String, default: null },
    status: {
      type: String,
      enum: ['INACTIVE', 'ACTIVE', 'MAINTENANCE', 'ABANDONED'],
      default: 'INACTIVE',
    },
    abandonedAt: { type: Date, default: null },
    apiKeyLastUsedAt: { type: Date, default: null },

    apiKey: { type: String, required: true },
    apiSecretHash: { type: String, required: true },
    apiSecretCreatedAt: { type: Date, default: () => new Date() },
    apiSecretRotatedAt: { type: Date, default: null },

    webhookUrl: { type: String, default: null },
    webhookSecret: { type: String, default: null },
    webhookEvents: { type: [String], default: [] },
    // v1.5 rotation grace
    webhookSecretPrevious: {
      secret: { type: String, default: null },
      deprecatedAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
    },
    webhookPayloadVersion: { type: String, default: '2026-04-23' },

    billingScope: { type: String, enum: ['user', 'workspace'], default: 'workspace' },

    billingConfig: {
      gatewayRouting: { type: Schema.Types.Mixed, default: { default: 'stripe' } },
      gracePeriodDays: { type: Number, default: 7 },
      gracePeriodEmailSchedule: { type: [Number], default: [1, 5, 7] },
      holdPeriodDays: { type: Number, default: 85 },
      holdPeriodWarningDays: { type: [Number], default: [30, 60] },
      canReactivateDuringHold: { type: Boolean, default: true },
      trialDefaultDays: { type: Number, default: 14 },
      trialWarningDays: { type: [Number], default: [3, 1] },
    },

    defaultRoleSlug: { type: String, default: 'MEMBER' },

    authConfig: {
      hostedUiEnabled: { type: Boolean, default: false },
      hostedUiTheme: {
        primaryColor: { type: String, default: '#6366f1' },
        logoUrl: { type: String, default: null },
        brandName: { type: String, default: null },
      },
      allowedRedirectUris: { type: [String], default: [] },
      pkceEnabled: { type: Boolean, default: true },
      maxConcurrentSessions: { type: Number, default: null },
      passwordPolicy: { type: Schema.Types.Mixed, default: null },
    },

    settings: {
      fromEmail: { type: String, default: null },
      fromName: { type: String, default: null },
    },

    rateLimitPerMinute: { type: Number, default: 1000 },

    taxConfig: {
      stripeAutomaticTax: { type: Boolean, default: false },
      taxBehavior: { type: String, enum: ['exclusive', 'inclusive'], default: 'exclusive' },
      sslcommerzVatPercent: { type: Number, default: null },
    },

    createdBy: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'products' },
);

productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ apiKey: 1 }, { unique: true });
productSchema.index({ status: 1 });

void encryptedField; // exported helper if other models want it later

export type ProductDoc = InferSchemaType<typeof productSchema> & { _id: string };
export const Product: Model<ProductDoc> = model<ProductDoc>('Product', productSchema);
