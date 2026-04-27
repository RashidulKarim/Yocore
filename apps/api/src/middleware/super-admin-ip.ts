/**
 * Super-Admin IP allowlist (V1.0-C / B-18 / YC-010).
 *
 * When `superAdminConfig.adminIpAllowlistEnabled === true`:
 *   - All `/v1/admin/*` requests check `req.ip` (post-trust-proxy resolution)
 *     against the CIDR list. Mismatch → 403 IP_NOT_ALLOWLISTED.
 *
 * Recovery escape hatch: env var `YOCORE_DISABLE_IP_ALLOWLIST=true` short-circuits
 * the check (used for emergency lockout recovery — see runbook).
 *
 * Config is loaded once on first request and cached for `cacheTtlMs` (default
 * 60s) so we don't hit Mongo per request. The cache is also reloaded on Redis
 * pub/sub `superAdminConfig:reload` (admin updates).
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { AppError, ErrorCode } from '../lib/errors.js';
import { SuperAdminConfig } from '../db/models/SuperAdminConfig.js';

export const SUPER_ADMIN_CONFIG_RELOAD_CHANNEL = 'superAdminConfig:reload';

interface CachedConfig {
  enabled: boolean;
  cidrs: string[];
  loadedAt: number;
}

export interface SuperAdminIpAllowlistOptions {
  redis?: Redis;
  /** Force-disable via env. */
  disable?: boolean;
  /** Cache TTL in ms. Default 60s. */
  cacheTtlMs?: number;
}

export function superAdminIpAllowlistMiddleware(
  opts: SuperAdminIpAllowlistOptions = {},
): RequestHandler {
  const cacheTtlMs = opts.cacheTtlMs ?? 60_000;
  let cache: CachedConfig | null = null;

  if (opts.redis && typeof opts.redis.duplicate === 'function') {
    try {
      const sub = opts.redis.duplicate();
      void sub
        .subscribe(SUPER_ADMIN_CONFIG_RELOAD_CHANNEL)
        .then(() => {
          sub.on('message', () => {
            cache = null;
          });
        })
        .catch(() => {
          /* non-fatal */
        });
    } catch {
      /* non-fatal */
    }
  }

  return async function ipAllowlistGate(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Only gate /v1/admin/* paths (excluding bootstrap which uses its own secret).
      if (!req.path.startsWith('/v1/admin/') || req.path === '/v1/admin/bootstrap') {
        return next();
      }
      if (opts.disable) return next();

      const t = Date.now();
      if (!cache || t - cache.loadedAt > cacheTtlMs) {
        const doc = await SuperAdminConfig.findById('super_admin_config').lean<{
          adminIpAllowlist?: string[];
          adminIpAllowlistEnabled?: boolean;
        } | null>();
        cache = {
          enabled: !!doc?.adminIpAllowlistEnabled,
          cidrs: doc?.adminIpAllowlist ?? [],
          loadedAt: t,
        };
      }

      if (!cache.enabled) return next();

      const ip = req.ip ?? '';
      if (!ip) {
        throw new AppError(ErrorCode.IP_NOT_ALLOWLISTED, 'No client IP available');
      }
      for (const cidr of cache.cidrs) {
        if (matchCidr(ip, cidr)) return next();
      }
      throw new AppError(ErrorCode.IP_NOT_ALLOWLISTED, 'IP not in admin allowlist');
    } catch (e) {
      next(e);
    }
  };
}

/** Match an IP (v4 or v6) against a CIDR string. Falls back to exact match for plain IPs. */
export function matchCidr(ip: string, cidr: string): boolean {
  // Strip optional IPv6 brackets / IPv4-mapped IPv6.
  const normIp = normalizeIp(ip);
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) return normalizeIp(cidr) === normIp;
  const range = cidr.slice(0, slashIdx);
  const prefix = parseInt(cidr.slice(slashIdx + 1), 10);
  if (Number.isNaN(prefix)) return false;

  if (range.includes(':')) {
    return matchCidrV6(normIp, range, prefix);
  }
  return matchCidrV4(normIp, range, prefix);
}

function normalizeIp(ip: string): string {
  let v = ip;
  if (v.startsWith('::ffff:')) v = v.slice(7); // ipv4-mapped
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  return v;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  // Use unsigned 32-bit math via bitwise then >>> 0.
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

function matchCidrV4(ip: string, range: string, prefix: number): boolean {
  if (prefix < 0 || prefix > 32) return false;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(range);
  if (a === null || b === null) return false;
  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (a & mask) === (b & mask);
}

function expandIpv6(ip: string): bigint | null {
  try {
    // Split on ::
    const parts = ip.split('::');
    if (parts.length > 2) return null;
    const head = parts[0] ? parts[0]!.split(':') : [];
    const tail = parts[1] ? parts[1]!.split(':') : [];
    const filled = head.length + tail.length;
    if (filled > 8) return null;
    const middle = parts.length === 2 ? new Array(8 - filled).fill('0') : [];
    const all = [...head, ...middle, ...tail];
    if (all.length !== 8) return null;
    let n = 0n;
    for (const p of all) {
      if (p.length === 0) return null;
      const v = parseInt(p, 16);
      if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
      n = (n << 16n) | BigInt(v);
    }
    return n;
  } catch {
    return null;
  }
}

function matchCidrV6(ip: string, range: string, prefix: number): boolean {
  if (prefix < 0 || prefix > 128) return false;
  const a = expandIpv6(ip);
  const b = expandIpv6(range);
  if (a === null || b === null) return false;
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return (a >> shift) === (b >> shift);
}
