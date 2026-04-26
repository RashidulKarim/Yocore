/**
 * API key + secret authentication middleware (Flow E).
 *
 * Accepts either:
 *   - `X-Api-Key` + `X-Api-Secret` headers, OR
 *   - `Authorization: ApiKey <key>:<secret>`
 *
 * Lookups go through a `ProductLookup` interface (Phase 3 wires this to the
 * `Product` repo + Redis cache). The middleware never touches Mongoose directly.
 *
 * Verification:
 *   - Looks up product by `apiKey`. Constant-time compares Argon2-verified
 *     secret. Rejects with `APIKEY_INVALID` on any mismatch (no enumeration).
 *   - Rejects with `APIKEY_PRODUCT_INACTIVE` if the product is not ACTIVE.
 *   - Attaches `req.product` so downstream middleware (cors, audit) can use it.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError, ErrorCode } from '../lib/errors.js';
import { verify as verifyArgon } from '../lib/password.js';

export interface ApiKeyProduct {
  productId: string;
  apiKey: string;
  apiSecretHash: string;
  status: 'INACTIVE' | 'ACTIVE' | 'MAINTENANCE' | 'ABANDONED';
  allowedOrigins: readonly string[];
  rateLimitPerMinute: number;
}

export interface ApiKeyContext {
  productId: string;
  apiKey: string;
  status: ApiKeyProduct['status'];
  allowedOrigins: readonly string[];
  rateLimitPerMinute: number;
}

declare module 'express' {
  interface Request {
    product?: ApiKeyContext;
  }
}

export interface ApiKeyOptions {
  lookupByKey: (apiKey: string) => Promise<ApiKeyProduct | null>;
  /**
   * Touch `apiKeyLastUsedAt` async (fire-and-forget). Implementation should
   * coalesce to ≤1 write per minute per product to avoid hot writes.
   */
  touchLastUsed?: (productId: string) => void;
}

const HEADER_KEY = 'x-api-key';
const HEADER_SECRET = 'x-api-secret';

function extractCredentials(req: Request): { key: string; secret: string } | null {
  const headerKey = req.get(HEADER_KEY);
  const headerSecret = req.get(HEADER_SECRET);
  if (headerKey && headerSecret) return { key: headerKey, secret: headerSecret };

  const auth = req.get('authorization');
  if (auth && auth.toLowerCase().startsWith('apikey ')) {
    const raw = auth.slice('apikey '.length).trim();
    const idx = raw.indexOf(':');
    if (idx > 0 && idx < raw.length - 1) {
      return { key: raw.slice(0, idx), secret: raw.slice(idx + 1) };
    }
  }
  return null;
}

export function apiKeyMiddleware(opts: ApiKeyOptions): RequestHandler {
  return async function apiKeyAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const creds = extractCredentials(req);
      if (!creds) {
        throw new AppError(ErrorCode.APIKEY_MISSING, 'Missing API key credentials');
      }

      const product = await opts.lookupByKey(creds.key);
      if (!product) {
        // Constant-ish-time: do a dummy verify to mask "not found" vs "wrong secret".
        // Hash format check via verify() returns false rather than throwing.
        await verifyArgon(
          '$argon2id$v=19$m=1024,t=2,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          creds.secret,
        ).catch(() => false);
        throw new AppError(ErrorCode.APIKEY_INVALID, 'Invalid API key or secret');
      }

      const ok = await verifyArgon(product.apiSecretHash, creds.secret);
      if (!ok) {
        throw new AppError(ErrorCode.APIKEY_INVALID, 'Invalid API key or secret');
      }

      if (product.status !== 'ACTIVE') {
        throw new AppError(
          ErrorCode.APIKEY_PRODUCT_INACTIVE,
          `Product is ${product.status.toLowerCase()}`,
        );
      }

      req.product = {
        productId: product.productId,
        apiKey: product.apiKey,
        status: product.status,
        allowedOrigins: product.allowedOrigins,
        rateLimitPerMinute: product.rateLimitPerMinute,
      };

      if (opts.touchLastUsed) opts.touchLastUsed(product.productId);
      next();
    } catch (err) {
      next(err);
    }
  };
}
