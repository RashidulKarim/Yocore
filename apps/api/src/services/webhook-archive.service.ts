/**
 * Webhook payload archival worker — V1.1-E.
 *
 * Cron `webhook.archive.tick` (daily, locked via `cronLocks`) scans
 * `webhookDeliveries` for rows that are in a terminal state (DELIVERED / DEAD),
 * older than `archiveAfterDays` (default 7), and still carry an inline
 * `payload`. For each, it gzips the JSON envelope, uploads to S3 under
 *   `${productId}/${YYYY-MM-DD}/${eventId}.json.gz`
 * (server-side AES256 encryption, content-encoding: gzip), then clears the
 * inline payload and stamps `payloadS3Key` / `payloadS3Bucket` /
 * `payloadArchivedAt`.
 *
 * The 90-day TTL index on `webhookDeliveries.createdAt` still removes the
 * envelope row eventually; S3 retention is governed by the bucket's lifecycle
 * policy (typically 365d, see infra docs).
 *
 * The worker is bounded — at most `batchSize` rows per tick — so a backlog
 * drains over multiple days rather than blocking startup.
 */
import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getS3 } from '../config/aws.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import * as deliveryRepo from '../repos/webhook-delivery.repo.js';

const gzip = promisify(gzipCb);

export interface WebhookArchiveS3 {
  put(args: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
    contentEncoding: string;
  }): Promise<void>;
}

export interface WebhookArchiveService {
  runArchiveTick(opts?: { now?: Date }): Promise<{
    scanned: number;
    archived: number;
    skipped: number;
    failed: number;
  }>;
}

export interface CreateWebhookArchiveServiceOptions {
  s3?: WebhookArchiveS3;
  bucket?: string;
  /** Rows must be at least this many days old (delivered/dead) to be archived. */
  archiveAfterDays?: number;
  /** Max rows per tick. */
  batchSize?: number;
  now?: () => Date;
}

export function createWebhookArchiveService(
  opts: CreateWebhookArchiveServiceOptions = {},
): WebhookArchiveService {
  const bucket = opts.bucket ?? env.S3_BUCKET_WEBHOOKS;
  const s3 = opts.s3 ?? defaultS3Adapter(getS3);
  const archiveAfterDays = opts.archiveAfterDays ?? 7;
  const batchSize = opts.batchSize ?? 200;
  const now = opts.now ?? (() => new Date());

  return {
    async runArchiveTick(o = {}) {
      const t = o.now ?? now();
      const cutoff = new Date(t.getTime() - archiveAfterDays * 24 * 60 * 60 * 1000);
      const rows = await deliveryRepo.findArchivable({ olderThan: cutoff, limit: batchSize });
      const out = { scanned: rows.length, archived: 0, skipped: 0, failed: 0 };

      for (const row of rows) {
        try {
          if (!row.payload) {
            out.skipped++;
            continue;
          }
          const day = (row.deliveredAt ?? t).toISOString().slice(0, 10);
          const key = `${row.productId}/${day}/${row.eventId}.json.gz`;
          const body = await gzip(
            Buffer.from(
              JSON.stringify({
                id: row.eventId,
                type: row.event,
                productId: row.productId,
                payloadVersion: row.payloadVersion ?? null,
                deliveredAt: row.deliveredAt,
                status: row.status,
                payload: row.payload,
              }),
              'utf8',
            ),
          );
          await s3.put({
            bucket,
            key,
            body,
            contentType: 'application/json',
            contentEncoding: 'gzip',
          });
          await deliveryRepo.markArchived({ id: row._id, bucket, key, at: t });
          out.archived++;
        } catch (err) {
          out.failed++;
          logger.error(
            { event: 'webhook.archive.error', id: row._id, err },
            'webhook archival failed',
          );
        }
      }

      logger.info({ event: 'webhook.archive.tick', ...out }, 'webhook.archive.tick complete');
      return out;
    },
  };
}

function defaultS3Adapter(getClient: () => S3Client): WebhookArchiveS3 {
  return {
    async put({ bucket, key, body, contentType, contentEncoding }) {
      await getClient().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentEncoding: contentEncoding,
          ServerSideEncryption: 'AES256',
        }),
      );
    },
  };
}
