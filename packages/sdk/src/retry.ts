/**
 * Rate-limit-aware exponential-backoff retry helper for SDK consumers.
 *
 * Honors:
 *   - 429 Too Many Requests with `Retry-After` header (seconds OR HTTP-date).
 *   - 5xx transient failures with capped jitter.
 *   - User-supplied `shouldRetry(err)` predicate.
 *
 * Does NOT retry 4xx errors other than 429 by default.
 */
import { YoCoreApiError } from './errors.js';

export interface RetryOptions {
  /** Max attempts INCLUDING the first. Default 5. */
  maxAttempts?: number;
  /** Base backoff in ms. Default 250. */
  baseMs?: number;
  /** Max backoff cap. Default 30s. */
  maxMs?: number;
  /** Custom predicate. Default = retry on 429 + 5xx. */
  shouldRetry?: (err: unknown) => boolean;
  /** Sleep impl (override for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter. */
  rng?: () => number;
}

const defaultShouldRetry = (err: unknown): boolean => {
  if (err instanceof YoCoreApiError) {
    return err.status === 429 || (err.status >= 500 && err.status <= 599);
  }
  return false;
};

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = opts.maxAttempts ?? 5;
  const base = opts.baseMs ?? 250;
  const cap = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !shouldRetry(err)) throw err;

      let waitMs = jitterBackoff(attempt, base, cap, rng);
      const retryAfter = readRetryAfter(err);
      if (retryAfter !== undefined) waitMs = Math.min(retryAfter, cap);

      await sleep(waitMs);
    }
  }
  throw lastErr;
}

function jitterBackoff(attempt: number, base: number, cap: number, rng: () => number): number {
  // Full-jitter: rand(0, min(cap, base*2^(attempt-1)))
  const exp = Math.min(cap, base * Math.pow(2, attempt - 1));
  return Math.floor(rng() * exp);
}

function readRetryAfter(err: unknown): number | undefined {
  if (!(err instanceof YoCoreApiError)) return undefined;
  const details = err.details as { retryAfter?: number | string } | undefined;
  if (typeof details?.retryAfter === 'number' && details.retryAfter > 0) {
    return details.retryAfter * 1000;
  }
  if (typeof details?.retryAfter === 'string') {
    const n = Number(details.retryAfter);
    if (Number.isFinite(n) && n > 0) return n * 1000;
    const t = Date.parse(details.retryAfter);
    if (!Number.isNaN(t)) {
      const diff = t - Date.now();
      if (diff > 0) return diff;
    }
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
