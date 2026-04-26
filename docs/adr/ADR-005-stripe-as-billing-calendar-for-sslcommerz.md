# ADR-005 — Stripe as billing calendar for SSLCommerz subscriptions

**Status:** Accepted

## Context
SSLCommerz is the only viable gateway for Bangladesh local payments (bKash, Nagad). It does NOT support native recurring billing — every payment is a fresh hosted-checkout session.

We need recurring monthly/annual billing for BDT customers without rebuilding period math, retries, dunning, etc.

## Decision
For every SSLCommerz subscription, we **also** create a Stripe `Subscription` with `collection_method: "send_invoice"` (no auto-charge). Stripe acts purely as a billing calendar:
- Stripe issues `invoice.created` events at each renewal date.
- Our handler converts these to "payment link" emails sent via SSLCommerz checkout.
- Customer pays via SSLCommerz IPN.
- We mark the Stripe invoice `paid_out_of_band: true`.
- Stripe schedules the next invoice. Loop continues.

## Rationale
- We don't reinvent: period math, retries, plan upgrades, prorations, dunning.
- Stripe Manage UI works for cancellations.
- Cost: Stripe charges $0.40/invoice for `send_invoice` mode — acceptable for BDT volume.
- Decouples scheduling (Stripe) from collection (SSLCommerz) cleanly.

## Consequences
- Two gateways involved per BDT customer; reconciliation cron `billing.invoices.pay` retries `paid_out_of_band` for 24h.
- See [runbooks/sslcommerz-desync.md](../runbooks/sslcommerz-desync.md) for failure scenarios.
- Documentation must explain to product engineers that "BDT subscription" actually has both gateway IDs.
