/**
 * Webhook receiver. Mounted at `/webhooks` with `express.raw` so the
 * HMAC verifier sees the canonical bytes. POSTs from YoCore deliver
 * outbound events (subscription.activated, plan_changed, trial.warning,
 * bundle.subscription.canceled, etc.).
 *
 * For visibility we keep a small in-memory ring of the last 50 events
 * so you can browse them at GET /webhooks/log.
 */
import { Router, type Request, type Response } from 'express';
import { verifyWebhookSignature, WebhookSignatureError } from '@yocore/sdk';
import { layout, jsonBlock } from '../lib/views.js';
import type { DemoConfig } from '../config.js';

interface LoggedEvent {
  receivedAt: string;
  type?: string;
  id?: string;
  raw: unknown;
}

const ring: LoggedEvent[] = [];
function push(evt: LoggedEvent): void {
  ring.unshift(evt);
  if (ring.length > 50) ring.length = 50;
}

export function webhookRouter(cfg: DemoConfig): Router {
  const r = Router();

  r.post('/webhooks', (req: Request, res: Response) => {
    const sig = req.header('x-yocore-signature');
    try {
      const result = verifyWebhookSignature(req.body as Buffer, sig, cfg.webhookSecret);
      let parsed: { id?: string; type?: string } & Record<string, unknown> = {};
      try {
        parsed = JSON.parse((req.body as Buffer).toString('utf8'));
      } catch {
        // payload may not be JSON in degenerate cases
      }
      push({
        receivedAt: new Date().toISOString(),
        type: parsed.type,
        id: parsed.id,
        raw: parsed,
      });
      // eslint-disable-next-line no-console
      console.log('[demo-yopm] webhook OK', { ts: result.timestamp, type: parsed.type });
      res.status(200).json({ received: true });
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        res.status(401).json({ error: 'invalid_signature', detail: err.message });
        return;
      }
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET endpoint so you can inspect recent deliveries from the browser.
  r.get('/webhooks/log', (_req, res) => {
    res.send(
      layout(
        'Webhook log',
        `<h1>Recent webhook events (in-memory)</h1>
        <div class="card">${jsonBlock(ring)}</div>`,
      ),
    );
  });

  return r;
}
