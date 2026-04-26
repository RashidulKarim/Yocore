/**
 * EmailQueue repository — `emailQueue` collection.
 *
 * Producers enqueue rows here; the email-worker (Phase 3.1 follow-up) consumes
 * them in priority order. Status starts as PENDING; the worker transitions to
 * SENT / FAILED / DEAD after retries.
 */
import { EmailQueue, type EmailQueueDoc } from '../db/models/EmailQueue.js';

export interface EnqueueEmailInput {
  productId: string | null;
  userId: string | null;
  toAddress: string;
  fromAddress: string;
  fromName?: string | null;
  subject: string;
  templateId: string;
  templateData?: Record<string, unknown>;
  priority?: 'critical' | 'normal' | 'bulk';
  category?: 'transactional' | 'billing' | 'marketing' | 'security';
  provider?: 'resend' | 'ses';
}

export async function enqueueEmail(input: EnqueueEmailInput): Promise<EmailQueueDoc> {
  const doc = await EmailQueue.create({
    productId: input.productId,
    userId: input.userId,
    toAddress: input.toAddress.trim().toLowerCase(),
    fromAddress: input.fromAddress,
    fromName: input.fromName ?? null,
    subject: input.subject,
    templateId: input.templateId,
    templateData: input.templateData ?? {},
    provider: input.provider ?? 'resend',
    priority: input.priority ?? 'normal',
    category: input.category ?? 'transactional',
    status: 'PENDING',
    nextAttemptAt: new Date(),
  });
  return doc.toObject() as EmailQueueDoc;
}
