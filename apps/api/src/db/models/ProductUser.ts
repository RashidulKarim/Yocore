import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/**
 * §1.5 `productUsers` — User ↔ Product junction.
 * All per-product profile, credentials, and status.
 */
const productUserSchema = new Schema(
  {
    _id: { type: String, default: idDefault('pu') },
    userId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },

    passwordHash: { type: String, default: null },
    passwordUpdatedAt: { type: Date, default: null },

    name: {
      first: { type: String, default: null },
      last: { type: String, default: null },
      display: { type: String, default: null },
    },
    avatarUrl: { type: String, default: null },
    timezone: { type: String, default: 'UTC' },
    locale: { type: String, default: 'en-US' },
    dateFormat: { type: String, default: 'YYYY-MM-DD' },
    timeFormat: { type: String, default: '24h' },
    marketingOptIn: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['UNVERIFIED', 'ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED'],
      default: 'UNVERIFIED',
    },

    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: null },

    joinedAt: { type: Date, default: () => new Date() },
    lastActiveAt: { type: Date, default: null },
    onboarded: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },

    preferences: {
      type: Schema.Types.Mixed,
      default: () => ({ notifications: { email: true, inApp: true }, theme: 'light', favorites: [] }),
    },

    productRole: { type: String, enum: ['END_USER', 'PRODUCT_ADMIN'], default: 'END_USER' },

    // v1.5 additions
    emailPreferences: {
      marketing: { type: Boolean, default: false },
      productUpdates: { type: Boolean, default: true },
      billing: { type: Boolean, default: true },
      security: { type: Boolean, default: true },
    },
    emailDeliverable: { type: Boolean, default: true },
    emailDeliverableUpdatedAt: { type: Date, default: null },
    mfaEnrolledAt: { type: Date, default: null },
    lastKnownDevices: {
      type: [
        {
          _id: false,
          fingerprint: String,
          country: String,
          city: String,
          lastSeenAt: Date,
        },
      ],
      default: [],
    },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'productUsers' },
);

productUserSchema.index({ userId: 1, productId: 1 }, { unique: true });
productUserSchema.index({ productId: 1, status: 1, lastActiveAt: -1 });
productUserSchema.index({ productId: 1, lockedUntil: 1 }, { sparse: true });

export type ProductUserDoc = InferSchemaType<typeof productUserSchema> & { _id: string };
export const ProductUser: Model<ProductUserDoc> = model<ProductUserDoc>(
  'ProductUser',
  productUserSchema,
);
