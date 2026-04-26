/**
 * Distributed token-bucket rate limiter backed by Redis.
 *
 * - Uses `rate-limiter-flexible`'s `RateLimiterRedis` when a Redis client is
 *   provided, falling back to in-memory when not (tests).
 * - Two-dimensional limiter: keyBy(req) returns a stable string (IP or
 *   user/api-key id). Distinct buckets per route family by passing a `keyPrefix`.
 * - On block: throws AppError(RATE_LIMIT_EXCEEDED). Sets standard headers:
 *     - RateLimit-Limit
 *     - RateLimit-Remaining
 *     - RateLimit-Reset (seconds)
 *     - Retry-After (seconds, on 429)
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  type RateLimiterAbstract,
  type RateLimiterRes,
} from 'rate-limiter-flexible';
import type { Redis } from 'ioredis';
import { AppError, ErrorCode } from '../lib/errors.js';

export interface RateLimitOptions {
  keyPrefix: string;
  /** Number of points (requests) per duration window. */
  points: number;
  /** Window length in seconds. */
  duration: number;
  /** How to derive the bucket key. Default: client IP. */
  keyBy?: (req: Request) => string;
  /** Redis client. If omitted, uses an in-process memory limiter (tests/dev only). */
  redis?: Redis;
  /** Block duration in seconds after exhaustion. Defaults to `duration`. */
  blockDuration?: number;
}

function defaultKeyBy(req: Request): string {
  const fwd = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return fwd;
}

function buildLimiter(opts: RateLimitOptions): RateLimiterAbstract {
  const common = {
    keyPrefix: opts.keyPrefix,
    points: opts.points,
    duration: opts.duration,
    blockDuration: opts.blockDuration ?? opts.duration,
  };
  if (opts.redis) {
    return new RateLimiterRedis({
      ...common,
      storeClient: opts.redis,
      // Atomic Lua script — fail-open is unsafe in prod, callers can change later.
      inMemoryBlockOnConsumed: opts.points,
    });
  }
  return new RateLimiterMemory(common);
}

export function rateLimitMiddleware(opts: RateLimitOptions): RequestHandler {
  const limiter = buildLimiter(opts);
  const keyBy = opts.keyBy ?? defaultKeyBy;

  return async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = keyBy(req);
    try {
      const result = await limiter.consume(key, 1);
      setHeaders(res, opts.points, result);
      next();
    } catch (rejection) {
      if (rejection instanceof Error) {
        // Redis connectivity error or similar — fail-closed with 503.
        next(new AppError(ErrorCode.SERVICE_UNAVAILABLE, 'Rate limiter unavailable'));
        return;
      }
      const result = rejection as RateLimiterRes;
      setHeaders(res, opts.points, result);
      const retryAfter = Math.ceil(result.msBeforeNext / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      next(
        new AppError(ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many requests', {
          retryAfterSeconds: retryAfter,
        }),
      );
    }
  };
}

function setHeaders(res: Response, limit: number, r: RateLimiterRes): void {
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, r.remainingPoints)));
  res.setHeader('RateLimit-Reset', String(Math.ceil(r.msBeforeNext / 1000)));
}
