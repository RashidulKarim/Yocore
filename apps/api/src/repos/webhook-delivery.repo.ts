/**
 * Outbound webhook delivery repository — `webhookDeliveries` collection.
 *
 * The actual HTTP delivery worker lives in Phase 3.8. Here we only enqueue
 * PENDING records that the worker will pick up. Multi-tenant by `productId`.
 */
import { WebhookDelivery, type WebhookDeliveryDoc } from '../db/models/WebhookDelivery.js';

export type WebhookDeliveryLean = WebhookDeliveryDoc;

export interface EnqueueDeliveryInput {
  productId: string;
  event: string;
  eventId: string;
  url: string;
  payloadRef: string;
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
