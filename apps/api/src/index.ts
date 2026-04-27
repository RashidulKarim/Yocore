import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './config/db.js';
import { getRedis, disconnectRedis } from './config/redis.js';
import { destroyAwsClients } from './config/aws.js';
import { logger } from './lib/logger.js';
import { createAppContext } from './context.js';
import { CronRunner } from './lib/cron-runner.js';
import { createMongoCronLockStore } from './repos/cron-lock.repo.js';
import os from 'node:os';

async function bootstrap(): Promise<void> {
  await connectMongo();
  // Touch redis to fail fast if misconfigured
  getRedis();

  const ctx = await createAppContext();
  const app = createApp({ ctx, trustProxy: 1 });
  const server = app.listen(env.PORT, () => {
    logger.info({ event: 'http.listening', port: env.PORT }, `API listening on :${env.PORT}`);
  });

  // ── Cron registry (Phase 3.4 Wave 4 — Flow G) ─────────────────────────
  const cronStore = createMongoCronLockStore({ instanceId: `${os.hostname()}.${process.pid}` });
  const cron = new CronRunner({ store: cronStore });
  cron.register({
    name: 'billing.trial.tick',
    schedule: 'hourly',
    dateKey: () => {
      const d = new Date();
      // Hourly bucket so each pod converges on one run/hr.
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;
    },
    lockTtlMs: 15 * 60 * 1000,
    handler: () => ctx.trial.runTrialTick().then(() => undefined),
  });
  cron.register({
    name: 'billing.grace.tick',
    schedule: 'hourly',
    dateKey: () => {
      const d = new Date();
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;
    },
    lockTtlMs: 15 * 60 * 1000,
    handler: () => ctx.grace.runGraceTick().then(() => undefined),
  });
  cron.register({
    name: 'bundle.cancel.cascade',
    schedule: 'daily',
    dateKey: () => {
      const d = new Date();
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    },
    lockTtlMs: 60 * 60 * 1000,
    handler: () => ctx.bundleCascade.runBundleCancelCascade().then(() => undefined),
  });
  const cronTimer = setInterval(() => {
    void cron.runOnce('billing.trial.tick');
    void cron.runOnce('billing.grace.tick');
    void cron.runOnce('bundle.cancel.cascade');
  }, 5 * 60 * 1000);
  cronTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown.start', signal }, `Received ${signal}, shutting down`);

    server.close((err) => {
      if (err) logger.error({ event: 'shutdown.http.error', err }, 'HTTP close error');
    });

    try {
      await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
      destroyAwsClients();
      logger.info({ event: 'shutdown.complete' }, 'Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ event: 'shutdown.error', err }, 'Shutdown error');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ event: 'unhandledRejection', reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ event: 'uncaughtException', err }, 'Uncaught exception — exiting');
    void shutdown('uncaughtException').finally(() => process.exit(1));
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
