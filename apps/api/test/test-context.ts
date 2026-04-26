/**
 * Test helpers for building an `AppContext` in unit tests without spinning up
 * Mongo / Redis. Integration tests use the real factory in `context.ts`.
 *
 * Used by `app.test.ts` and unit suites that just need an Express app to
 * exercise middleware behaviour (CORS, headers, 404, etc.).
 */
import { JwtKeyring } from '../src/lib/jwt-keyring.js';
import type { AppContext } from '../src/context.js';
import type { AuditLogStore } from '../src/middleware/audit-log.js';
import type { SessionStore } from '../src/middleware/jwt-auth.js';
import type { Redis } from 'ioredis';

const noopAuditStore: AuditLogStore = {
  async append(record, computeHash) {
    const hash = computeHash(null);
    return { ...record, prevHash: null, hash };
  },
};

const noopSessionStore: SessionStore & {
  markActive: (jti: string, ttl: number) => Promise<void>;
  markRevoked: (jti: string) => Promise<void>;
} = {
  async isActive() {
    return true;
  },
  async markActive() {},
  async markRevoked() {},
};

export function createNoopAppContext(): AppContext {
  const keyring = new JwtKeyring(async () => []);
  return {
    redis: {} as Redis,
    keyring,
    sessionStore: noopSessionStore,
    auditStore: noopAuditStore,
    auth: {
      async signin() {
        throw new Error('noop auth: signin not supported');
      },
      async refresh() {
        throw new Error('noop auth: refresh not supported');
      },
      async signout() {},
    },
  };
}
