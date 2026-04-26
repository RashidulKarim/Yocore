# Runbook — Disaster Recovery (Mongo / Redis / Region)

**Severity:** P0 (full or partial platform outage)
**RTO target:** < 1 hour
**RPO target:** < 5 minutes (Mongo PITR)

## Scenarios

### Scenario 1: MongoDB Atlas primary failure
- **Detection:** ALB health check fails; CloudWatch alarm `yocore_db_connection_errors`.
- **Action:** Atlas auto-failover to secondary (typically <30s). No manual action required.
- **Verify:** `GET /v1/health/deep` returns OK once new primary elected.

### Scenario 2: All Atlas nodes lost (region failure)
1. Atlas point-in-time restore to new cluster in fallback region (eu-west-1):
   - Atlas UI → Backup → Restore → choose timestamp closest to incident.
2. Update Secrets Manager `yocore/prod/mongodb` with new connection URI.
3. Trigger ECS redeploy.
4. Validate: smoke test `/v1/health/deep` + spot-check 5 random subscriptions for state.

### Scenario 3: Redis (Upstash) outage
- **Behavior:** API still functions (degraded). Effects:
  - Permission cache miss → re-resolve from Mongo (slower)
  - Idempotency cache miss → falls back to Mongo `idempotencyKeys` collection
  - JWT blocklist miss → falls back to Mongo `sessions.revokedAt` (per addendum #9)
  - Rate limits less accurate (in-memory fallback per pod)
- **Action:** Wait for Upstash recovery; no manual action needed.
- **If extended (>30 min):** Provision new Redis cluster manually, update Secrets Manager, redeploy.

### Scenario 4: ECS region (us-east-1) failure
1. Deploy stack to fallback region (us-west-2) using IaC (Terraform/Pulumi state tagged `dr`):
   ```bash
   cd infra/dr && terraform apply -var region=us-west-2
   ```
2. Restore Mongo from latest snapshot (already replicated cross-region).
3. Update Cloudflare DNS to point to new ALB.
4. TTL was 60s → propagation < 5 min.
5. Validate via end-to-end smoke test.

### Scenario 5: S3 bucket loss / corruption
- Audit logs replicated to eu-west-1: re-sync.
- Webhook payloads have 90d TTL anyway; loss acceptable.
- Exports re-runnable on demand.

## Restore validation checklist (post-DR)

- [ ] `GET /v1/health/deep` 200
- [ ] Super Admin can log in with MFA
- [ ] Demo product API key works
- [ ] Stripe test webhook deliverable + idempotent
- [ ] Cron `billing.grace.tick` executed within last hour
- [ ] All 23+ collections have expected indexes (`scripts/audit-indexes.ts`)
- [ ] `auditLogs` chain integrity intact for last 24h

## Quarterly DR drill
- Restore Mongo snapshot to staging
- Run E2E suite against restored data
- Document time-to-recovery
- Update this runbook with deltas
