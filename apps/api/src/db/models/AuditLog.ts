import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.14 `auditLogs` — Append-only event trail with hash chain. */
const auditLogSchema = new Schema(
  {
    _id: { type: String, default: idDefault('log') },
    ts: { type: Date, default: () => new Date() },
    productId: { type: String, default: null },
    workspaceId: { type: String, default: null },

    actor: {
      type: {
        type: String,
        enum: ['user', 'super_admin', 'product', 'system', 'webhook'],
        required: true,
      },
      id: { type: String, default: null },
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
      apiKeyId: { type: String, default: null },
      sessionId: { type: String, default: null },
      correlationId: { type: String, default: null },
    },

    action: { type: String, required: true },
    resource: {
      type: { type: String, default: null },
      id: { type: String, default: null },
    },
    outcome: { type: String, enum: ['success', 'failure', 'denied'], required: true },
    reason: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },

    prevHash: { type: String, default: null },
    hash: { type: String, required: true },
  },
  { collection: 'auditLogs' },
);

auditLogSchema.index({ productId: 1, ts: -1 });
auditLogSchema.index({ 'actor.id': 1, ts: -1 });
auditLogSchema.index({ action: 1, ts: -1 });
auditLogSchema.index({ 'resource.type': 1, 'resource.id': 1, ts: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema> & { _id: string };
export const AuditLog: Model<AuditLogDoc> = model<AuditLogDoc>('AuditLog', auditLogSchema);
