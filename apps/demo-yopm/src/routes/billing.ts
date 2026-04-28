/**
 * Billing routes — wraps every /v1/billing/* end-user endpoint:
 *   POST /billing/checkout                          → /v1/billing/checkout
 *   POST /billing/trial/start                       → /v1/billing/trial/start
 *   GET  /billing                                   → invoices, tax profile, plan, change-plan form
 *   POST /billing/subscription/change-plan/preview  → preview
 *   POST /billing/subscription/change-plan          → apply
 *   POST /billing/subscription/seats                → change quantity
 *   POST /billing/subscription/pause                → pause
 *   POST /billing/subscription/resume               → resume
 *   GET  /billing/coupons/validate                  → validate
 *   POST /billing/subscription/migrate-gateway      → migrate-gateway
 *   POST /billing/tax-profile                       → upsert tax profile
 *
 * Idempotency: the demo generates a per-request key from the session id +
 * action. Real apps SHOULD send a stable client-generated UUID instead.
 */
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { layout, jsonBlock, escape, flashFromQuery } from '../lib/views.js';
import { authCall, describeError } from '../lib/api.js';
import { getSession, requireSession } from '../lib/session.js';
import type { DemoConfig } from '../config.js';

function genIdemKey(action: string): string {
  return `demo-yopm:${action}:${randomBytes(12).toString('hex')}`;
}

export function billingRouter(cfg: DemoConfig): Router {
  const r = Router();
  r.use(requireSession);

  // ── Dashboard ────────────────────────────────────────────────────────
  r.get('/billing', async (req, res) => {
    const [invoices, tax] = await Promise.all([
      authCall<{ invoices?: Array<Record<string, unknown>> }>(cfg.yocoreBaseUrl, req, '/v1/billing/invoices', {
        query: { limit: 25 },
      }),
      authCall(cfg.yocoreBaseUrl, req, '/v1/billing/tax-profile'),
    ]);
    const sess = getSession(req);
    const wsId = sess?.workspaceId ?? '';
    res.send(
      layout(
        'Billing',
        `<h1>Billing</h1>
        <div class="card"><h3>Invoices</h3>${jsonBlock(invoices.body)}</div>
        <div class="card"><h3>Tax profile</h3>${jsonBlock(tax.body)}
          <form method="POST" action="/billing/tax-profile">
            <input type="hidden" name="workspaceId" value="${escape(wsId)}"/>
            <label>Tax ID type (e.g. eu_vat, us_ein)</label><input name="taxIdType" required/>
            <label>Tax ID value</label><input name="taxIdValue" required/>
            <label>Billing name</label><input name="billingName"/>
            <label>Country (ISO-2)</label><input name="billingCountry" maxlength="2"/>
            <button>Save</button>
          </form>
        </div>
        <div class="card"><h3>Change plan</h3>
          <form method="POST" action="/billing/subscription/change-plan/preview">
            <input type="hidden" name="workspaceId" value="${escape(wsId)}"/>
            <label>New plan id</label><input name="newPlanId" required/>
            <button class="secondary">Preview</button>
          </form>
          <form method="POST" action="/billing/subscription/change-plan" style="margin-top:8px">
            <input type="hidden" name="workspaceId" value="${escape(wsId)}"/>
            <label>New plan id</label><input name="newPlanId" required/>
            <button>Apply</button>
          </form>
        </div>
        <div class="card"><h3>Seats</h3>
          <form method="POST" action="/billing/subscription/seats">
            <input type="hidden" name="workspaceId" value="${escape(wsId)}"/>
            <label>Quantity (1-1000)</label><input name="quantity" type="number" min="1" max="1000" required/>
            <button>Update</button>
          </form>
        </div>
        <div class="card"><h3>Pause / Resume</h3>
          <form method="POST" action="/billing/subscription/pause" style="display:inline">
            <input type="hidden" name="workspaceId" value="${escape(wsId)}"/>
            <button class="secondary">Pause</button>
          </form>
          <form method="POST" action="/billing/subscription/resume" style="display:inline">
            <input type="hidden" name="workspaceId" value="${escape(wsId)}"/>
            <button class="secondary">Resume</button>
          </form>
        </div>
        <div class="card"><h3>Migrate gateway (Stripe ↔ SSLCommerz)</h3>
          <form method="POST" action="/billing/subscription/migrate-gateway">
            <input type="hidden" name="workspaceId" value="${escape(wsId)}"/>
            <label>Target gateway</label>
            <select name="targetGateway"><option>stripe</option><option>sslcommerz</option></select>
            <button>Start migration</button>
          </form>
        </div>
        <div class="card"><h3>Validate coupon</h3>
          <form method="GET" action="/billing/coupons/validate">
            <label>Code</label><input name="code" required/>
            <label>Plan id (optional)</label><input name="planId"/>
            <button>Check</button>
          </form>
        </div>`,
        { session: sess, active: 'billing', ...flashFromQuery(req) },
      ),
    );
  });

  // ── Checkout ─────────────────────────────────────────────────────────
  r.post('/billing/checkout', async (req, res) => {
    const body = req.body as Record<string, string>;
    const sess = getSession(req);
    const result = await authCall<{ url?: string }>(cfg.yocoreBaseUrl, req, '/v1/billing/checkout', {
      method: 'POST',
      idempotencyKey: genIdemKey('checkout'),
      body: {
        planId: body['planId'],
        workspaceId: sess?.workspaceId,
        quantity: 1,
        successUrl: `http://localhost:${cfg.port}/billing?msg=Payment%20completed`,
        cancelUrl: `http://localhost:${cfg.port}/billing?err=Payment%20cancelled`,
      },
    });
    if (!result.ok || !result.body?.url) {
      return res.redirect('/plans?err=' + encodeURIComponent(describeError(result)));
    }
    return res.redirect(result.body.url);
  });

  // ── Trial start ──────────────────────────────────────────────────────
  r.post('/billing/trial/start', async (req, res) => {
    const body = req.body as Record<string, string>;
    const sess = getSession(req);
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/billing/trial/start', {
      method: 'POST',
      idempotencyKey: genIdemKey('trial'),
      body: { planId: body['planId'], workspaceId: sess?.workspaceId },
    });
    if (!result.ok) return res.redirect('/plans?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/billing?msg=' + encodeURIComponent('Trial started'));
  });

  // ── Change plan preview / apply ──────────────────────────────────────
  r.post('/billing/subscription/change-plan/preview', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/billing/subscription/change-plan/preview', {
      query: { newPlanId: body['newPlanId'], workspaceId: body['workspaceId'] || undefined },
    });
    if (!result.ok) return res.redirect('/billing?err=' + encodeURIComponent(describeError(result)));
    return res.send(
      layout('Plan change preview', `<h1>Plan change preview</h1><div class="card">${jsonBlock(result.body)}</div><a class="btn" href="/billing">Back</a>`, {
        session: getSession(req),
        active: 'billing',
      }),
    );
  });

  r.post('/billing/subscription/change-plan', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/billing/subscription/change-plan', {
      method: 'POST',
      idempotencyKey: genIdemKey('changeplan'),
      body: { newPlanId: body['newPlanId'], workspaceId: body['workspaceId'] || undefined },
    });
    if (!result.ok) return res.redirect('/billing?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/billing?msg=' + encodeURIComponent('Plan changed'));
  });

  // ── Seats ────────────────────────────────────────────────────────────
  r.post('/billing/subscription/seats', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/billing/subscription/seats', {
      method: 'POST',
      idempotencyKey: genIdemKey('seats'),
      body: {
        quantity: Number(body['quantity']),
        workspaceId: body['workspaceId'] || undefined,
      },
    });
    if (!result.ok) return res.redirect('/billing?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/billing?msg=Seats updated');
  });

  // ── Pause / Resume ───────────────────────────────────────────────────
  r.post('/billing/subscription/pause', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/billing/subscription/pause', {
      method: 'POST',
      idempotencyKey: genIdemKey('pause'),
      body: { workspaceId: body['workspaceId'] || undefined },
    });
    if (!result.ok) return res.redirect('/billing?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/billing?msg=Paused');
  });

  r.post('/billing/subscription/resume', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/billing/subscription/resume', {
      method: 'POST',
      idempotencyKey: genIdemKey('resume'),
      body: { workspaceId: body['workspaceId'] || undefined },
    });
    if (!result.ok) return res.redirect('/billing?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/billing?msg=Resumed');
  });

  // ── Coupon validation ────────────────────────────────────────────────
  r.get('/billing/coupons/validate', async (req, res) => {
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/billing/coupons/validate', {
      query: {
        code: String(req.query['code'] ?? ''),
        planId: req.query['planId'] ? String(req.query['planId']) : undefined,
      },
    });
    return res.send(
      layout(
        'Coupon',
        `<h1>Coupon</h1><div class="card">Status ${result.status}${jsonBlock(result.body)}</div><a class="btn" href="/billing">Back</a>`,
        { session: getSession(req), active: 'billing' },
      ),
    );
  });

  // ── Gateway migrate ──────────────────────────────────────────────────
  r.post('/billing/subscription/migrate-gateway', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall<{ url?: string }>(cfg.yocoreBaseUrl, req, '/v1/billing/subscription/migrate-gateway', {
      method: 'POST',
      idempotencyKey: genIdemKey('migrate'),
      body: {
        workspaceId: body['workspaceId'] || undefined,
        targetGateway: body['targetGateway'],
        successUrl: `http://localhost:${cfg.port}/billing?msg=Migration%20completed`,
        cancelUrl: `http://localhost:${cfg.port}/billing?err=Migration%20cancelled`,
      },
    });
    if (!result.ok || !result.body?.url) {
      return res.redirect('/billing?err=' + encodeURIComponent(describeError(result)));
    }
    return res.redirect(result.body.url);
  });

  // ── Tax profile ──────────────────────────────────────────────────────
  r.post('/billing/tax-profile', async (req, res) => {
    const body = req.body as Record<string, string>;
    const result = await authCall(cfg.yocoreBaseUrl, req, '/v1/billing/tax-profile', {
      method: 'PUT',
      body: {
        workspaceId: body['workspaceId'] || undefined,
        taxIdType: body['taxIdType'],
        taxIdValue: body['taxIdValue'],
        billingName: body['billingName'] || undefined,
        billingCountry: body['billingCountry'] || undefined,
      },
    });
    if (!result.ok) return res.redirect('/billing?err=' + encodeURIComponent(describeError(result)));
    return res.redirect('/billing?msg=Tax profile saved');
  });

  return r;
}
