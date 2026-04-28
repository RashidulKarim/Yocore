/**
 * Bundle routes (Phase 3.5):
 *   GET  /bundles                       form to checkout / cancel by id
 *   POST /bundles/checkout              → /v1/billing/bundle-checkout
 *   POST /bundles/:id/cancel            → /v1/billing/bundles/:id/cancel
 *
 * Bundles are global (cross-product). There's no public bundle catalog
 * endpoint yet — the super-admin curates them — so this page is a manual
 * "I have a bundleId" tester.
 */
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { layout, escape, flashFromQuery } from '../lib/views.js';
import { authCall, describeError } from '../lib/api.js';
import { getSession, requireSession } from '../lib/session.js';
import type { DemoConfig } from '../config.js';

export function bundleRouter(cfg: DemoConfig): Router {
  const r = Router();
  r.use(requireSession);

  r.get('/bundles', (req, res) => {
    res.send(
      layout(
        'Bundles',
        `<h1>Bundles</h1>
        <div class="card"><h3>Subscribe to a bundle</h3>
          <p class="muted">Bundles span multiple products. Paste the bundleId + currency + a JSON map of <code>productId → workspaceId</code>.</p>
          <form method="POST" action="/bundles/checkout">
            <label>Bundle id</label><input name="bundleId" required/>
            <label>Currency (3-letter)</label><input name="currency" maxlength="3" required value="usd"/>
            <label>Subjects JSON (e.g. {"prod_x":"ws_y"})</label><textarea name="subjects" rows="4" required>{}</textarea>
            <button>Start checkout</button>
          </form>
        </div>
        <div class="card"><h3>Cancel a bundle subscription</h3>
          <form method="POST" action="/bundles/cancel">
            <label>Bundle id</label><input name="bundleId" required/>
            <button class="danger">Cancel</button>
          </form>
        </div>`,
        { session: getSession(req), active: 'bundles', ...flashFromQuery(req) },
      ),
    );
  });

  r.post('/bundles/checkout', async (req, res) => {
    const body = req.body as Record<string, string>;
    let subjects: Record<string, string>;
    try {
      subjects = JSON.parse(body['subjects'] ?? '{}');
    } catch (err) {
      return res.redirect('/bundles?err=' + encodeURIComponent('Subjects JSON parse error: ' + (err as Error).message));
    }
    const result = await authCall<{ url?: string }>(cfg.yocoreBaseUrl, req, '/v1/billing/bundle-checkout', {
      method: 'POST',
      idempotencyKey: `demo-yopm:bundle:${randomBytes(12).toString('hex')}`,
      body: {
        bundleId: body['bundleId'],
        subjects,
        currency: body['currency'],
        successUrl: `http://localhost:${cfg.port}/bundles?msg=Checkout%20completed`,
        cancelUrl: `http://localhost:${cfg.port}/bundles?err=Checkout%20cancelled`,
      },
    });
    if (!result.ok || !result.body?.url) {
      return res.redirect('/bundles?err=' + encodeURIComponent(describeError(result)));
    }
    return res.redirect(result.body.url);
  });

  r.post('/bundles/cancel', async (req, res) => {
    const body = req.body as Record<string, string>;
    const id = body['bundleId']!;
    const result = await authCall(cfg.yocoreBaseUrl, req, `/v1/billing/bundles/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      idempotencyKey: `demo-yopm:bundle-cancel:${randomBytes(12).toString('hex')}`,
    });
    if (!result.ok) return res.redirect('/bundles?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/bundles?msg=' + encodeURIComponent('Cancelled (cron will cascade to children).'));
  });

  // Generic helper so the public routes can compose the cancel link.
  r.use((_req, _res, next) => {
    void escape; // keep tree-shaker happy
    next();
  });

  return r;
}
