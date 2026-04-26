# Runbook — Super Admin IP Allowlist Lockout

**Severity:** P0 (no admin access to platform)
**Trigger:** All Super Admin requests return `403 IP_NOT_ALLOWLISTED` after editing `superAdminConfig.adminIpAllowlist`
**Page:** SRE on-call + Engineering Manager
**Owner:** Platform team

## Recovery options (try in order)

### Option 1 — Emergency bypass env var (preferred)
1. SSH into deployment platform's secrets store (AWS Secrets Manager).
2. Set `SUPER_ADMIN_IP_ALLOWLIST_BYPASS=true` in the API task secrets.
3. Trigger ECS service redeploy (`aws ecs update-service --force-new-deployment`).
4. Wait ≤2 min for new tasks to come up.
5. Log in via Super Admin UI — bypass mode skips IP check (but logs each request to `auditLogs` with action `auth.ip_allowlist.bypassed`).
6. Fix the allowlist via `PATCH /v1/admin/super-admin/config`.
7. **Set `SUPER_ADMIN_IP_ALLOWLIST_BYPASS=false`** + redeploy.
8. Verify bypass disabled (try from non-allowlisted IP → should 403).

### Option 2 — Bastion direct DB write (if Secrets Manager access blocked)
1. Connect to bastion host with engineering production access.
2. Authenticate to MongoDB Atlas using break-glass account (stored in 1Password "yocore-mongo-break-glass").
3. Run:
   ```js
   db.superAdminConfig.updateOne(
     { _id: "singleton" },
     { $set: { adminIpAllowlist: [], updatedAt: new Date(), updatedBy: "ops:break-glass" } }
   );
   ```
4. Wait 5 min for `cache:superadmin:config` (Redis) TTL or run `redis-cli DEL cache:superadmin:config`.
5. Verify Super Admin can log in.
6. File post-mortem.

### Option 3 — Redeploy with allowlist disabled (last resort)
1. Set env `SUPER_ADMIN_IP_ALLOWLIST_DISABLED=true`.
2. Redeploy.
3. After regaining access, fix config + remove env + redeploy.

## Post-incident

- Audit log: filter `action: auth.ip_allowlist.bypassed` to confirm only authorized engineers used bypass.
- Update [docs/runbooks/](.) with any procedural changes.
- Schedule retro within 5 business days.
- Verify all 3 recovery paths still work in staging quarterly.
