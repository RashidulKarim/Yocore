# Runbook — EasyStock Auth Cutover (Legacy → YoCore)

**Severity:** P1 (auth outage during cutover risks 100% login failure)
**Trigger:** Scheduled cutover from EasyStock-owned auth (bcrypt/JWT/speakeasy) to
YoCore-owned auth (argon2id/JWT-via-jose/YoCore MFA). Phase 3.5 of
[easystock-yocore-integration.md](../easystock-yocore-integration.md).
**Estimated duration:** 30–60 minutes (excluding the user re-enrol window).
**Reversible:** Yes, until users start setting new passwords. After that, the bcrypt hashes are stale — full rollback means data-loss for new sign-ups + a second password-reset round.

---

## 0. One week before — comms + readiness

- [ ] Send in-app banner + email to all active users: "On `<DATE>` you will receive a one-time email to set a new password. Existing 2FA setups will need to be re-enrolled." (Decision 5 + Decision 4.)
- [ ] Verify YoCore prerequisites are green:
  - `GET /v1/admin/products/<easystock-product-id>` returns the registered product.
  - `GET /v1/admin/products/<id>/roles` lists `admin`, `manager`, `staff`, `viewer` (run `pnpm tsx scripts/sync-yocore-roles.ts` if missing).
  - YoCore has shipped `GET /.well-known/jwks.json` (jwks.service.ts depends on it).
  - The platform operator has a SUPER_ADMIN bearer token ready.
- [ ] On staging, do a full dry-run of every step below; capture timings.
- [ ] Schedule the cutover for low-traffic window. Freeze all other deploys.

---

## 1. T-30 min — pre-flight (read-only)

```bash
cd easystock-backend

# Confirm Mongo connectivity + count rows the migration will touch.
pnpm tsx scripts/audit-duplicate-emails.ts                        # exit 0 expected
pnpm tsx scripts/migrate-users-to-yocore.ts --dry-run | tee /tmp/users-dry.log
pnpm tsx scripts/migrate-super-admins.ts  --dry-run | tee /tmp/sa-dry.log
```

Verify in the dry-run output:
- [ ] No `ERROR` rows.
- [ ] All `super_admin` rows show **plan: provision + workspace-role + local-role**.
- [ ] Skipped rows due to "no `yocoreWorkspaceId`" are an acceptable count (those orgs were never linked → backfill or accept that they will not migrate this round).

Required env (set in the shell where you'll run the apply step):

```bash
export MONGODB_URI=...                       # EasyStock prod URI
export YOCORE_API_BASE_URL=https://api.yocore.com
export YOCORE_API_KEY_ID=...                 # EasyStock product key
export YOCORE_API_KEY_SECRET=...
export YOCORE_PRODUCT_ID=prd_easystock
export YOCORE_SUPER_ADMIN_TOKEN=...          # short-lived; rotate after cutover
```

---

## 2. T-0 — apply migrations

> ⚠️ Order matters: super-admins first (small set, easier to verify), then bulk users.

```bash
# 1. Promote super-admins.
pnpm tsx scripts/migrate-super-admins.ts | tee /tmp/sa-apply.log

# 2. Big-bang user provision.
pnpm tsx scripts/migrate-users-to-yocore.ts | tee /tmp/users-apply.log
```

Both scripts are resumable; if either errors out partway, re-run — already-migrated rows are skipped via `User.yocoreUserId`.

After each run, confirm:
- [ ] `errors: 0` in the summary block.
- [ ] The "OUT-OF-BAND" list at the bottom of `sa-apply.log` is non-empty if you had `super_admin` users.

---

## 3. T+5 min — out-of-band: promote globals to SUPER_ADMIN

For each `(email, yocoreUserId)` pair printed by `migrate-super-admins.ts`:

- Option A — via the YoCore admin web app: log in, "Users" → search → "Promote to SUPER_ADMIN".
- Option B — via the bootstrap script:
  ```bash
  cd Yocore
  pnpm tsx scripts/bootstrap-superadmin.ts --user-id <yocoreUserId>
  ```

Verify with `GET /v1/admin/users/<id>` that `role === "SUPER_ADMIN"`.

---

## 4. T+10 min — flip env on backend (canary first)

On a single API instance:

```bash
# Edit env (Render / k8s / pm2 — whichever deploy target you use):
AUTH_PROVIDER=yocore
```

Restart that one instance. Smoke-test from a curl runner:

```bash
# Login should now return either signed_in or requiresWorkspaceSelection.
curl -X POST https://api.easystock.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<test-user>","password":"<the-new-password>"}'

# Authenticated request should work.
curl https://api.easystock.com/api/profile -H "Authorization: Bearer $TOKEN"

# Refresh should rotate the token.
curl -X POST https://api.easystock.com/api/auth/refresh \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}"
```

If smoke-test passes:

```bash
# Promote AUTH_PROVIDER=yocore on all backend instances.
```

If anything fails — see §7 (rollback).

---

## 5. T+20 min — frontend cutover

Both env values must be set together (they are independent processes but a logically single release):

```bash
# easystock-frontend env (build-time):
NEXT_PUBLIC_AUTH_PROVIDER=yocore
```

Trigger the FE build + deploy. After deploy:

- [ ] Login page no longer renders the `Organization Slug` field.
- [ ] A user with multiple workspaces sees the workspace picker after entering credentials.
- [ ] A user with one workspace lands directly on `/dashboard`.

---

## 6. T+30 min — post-cutover monitoring (first hour)

Watch the following metrics; fail early if any spike:

| Metric | Healthy | Alarm |
|---|---|---|
| `POST /api/auth/login` 5xx rate | <0.1% | >1% |
| `POST /api/auth/refresh` 5xx rate | <0.1% | >1% |
| `auth:session:*` Redis key count | grows linearly with logins | drops to 0 (Redis disconnected) |
| YoCore `provisionProductUser` 5xx | n/a (script done) | any |
| Sentry: `YocoreApiError` | <5/min | >50/min |

Communications:
- [ ] Post in #engineering: "Auth cutover complete. Monitoring for 1h."
- [ ] Reply in support inbox to any "I can't log in" tickets — direct users to check their email for the password-reset link.
- [ ] Re-send the reset email (via YoCore admin web app) to any user reporting a missing link.

---

## 7. Rollback

You CAN safely roll back any time before users start setting new YoCore passwords. Once a user successfully resets, that account exists only on YoCore — rolling back means they cannot log in until you either roll forward or manually re-enable bcrypt for them.

```bash
# 1. Backend: revert AUTH_PROVIDER to legacy on every instance and restart.
AUTH_PROVIDER=legacy

# 2. Frontend: redeploy with NEXT_PUBLIC_AUTH_PROVIDER=legacy (or unset).

# 3. Optional — clear Redis sessions written under YoCore mode (they have a different shape, harmless to keep but cleaner gone):
redis-cli --scan --pattern 'auth:session:*' | xargs -r redis-cli DEL
```

You do NOT need to undo the Mongo-side changes:
- `User.yocoreUserId` / `yocoreProductUserId` are dormant on the legacy path.
- `User.role` for ex-super-admins stays `admin` (legacy still understands `admin`).
- `Organization.yocoreWorkspaceId` is dormant.

What you DO need to communicate after rollback:
- "Please use your previous EasyStock password — the password-reset link you received was issued in error and is now invalid."

---

## 8. T+24h — sign-off

- [ ] Login p95 latency within 10% of baseline.
- [ ] Zero unresolved auth tickets older than 4h.
- [ ] All `super_admin` users confirmed they can sign in and reach the YoCore admin web app.
- [ ] Schedule Phase 3.6 cleanup ticket: remove bcrypt, speakeasy, legacy auth fields, `ROLE_PERMISSIONS["super_admin"]`, and the `legacy` branch in `auth.controller.ts` / `profile.controller.ts`.
- [ ] Rotate `YOCORE_SUPER_ADMIN_TOKEN` (it had broad scope during the migration window).

---

## Appendix — known gotchas

- **Skipped users in the migration log.** Users in orgs without a `yocoreWorkspaceId` are skipped. If you later link the org (via the `workspace.created` webhook handler), re-run `migrate-users-to-yocore.ts` to provision them. They simply receive their reset email later.
- **Workspace 404 on `migrate-super-admins.ts`.** The role-change call assumes the user is already a member of the YoCore workspace. For new YoCore users this isn't the case yet — invite them via the YoCore admin web app, then re-run the script (idempotent).
- **MFA re-enrolment.** Local `User.twoFactorEnabled === true` does not carry over. Users get prompted to re-enrol the first time they hit a YoCore MFA-required flow. The post-cutover banner is deferred to Phase 3.6 — for now, document it in the cutover comms email.
- **Top-bar workspace switcher.** Mid-session switching is also Phase 3.6. Until then, users with multiple workspaces must log out and re-log to switch.
