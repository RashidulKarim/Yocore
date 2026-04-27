/**
 * Announcements model — V1.1-D Screen 12.
 *
 * Super-Admin can publish global or per-product banners that show in
 * end-user product UIs (and admin-web). Stored without the `productId`
 * filter when global; per-product when scoped.
 */
import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

const announcementSchema = new Schema(
  {
    _id: { type: String, default: idDefault('ann') },
    productId: { type: String, default: null },
    title: { type: String, required: true },
    body: { type: String, required: true },
    severity: {
      type: String,
      enum: ['info', 'warning', 'critical'],
      default: 'info',
    },
    audience: {
      type: String,
      enum: ['all_users', 'product_admins', 'super_admin_only'],
      default: 'all_users',
    },
    publishedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    publishedBy: { type: String, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'announcements' },
);

announcementSchema.index({ productId: 1, publishedAt: -1 });
announcementSchema.index({ publishedAt: -1 });

export type AnnouncementDoc = InferSchemaType<typeof announcementSchema> & {
  _id: string;
};
export const Announcement: Model<AnnouncementDoc> = model<AnnouncementDoc>(
  'Announcement',
  announcementSchema,
);
