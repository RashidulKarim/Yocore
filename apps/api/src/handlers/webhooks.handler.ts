/**
 * Inbound webhook handlers — Phase 3.4 Wave 2 (Flow J1.6).
 *
 * `POST /v1/webhooks/stripe` — verifies Stripe signature against the
 * product's stored `webhookSecret`, dedups by event id, and dispatches.
 *
 * The handler MUST receive the raw request body (bytes-as-string) so the
 * signature math matches Stripe's. The app captures it via the JSON
 * parser's `verify` callback into `req.rawBody`.
 */
import type { RequestHandler } from 'express';
import { asyncHandler } from './index.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import type { AppContext } from '../context.js';

export interface WebhookHandlers {
  stripe: RequestHandler;
  sslcommerz: RequestHandler;
}

export function webhookHandlerFactory(ctx: AppContext): WebhookHandlers {
  return {
    stripe: asyncHandler(async (req, res) => {
      const raw =
        (req as unknown as { rawBody?: Buffer | string }).rawBody;
      if (!raw) {
        throw new AppError(
          ErrorCode.WEBHOOK_PAYLOAD_INVALID,
          'Missing raw body for signature verification',
        );
      }
      const rawString = typeof raw === 'string' ? raw : raw.toString('utf8');
      const sig = req.get('stripe-signature') ?? undefined;

      const result = await ctx.stripeWebhook.process({
        rawBody: rawString,
        signatureHeader: sig,
        ...(req.audit ? { audit: req.audit } : {}),
      });

      // Stripe expects 2xx for "received". 200 is canonical.
      res.status(200).json({
        received: true,
        deduped: result.deduped,
        handled: result.handled,
      });
    }),

    sslcommerz: asyncHandler(async (req, res) => {
      // SSLCommerz IPN bodies are `application/x-www-form-urlencoded`,
      // already parsed by express into `req.body` as a string-only map.
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      const result = await ctx.sslcommerzWebhook.process({
        body,
        ...(req.audit ? { audit: req.audit } : {}),
      });
      res.status(200).json({
        received: true,
        deduped: result.deduped,
        activated: result.activated,
      });
    }),
  };
}
