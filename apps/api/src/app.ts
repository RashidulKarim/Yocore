/**
 * Express app factory. Composes the middleware chain in canonical order:
 *
 *   1. correlation-id    — every log line gets the same id as the response
 *   2. security headers  — helmet (HSTS, frameguard, noSniff, referrer-policy)
 *   3. CORS              — per-product allow-list (global fallback at app level)
 *   4. body parsers      — JSON + urlencoded (1mb limit)
 *   5. routes            — per-route middlewares (rate-limit / api-key / jwt-auth
 *                         / idempotency / audit-log) live inside the router
 *   6. 404               — fallthrough for unmatched paths
 *   7. error handler     — final mapper to AppError JSON shape
 *
 * Phase 3 wires the per-route middleware factories to real handlers.
 */
import express, { type Express } from 'express';
import { correlationIdMiddleware } from './middleware/correlation-id.js';
import { securityHeadersMiddleware } from './middleware/security-headers.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { buildRouter } from './router.js';
import type { AppContext } from './context.js';

export interface CreateAppOptions {
  ctx: AppContext;
  trustProxy?: boolean | number | string;
  /** Global CORS allow-list (used by product-less endpoints: health, hosted auth). */
  globalAllowOrigins?: readonly string[];
}

export function createApp(opts: CreateAppOptions): Express {
  const app = express();

  if (opts.trustProxy !== undefined) app.set('trust proxy', opts.trustProxy);
  app.disable('x-powered-by');

  app.use(correlationIdMiddleware);
  app.use(securityHeadersMiddleware());
  app.use(
    corsMiddleware({
      globalAllowOrigins: opts.globalAllowOrigins ?? [],
    }),
  );

  // Capture raw body for webhook signature verification (Stripe etc.).
  // We attach it via the JSON parser's `verify` callback so a single body
  // pass works for both JSON-typed routes and raw-bytes-needing webhooks.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use(buildRouter({ ctx: opts.ctx }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
