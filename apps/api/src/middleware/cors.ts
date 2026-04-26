/**
 * Per-product CORS middleware.
 *
 * Behavior:
 *   - Browsers attach `Origin` header on cross-origin requests.
 *   - We resolve the product from `X-Product-Slug` (or look up by API key further
 *     down the chain). If the request carries no product context, we fall back
 *     to the `globalAllowOrigins` list (used by health checks, hosted auth
 *     /authorize, etc.).
 *   - If the origin is allowed, echo it back with `Access-Control-Allow-Origin`
 *     and `Vary: Origin`. Otherwise, omit ACAO (the browser blocks the request)
 *     and on preflight reject with 403 + `CORS_ORIGIN_NOT_ALLOWED`.
 *
 * NEVER use `*` for a credentialed API. Origins are always echoed exactly.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError, ErrorCode } from '../lib/errors.js';

export interface ProductCorsContext {
  productId: string;
  allowedOrigins: readonly string[];
}

export interface CorsOptions {
  /** Origins allowed for product-less endpoints (health, hosted auth, admin web). */
  globalAllowOrigins: readonly string[];
  /**
   * Resolve the per-product allow-list by inspecting the request.
   * Returns `null` when no product context is found — caller falls back to global.
   */
  resolveProduct?: (req: Request) => Promise<ProductCorsContext | null> | ProductCorsContext | null;
  /** Methods to allow on preflight responses. */
  allowedMethods?: readonly string[];
  /** Headers to allow on preflight responses. */
  allowedHeaders?: readonly string[];
  /** `Access-Control-Allow-Credentials` value. Defaults to `true`. */
  credentials?: boolean;
  /** Preflight cache duration in seconds. Defaults to 600 (10 min). */
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const DEFAULT_HEADERS = [
  'authorization',
  'content-type',
  'x-api-key',
  'x-api-secret',
  'x-product-slug',
  'x-correlation-id',
  'x-request-id',
  'idempotency-key',
] as const;

function originMatches(origin: string, allowed: readonly string[]): boolean {
  // Direct match (case-insensitive on host part); we keep it strict here — wildcards
  // handled explicitly with leading '*.' (e.g. '*.example.com').
  for (const candidate of allowed) {
    if (candidate === origin) return true;
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1); // ".example.com"
      try {
        const u = new URL(origin);
        if (u.hostname.endsWith(suffix.slice(1)) || u.host.endsWith(suffix)) return true;
      } catch {
        /* ignore — invalid origin URL */
      }
    }
  }
  return false;
}

export function corsMiddleware(options: CorsOptions): RequestHandler {
  const {
    globalAllowOrigins,
    resolveProduct,
    allowedMethods = DEFAULT_METHODS,
    allowedHeaders = DEFAULT_HEADERS,
    credentials = true,
    maxAge = 600,
  } = options;

  return async function corsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
    const origin = req.get('origin');

    // Same-origin / non-browser request: nothing to do.
    if (!origin) {
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
      return;
    }

    let allowed: readonly string[] = globalAllowOrigins;
    try {
      const productCtx = resolveProduct ? await resolveProduct(req) : null;
      if (productCtx && productCtx.allowedOrigins.length > 0) {
        allowed = productCtx.allowedOrigins;
      }
    } catch (err) {
      next(err);
      return;
    }

    const ok = originMatches(origin, allowed);

    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      if (!ok) {
        next(new AppError(ErrorCode.CORS_ORIGIN_NOT_ALLOWED, `Origin not allowed: ${origin}`));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      res.setHeader('Access-Control-Max-Age', String(maxAge));
      res.sendStatus(204);
      return;
    }

    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    next();
  };
}
