import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.7 `workspaceMembers` — Membership + role. */
const workspaceMemberSchema = new Schema(
  {
    _id: { type: String, default: idDefault('wm') },
    workspaceId: { type: String, required: true },
    productId: { type: String, required: true },
    userId: { type: String, required: true },
    roleId: { type: String, required: true },
    roleSlug: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'INVITED', 'REMOVED'], default: 'ACTIVE' },
    addedBy: { type: String, default: null },
    joinedAt: { type: Date, default: () => new Date() },
    removedAt: { type: Date, default: null },
    removedBy: { type: String, default: null },
  },
  { collection: 'workspaceMembers' },
);

workspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
workspaceMemberSchema.index({ userId: 1, productId: 1, status: 1 });
workspaceMemberSchema.index({ workspaceId: 1, status: 1 });

export type WorkspaceMemberDoc = InferSchemaType<typeof workspaceMemberSchema> & { _id: string };
export const WorkspaceMember: Model<WorkspaceMemberDoc> = model<WorkspaceMemberDoc>(
  'WorkspaceMember',
  workspaceMemberSchema,
);
