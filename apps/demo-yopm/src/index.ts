/**
 * YoPM Demo App — minimal Express server demonstrating end-to-end YoCore
 * integration:
 *
 *   1. PKCE login start (`GET /login`)         — builds /authorize URL
 *   2. PKCE callback     (`GET /callback`)     — exchanges code → tokens
 *   3. Authenticated me  (`GET /me`)           — bearer token to `/v1/users/me`
 *   4. List plans        (`GET /plans`)        — server-side via API key
 *   5. Webhook receiver  (`POST /webhooks`)    — verifies HMAC then 200s
 *
 * In-memory session for demo only — not for production.
 */
import express, { type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import {
  YoCoreClient,
  YoCoreServer,
  verifyWebhookSignature,
  WebhookSignatureError,
} from '@yocore/sdk';

const port = Number(process.env['DEMO_YOPM_PORT'] ?? 5175);
const yocoreBaseUrl = process.env['YOCORE_BASE_URL'] ?? 'http://localhost:4000';
const apiKey = process.env['YOCORE_PRODUCT_API_KEY'] ?? 'pk_demo_missing';
const apiSecret = process.env['YOCORE_PRODUCT_API_SECRET'] ?? 'sk_demo_missing';
const productSlug = process.env['YOCORE_PRODUCT_SLUG'] ?? 'yopm-demo';
const webhookSecret = process.env['YOCORE_WEBHOOK_SECRET'] ?? 'whsec_demo_missing';
const redirectUri = `http://localhost:${port}/callback`;

const client = new YoCoreClient({ apiKey, baseUrl: yocoreBaseUrl });
const server = new YoCoreServer({ apiKey, apiSecret, baseUrl: yocoreBaseUrl, productSlug });

/** state → { verifier, createdAt } */
const pkceStore = new Map<string, { verifier: string; createdAt: number }>();
/** state → access token (demo only). */
const sessionTokens = new Map<string, string>();

const app = express();
// Webhook route MUST get raw body for HMAC verification — register BEFORE json().
app.use('/webhooks', express.raw({ type: '*/*' }));
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, service: 'demo-yopm' });
});

app.get('/', (_req: Request, res: Response) => {
  res.type('html').send(`
    <h1>YoPM Demo</h1>
    <ul>
      <li><a href="/login">Sign in via YoCore (PKCE)</a></li>
      <li><a href="/plans">List plans</a></li>
    </ul>
  `);
});

app.get('/login', async (_req: Request, res: Response) => {
  const verifier = await YoCoreClient.createPkceVerifier();
  const challenge = await YoCoreClient.pkceChallenge(verifier);
  const state = randomBytes(16).toString('hex');
  pkceStore.set(state, { verifier, createdAt: Date.now() });
  const url = client.buildAuthorizeUrl({
    productSlug,
    redirectUri,
    state,
    codeChallenge: challenge,
    scope: 'profile billing',
  });
  res.redirect(302, url);
});

app.get('/callback', async (req: Request, res: Response) => {
  const code = String(req.query['code'] ?? '');
  const state = String(req.query['state'] ?? '');
  const entry = pkceStore.get(state);
  if (!code || !entry) {
    res.status(400).type('text').send('Missing or unknown state/code');
    return;
  }
  pkceStore.delete(state);
  try {
    const tokens = await client.exchangeCode({ code, verifier: entry.verifier, redirectUri });
    sessionTokens.set(state, tokens.accessToken);
    client.setAccessToken(tokens.accessToken);
    res.type('html').send(`
      <h1>Signed in</h1>
      <p>Access token issued. <a href="/me?s=${state}">View profile</a></p>
    `);
  } catch (err) {
    res.status(500).type('text').send(`Exchange failed: ${(err as Error).message}`);
  }
});

app.get('/me', async (req: Request, res: Response) => {
  const token = sessionTokens.get(String(req.query['s'] ?? ''));
  if (!token) {
    res.status(401).type('text').send('Not signed in');
    return;
  }
  client.setAccessToken(token);
  try {
    const me = await client.me();
    res.json(me);
  } catch (err) {
    res.status(502).type('text').send(`me failed: ${(err as Error).message}`);
  }
});

app.get('/plans', async (_req: Request, res: Response) => {
  try {
    const plans = await server.listPlans(productSlug);
    res.json(plans);
  } catch (err) {
    res.status(502).type('text').send(`listPlans failed: ${(err as Error).message}`);
  }
});

app.post('/webhooks', (req: Request, res: Response) => {
  const sig = req.header('x-yocore-signature');
  try {
    const result = verifyWebhookSignature(req.body as Buffer, sig, webhookSecret);
    // eslint-disable-next-line no-console
    console.log('[demo-yopm] webhook OK', { ts: result.timestamp });
    res.status(200).json({ received: true });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      res.status(401).json({ error: 'invalid_signature', detail: err.message });
      return;
    }
    res.status(500).json({ error: 'internal' });
  }
});

// Export app for supertest-based tests (listen is guarded below).
export { app };

// Start the server only when NOT running under the test runner.
if (process.env['NODE_ENV'] !== 'test') {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[demo-yopm] listening on http://localhost:${port}  →  YoCore ${yocoreBaseUrl}`);
  });
}
