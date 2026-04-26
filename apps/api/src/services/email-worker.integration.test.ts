/**
 * Email worker — processBatch (integration).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestContext, resetDatabase } from '../../test/integration-setup.js';
import { EmailQueue } from '../db/models/EmailQueue.js';
import { processBatch, type EmailDriver } from '../services/email-worker.service.js';

async function enqueue(): Promise<string> {
  await getTestContext();
  const doc = await EmailQueue.create({
    productId: null,
    toAddress: 'to@example.com',
    fromAddress: 'from@example.com',
    fromName: 'YoCore',
    subject: 'Test',
    templateId: 'auth.test',
    templateData: { hello: 'world' },
    category: 'security',
    priority: 'critical',
    status: 'PENDING',
    nextAttemptAt: new Date(0),
    attemptCount: 0,
  });
  return doc._id;
}

const okDriver: EmailDriver = {
  name: 'console',
  async send() {
    return { providerMessageId: 'msg_test_123' };
  },
};

const failDriver: EmailDriver = {
  name: 'console',
  async send() {
    throw new Error('upstream 500');
  },
};

describe('email worker — processBatch', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('marks a row SENT on driver success', async () => {
    const id = await enqueue();
    const out = await processBatch({ driver: okDriver });
    expect(out).toMatchObject({ attempted: 1, sent: 1, failed: 0, dead: 0 });
    const row = await EmailQueue.findById(id).lean();
    expect(row!.status).toBe('SENT');
    expect(row!.providerMessageId).toBe('msg_test_123');
    expect(row!.sentAt).toBeInstanceOf(Date);
  });

  it('reschedules with backoff when the driver throws', async () => {
    const id = await enqueue();
    const now = new Date('2025-01-01T12:00:00Z');
    const out = await processBatch({ driver: failDriver, now });
    expect(out).toMatchObject({ attempted: 1, sent: 0, failed: 1, dead: 0 });
    const row = await EmailQueue.findById(id).lean();
    expect(row!.status).toBe('PENDING');
    expect(row!.attemptCount).toBe(1);
    // First retry is +30s.
    expect(row!.nextAttemptAt!.getTime() - now.getTime()).toBe(30_000);
    expect(row!.attempts).toHaveLength(1);
  });

  it('marks DEAD after MAX_ATTEMPTS (6) failures', async () => {
    const id = await enqueue();
    for (let i = 0; i < 6; i++) {
      // Bump nextAttemptAt back to "now" between passes so it's always claimable.
      await EmailQueue.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(0) } });
      await processBatch({ driver: failDriver, now: new Date() });
    }
    const row = await EmailQueue.findById(id).lean();
    expect(row!.status).toBe('DEAD');
    expect(row!.attemptCount).toBe(6);
  });

  it('returns 0/0/0/0 when there is nothing to claim', async () => {
    const out = await processBatch({ driver: okDriver });
    expect(out).toEqual({ attempted: 0, sent: 0, failed: 0, dead: 0 });
  });

  it('respects priority ordering (critical before normal)', async () => {
    await getTestContext();
    const lowId = (
      await EmailQueue.create({
        productId: null,
        toAddress: 'low@example.com',
        fromAddress: 'f@example.com',
        fromName: null,
        subject: 'L',
        templateId: 't',
        templateData: {},
        category: 'marketing',
        priority: 'normal',
        status: 'PENDING',
        nextAttemptAt: new Date(0),
        attemptCount: 0,
      })
    )._id;
    const highId = (
      await EmailQueue.create({
        productId: null,
        toAddress: 'hi@example.com',
        fromAddress: 'f@example.com',
        fromName: null,
        subject: 'H',
        templateId: 't',
        templateData: {},
        category: 'security',
        priority: 'critical',
        status: 'PENDING',
        nextAttemptAt: new Date(0),
        attemptCount: 0,
      })
    )._id;

    await processBatch({ driver: okDriver, batchSize: 1 });
    const high = await EmailQueue.findById(highId).lean();
    const low = await EmailQueue.findById(lowId).lean();
    expect(high!.status).toBe('SENT');
    expect(low!.status).toBe('PENDING');
  });
});
