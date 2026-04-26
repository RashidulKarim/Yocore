import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.12 `invitations` — Workspace invitations (72h TTL). */
const invitationSchema = new Schema(
  {
    _id: { type: String, default: idDefault('inv') },
    productId: { type: String, required: true },
    workspaceId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    roleId: { type: String, required: true },
    roleSlug: { type: String, required: true },
    invitedBy: { type: String, required: true },
    tokenHash: { type: String, required: true },
    isExistingUser: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'],
      default: 'PENDING',
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedByUserId: { type: String, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null },
    resendCount: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'invitations' },
);

invitationSchema.index({ tokenHash: 1 }, { unique: true });
invitationSchema.index({ workspaceId: 1, email: 1, status: 1 });
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
invitationSchema.index({ status: 1, expiresAt: 1 });

export type InvitationDoc = InferSchemaType<typeof invitationSchema> & { _id: string };
export const Invitation: Model<InvitationDoc> = model<InvitationDoc>('Invitation', invitationSchema);
