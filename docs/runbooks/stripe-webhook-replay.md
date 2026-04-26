# Runbook — Stripe Webhook Replay

**Severity:** P1 (subscriptions out of sync)
**Trigger:**
- Spike in `yocore_stripe_webhook_failures_total`
- Customer complaint: "I paid but my subscription says PAST_DUE"
- Stripe dashboard shows successful events that we didn't process

## Diagnosis

1. In Stripe Dashboard → **Developers → Webhooks → [Endpoint]**, look for failed deliveries (red badge).
2. For each failed event, copy the `evt_...` ID.
3. Check our DB:
   ```js
   db.webhookEventsProcessed.findOne({ provider: "stripe", eventId: "evt_..." });
   ```
   - If exists → we processed it, look at `handlerAction`. State may be inconsistent.
   - If not → we never received/processed it.

## Replay procedure

### From Stripe Dashboard (preferred)
1. Open the failed event.
2. Click **"Resend"** in top-right.
3. Confirm in our logs: `correlationId` for that delivery.
4. Verify state in DB:
   ```js
   db.subscriptions.findOne({ "gatewayRefs.stripeSubscriptionId": "sub_..." });
   ```

### From Stripe CLI (bulk)
```bash
stripe events list --limit 100 --type "invoice.payment_succeeded" --created "gte:1714000000"
# For each event ID:
stripe events resend evt_...
```

### Manual reconciliation (if event no longer in Stripe API window)
1. Use Stripe API to fetch current subscription state:
   ```bash
   stripe subscriptions retrieve sub_...
   ```
2. Compare with our `subscriptions` doc.
3. If divergent, manually patch via Super Admin endpoint:
   ```
   POST /v1/admin/subscriptions/:id/force-status
   { "status": "ACTIVE", "currentPeriodEnd": "2026-05-26T...", "reason": "stripe-webhook-replay-recon" }
   ```
4. Audit log captures the override.

## Idempotency check
After replay, verify no double-charge or double-state-change:
- `webhookEventsProcessed` should have exactly one row per `eventId`.
- `subscriptions.changeHistory[]` should not show duplicate transitions.

## Prevent future incidents
- Verify `webhookEventsProcessed` unique index intact (`db.webhookEventsProcessed.getIndexes()`).
- Check Stripe webhook endpoint health: `GET /v1/health/deep`.
- Confirm Sentry alert configured for `WEBHOOK_SIGNATURE_INVALID` rate.
