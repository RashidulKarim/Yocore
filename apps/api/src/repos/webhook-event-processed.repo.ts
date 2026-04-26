/**
 * Inbound webhook dedup repository — `webhookEventsProcessed` (FIX-G1, ADR-009).
 *
 * Strategy: every webhook handler inserts `{provider, eventId}` FIRST. If the
 * unique index (provider, eventId) raises E11000, the event was already
 * processed → handler returns 200 immediately (noop). This is belt + braces
 * with a Redis SET NX fast-path which lives in the service layer.
 */
import { WebhookEventProcessed } from '../db/models/WebhookEventProcessed.js';

export type WebhookProvider = 'stripe' | 'sslcommerz' | 'paypal' | 'paddle';

export interface RecordEventResult {
  /** True if this is the first time we've seen this event (proceed). */
  fresh: boolean;
}

/**
 * Atomically claim an inbound event. Returns `{fresh:true}` on first sight;
 * `{fresh:false}` if the event was already processed (caller should noop 200).
 */
export async function recordEvent(args: {
  provider: WebhookProvider;
  eventId: string;
  productId?: string | null;
  handlerAction?: string | null;
}): Promise<RecordEventResult> {
  try {
    await WebhookEventProcessed.create({
      provider: args.provider,
      eventId: args.eventId,
      productId: args.productId ?? null,
      handlerAction: args.handlerAction ?? null,
      processedAt: new Date(),
    });
    return { fresh: true };
  } catch (err) {
    // E11000 → already processed.
    const code = (err as { code?: number; codeName?: string }).code;
    if (code === 11000) return { fresh: false };
    throw err;
  }
}
