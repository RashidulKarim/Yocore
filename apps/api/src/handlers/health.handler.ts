import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { getRedis } from '../config/redis.js';
import { getS3 } from '../config/aws.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

type CheckStatus = 'ok' | 'down' | 'skipped';

/** Liveness — process is alive. No external dependency. */
export function livenessHandler(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
}

/** Readiness — Mongo + Redis are reachable (no S3 — that's deep). */
export async function readinessHandler(_req: Request, res: Response): Promise<void> {
  const checks: Record<string, CheckStatus> = { mongo: 'skipped', redis: 'skipped' };

  if (mongoose.connection.readyState === 1) checks.mongo = 'ok';
  else if (mongoose.connection.readyState !== 0) checks.mongo = 'down';

  try {
    const pong = await getRedis().ping();
    checks.redis = pong === 'PONG' ? 'ok' : 'down';
  } catch {
    checks.redis = 'down';
  }

  const ok = Object.values(checks).every((v) => v !== 'down');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks });
}

/**
 * Deep health — exercises every external dependency (Mongo ping, Redis ping,
 * S3 HeadBucket). Used by ops dashboards & runbooks; cheap enough to call
 * every minute, expensive enough to skip from app health checks.
 */
export async function deepHealthHandler(_req: Request, res: Response): Promise<void> {
  const checks: Record<string, CheckStatus> = {
    mongo: 'skipped',
    redis: 'skipped',
    s3: 'skipped',
  };

  try {
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      await mongoose.connection.db.admin().ping();
      checks.mongo = 'ok';
    } else {
      checks.mongo = 'down';
    }
  } catch (err) {
    logger.warn({ event: 'health.deep.mongo.failed', err }, 'mongo deep check failed');
    checks.mongo = 'down';
  }

  try {
    const pong = await getRedis().ping();
    checks.redis = pong === 'PONG' ? 'ok' : 'down';
  } catch (err) {
    logger.warn({ event: 'health.deep.redis.failed', err }, 'redis deep check failed');
    checks.redis = 'down';
  }

  try {
    await getS3().send(new HeadBucketCommand({ Bucket: env.S3_BUCKET_AUDITLOGS }));
    checks.s3 = 'ok';
  } catch (err) {
    logger.warn({ event: 'health.deep.s3.failed', err }, 's3 deep check failed');
    checks.s3 = 'down';
  }

  const ok = Object.values(checks).every((v) => v !== 'down');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks });
}
