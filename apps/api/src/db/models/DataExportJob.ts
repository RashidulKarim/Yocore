import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.19 `dataExportJobs` — GDPR data export queue. */
const dataExportJobSchema = new Schema(
  {
    _id: { type: String, default: idDefault('exp') },
    userId: { type: String, required: true },
    /** "all" or array of productIds. */
    scope: { type: Schema.Types.Mixed, default: 'all' },
    status: {
      type: String,
      enum: ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED'],
      default: 'PENDING',
    },
    s3Key: { type: String, default: null },
    s3SignedUrlExpiresAt: { type: Date, default: null },
    errorMessage: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    emailSentAt: { type: Date, default: null },
    requestedFromIp: { type: String, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'dataExportJobs' },
);

dataExportJobSchema.index({ userId: 1, status: 1, createdAt: -1 });
dataExportJobSchema.index({ status: 1, createdAt: 1 });
dataExportJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2_592_000 });

export type DataExportJobDoc = InferSchemaType<typeof dataExportJobSchema> & { _id: string };
export const DataExportJob: Model<DataExportJobDoc> = model<DataExportJobDoc>(
  'DataExportJob',
  dataExportJobSchema,
);
