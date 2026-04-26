import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.6 + §7.1 `workspaces` — Teams scoped to a product. */
const workspaceSchema = new Schema(
  {
    _id: { type: String, default: idDefault('ws') },
    productId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    logoUrl: { type: String, default: null },
    ownerUserId: { type: String, required: true },
    billingContactUserId: { type: String, required: true },

    status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'DELETED'], default: 'ACTIVE' },
    suspended: { type: Boolean, default: false },
    suspensionDate: { type: Date, default: null },
    suspensionReason: { type: String, default: null },

    suspensionWarning30Sent: { type: Boolean, default: false },
    suspensionWarning60Sent: { type: Boolean, default: false },
    trialWarningSent: {
      days3: { type: Boolean, default: false },
      days1: { type: Boolean, default: false },
    },
    trialConverted: { type: Boolean, default: false },

    dataDeleted: { type: Boolean, default: false },
    dataDeletedAt: { type: Date, default: null },

    timezone: { type: String, default: 'UTC' },
    settings: { type: Schema.Types.Mixed, default: {} },

    // v1.5 voluntary deletion
    voluntaryDeletionRequestedAt: { type: Date, default: null },
    voluntaryDeletionFinalizesAt: { type: Date, default: null },
    ownershipTransferredAt: { type: Date, default: null },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'workspaces' },
);

workspaceSchema.index({ productId: 1, slug: 1 }, { unique: true });
workspaceSchema.index({ productId: 1, ownerUserId: 1 });
workspaceSchema.index({ suspended: 1, suspensionDate: 1 });
workspaceSchema.index({ status: 1 });

export type WorkspaceDoc = InferSchemaType<typeof workspaceSchema> & { _id: string };
export const Workspace: Model<WorkspaceDoc> = model<WorkspaceDoc>('Workspace', workspaceSchema);
