/**
 * Email worker — drains the `emailQueue` collection in priority order,
 * delivers via a pluggable driver, retries with exponential backoff up to a
 * configurable cap, and finally moves rows to status DEAD.
 *
 * The worker is framework-agnostic — the cron-runner / Agenda integration
 * (Phase 5) wires `processBatch()` on a 30s interval. Tests can drive it
 * directly via `processBatch({ now })`.
 *
 * Driver contract (see `EmailDriver`):
 *   - send({...}) → { providerMessageId } on success
 *   - throws on failure; the caller decides retryability.
 */
import { logger } from '../lib/logger.js';
import { EmailQueue, type EmailQueueDoc } from '../db/models/EmailQueue.js';

export interface EmailDriverPayload {
  toAddress: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  templateId: string;
  templateData: Record<string, unknown>;
}

export interface EmailDriver {
  name: 'resend' | 'ses' | 'console';
  send(payload: EmailDriverPayload): Promise<{ providerMessageId: string }>;
}

/** Default driver for local dev + tests. Logs the email and returns a synthetic id. */
export const consoleDriver: EmailDriver = {
  name: 'console',
  async send(payload) {
    logger.info(
      {
        to: payload.toAddress,
        from: payload.fromAddress,
        templateId: payload.templateId,
        subject: payload.subject,
      },
      '[email/console] send',
    );
    return { providerMessageId: `console_${Date.now()}_${Math.random().toString(36).slice(2)}` };
  },
};

/** Backoff in ms per attempt index (0-based). Cap = 6 attempts → DEAD. */
const RETRY_DELAYS_MS = [
  30_000, // 30s
  5 * 60_000, // 5m
  30 * 60_000, // 30m
  2 * 60 * 60_000, // 2h
  6 * 60 * 60_000, // 6h
];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 6

export interface ProcessBatchOptions {
  driver: EmailDriver;
  now?: Date;
  /** Max rows to claim per pass. */
  batchSize?: number;
}

export interface ProcessBatchOutcome {
  attempted: number;
  sent: number;
  failed: number;
  dead: number;
}

/** Atomically claim and process up to `batchSize` PENDING emails whose nextAttemptAt is due. */
export async function processBatch(opts: ProcessBatchOptions): Promise<ProcessBatchOutcome> {
  const driver = opts.driver;
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 25;

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let dead = 0;

  for (let i = 0; i < batchSize; i++) {
    const claimed = await EmailQueue.findOneAndUpdate(
      {
        status: 'PENDING',
        nextAttemptAt: { $lte: now },
      },
      {
        $set: { status: 'PENDING', nextAttemptAt: new Date(now.getTime() + 60_000) },
        $inc: { attemptCount: 1 },
      },
      { new: true, sort: { priority: 1, nextAttemptAt: 1 } },
    ).lean<EmailQueueDoc | null>();

    if (!claimed) break;
    attempted++;

    try {
      const { providerMessageId } = await driver.send({
        toAddress: claimed.toAddress,
        fromAddress: claimed.fromAddress,
        fromName: claimed.fromName ?? null,
        subject: claimed.subject,
        templateId: claimed.templateId,
        templateData: (claimed.templateData ?? {}) as Record<string, unknown>,
      });
      await EmailQueue.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: 'SENT',
            sentAt: new Date(),
            provider: driver.name === 'console' ? 'resend' : driver.name,
            providerMessageId,
          },
        },
      );
      sent++;
    } catch (err) {
      // `claimed` is the post-$inc doc, so its attemptCount already reflects this attempt.
      const attempt = claimed.attemptCount ?? 1;
      if (attempt >= MAX_ATTEMPTS) {
        await EmailQueue.updateOne(
          { _id: claimed._id },
          {
            $set: { status: 'DEAD', failedAt: new Date() },
            $push: { attempts: { at: new Date(), error: String((err as Error).message ?? err) } },
          },
        );
        dead++;
        logger.error({ id: claimed._id, err }, 'email worker: row marked DEAD');
      } else {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
        await EmailQueue.updateOne(
          { _id: claimed._id },
          {
            $set: { status: 'PENDING', nextAttemptAt: new Date(now.getTime() + delay) },
            $push: { attempts: { at: new Date(), error: String((err as Error).message ?? err) } },
          },
        );
        failed++;
      }
    }
  }

  return { attempted, sent, failed, dead };
}
