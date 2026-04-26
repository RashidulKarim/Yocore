import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './config/db.js';
import { getRedis, disconnectRedis } from './config/redis.js';
import { destroyAwsClients } from './config/aws.js';
import { logger } from './lib/logger.js';
import { createAppContext } from './context.js';

async function bootstrap(): Promise<void> {
  await connectMongo();
  // Touch redis to fail fast if misconfigured
  getRedis();

  const ctx = await createAppContext();
  const app = createApp({ ctx, trustProxy: 1 });
  const server = app.listen(env.PORT, () => {
    logger.info({ event: 'http.listening', port: env.PORT }, `API listening on :${env.PORT}`);
  });

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
