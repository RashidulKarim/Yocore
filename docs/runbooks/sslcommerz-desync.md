# Runbook — SSLCommerz Desync (paid but Stripe invoice not marked)

**Severity:** P1 (customer paid, system says unpaid)
**Trigger:**
- Customer email: "I paid via bKash but still see PAST_DUE"
- `yocore_sslcommerz_ipn_rejected_total{reason="amount_mismatch"}` rising
- Cron `billing.invoices.pay` failed > 24h

## Diagnosis

1. Get `tran_id` from customer email or SSLCommerz dashboard.
2. Check our records:
   ```js
   db.subscriptions.findOne({ "gatewayRefs.sslcommerzTranId": "TRAN_..." });
   db.webhookEventsProcessed.findOne({ provider: "sslcommerz", eventId: "TRAN_..." });
   ```
3. Validate against SSLCommerz Order Validation API:
   ```bash
   curl "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?val_id=...&store_id=...&store_passwd=..."
   ```
4. Check Stripe invoice status:
   ```bash
   stripe invoices retrieve in_...
   ```
   If `status: open`, it never got marked `paid_out_of_band`.

## Recovery

### If validation API confirms payment but Stripe invoice unpaid:
```bash
stripe invoices pay in_... --paid-out-of-band
```
Then update local subscription:
```
POST /v1/admin/subscriptions/:id/force-status
{ "status": "ACTIVE", "reason": "sslcommerz-desync-recovery", "metadata": { "tranId": "TRAN_..." } }
```

### If validation API says NOT validated:
- Customer fraud / failed payment that user thought succeeded. Reply with payment instructions.
- If gateway error on SSLCommerz side, escalate to SSLCommerz support with `tran_id`.

## Cron retry verification
- `billing.invoices.pay` cron runs hourly with idempotency key per `(subscriptionId, periodStart)`.
- Retry budget: 24h. After 24h failure → status flips to PAST_DUE + alert.
- Verify cron is running:
  ```js
  db.cronLocks.find({ jobName: "billing.invoices.pay" }).sort({ lockedAt: -1 }).limit(5);
  ```

## Prevent
- Monitor `yocore_sslcommerz_ipn_rejected_total{reason}` dashboard panel.
- Alert if `signature_mismatch > 5/h` (spoofing) or `amount_mismatch > 3/h` (config drift).
- Re-verify SSLCommerz credentials monthly via Super Admin → Gateways → Test connection.
