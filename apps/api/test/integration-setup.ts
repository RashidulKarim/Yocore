/**
 * Integration test setup. Spins up an in-memory Mongo replica set and an
 * ioredis-mock instance per test process. A `getTestContext()` helper builds
 * an `AppContext` wired to those primitives + an in-memory keyring with a
 * freshly generated EdDSA key.
 *
 * Tests should:
 *   - import { getTestContext } from '../test/integration-setup';
 *   - call `await resetDatabase()` in `beforeEach`.
 */
import 'mongodb-memory-server'; // ensures the package is loaded for type augmentation
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import RedisMock from 'ioredis-mock';
import mongoose from 'mongoose';
import { generateKeyPair, exportJWK } from 'jose';
import { afterAll, beforeAll } from 'vitest';

// Set required env BEFORE any module imports it.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
process.env.YOCORE_KMS_KEY =
  process.env.YOCORE_KMS_KEY ??
  '0000000000000000000000000000000000000000000000000000000000000000';
process.env.BOOTSTRAP_SECRET =
  process.env.BOOTSTRAP_SECRET ?? 'integration-bootstrap-secret-must-be-32-chars-or-more';
process.env.JWT_ISSUER = process.env.JWT_ISSUER ?? 'yocore-test';
process.env.JWT_ACCESS_TTL_SECONDS = process.env.JWT_ACCESS_TTL_SECONDS ?? '900';
process.env.JWT_REFRESH_TTL_SECONDS = process.env.JWT_REFRESH_TTL_SECONDS ?? '2592000';
process.env.JWT_REFRESH_TTL_NO_REMEMBER_SECONDS =
  process.env.JWT_REFRESH_TTL_NO_REMEMBER_SECONDS ?? '604800';

// Set placeholders for env vars Zod requires; the in-memory connection replaces these.
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://placeholder/integration';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://placeholder';

let replset: MongoMemoryReplSet | undefined;

beforeAll(async () => {
  if (mongoose.connection.readyState === 1) return;
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  const uri = replset.getUri();
  await mongoose.connect(uri, { dbName: 'yocore_integration' });
}, 60_000);

afterAll(async () => {
  // Connection + replset are shared across files (isolate:false). Last file
  // to run handles teardown; re-running disconnect is a no-op.
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replset) {
    await replset.stop();
    replset = undefined;
  }
}, 30_000);

export async function resetDatabase(): Promise<void> {
  if (!mongoose.connection.db) return;
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}

// ─── Test context builder ────────────────────────────────────────────────────
// We import the AppContext factory dynamically so the env vars above are read
// AFTER setup, not at module-load time.

let cachedContext: import('../src/context.js').AppContext | undefined;
let cachedRedis: import('ioredis').Redis | undefined;
let cachedApp: import('express').Express | undefined;

export async function getTestContext(): Promise<{
  ctx: import('../src/context.js').AppContext;
  redis: import('ioredis').Redis;
  app: import('express').Express;
}> {
  if (cachedContext && cachedApp && cachedRedis) {
    return { ctx: cachedContext, redis: cachedRedis, app: cachedApp };
  }

  const { JwtKeyring } = await import('../src/lib/jwt-keyring.js');
  const { createAppContext } = await import('../src/context.js');
  const { createApp } = await import('../src/app.js');

  // Fresh EdDSA keypair for the test keyring.
  const { publicKey, privateKey } = await generateKeyPair('EdDSA');
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const keyring = new JwtKeyring(async () => [
    {
      kid: 'test-kid-1',
      status: 'active',
      alg: 'EdDSA',
      publicJwk,
      privateJwk,
    },
  ]);
  await keyring.reload();

  const redis = new (RedisMock as unknown as new () => import('ioredis').Redis)();
  const ctx = await createAppContext({ redis, keyring });
  const app = createApp({ ctx });

  cachedContext = ctx;
  cachedRedis = redis;
  cachedApp = app;
  return { ctx, redis, app };
}
