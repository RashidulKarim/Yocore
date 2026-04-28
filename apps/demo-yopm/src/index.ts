/**
 * YoPM Demo App — full end-user playground for YoCore.
 *
 * Pages cover every public/end-user feature: plans, signup, email
 * verification, signin (incl. MFA), forgot/reset password, account
 * (sessions/MFA/email-prefs/email-change/data-export/deletion),
 * workspaces (CRUD/members/invitations/transfer/switch), billing
 * (checkout/trial/change-plan/seats/pause/resume/coupon/migrate-gateway/
 * tax-profile/invoices), bundles (checkout/cancel) and a webhook
 * receiver with an inspector.
 *
 * Auth: sign-in is direct (POST /v1/auth/signin with productSlug);
 * the auth-web micro-frontend is NOT required. Tokens are kept in an
 * in-memory cookie session for demo purposes only.
 */
import express, { type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { loadConfig } from './config.js';
import { attachSession } from './lib/session.js';
import { connectYopmDb } from './db/connection.js';
import { publicRouter } from './routes/public.js';
import { accountRouter } from './routes/account.js';
import { workspaceRouter } from './routes/workspaces.js';
import { billingRouter } from './routes/billing.js';
import { bundleRouter } from './routes/bundles.js';
import { projectsRouter } from './routes/projects.js';
import { webhookRouter } from './routes/webhooks.js';

export function createApp(): express.Express {
  const cfg = loadConfig();
  const app = express();

  // 👉 Webhook router goes BEFORE express.json() so the raw body survives.
  app.use(webhookRouter(cfg));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(attachSession);

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, service: 'demo-yopm' });
  });

  app.use(publicRouter(cfg));
  app.use(accountRouter(cfg));
  app.use(workspaceRouter(cfg));
  app.use(billingRouter(cfg));
  app.use(bundleRouter(cfg));
  app.use(projectsRouter(cfg));

  // Generic error handler — keeps the demo alive when a sub-route throws.
  app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('[demo-yopm] error', err);
    res.status(500).type('text').send(`Internal error: ${err.message}`);
  });

  return app;
}

export const app = createApp();

if (process.env['NODE_ENV'] !== 'test') {
  const cfg = loadConfig();
  // Connect to the product's OWN database before accepting traffic.
  connectYopmDb(cfg.mongoUri)
    .then(() => {
      app.listen(cfg.port, () => {
        // eslint-disable-next-line no-console
        console.log(`[demo-yopm] listening on http://localhost:${cfg.port}  →  YoCore ${cfg.yocoreBaseUrl}  (product: ${cfg.productSlug})`);
      });
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[demo-yopm] failed to connect to product DB', err);
      process.exit(1);
    });
}
