import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.js';
import { logger } from '../lib/logger.js';

let client: Redis | undefined;
let subscriber: Redis | undefined;

function buildOptions(): RedisOptions {
  const useTls = env.REDIS_URL.startsWith('rediss://');
  return {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: 10_000,
    ...(useTls ? { tls: {} } : {}),
  };
}

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, buildOptions());
    client.on('connect', () => logger.info({ event: 'redis.connected' }, 'Redis connected'));
    client.on('error', (err) => logger.error({ event: 'redis.error', err }, 'Redis error'));
    client.on('close', () => logger.warn({ event: 'redis.closed' }, 'Redis closed'));
  }
  return client;
}

export function getRedisSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(env.REDIS_URL, buildOptions());
    subscriber.on('error', (err) =>
      logger.error({ event: 'redis.sub.error', err }, 'Redis subscriber error'),
    );
  }
  return subscriber;
}

export async function disconnectRedis(): Promise<void> {
  await Promise.all([
    client ? client.quit().catch(() => undefined) : Promise.resolve(),
    subscriber ? subscriber.quit().catch(() => undefined) : Promise.resolve(),
  ]);
  client = undefined;
  subscriber = undefined;
}
