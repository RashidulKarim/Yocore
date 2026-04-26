/**
 * Session activity store — used by jwt-auth middleware to determine if a
 * session has been revoked since the JWT was issued.
 *
 * Strategy:
 *   - On sign-in / refresh: SET `sess:{jti}` = '1' EX <accessTtl>.
 *   - On logout / revoke: DEL `sess:{jti}`. Also fall back to Mongo (revokedAt set).
 *   - On lookup: EXISTS `sess:{jti}`; if missing, hit Mongo as a fallback to
 *     handle the case where the cache key TTL'd out but the JWT is still valid.
 *
 * The 2-tier check means a logout invalidates immediately AND survives Redis
 * eviction.
 */
import type { Redis } from 'ioredis';
import { Session } from '../db/models/Session.js';
import type { SessionStore } from '../middleware/jwt-auth.js';

const KEY = (jti: string) => `sess:${jti}`;

export interface SessionStoreOptions {
  redis: Redis;
}

export function createSessionStore({ redis }: SessionStoreOptions): SessionStore & {
  markActive(jti: string, ttlSeconds: number): Promise<void>;
  markRevoked(jti: string): Promise<void>;
} {
  return {
    async isActive(jti: string): Promise<boolean> {
      const cached = await redis.exists(KEY(jti));
      if (cached === 1) return true;

      // Cache miss — check Mongo. If a row exists and has not been revoked, it's active.
      const row = await Session.findOne({ jwtId: jti }).select({ revokedAt: 1 }).lean();
      return row !== null && row.revokedAt === null;
    },

    async markActive(jti: string, ttlSeconds: number): Promise<void> {
      await redis.set(KEY(jti), '1', 'EX', ttlSeconds);
    },

    async markRevoked(jti: string): Promise<void> {
      await redis.del(KEY(jti));
    },
  };
}
