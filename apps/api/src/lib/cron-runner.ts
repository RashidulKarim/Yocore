/**
 * Distributed cron runner. See ADR-008.
 *
 * Wraps Agenda with a `cronLocks` mutex so that across N pods only one runs
 * each scheduled occurrence. The CronLock model is created in Phase 2.3; this
 * module accepts the lock store as a dependency so it can be unit-tested
 * without Mongoose.
 */
import type { Logger } from 'pino';
import { logger as defaultLogger } from './logger.js';

export interface CronLockStore {
  /**
   * Try to acquire a lock for `(jobName, dateKey)`. Resolves true if acquired,
   * false if already held by another pod for this occurrence.
   */
  acquire(jobName: string, dateKey: string, ttlMs: number): Promise<boolean>;
  /** Release a lock (best-effort). */
  release(jobName: string, dateKey: string): Promise<void>;
}

export interface CronJob {
  name: string;
  /** Cron-like schedule descriptor — runner does not parse, just identifies. */
  schedule: string;
  /** Returns a stable bucket key per occurrence (e.g. 'YYYY-MM-DDTHH:mm'). */
  dateKey: () => string;
  /** TTL of the lock — should be > expected runtime + safety margin. */
  lockTtlMs: number;
  handler: () => Promise<void>;
}

export interface CronRunnerOptions {
  store: CronLockStore;
  logger?: Logger;
}

export class CronRunner {
  private readonly store: CronLockStore;
  private readonly log: Logger;
  private readonly jobs = new Map<string, CronJob>();

  constructor(opts: CronRunnerOptions) {
    this.store = opts.store;
    this.log = opts.logger ?? defaultLogger;
  }

  register(job: CronJob): void {
    if (this.jobs.has(job.name)) throw new Error(`cron: job '${job.name}' already registered`);
    this.jobs.set(job.name, job);
  }

  /**
   * Execute a job once if-and-only-if this pod wins the lock.
   * Returns true if the handler ran, false if another pod held the lock or it failed.
   */
  async runOnce(name: string): Promise<boolean> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`cron: unknown job '${name}'`);
    const dateKey = job.dateKey();
    const acquired = await this.store.acquire(name, dateKey, job.lockTtlMs);
    if (!acquired) {
      this.log.debug({ event: 'cron.skipped', job: name, dateKey }, 'cron lock not acquired');
      return false;
    }
    const startedAt = Date.now();
    try {
      await job.handler();
      this.log.info(
        { event: 'cron.ran', job: name, dateKey, durationMs: Date.now() - startedAt },
        'cron ran',
      );
      return true;
    } catch (err) {
      this.log.error({ event: 'cron.failed', job: name, dateKey, err }, 'cron handler failed');
      return false;
    } finally {
      await this.store.release(name, dateKey).catch(() => undefined);
    }
  }

  list(): readonly string[] {
    return [...this.jobs.keys()];
  }
}
