/**
 * Mongo-backed `CronLockStore` (ADR-008).
 *
 * Provides distributed mutual exclusion for scheduled jobs across N pods using
 * the unique `{jobName, dateKey}` index on the `cronLocks` collection. Acquire
 * is implemented as `insertOne`; an E11000 duplicate key means another pod
 * holds the lock for this occurrence.
 *
 * The `lockedAt` TTL index (24h) reaps stale locks; we additionally release
 * on completion to allow earlier-than-TTL re-runs (e.g. manual force-run).
 */
import { CronLock } from '../db/models/CronLock.js';
import type { CronLockStore } from '../lib/cron-runner.js';

export interface CreateMongoCronLockStoreOptions {
  /** Identifier of this process for diagnostics (e.g. `os.hostname()`). */
  instanceId: string;
}

export function createMongoCronLockStore(
  opts: CreateMongoCronLockStoreOptions,
): CronLockStore {
  return {
    async acquire(jobName, dateKey, _ttlMs): Promise<boolean> {
      try {
        await CronLock.create({
          jobName,
          dateKey,
          lockedByInstanceId: opts.instanceId,
          lockedAt: new Date(),
        });
        return true;
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 11000) return false;
        throw err;
      }
    },
    async release(jobName, dateKey): Promise<void> {
      await CronLock.updateOne(
        { jobName, dateKey, completedAt: null },
        { $set: { completedAt: new Date() } },
      );
    },
  };
}

/** Diagnostic — return the latest lock row per jobName for cron-status admin endpoint. */
export async function listLatestLocks(): Promise<
  Array<{
    jobName: string;
    lastDateKey: string | null;
    lastLockedAt: Date | null;
    lastCompletedAt: Date | null;
    lastInstanceId: string | null;
  }>
> {
  const rows = await CronLock.aggregate<{
    _id: string;
    lastDateKey: string;
    lastLockedAt: Date;
    lastCompletedAt: Date | null;
    lastInstanceId: string | null;
  }>([
    { $sort: { lockedAt: -1 } },
    {
      $group: {
        _id: '$jobName',
        lastDateKey: { $first: '$dateKey' },
        lastLockedAt: { $first: '$lockedAt' },
        lastCompletedAt: { $first: '$completedAt' },
        lastInstanceId: { $first: '$lockedByInstanceId' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({
    jobName: r._id,
    lastDateKey: r.lastDateKey,
    lastLockedAt: r.lastLockedAt,
    lastCompletedAt: r.lastCompletedAt,
    lastInstanceId: r.lastInstanceId,
  }));
}
