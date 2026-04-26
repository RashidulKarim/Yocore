/**
 * Security headers middleware — wraps `helmet` with YoCore-tuned defaults.
 *
 * - HSTS enabled (1 year, includeSubDomains, preload) — only meaningful behind HTTPS,
 *   harmless otherwise.
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY (no embedding)
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - Cross-Origin-Opener-Policy: same-origin
 * - CSP is OFF for the JSON API surface (the frontends apply their own CSP).
 *
 * Phase 2.4 — applied immediately after correlation-id middleware, before CORS.
 */
import helmet, { type HelmetOptions } from 'helmet';
import type { RequestHandler } from 'express';

export function securityHeadersMiddleware(overrides: HelmetOptions = {}): RequestHandler {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    noSniff: true,
    xssFilter: true,
    ...overrides,
  } as HelmetOptions);
}
