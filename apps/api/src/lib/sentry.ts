/**
 * Sentry initialisation — V1.1-F.
 *
 * Off when `SENTRY_DSN` is not configured (default in dev/test). When set, we
 * forward unhandled errors and HTTP 5xx responses with the request's
 * correlation id attached.
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

let started = false;

/** Idempotent — safe to call from `bootstrap()`. */
export async function initSentry(): Promise<void> {
  if (started) return;
  started = true;

  if (!env.SENTRY_DSN) {
    logger.info({ event: 'sentry.disabled' }, 'Sentry disabled (no SENTRY_DSN)');
    return;
  }

  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.NODE_ENV === 'production' ? 0.05 : 0,
      sendDefaultPii: false,
    });
    logger.info({ event: 'sentry.started' }, 'Sentry initialised');
  } catch (err) {
    logger.error({ event: 'sentry.start.failed', err }, 'Sentry init failed');
  }
}

/** Capture an exception (no-op if Sentry not initialised). */
export async function captureException(err: unknown, context?: Record<string, unknown>): Promise<void> {
  if (!started || !env.SENTRY_DSN) return;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    // never let observability take down the request
  }
}
