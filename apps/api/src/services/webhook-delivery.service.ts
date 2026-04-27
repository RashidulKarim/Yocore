/**
 * Outbound webhook delivery worker — drains the `webhookDeliveries` collection.
 *
 * Atomically claims a due PENDING row, signs the payload with the product's
 * `webhookSecret` (HMAC-SHA256 via `signWebhook`), POSTs to `product.webhookUrl`,
 * and updates the row's status / nextRetryAt based on the outcome.
 *
 * Backoff schedule (5 retries → DEAD):
 *   attempt 1 fails → +30s
 *   attempt 2 fails → +5m
 *   attempt 3 fails → +30m
 *   attempt 4 fails → +2h
 *   attempt 5 fails → +6h
 *   attempt 6 fails → DEAD
 *
 * Success criteria: HTTP status in [200, 300). Anything else = retry/DEAD.
 *
 * Cron registration: `webhook.delivery.tick` runs `processBatch()` on each
 * pod every 30s. We do NOT use Mongo cronLocks here — claim-locking via
 * `lockedUntil` on each row is sufficient (per-row mutex).
 */
import { logger } from '../lib/logger.js';
import { signWebhook } from '../lib/webhook-signature.js';
import { webhookDeliveryTotal, webhookDeliveryDuration } from '../lib/metrics.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import * as productRepo from '../repos/product.repo.js';

/** Backoff delays in ms; index = attempt-1 that just failed. */
const RETRY_DELAYS_MS = [
  30_000, // after attempt 1 → +30s
  5 * 60_000, // after attempt 2 → +5m
  30 * 60_000, // after attempt 3 → +30m
  2 * 60 * 60_000, // after attempt 4 → +2h
  6 * 60 * 60_000, // after attempt 5 → +6h
];
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 6

export interface DeliveryHttpClient {
  post(args: {
    url: string;
    body: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }): Promise<{ statusCode: number; bodyPreview: string }>;
}

export const defaultHttpClient: DeliveryHttpClient = {
  async post({ url, body, headers, timeoutMs }) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers,
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => '');
      return { statusCode: res.status, bodyPreview: text.slice(0, 500) };
    } finally {
      clearTimeout(t);
    }
  },
};

export interface CreateWebhookDeliveryServiceOptions {
  httpClient?: DeliveryHttpClient;
  /** Override clock (tests). */
  now?: () => Date;
  /** Per-attempt HTTP timeout. Default 10s. */
  requestTimeoutMs?: number;
  /** Lease time on a claimed row before another worker may steal it. Default 60s. */
  lockTtlMs?: number;
  /** YoCore version sent in `User-Agent`. */
  userAgent?: string;
}

export interface ProcessBatchOptions {
  batchSize?: number;
  now?: Date;
}

export interface ProcessBatchOutcome {
  attempted: number;
  delivered: number;
  retried: number;
  dead: number;
  skipped: number;
}

export interface WebhookDeliveryService {
  processBatch(opts?: ProcessBatchOptions): Promise<ProcessBatchOutcome>;
  retryNow(id: string): Promise<deliveryRepo.WebhookDeliveryLean | null>;
}

export function createWebhookDeliveryService(
  opts: CreateWebhookDeliveryServiceOptions = {},
): WebhookDeliveryService {
  const httpClient = opts.httpClient ?? defaultHttpClient;
  const now = opts.now ?? (() => new Date());
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const lockTtlMs = opts.lockTtlMs ?? 60_000;
  const userAgent = opts.userAgent ?? 'YoCore-Webhooks/1.0';

  async function processOne(row: deliveryRepo.WebhookDeliveryLean, t: Date): Promise<'delivered' | 'retried' | 'dead' | 'skipped'> {
    const product = await productRepo.findProductById(row.productId);
    if (!product || !product.webhookSecret || !product.webhookUrl) {
      // Product gone or webhook config removed — mark DEAD so it doesn't loop forever.
      await deliveryRepo.markDead({
        id: row._id,
        at: t,
        statusCode: null,
        durationMs: 0,
        error: 'Product webhook config missing',
      });
      return 'dead';
    }
    // Build canonical envelope (versioned per product.webhookPayloadVersion).
    const envelope = {
      id: row.eventId,
      type: row.event,
      createdAt: t.toISOString(),
      apiVersion: product.webhookPayloadVersion ?? '2026-04-23',
      data: row.payload ?? { ref: row.payloadRef },
    };
    const body = JSON.stringify(envelope);
    const sig = signWebhook(body, product.webhookSecret, t);

    // Build headers — include previous-secret signature during 24h rotation grace.
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': userAgent,
      'x-webhook-event': row.event,
      'x-webhook-event-id': row.eventId,
      'x-webhook-signature': sig.header,
      'x-webhook-attempt': String(row.attemptCount ?? 1),
    };
    const prevExpiresAt = product.webhookSecretPrevious?.expiresAt;
    const prevSecret = product.webhookSecretPrevious?.secret;
    if (prevSecret && prevExpiresAt && prevExpiresAt.getTime() > t.getTime()) {
      const prevSig = signWebhook(body, prevSecret, t);
      headers['x-webhook-signature-previous'] = prevSig.header;
    }

    const start = Date.now();
    try {
      const res = await httpClient.post({
        url: product.webhookUrl,
        body,
        headers,
        timeoutMs: requestTimeoutMs,
      });
      const dur = Date.now() - start;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await deliveryRepo.markDelivered({
          id: row._id,
          at: t,
          statusCode: res.statusCode,
          durationMs: dur,
        });
        return 'delivered';
      }
      // Non-2xx → retry or DEAD.
      const err = `HTTP ${res.statusCode}: ${res.bodyPreview.slice(0, 200)}`;
      return scheduleRetryOrDead(row, t, res.statusCode, dur, err);
    } catch (e) {
      const dur = Date.now() - start;
      const msg = e instanceof Error ? e.message : String(e);
      return scheduleRetryOrDead(row, t, null, dur, msg);
    }
  }

  async function scheduleRetryOrDead(
    row: deliveryRepo.WebhookDeliveryLean,
    t: Date,
    statusCode: number | null,
    durationMs: number,
    error: string,
  ): Promise<'retried' | 'dead'> {
    const attempt = row.attemptCount ?? 1;
    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      await deliveryRepo.markDead({ id: row._id, at: t, statusCode, durationMs, error });
      logger.warn(
        { id: row._id, productId: row.productId, event: row.event, attempt },
        'webhook delivery: marked DEAD after max attempts',
      );
      return 'dead';
    }
    const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
    const nextRetryAt = new Date(t.getTime() + delay);
    await deliveryRepo.markFailedRetry({
      id: row._id,
      at: t,
      statusCode,
      durationMs,
      error,
      nextRetryAt,
    });
    return 'retried';
  }

  async function processBatch(o: ProcessBatchOptions = {}): Promise<ProcessBatchOutcome> {
    const t = o.now ?? now();
    const batchSize = o.batchSize ?? 25;
    const out: ProcessBatchOutcome = { attempted: 0, delivered: 0, retried: 0, dead: 0, skipped: 0 };
    for (let i = 0; i < batchSize; i++) {
      const row = await deliveryRepo.claimDueDelivery({ now: t, lockTtlMs });
      if (!row) break;
      out.attempted++;
      const startMs = Date.now();
      try {
        const result = await processOne(row, t);
        out[result]++;
        webhookDeliveryTotal.labels(result).inc();
        webhookDeliveryDuration.labels(result).observe((Date.now() - startMs) / 1000);
      } catch (e) {
        // Defensive: never crash the whole batch — release lock + mark for retry.
        const msg = e instanceof Error ? e.message : String(e);
        out.skipped++;
        webhookDeliveryTotal.labels('skipped').inc();
        logger.error({ id: row._id, err: e }, 'webhook delivery: unexpected processOne error');
        await scheduleRetryOrDead(row, t, null, 0, `worker error: ${msg}`).catch(() => undefined);
      }
    }
    return out;
  }

  async function retryNow(id: string): Promise<deliveryRepo.WebhookDeliveryLean | null> {
    return deliveryRepo.resetForRetry(id, now());
  }

  return { processBatch, retryNow };
}
