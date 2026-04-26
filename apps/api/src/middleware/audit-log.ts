/**
 * Audit-log helper + middleware.
 *
 * Audit logs are an append-only, hash-chained event trail (`auditLogs` collection).
 * Every state-changing action MUST emit an entry. Two surfaces:
 *
 *   1. `req.audit(event)` — handlers/services call this directly when they know
 *      what changed. Preferred.
 *   2. `auditLogMiddleware()` — attaches the helper to `req`. Optional defaults
 *      (productId, actor) are pulled from `req.product` / `req.auth`.
 *
 * The hash chain:
 *   - Per-product chain (productId or '__global__' for SUPER_ADMIN actions).
 *   - hash = sha256(prevHash || canonical(event)).
 *   - The store is responsible for atomically reading prevHash + writing the
 *     new entry; we surface a simple `append()` API.
 */
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../lib/logger.js';

export type AuditOutcome = 'success' | 'failure' | 'denied';
export type ActorType = 'user' | 'super_admin' | 'product' | 'system' | 'webhook';

export interface AuditEventInput {
  action: string;
  outcome: AuditOutcome;
  productId?: string | null;
  workspaceId?: string | null;
  resource?: { type: string; id: string };
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Override the actor pulled from req.auth/req.product. */
  actor?: {
    type: ActorType;
    id?: string | null;
    apiKeyId?: string | null;
    sessionId?: string | null;
  };
}

export interface AuditLogRecord {
  ts: Date;
  productId: string | null;
  workspaceId: string | null;
  actor: {
    type: ActorType;
    id: string | null;
    ip: string | null;
    userAgent: string | null;
    apiKeyId: string | null;
    sessionId: string | null;
    correlationId: string | null;
  };
  action: string;
  resource: { type: string | null; id: string | null };
  outcome: AuditOutcome;
  reason: string | null;
  metadata: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}

export interface AuditLogStore {
  /** Append a new audit entry; the store reads prevHash and writes hash atomically. */
  append: (record: Omit<AuditLogRecord, 'prevHash' | 'hash'>, computeHash: (prevHash: string | null) => string) => Promise<AuditLogRecord>;
}

export type AuditEmitter = (event: AuditEventInput) => Promise<void>;

declare module 'express' {
  interface Request {
    audit?: AuditEmitter;
  }
}

export interface AuditMiddlewareOptions {
  store: AuditLogStore;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function computeAuditHash(prevHash: string | null, body: Omit<AuditLogRecord, 'prevHash' | 'hash'>): string {
  const h = createHash('sha256');
  h.update(prevHash ?? '');
  h.update('\n');
  h.update(canonicalize(body));
  return h.digest('hex');
}

export function auditLogMiddleware(opts: AuditMiddlewareOptions): RequestHandler {
  return function attachAudit(req: Request, _res: Response, next: NextFunction): void {
    req.audit = async (event: AuditEventInput): Promise<void> => {
      const productId = event.productId ?? req.product?.productId ?? null;
      const workspaceId = event.workspaceId ?? req.auth?.workspaceId ?? null;

      const actor =
        event.actor ??
        (req.auth
          ? {
              type: req.auth.role === 'SUPER_ADMIN' ? 'super_admin' : 'user',
              id: req.auth.userId,
              sessionId: req.auth.sessionId,
            }
          : req.product
            ? { type: 'product' as const, id: req.product.productId, apiKeyId: req.product.apiKey }
            : { type: 'system' as const });

      const body: Omit<AuditLogRecord, 'prevHash' | 'hash'> = {
        ts: new Date(),
        productId,
        workspaceId,
        actor: {
          type: actor.type,
          id: actor.id ?? null,
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
          apiKeyId: actor.apiKeyId ?? null,
          sessionId: actor.sessionId ?? null,
          correlationId: req.correlationId ?? null,
        },
        action: event.action,
        resource: { type: event.resource?.type ?? null, id: event.resource?.id ?? null },
        outcome: event.outcome,
        reason: event.reason ?? null,
        metadata: event.metadata ?? {},
      };

      try {
        await opts.store.append(body, (prevHash) => computeAuditHash(prevHash, body));
      } catch (err) {
        // Audit failures must never break the request; surface to logs only.
        logger.error({ event: 'audit.append.failed', action: body.action, err }, 'audit append failed');
      }
    };
    next();
  };
}
