/**
 * Data export service — Flow W (V1.1-A).
 *
 * GDPR Article 15 / 20 — "right of access" / "right to data portability".
 *
 *   POST /v1/users/me/data-export   → create a job (24h cooldown)
 *   GET  /v1/users/me/data-exports  → list past + current jobs
 *   GET  /v1/users/me/data-exports/:id/download?token=...
 *                                   → streams the JSON archive (HMAC-signed)
 *
 * Worker (`gdpr.dataExport.tick`, every 5 min) drains PENDING jobs:
 *   1. Collect user PII across users, productUsers, sessions metadata,
 *      subscriptions, audit logs, email events.
 *   2. Serialize to JSON, upload to S3 under `${userId}/${jobId}.json`.
 *   3. Generate a 24h signed download token (`HMAC(jobId,userId,exp)`).
 *   4. Mark COMPLETE + email the user with the download URL.
 *
 * S3 is the source of truth — the API never re-derives the export. The
 * 24h TTL is enforced both via the signed token's `exp` and the
 * `dataExportJobs` document's `s3SignedUrlExpiresAt` field.
 */
import crypto from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { DataExportJob, type DataExportJobDoc } from '../db/models/DataExportJob.js';
import { User } from '../db/models/User.js';
import { ProductUser } from '../db/models/ProductUser.js';
import { Session } from '../db/models/Session.js';
import { Subscription } from '../db/models/Subscription.js';
import { AuditLog } from '../db/models/AuditLog.js';
import { EmailEvent } from '../db/models/EmailEvent.js';
import { WorkspaceMember } from '../db/models/WorkspaceMember.js';
import * as productRepo from '../repos/product.repo.js';
import * as emailQueueRepo from '../repos/email-queue.repo.js';
import { getS3 } from '../config/aws.js';
import { env } from '../config/env.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** Cooldown between successive export requests (per scope). */
export const DATA_EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Signed-URL TTL — also enforced in the HMAC token. */
export const DATA_EXPORT_URL_TTL_SECONDS = 24 * 60 * 60;

export interface DataExportS3 {
  put(key: string, body: Buffer | Uint8Array | string): Promise<void>;
  get(key: string): Promise<Readable>;
}

export interface DataExportService {
  requestExport(input: {
    userId: string;
    scope: 'all' | string[];
    requestedFromIp?: string | null;
    now?: Date;
  }): Promise<{ jobId: string; status: string; createdAt: Date }>;
  listForUser(userId: string): Promise<
    Array<{
      id: string;
      status: string;
      scope: 'all' | string[];
      createdAt: Date;
      completedAt: Date | null;
      expiresAt: Date | null;
      downloadUrl: string | null;
      errorMessage: string | null;
    }>
  >;
  runExportTick(now?: Date): Promise<{ processed: number; failed: number }>;
  /**
   * Stream a completed export's JSON archive to the caller after verifying
   * the HMAC token. Throws AppError on any verification failure.
   */
  streamDownload(args: {
    jobId: string;
    userId: string;
    token: string;
    now?: Date;
  }): Promise<{ stream: Readable; contentType: string; filename: string }>;
}

export interface CreateDataExportServiceOptions {
  s3?: DataExportS3;
  bucket?: string;
  signingSecret: string;
  defaultFromAddress: string;
  publicBaseUrl: string;
}

export function createDataExportService(opts: CreateDataExportServiceOptions): DataExportService {
  const bucket = opts.bucket ?? env.S3_BUCKET_EXPORTS;
  const s3 = opts.s3 ?? defaultS3Adapter(getS3, bucket);

  return {
    async requestExport({ userId, scope, requestedFromIp, now }) {
      const t = now ?? new Date();
      // 24h cooldown — most recent successful export.
      const recent = await DataExportJob.findOne({
        userId,
        status: { $in: ['PENDING', 'RUNNING', 'COMPLETE'] },
        createdAt: { $gte: new Date(t.getTime() - DATA_EXPORT_COOLDOWN_MS) },
      })
        .sort({ createdAt: -1 })
        .lean<DataExportJobDoc | null>();
      if (recent) {
        throw new AppError(
          ErrorCode.RATE_LIMIT_EXCEEDED,
          'A data export was requested in the last 24 hours; please wait',
          {
            details: { previousJobId: recent._id, previousStatus: recent.status },
          },
        );
      }
      const created = await DataExportJob.create({
        userId,
        scope,
        status: 'PENDING',
        requestedFromIp: requestedFromIp ?? null,
      });
      return {
        jobId: created._id,
        status: created.status,
        createdAt: created.createdAt instanceof Date ? created.createdAt : t,
      };
    },

    async listForUser(userId) {
      const rows = await DataExportJob.find({ userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean<DataExportJobDoc[]>();
      return rows.map((r) => ({
        id: r._id,
        status: r.status,
        scope: r.scope as 'all' | string[],
        createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(),
        completedAt: r.completedAt ?? null,
        expiresAt: r.s3SignedUrlExpiresAt ?? null,
        downloadUrl:
          r.status === 'COMPLETE' &&
          r.s3SignedUrlExpiresAt &&
          r.s3SignedUrlExpiresAt.getTime() > Date.now()
            ? buildDownloadUrl({
                publicBaseUrl: opts.publicBaseUrl,
                jobId: r._id,
                userId,
                expiresAtSec: Math.floor(r.s3SignedUrlExpiresAt.getTime() / 1000),
                signingSecret: opts.signingSecret,
              })
            : null,
        errorMessage: r.errorMessage ?? null,
      }));
    },

    async runExportTick(now) {
      const t = now ?? new Date();
      const due = await DataExportJob.find({ status: 'PENDING' })
        .sort({ createdAt: 1 })
        .limit(10)
        .lean<DataExportJobDoc[]>();
      let processed = 0;
      let failed = 0;
      for (const job of due) {
        const claimed = await DataExportJob.updateOne(
          { _id: job._id, status: 'PENDING' },
          { $set: { status: 'RUNNING', startedAt: t } },
        );
        if (claimed.modifiedCount === 0) continue; // peer pod claimed
        try {
          const archive = await collectUserData(job.userId, job.scope as 'all' | string[]);
          const key = `${job.userId}/${job._id}.json`;
          const body = Buffer.from(JSON.stringify(archive, null, 2), 'utf8');
          await s3.put(key, body);
          const expiresAt = new Date(t.getTime() + DATA_EXPORT_URL_TTL_SECONDS * 1000);
          await DataExportJob.updateOne(
            { _id: job._id },
            {
              $set: {
                status: 'COMPLETE',
                completedAt: new Date(),
                s3Key: key,
                s3SignedUrlExpiresAt: expiresAt,
                errorMessage: null,
              },
            },
          );
          // Notify user.
          const user = await User.findById(job.userId).lean<{ _id: string; email: string } | null>();
          if (user) {
            const downloadUrl = buildDownloadUrl({
              publicBaseUrl: opts.publicBaseUrl,
              jobId: job._id,
              userId: job.userId,
              expiresAtSec: Math.floor(expiresAt.getTime() / 1000),
              signingSecret: opts.signingSecret,
            });
            await emailQueueRepo.enqueueEmail({
              productId: null,
              userId: job.userId,
              toAddress: user.email,
              fromAddress: opts.defaultFromAddress,
              subject: 'Your YoCore data export is ready',
              templateId: 'gdpr.data_export_ready',
              category: 'security',
              priority: 'normal',
              templateData: {
                downloadUrl,
                expiresAt: expiresAt.toISOString(),
                sizeBytes: body.byteLength,
              },
            });
            await DataExportJob.updateOne({ _id: job._id }, { $set: { emailSentAt: new Date() } });
          }
          processed++;
        } catch (err) {
          await DataExportJob.updateOne(
            { _id: job._id },
            {
              $set: {
                status: 'FAILED',
                errorMessage: err instanceof Error ? err.message : String(err),
              },
            },
          );
          logger.error({ event: 'gdpr.dataExport.failed', jobId: job._id, err }, 'data export failed');
          failed++;
        }
      }
      return { processed, failed };
    },

    async streamDownload({ jobId, userId, token, now }) {
      const t = now ?? new Date();
      const row = await DataExportJob.findOne({ _id: jobId, userId }).lean<DataExportJobDoc | null>();
      if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Export not found');
      if (row.status !== 'COMPLETE' || !row.s3Key || !row.s3SignedUrlExpiresAt) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Export not ready');
      }
      const expSec = Math.floor(row.s3SignedUrlExpiresAt.getTime() / 1000);
      const expected = signDownload({
        jobId,
        userId,
        expiresAtSec: expSec,
        signingSecret: opts.signingSecret,
      });
      const provided = Buffer.from(token, 'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      if (
        provided.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(provided, expectedBuf)
      ) {
        throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Invalid download token');
      }
      if (row.s3SignedUrlExpiresAt.getTime() < t.getTime()) {
        throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Download token expired');
      }
      const stream = await s3.get(row.s3Key);
      return {
        stream,
        contentType: 'application/json',
        filename: `yocore-export-${jobId}.json`,
      };
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function defaultS3Adapter(getClient: () => S3Client, bucket: string): DataExportS3 {
  return {
    async put(key, body) {
      await getClient().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
        }),
      );
    },
    async get(key) {
      const out = await getClient().send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const body = out.Body;
      if (!body || typeof (body as Readable).pipe !== 'function') {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'S3 object stream missing');
      }
      return body as Readable;
    },
  };
}

function signDownload(args: {
  jobId: string;
  userId: string;
  expiresAtSec: number;
  signingSecret: string;
}): string {
  return crypto
    .createHmac('sha256', args.signingSecret)
    .update(`${args.jobId}|${args.userId}|${args.expiresAtSec}`)
    .digest('hex');
}

function buildDownloadUrl(args: {
  publicBaseUrl: string;
  jobId: string;
  userId: string;
  expiresAtSec: number;
  signingSecret: string;
}): string {
  const token = signDownload(args);
  const base = args.publicBaseUrl.replace(/\/$/, '');
  return `${base}/v1/users/me/data-exports/${args.jobId}/download?token=${token}`;
}

async function collectUserData(
  userId: string,
  scope: 'all' | string[],
): Promise<Record<string, unknown>> {
  const productFilter =
    scope === 'all' ? {} : { productId: { $in: scope as string[] } };
  const [user, productUsers, sessions, subscriptions, audits, emailEvents, memberships, products] =
    await Promise.all([
      User.findById(userId).lean(),
      ProductUser.find({ userId, ...productFilter }).lean(),
      Session.find({ userId, ...productFilter }).select('-_v').lean(),
      Subscription.find({ subjectUserId: userId, ...productFilter }).lean(),
      AuditLog.find({ 'actor.id': userId, ...productFilter }).limit(5_000).lean(),
      EmailEvent.find({ userId, ...productFilter }).limit(5_000).lean(),
      WorkspaceMember.find({ userId, ...productFilter }).lean(),
      productRepo.listProducts(),
    ]);
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    scope,
    user,
    productUsers,
    sessions: sessions.map((s) => ({ ...s, refreshTokenHash: undefined })),
    subscriptions,
    auditLogs: audits,
    emailEvents,
    workspaceMemberships: memberships,
    products: products.map((p) => ({ id: p._id, slug: p.slug, name: p.name })),
  };
}
