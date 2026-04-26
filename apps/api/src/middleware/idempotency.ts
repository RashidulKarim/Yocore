/**
 * Idempotency middleware (FIX-IDEMP / YC-004).
 *
 * Required on all mutating billing endpoints (POST/PUT/PATCH/DELETE under /v1/billing,
 * /v1/checkout, /v1/subscriptions). Wired per-route — NOT a global default — so we
 * don't accidentally cache safe reads.
 *
 * Algorithm:
 *   1. Read `Idempotency-Key` header. If missing → 400 IDEMPOTENCY_KEY_MISSING.
 *   2. Compute requestBodyHash = sha256(method + path + body).
 *   3. Look up `(productId|null, scope, key)` in the store:
 *        - HIT and same hash → replay cached response (status + body).
 *        - HIT and different hash → IDEMPOTENCY_KEY_CONFLICT (422).
 *        - INPROGRESS lock → IDEMPOTENCY_KEY_IN_PROGRESS (409).
 *        - MISS → acquire lock, run handler, persist response, release lock.
 *   4. The store implementation lives outside this file (Phase 3 wires Redis +
 *      `IdempotencyKey` Mongo collection).
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from '../lib/errors.js';

export interface IdempotencyRecord {
  responseStatus: number;
  responseBody: unknown;
  requestBodyHash: string;
}

export interface IdempotencyStore {
  /** Try to claim the key. Returns:
   *   - 'acquired' if the lock was taken (caller proceeds)
   *   - { state: 'replay', record } if a completed response is cached
   *   - { state: 'conflict' } if a record exists with a different bodyHash
   *   - { state: 'in_progress' } if another request is already processing
   */
  acquire: (
    args: {
      productId: string | null;
      scope: string;
      key: string;
      requestBodyHash: string;
      ttlSeconds: number;
    },
  ) => Promise<
    | { state: 'acquired' }
    | { state: 'replay'; record: IdempotencyRecord }
    | { state: 'conflict' }
    | { state: 'in_progress' }
  >;
  /** Persist a completed response and release any in-progress lock. */
  complete: (args: {
    productId: string | null;
    scope: string;
    key: string;
    requestBodyHash: string;
    responseStatus: number;
    responseBody: unknown;
    ttlSeconds: number;
  }) => Promise<void>;
  /** Release the in-progress lock when the handler errors before completion. */
  release: (args: { productId: string | null; scope: string; key: string }) => Promise<void>;
}

export interface IdempotencyOptions {
  store: IdempotencyStore;
  /** Logical scope used in the storage key, e.g. 'checkout', 'subscription:cancel'. */
  scope: string;
  /** Cache duration in seconds. Default 24h. */
  ttlSeconds?: number;
}

const HEADER = 'idempotency-key';
const KEY_RE = /^[A-Za-z0-9._\-:]{8,128}$/;

function hashRequest(req: Request): string {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  return createHash('sha256')
    .update(req.method)
    .update('\n')
    .update(req.originalUrl || req.url)
    .update('\n')
    .update(body)
    .digest('hex');
}

export function idempotencyMiddleware(opts: IdempotencyOptions): RequestHandler {
  const ttlSeconds = opts.ttlSeconds ?? 86_400;

  return async function idempotency(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = req.get(HEADER);
    if (!key) {
      next(new AppError(ErrorCode.IDEMPOTENCY_KEY_MISSING, 'Idempotency-Key header required'));
      return;
    }
    if (!KEY_RE.test(key)) {
      next(
        new AppError(ErrorCode.VALIDATION_FAILED, 'Idempotency-Key format invalid', {
          header: HEADER,
        }),
      );
      return;
    }

    const productId = req.product?.productId ?? null;
    const requestBodyHash = hashRequest(req);

    let outcome: Awaited<ReturnType<IdempotencyStore['acquire']>>;
    try {
      outcome = await opts.store.acquire({
        productId,
        scope: opts.scope,
        key,
        requestBodyHash,
        ttlSeconds,
      });
    } catch (err) {
      next(err);
      return;
    }

    if (outcome.state === 'replay') {
      res.status(outcome.record.responseStatus).json(outcome.record.responseBody);
      return;
    }
    if (outcome.state === 'conflict') {
      next(
        new AppError(
          ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
          'Idempotency-Key reused with a different request body',
        ),
      );
      return;
    }
    if (outcome.state === 'in_progress') {
      next(
        new AppError(
          ErrorCode.IDEMPOTENCY_KEY_IN_PROGRESS,
          'A previous request with this Idempotency-Key is still being processed',
        ),
      );
      return;
    }

    // Acquired — wrap res.json so we capture the response.
    let captured = false;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (!captured) {
        captured = true;
        // Persist asynchronously; surface failures to logs only.
        const status = res.statusCode;
        void opts.store
          .complete({ productId, scope: opts.scope, key, requestBodyHash, responseStatus: status, responseBody: body, ttlSeconds })
          .catch(() => {
            /* logged inside store */
          });
      }
      return originalJson(body);
    }) as Response['json'];

    res.on('close', () => {
      if (!captured) {
        // Aborted before response — release the in-progress lock so retries can proceed.
        void opts.store.release({ productId, scope: opts.scope, key }).catch(() => undefined);
      }
    });

    next();
  };
}
