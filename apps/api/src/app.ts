import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { correlationIdMiddleware } from './middleware/correlation-id.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { buildRouter } from './router.js';

export interface CreateAppOptions {
  trustProxy?: boolean | number | string;
}

export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();

  if (opts.trustProxy !== undefined) app.set('trust proxy', opts.trustProxy);
  app.disable('x-powered-by');

  // 1. correlation id (must run first so all logs carry it)
  app.use(correlationIdMiddleware);

  // 2. security headers
  app.use(helmet({ contentSecurityPolicy: false }));

  // 3. CORS — placeholder permissive config; per-product allowlist replaces this in Phase 2.4
  app.use(cors());

  // Body parsers
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Routes
  app.use(buildRouter());

  // 404 + error handler (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
