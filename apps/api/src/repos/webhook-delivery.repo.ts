/**
 * Outbound webhook delivery repository — `webhookDeliveries` collection.
 *
 * Multi-tenant by `productId`. Enqueue inserts a PENDING row; the delivery
 * worker (`webhook-delivery.service.ts`) atomically claims rows whose
 * `nextRetryAt` is due, signs+POSTs them, and updates status/backoff.
 */
import { WebhookDelivery, type WebhookDeliveryDoc } from '../db/models/WebhookDelivery.js';

export type WebhookDeliveryLean = WebhookDeliveryDoc;

export interface EnqueueDeliveryInput {
  productId: string;
  event: string;
  eventId: string;
  url: string;
  payloadRef: string;
  payload?: Record<string, unknown> | null;
  signatureHeader?: string | null;
}

/**
 * Insert a PENDING delivery row. Idempotent on `eventId` (unique index): if a
 * delivery row already exists for this event id, we return the existing row.
 */
export async function enqueueDelivery(
  input: EnqueueDeliveryInput,
): Promise<WebhookDeliveryLean> {
  try {
    const doc = await WebhookDelivery.create({
      productId: input.productId,
      event: input.event,
      eventId: input.eventId,
      url: input.url,
      payloadRef: input.payloadRef,
      payload: input.payload ?? null,
      signatureHeader: input.signatureHeader ?? null,
      status: 'PENDING',
      attempts: [],
      attemptCount: 0,
      nextRetryAt: new Date(),
    });
    return doc.toObject() as WebhookDeliveryLean;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) {
      const existing = await WebhookDelivery.findOne({ eventId: input.eventId })
        .lean<WebhookDeliveryLean | null>();
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Atomically claim one due PENDING delivery for processing. Sets `lockedUntil`
 * to `now + lockTtlMs` so concurrent workers don't double-pick. Returns null
 * when nothing is due.
 */
export async function claimDueDelivery(args: {
  now: Date;
  lockTtlMs: number;
}): Promise<WebhookDeliveryLean | null> {
  const lockedUntil = new Date(args.now.getTime() + args.lockTtlMs);
  return WebhookDelivery.findOneAndUpdate(
    {
      status: 'PENDING',
      nextRetryAt: { $lte: args.now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: args.now } }],
    },
    {
      $set: { lockedUntil },
      $inc: { attemptCount: 1 },
    },
    { new: true, sort: { nextRetryAt: 1 } },
  ).lean<WebhookDeliveryLean | null>();
}

export async function markDelivered(args: {
  id: string;
  at: Date;
  statusCode: number;
  durationMs: number;
}): Promise<void> {
  await WebhookDelivery.updateOne(
    { _id: args.id },
    {
      $set: {
        status: 'DELIVERED',
        deliveredAt: args.at,
        lockedUntil: null,
        nextRetryAt: null,
        lastError: null,
      },
      $push: {
        attempts: { at: args.at, statusCode: args.statusCode, durationMs: args.durationMs, error: null },
      },
    },
  );
}

export async function markFailedRetry(args: {
  id: string;
  at: Date;
  statusCode: number | null;
  durationMs: number;
  error: string;
  nextRetryAt: Date;
}): Promise<void> {
  await WebhookDelivery.updateOne(
    { _id: args.id },
    {
      $set: {
        status: 'PENDING',
        nextRetryAt: args.nextRetryAt,
        lockedUntil: null,
        lastError: args.error,
      },
      $push: {
        attempts: { at: args.at, statusCode: args.statusCode, durationMs: args.durationMs, error: args.error },
      },
    },
  );
}

export async function markDead(args: {
  id: string;
  at: Date;
  statusCode: number | null;
  durationMs: number;
  error: string;
}): Promise<void> {
  await WebhookDelivery.updateOne(
    { _id: args.id },
    {
      $set: {
        status: 'DEAD',
        nextRetryAt: null,
        lockedUntil: null,
        lastError: args.error,
      },
      $push: {
        attempts: { at: args.at, statusCode: args.statusCode, durationMs: args.durationMs, error: args.error },
      },
    },
  );
}

export interface ListDeliveriesQuery {
  productId?: string | undefined;
  status?: 'PENDING' | 'DELIVERED' | 'FAILED' | 'DEAD' | undefined;
  event?: string | undefined;
  limit?: number;
  cursor?: string | undefined;
}

export async function listDeliveries(query: ListDeliveriesQuery): Promise<{
  items: WebhookDeliveryLean[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const filter: Record<string, unknown> = {};
  if (query.productId) filter.productId = query.productId;
  if (query.status) filter.status = query.status;
  if (query.event) filter.event = query.event;
  if (query.cursor) filter._id = { $lt: query.cursor };
  const items = await WebhookDelivery.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean<WebhookDeliveryLean[]>();
  const hasMore = items.length > limit;
  const trimmed = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? trimmed[trimmed.length - 1]!._id : null;
  return { items: trimmed, nextCursor };
}

export async function findById(id: string): Promise<WebhookDeliveryLean | null> {
  return WebhookDelivery.findById(id).lean<WebhookDeliveryLean | null>();
}

/** Reset a PENDING/FAILED/DEAD row to be picked up immediately. */
export async function resetForRetry(id: string, now: Date): Promise<WebhookDeliveryLean | null> {
  return WebhookDelivery.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        status: 'PENDING',
        nextRetryAt: now,
        lockedUntil: null,
      },
    },
    { new: true },
  ).lean<WebhookDeliveryLean | null>();
}
