import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getRedis } from '../config/redis.js';

export function livenessHandler(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
}

export async function readinessHandler(_req: Request, res: Response): Promise<void> {
  const checks: Record<string, 'ok' | 'down' | 'skipped'> = {
    mongo: 'skipped',
    redis: 'skipped',
  };

  if (mongoose.connection.readyState === 1) {
    checks.mongo = 'ok';
  } else if (mongoose.connection.readyState !== 0) {
    checks.mongo = 'down';
  }

  try {
    const pong = await getRedis().ping();
    checks.redis = pong === 'PONG' ? 'ok' : 'down';
  } catch {
    checks.redis = 'down';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok' || v === 'skipped');
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks });
}
