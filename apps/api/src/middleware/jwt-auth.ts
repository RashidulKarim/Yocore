/**
 * JWT bearer auth middleware.
 *
 * Verifies `Authorization: Bearer <jwt>` against the keyring and (optionally)
 * cross-checks the session is not revoked using a `SessionStore` interface.
 *
 * Lookup strategy (Phase 3 implementation):
 *   1. Decode JWT, find `kid` in keyring, verify signature + exp + iss + aud.
 *   2. Read `jti` claim → `sessionStore.isActive(jti)` (Redis SET; Mongo fallback).
 *   3. If not active → AUTH_TOKEN_REVOKED.
 *
 * Sets `req.auth` for downstream handlers.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError, ErrorCode } from '../lib/errors.js';
import { verifyJwt, type JwtPurpose } from '../lib/jwt.js';
import type { JwtKeyring } from '../lib/jwt-keyring.js';

export interface AuthContext {
  userId: string;
  productId: string | null;
  workspaceId: string | null;
  sessionId: string;
  role: 'SUPER_ADMIN' | 'END_USER';
  scopes: readonly string[];
  /** JWT id claim — used for session/refresh lookup. */
  jti: string;
}

declare module 'express' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface SessionStore {
  /** Returns false if the session was logged-out / revoked. */
  isActive: (jti: string) => Promise<boolean>;
}

export interface JwtAuthOptions {
  keyring: JwtKeyring;
  sessionStore?: SessionStore;
  /** Defaults to 'access'. Use 'hosted-auth' for the /exchange endpoint. */
  purpose?: JwtPurpose;
  audience?: string | readonly string[];
  /** When true, missing/invalid token sets req.auth=undefined and continues. */
  optional?: boolean;
}

function extractBearer(req: Request): string | null {
  const auth = req.get('authorization');
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const t = auth.slice(7).trim();
  return t.length > 0 ? t : null;
}

export function jwtAuthMiddleware(opts: JwtAuthOptions): RequestHandler {
  const purpose = opts.purpose ?? 'access';

  return async function jwtAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const token = extractBearer(req);
      if (!token) {
        if (opts.optional) {
          next();
          return;
        }
        throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Missing bearer token');
      }

      const verified = await verifyJwt(opts.keyring, token, {
        purpose,
        ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
      });

      const payload = verified.payload as Record<string, unknown>;
      const jti = String(payload['jti'] ?? '');
      if (!jti) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Missing jti');

      if (opts.sessionStore) {
        const active = await opts.sessionStore.isActive(jti);
        if (!active) throw new AppError(ErrorCode.AUTH_TOKEN_REVOKED, 'Session revoked');
      }

      req.auth = {
        userId: String(payload['sub'] ?? ''),
        productId: (payload['pid'] as string | undefined) ?? null,
        workspaceId: (payload['wid'] as string | undefined) ?? null,
        sessionId: (payload['sid'] as string | undefined) ?? jti,
        role: (payload['role'] as 'SUPER_ADMIN' | 'END_USER' | undefined) ?? 'END_USER',
        scopes: Array.isArray(payload['scopes']) ? (payload['scopes'] as string[]) : [],
        jti,
      };

      next();
    } catch (err) {
      if (opts.optional && err instanceof AppError && err.code === ErrorCode.AUTH_INVALID_TOKEN) {
        next();
        return;
      }
      next(err);
    }
  };
}

/** Helper for handlers that require an authenticated request. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw new AppError(ErrorCode.AUTH_INVALID_TOKEN, 'Authentication required');
  return req.auth;
}

/** Helper that asserts SUPER_ADMIN role on top of authentication. */
export function requireSuperAdmin(req: Request): AuthContext {
  const auth = requireAuth(req);
  if (auth.role !== 'SUPER_ADMIN') {
    throw new AppError(ErrorCode.SUPER_ADMIN_ONLY, 'Super admin only');
  }
  return auth;
}

/**
 * V1.2-C — Asserts the caller is either a SUPER_ADMIN or a PRODUCT_ADMIN
 * for `productId` (i.e. has `productUsers.productRole === 'PRODUCT_ADMIN'`
 * AND `status === 'ACTIVE'`).
 *
 * Throws PERMISSION_DENIED otherwise. Per System Design §5.15 / GAP-03.
 */
export async function requireProductAdminOrSuperAdmin(
  req: Request,
  productId: string,
): Promise<AuthContext> {
  const auth = requireAuth(req);
  if (auth.role === 'SUPER_ADMIN') return auth;
  // Lazy-import to avoid a circular dep with repos at module load.
  const productUserRepo = await import('../repos/product-user.repo.js');
  const pu = await productUserRepo.findByUserAndProduct(productId, auth.userId);
  if (pu && pu.status === 'ACTIVE' && pu.productRole === 'PRODUCT_ADMIN') {
    return auth;
  }
  throw new AppError(
    ErrorCode.PERMISSION_DENIED,
    'PRODUCT_ADMIN or SUPER_ADMIN required',
  );
}
