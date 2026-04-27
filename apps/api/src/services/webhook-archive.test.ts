import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../repos/webhook-delivery.repo.js', () => ({
  findArchivable: vi.fn(),
  markArchived: vi.fn(),
}));
vi.mock('../config/aws.js', () => ({
  getS3: vi.fn(),
}));

import * as deliveryRepo from '../repos/webhook-delivery.repo.js';
import { createWebhookArchiveService } from './webhook-archive.service.js';

const findArchivableMock = vi.mocked(deliveryRepo.findArchivable);
const markArchivedMock = vi.mocked(deliveryRepo.markArchived);

describe('webhook-archive service', () => {
  beforeEach(() => {
    findArchivableMock.mockReset();
    markArchivedMock.mockReset();
  });

  it('archives candidate rows and marks them done', async () => {
    const now = new Date('2026-04-28T10:00:00.000Z');
    const delivered = new Date('2026-04-15T00:00:00.000Z');
    findArchivableMock.mockResolvedValueOnce([
      {
        _id: 'whd_1',
        productId: 'prod_a',
        eventId: 'evt_1',
        event: 'subscription.activated',
        status: 'DELIVERED',
        deliveredAt: delivered,
        payloadVersion: '2026-04-23',
        payload: { hello: 'world' },
        // unrelated fields:
        url: 'https://example.com/webhook',
        payloadRef: 'inline',
        signatureHeader: null,
        attempts: [],
        attemptCount: 1,
        nextRetryAt: null,
        lastError: null,
        lockedUntil: null,
        createdAt: delivered,
        updatedAt: delivered,
      } as unknown as Awaited<ReturnType<typeof deliveryRepo.findArchivable>>[number],
    ]);

    const puts: Array<{ bucket: string; key: string; size: number; ce: string }> = [];
    const svc = createWebhookArchiveService({
      bucket: 'test-bucket',
      now: () => now,
      s3: {
        async put({ bucket, key, body, contentEncoding }) {
          puts.push({ bucket, key, size: body.length, ce: contentEncoding });
        },
      },
    });

    const out = await svc.runArchiveTick();
    expect(out).toEqual({ scanned: 1, archived: 1, skipped: 0, failed: 0 });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.bucket).toBe('test-bucket');
    expect(puts[0]?.key).toBe('prod_a/2026-04-15/evt_1.json.gz');
    expect(puts[0]?.ce).toBe('gzip');
    expect(puts[0]?.size).toBeGreaterThan(0);
    expect(markArchivedMock).toHaveBeenCalledWith({
      id: 'whd_1',
      bucket: 'test-bucket',
      key: 'prod_a/2026-04-15/evt_1.json.gz',
      at: now,
    });
  });

  it('counts failures without throwing the batch', async () => {
    findArchivableMock.mockResolvedValueOnce([
      {
        _id: 'whd_2',
        productId: 'p',
        eventId: 'e',
        event: 'x',
        status: 'DELIVERED',
        deliveredAt: new Date(),
        payloadVersion: 'v1',
        payload: { a: 1 },
      } as unknown as Awaited<ReturnType<typeof deliveryRepo.findArchivable>>[number],
    ]);
    const svc = createWebhookArchiveService({
      now: () => new Date('2026-04-28T10:00:00.000Z'),
      s3: {
        async put() {
          throw new Error('s3 down');
        },
      },
    });
    const out = await svc.runArchiveTick();
    expect(out.failed).toBe(1);
    expect(out.archived).toBe(0);
    expect(markArchivedMock).not.toHaveBeenCalled();
  });

  it('skips rows missing payload', async () => {
    findArchivableMock.mockResolvedValueOnce([
      {
        _id: 'whd_3',
        productId: 'p',
        eventId: 'e',
        event: 'x',
        status: 'DELIVERED',
        deliveredAt: new Date(),
        payload: null,
      } as unknown as Awaited<ReturnType<typeof deliveryRepo.findArchivable>>[number],
    ]);
    const svc = createWebhookArchiveService({
      s3: { async put() {} },
    });
    const out = await svc.runArchiveTick();
    expect(out.skipped).toBe(1);
    expect(out.archived).toBe(0);
  });
});
