import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §7.4 `auditLogExportJobs` — Async export queue (GAP-21). */
const auditLogExportJobSchema = new Schema(
  {
    _id: { type: String, default: idDefault('aej') },
    requestedBy: { type: String, required: true },
    productId: { type: String, default: null },
    filters: {
      dateFrom: { type: Date, default: null },
      dateTo: { type: Date, default: null },
      actions: { type: [String], default: [] },
      resourceTypes: { type: [String], default: [] },
    },
    format: { type: String, enum: ['json', 'csv'], default: 'json' },
    status: {
      type: String,
      enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
    },
    rowCount: { type: Number, default: null },
    s3Key: { type: String, default: null },
    signedUrl: { type: String, default: null },
    signedUrlExpiresAt: { type: Date, default: null },
    errorMessage: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'auditLogExportJobs' },
);

auditLogExportJobSchema.index({ requestedBy: 1, createdAt: -1 });
auditLogExportJobSchema.index({ status: 1, createdAt: 1 });
auditLogExportJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2_592_000 });

export type AuditLogExportJobDoc = InferSchemaType<typeof auditLogExportJobSchema> & {
  _id: string;
};
export const AuditLogExportJob: Model<AuditLogExportJobDoc> = model<AuditLogExportJobDoc>(
  'AuditLogExportJob',
  auditLogExportJobSchema,
);
