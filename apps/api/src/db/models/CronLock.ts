import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { idDefault } from '../id.js';

/** §1.17 `cronLocks` — Distributed cron idempotency (FIX-CRON). */
const cronLockSchema = new Schema(
  {
    _id: { type: String, default: idDefault('cronlock') },
    jobName: { type: String, required: true },
    dateKey: { type: String, required: true },
    lockedAt: { type: Date, default: () => new Date() },
    lockedByInstanceId: { type: String, required: true },
    completedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { collection: 'cronLocks' },
);

cronLockSchema.index({ jobName: 1, dateKey: 1 }, { unique: true });
cronLockSchema.index({ lockedAt: 1 }, { expireAfterSeconds: 86_400 });

export type CronLockDoc = InferSchemaType<typeof cronLockSchema> & { _id: string };
export const CronLock: Model<CronLockDoc> = model<CronLockDoc>('CronLock', cronLockSchema);
