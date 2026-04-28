# YoCore — User Manual

**Version:** 1.1  
**Last updated:** April 28, 2026

---

## Table of Contents

1. [What Is YoCore?](#1-what-is-yocore)
2. [System Overview](#2-system-overview)
3. [Getting Started — Local Setup](#3-getting-started--local-setup)
4. [Super Admin Dashboard (admin-web)](#4-super-admin-dashboard-admin-web)
   - 4.1 Login & MFA
   - 4.2 Dashboard (Cron Status)
   - 4.3 Products List
   - 4.4 Product Detail
   - 4.5 Billing Plans
   - 4.6 Subscriptions — Force Status & Apply Credit
   - 4.7 Webhook Deliveries
   - 4.8 ToS / Privacy Publishing
   - 4.9 Super Admin Settings
5. [Hosted Auth UI (auth-web)](#5-hosted-auth-ui-auth-web)
   - 5.1 Signup
   - 5.2 Login
   - 5.3 MFA Challenge
   - 5.4 Forgot / Reset Password
   - 5.5 Email Verification
   - 5.6 PKCE / Authorize Flow
   - 5.7 Direct API Sign-in (no auth-web)
6. [REST API Reference](#6-rest-api-reference)
   - 6.1 Health
   - 6.2 Authentication
   - 6.3 MFA
   - 6.4 Workspaces & Members
   - 6.5 Invitations & Permissions
   - 6.6 Billing — Checkout & Subscriptions
   - 6.7 Billing — Plans (public)
   - 6.8 Billing — Invoices & Tax
   - 6.9 Bundles
   - 6.10 Webhooks (inbound)
   - 6.11 Admin — Products & Gateways
   - 6.12 Admin — Plans & Coupons
   - 6.13 Admin — Bundles
   - 6.14 Admin — Operations & Security
   - 6.15 Self-service (Me / Sessions)
7. [SDK Usage](#7-sdk-usage)
8. [Common End-to-End Workflows](#8-common-end-to-end-workflows)
9. [Security Operations](#9-security-operations)
10. [Troubleshooting](#10-troubleshooting)
11. [API Error Code Reference](#11-api-error-code-reference)

---

## 1. What Is YoCore?

YoCore is a **centralized SaaS backend** for all Yo products. It provides:

- **Authentication** — signup, signin, password reset, email verification, MFA (TOTP)
- **Multi-tenancy** — every user/workspace/subscription is scoped to a `productId`; data never leaks across products
- **Workspaces & Teams** — OWNER / ADMIN / MEMBER / VIEWER roles, invitations, transfers
- **Billing** — Stripe and SSLCommerz checkout, plan management, trials, upgrades, refunds, coupons
- **Bundle Packages** — cross-product subscription bundles at a discount
- **Super Admin Console** — single god-mode dashboard to manage all products

End users **never interact with YoCore directly**. They interact with a Yo product (e.g. YoPM), which calls YoCore APIs behind the scenes.

---

## 2. System Overview

```
┌─────────────────────────────────────────┐
│         Super Admin (you)               │
│  admin-web  http://localhost:5173        │
└───────────────────┬─────────────────────┘
                    │ HTTPS / JWT
┌───────────────────▼─────────────────────┐
│      YoCore API   http://localhost:3000  │
│        Express 4 · MongoDB 7 · Redis 7  │
└──────┬──────────────────┬───────────────┘
       │                  │
┌──────▼──────┐   ┌───────▼────────┐   ┌──────────────────┐
│  auth-web   │   │  Yo Products   │   │  demo-yopm       │
│  :5174      │   │  (via SDK /    │   │  :5175           │
│  PKCE / MFA │   │   API key)     │   │  dev test bench  │
└─────────────┘   └────────────────┘   └──────────────────┘
```

| App | URL (local) | Who uses it |
|---|---|---|
| `apps/api` | `http://localhost:3000` | All clients via REST |
| `apps/admin-web` | `http://localhost:5173` | Super Admin only |
| `apps/auth-web` | `http://localhost:5174` | End users (hosted login/signup via PKCE) |
| `apps/demo-yopm` | `http://localhost:5175` | Developers — full-feature test playground |
| Mailhog | `http://localhost:8025` | View dev emails |
| MinIO | `http://localhost:9001` | View dev S3 objects |

---

## 3. Getting Started — Local Setup

### Prerequisites

| Tool | Required version |
|---|---|
| Node.js | 20.11.0 (`.nvmrc`) |
| pnpm | 9.12.0 |
| Docker Desktop | latest |

### Step-by-step

```bash
# 1. Install dependencies
nvm use
pnpm install

# 2. Start infrastructure (Mongo replica set, Redis, Mailhog, MinIO)
docker compose up -d
# Wait ~10 seconds, then verify Mongo replica set:
mongosh "mongodb://localhost:27017/?replicaSet=rs0" --eval "rs.status().ok"

# 3. Configure environment
cp .env.example .env
# Edit .env — at minimum set:
#   YOCORE_KMS_KEY  →  openssl rand -hex 32
#   BOOTSTRAP_SECRET →  openssl rand -hex 64

# 4. Build types package first (other packages depend on it)
pnpm turbo run build --filter=@yocore/types

# 5. Seed demo data (creates a sample product + plans)
pnpm tsx scripts/seed-dev.ts

# 6. Create the first Super Admin account
pnpm tsx scripts/bootstrap-superadmin.ts \
  --email admin@yocore.test \
  --password 'AdminP@ssw0rd!'

# 7. Start all apps in watch mode
pnpm dev

# 8. (Optional) Start the demo-yopm test playground
#    See apps/demo-yopm/README.md for required env vars
set -a; source apps/demo-yopm/.env; set +a
pnpm --filter @yocore/demo-yopm dev
# → open http://localhost:5175
```

### Verify everything is working

```bash
curl http://localhost:3000/v1/health
# → {"status":"ok"}

curl http://localhost:3000/v1/health/deep
# → {"status":"ok","checks":{"mongo":"ok","redis":"ok","s3":"ok"}}
```

Open `http://localhost:5173` → you should see the Admin login page.

### Stripe webhooks (local testing)

```bash
# Install Stripe CLI: https://stripe.com/docs/stripe-cli
stripe login
stripe listen --forward-to localhost:3000/v1/webhooks/stripe
# Copy the printed whsec_... and save it in Admin → Product → Gateway config
```

---

## 4. Super Admin Dashboard (admin-web)

The admin dashboard lives at **`http://localhost:5173`** (production: your deployed Vercel URL).

### 4.1 Login & MFA

1. Navigate to `http://localhost:5173`.
2. Enter your Super Admin **email** and **password**.
3. If MFA is enrolled, enter the 6-digit TOTP code from your authenticator app.
4. On first login after bootstrap you will be prompted to **enrol MFA** — this is mandatory for Super Admin accounts.

**MFA enrollment:**
- Click **Set up MFA** on the prompt screen.
- Scan the QR code with Google Authenticator / Authy / 1Password.
- Enter the 6-digit code to confirm enrollment.
- **Save the 10 recovery codes** shown after enrollment. Each code can be used once if you lose your device.

---

### 4.2 Dashboard — Cron Status

**URL:** `/` (home screen)

Shows a table of all scheduled cron jobs and their last-run state:

| Column | Meaning |
|---|---|
| Job | Internal job name (e.g. `billing.trial.tick`) |
| Date key | The execution slot (hourly or daily) |
| Locked at | When the job acquired its distributed lock |
| Completed at | When the job finished |
| Error | Last error message, if any |

**Active cron jobs:**

| Job name | Schedule | What it does |
|---|---|---|
| `billing.trial.tick` | Every hour | Expires trials, sends 3-day / 1-day warning emails |
| `billing.grace.tick` | Every hour | Failed-payment grace period emails + cancellation (D+1, D+5, D+7) |
| `bundle.cancel.cascade` | Daily | Cancels child subscriptions when a bundle parent is canceled |
| `jwt.key.retire` | Daily | Retires old JWT signing keys after rotation |
| `gdpr.deletion.tick` | Daily | Hard-deletes accounts after 30-day grace period |

**Force-run a job manually:**

> Only `webhook.delivery.tick`, `jwt.key.retire`, and `gdpr.deletion.tick` can be force-run. Billing/bundle ticks run on the Agenda schedule and cannot be manually triggered.

```bash
curl -X POST http://localhost:3000/v1/admin/cron/run \
  -H "Authorization: Bearer <SUPER_ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"jobName":"webhook.delivery.tick"}'
```

---

### 4.3 Products List

**URL:** `/products`

Lists all registered products. Each row shows:
- Product name & slug
- Status badge (INACTIVE / ACTIVE / SUSPENDED)
- Creation date
- Link to Product Detail

**Create a new product:**
1. Click **New product**.
2. Fill in **Name** (display name) and **Slug** (URL-safe, e.g. `yopm`).
3. Choose **Billing scope**: `user` or `workspace`.
4. Click **Create**.

The product starts as `INACTIVE`. You must activate it before users can sign up.

---

### 4.4 Product Detail

**URL:** `/products/:id`

This screen is the control center for a single product.

#### Identifiers section
| Field | Description |
|---|---|
| Product ID | Internal MongoDB ID (use in API calls as `productId`) |
| API Key | Public key (`yc_live_pk_...`) — embed in your product's environment |
| Slug | URL segment used for signup / login |

#### Status management
Use the **Activate / Suspend / Deactivate** buttons to change product status:

| Status | Effect |
|---|---|
| `INACTIVE` | Blocks new signups; existing users can still sign in |
| `ACTIVE` | Normal operation |
| `SUSPENDED` | Blocks all user activity for this product |

**Via API (POST):**
```bash
curl -X POST http://localhost:3000/v1/admin/products/<id>/status \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"status":"ACTIVE"}'
```

#### Secret rotation
- **Rotate API Secret** — generates a new `apiSecret`. The old secret is immediately invalidated. **Copy and save the new secret** — it is never shown again.
- **Rotate Webhook Secret** — generates a new HMAC signing secret. The old secret remains valid for **24 hours** (grace period) to allow rolling updates on your receiving endpoint.

#### Billing config
Set defaults for the product's billing behavior:
- **Grace period days** (default: 7) — how many days after failed payment before subscription cancels
- **Trial default days** — default trial length when no plan-specific override is set

#### Payment gateways
Click **Add gateway** to configure Stripe or SSLCommerz:

**Stripe:**
```
Provider:       stripe
Mode:           live | test
Secret key:     sk_live_...  (or sk_test_...)
Webhook secret: whsec_...
```

> Stripe **publishable keys** are not stored in YoCore — they are public and live in your product's frontend env. YoCore only needs the secret key (server-side API calls) and the webhook secret (HMAC verification).

**SSLCommerz:**
```
Provider:   sslcommerz
Mode:       live | test
Store ID:   <your-store-id>
Store pass: <your-store-pass>
```

After saving, YoCore verifies the credentials with the provider's API. If verification fails, the gateway is **not saved** — fix the credentials and retry.

---

### 4.5 Billing Plans

**URL:** `/plans`

Create and manage subscription plans for any product.

#### Create a plan
1. Select a product from the dropdown.
2. Click **New plan**.
3. Fill in the fields:

| Field | Required | Notes |
|---|---|---|
| Name | ✓ | Display name (e.g. "Pro Monthly") |
| Slug | ✓ | URL-safe, min 2 chars (e.g. `pro-monthly`) |
| Free plan | — | Toggle on for $0 plans |
| Amount | ✓ (paid) | **Enter in major units** (e.g. `19.99` = $19.99). The form converts to minor units (cents) for the API. The API stores `1999`. |
| Currency | ✓ | `usd`, `eur`, `gbp`, `bdt`, `inr`, `sgd` |
| Interval | ✓ | `month`, `year`, `one_time` |
| Trial days | — | 0 = no trial |
| Per-seat billing | — | Toggle on for seat-based billing (extra fields appear) |
| Per-seat amount | ✓ (if seat) | Cost per additional seat (major units) |
| Included seats | — | How many seats are included before per-seat billing kicks in |
| Max members | — | -1 = unlimited; leave blank to inherit defaults |

4. Click **Create** — plan is saved as `DRAFT`.

#### Publish a plan
A plan must be `ACTIVE` before users can check out.

1. Click **Publish** on a draft plan (button only appears when status = `DRAFT`).
2. YoCore syncs the plan to Stripe (creates a Price object) if a live Stripe gateway is configured.
3. Status changes to `ACTIVE`.

> **Important:** Once a plan is `ACTIVE`, you cannot change its `amount`, `currency`, `interval`, or `slug`. The Edit form will disable those fields. You can still change the name, description, trial days, seat config, and limits.

#### Edit a plan
- **DRAFT** plans: click **Edit** to change any field.
- **ACTIVE** plans: click **Edit** to change name / trial / seats / limits only. Price/currency/interval are locked.
- **ARCHIVED** plans: cannot be edited.

#### Archive a plan
1. Click **Archive** on an active plan (button only appears when status = `ACTIVE`).
2. The plan is hidden from public listings.
3. Existing subscribers remain on the plan (grandfathered) until they explicitly change plans.

---

### 4.6 Subscriptions — Force Status & Apply Credit

Use these endpoints for customer support operations.

**Force subscription to a status** (e.g. re-activate a canceled subscription):
```bash
curl -X POST http://localhost:3000/v1/admin/products/<productId>/subscriptions/<subId>/force-status \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"status":"ACTIVE","reason":"Customer support override"}'
```

**Apply a credit to a subscription** (reduces next charge):
```bash
curl -X POST http://localhost:3000/v1/admin/products/<productId>/subscriptions/<subId>/apply-credit \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"amountMinorUnits":500,"currency":"usd","reason":"Compensation"}'
```

---

### 4.7 Webhook Deliveries

**URL:** `/webhook-deliveries`

Monitor all outbound webhook events sent to your products.

| Column | Meaning |
|---|---|
| Event | Event type (e.g. `subscription.activated`) |
| Status | `PENDING` / `DELIVERED` / `FAILED` / `DEAD` |
| Attempts | How many delivery attempts were made |
| Next attempt | Next scheduled retry (exponential backoff: 30s → 5m → 30m → 2h → 6h) |
| Last error | HTTP error or connection error from last attempt |

**Retry a dead delivery:**
Click the **Retry** button next to any failed or dead delivery. YoCore immediately re-queues it.

**Retry via API:**
```bash
curl -X POST http://localhost:3000/v1/admin/webhook-deliveries/<id>/retry \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <uuid>"
```

**Retry behavior:** max 5 attempts total. After 5 failures, status becomes `DEAD`. Manual retry resets the counter.

---

### 4.8 ToS / Privacy Publishing

**URL:** `/tos`

Manage Terms of Service and Privacy Policy versions. Users are gated at signup/onboarding until they accept the current version.

**Publish a new version:**
1. Fill in **Version** (e.g. `1.0`), **Content URL**, **Content hash** (SHA-256 of the document), and **Effective at** date.
2. Select **Type**: `terms_of_service` or `privacy_policy`.
3. Click **Publish**.

The current published version is automatically served at `GET /v1/tos/current`.

> Users who signed up before a new version will be prompted to accept it on their next login.

---

### 4.9 Super Admin Settings

**URL:** `/settings`

#### IP Allowlist
Restrict Super Admin console access to specific IP addresses.

1. Enter one IP per line (supports CIDR notation, e.g. `192.168.1.0/24`).
2. Toggle **Enable IP allowlist**.
3. Click **Save**.

> **Emergency bypass:** If you lock yourself out, restart the API with `SUPER_ADMIN_IP_ALLOWLIST_BYPASS=true` in your environment. See `docs/runbooks/ip-allowlist-recovery.md`.

#### JWT Key Rotation
Rotate the signing key used for all JWTs.

1. Click **Rotate JWT signing key**.
2. The new key becomes active immediately.
3. Old keys remain valid for **7 days** (keyring keeps the last 3 keys) so existing tokens are not invalidated immediately.

> All new JWTs are signed with the new key. Existing access tokens (15-minute TTL) will naturally expire. Refresh tokens use the old key until rotated by the client.

---

## 5. Hosted Auth UI (auth-web)

The auth UI lives at **`http://localhost:5174`** (production: your Vercel URL). Your products embed it via PKCE redirect or an iframe.

### 5.1 Signup

**URL:** `http://localhost:5174/signup?product=<slug>`

Users fill in:
- Full name
- Email
- Password (min 12 chars; must contain uppercase, lowercase, digit, and symbol)
- Marketing opt-in (optional)

After submitting:
1. A verification email is sent to the provided address.
2. The page shows "Check your email".
3. Constant-time response — the page always shows the same message whether the email exists or not (prevents email enumeration).

### 5.2 Login

**URL:** `http://localhost:5174/login?product=<slug>`

Users enter email + password. On success:
- If **no MFA**: tokens are issued, redirected to `/callback`.
- If **MFA enrolled**: redirected to `/mfa` challenge page.

### 5.3 MFA Challenge

**URL:** `http://localhost:5174/mfa`

Users enter the 6-digit TOTP code from their authenticator app, or one of their 10 recovery codes.

> Recovery codes are one-use. After use, regenerate them from your account security settings.

### 5.4 Forgot / Reset Password

**Forgot password URL:** `http://localhost:5174/forgot-password?product=<slug>`

1. Enter email → YoCore sends a reset link (valid for 1 hour).
2. Follow the link → `http://localhost:5174/reset-password?token=<token>`.
3. Enter a new password (same complexity rules as signup).
4. All existing sessions are revoked on successful reset.

### 5.5 Email Verification

After signup, the user receives an email with a link:
```
http://localhost:5174/verify-email?token=<token>
```
Clicking the link:
- Marks the email as verified
- Auto-signs the user in (issues tokens)
- Redirects to `/callback` to complete any pending PKCE flow

If the link is expired (>24 hours): shows an error with a "Resend verification" option.  
If clicked again after already verified: silently re-issues tokens (idempotent).

### 5.7 Direct API Sign-in (no auth-web)

Products that implement their own login UI (rather than delegating to auth-web) can call the signin endpoint directly — no PKCE redirect required.

```json
POST /v1/auth/signin
{
  "email": "user@example.com",
  "password": "SecureP@ssw0rd!",
  "productSlug": "yopm",
  "rememberMe": true
}
```

- If MFA is **not enrolled**: response is `{"status":"signed_in", "tokens":{...}}` — store the tokens and continue.
- If MFA is **enrolled**: response is `{"status":"mfa_required", "mfaChallengeId":"chal_..."}` — show a TOTP input, then re-submit the same endpoint with `mfaChallengeId` + `mfaCode` added to the body.

This pattern is used by `apps/demo-yopm` (see [apps/demo-yopm/README.md](../apps/demo-yopm/README.md)) and by any Yo product that hosts its own login screen.

> **Security note:** The API response is always `AUTH_INVALID_CREDENTIALS` on failure regardless of whether the email exists or the password is wrong — email enumeration is prevented by design.

---

### 5.6 PKCE / Authorize Flow

Your product initiates the hosted auth flow by redirecting the user to:

```
http://localhost:5174/authorize
  ?client_id=<apiKey>
  &redirect_uri=<your-app-callback>
  &code_challenge=<S256-hash>
  &code_challenge_method=S256
  &state=<random-state>
  &product=<slug>
```

After the user logs in, auth-web redirects back to your `redirect_uri` with:
```
https://your-app.com/callback?code=<authorization_code>&state=<state>
```

Your server then exchanges the code:
```bash
POST /v1/auth/pkce/exchange
Content-Type: application/json

{
  "code": "<authorization_code>",
  "codeVerifier": "<original-verifier>",
  "redirectUri": "<same-redirect-uri>"
}
```

Response:
```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresIn": 900
}
```

The `@yocore/sdk` `YoCoreClient` handles all of this automatically — see [Section 7](#7-sdk-usage).

---

## 6. REST API Reference

All endpoints are prefixed with `/v1`. The API runs on port `3000`.

### Authentication

Protected endpoints require:
```
Authorization: Bearer <accessToken>
```

Mutating billing endpoints also require:
```
Idempotency-Key: <uuid-v4>
```

### Response format

**Success:**
```json
{ "field": "value" }
```

**Error:**
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "correlationId": "01H..."
}
```

---

### 6.1 Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/health` | None | Liveness probe |
| GET | `/v1/health/ready` | None | Readiness probe |
| GET | `/v1/health/deep` | None | Full check (Mongo + Redis + S3) |

---

### 6.2 Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/auth/signup` | None | Register new user for a product |
| GET | `/v1/auth/verify-email` | None | Consume email verification token (`?token=`) |
| POST | `/v1/auth/signin` | None | Sign in, get tokens or MFA challenge |
| POST | `/v1/auth/refresh` | None | Rotate refresh token, get new access token |
| POST | `/v1/auth/logout` | JWT | Revoke current session |
| POST | `/v1/auth/forgot-password` | None | Request password reset email |
| POST | `/v1/auth/reset-password` | None | Set new password from reset token |
| GET | `/v1/auth/confirm-join` | None | Accept cross-product join invitation (`?token=`) |
| POST | `/v1/auth/finalize-onboarding` | JWT | Complete onboarding, create first workspace |
| POST | `/v1/auth/email/change-request` | JWT | Request email change (sends verify to new address) |
| GET | `/v1/auth/email/change-confirm` | None | Confirm new email (`?token=`) |
| GET | `/v1/users/me/email-preferences` | JWT | Get email notification preferences |
| PATCH | `/v1/users/me/email-preferences` | JWT | Update email preferences |
| POST | `/v1/email/unsubscribe` | None | Unsubscribe via signed token (RFC 8058) |
| GET | `/v1/email/unsubscribe` | None | Same, via query param |
| POST | `/v1/auth/pkce/issue` | JWT | Issue PKCE authorization code (used by auth-web) |
| POST | `/v1/auth/pkce/exchange` | None | Exchange code for tokens (S256 verified) |

**Signup request:**
```json
{
  "email": "user@example.com",
  "password": "SecureP@ssw0rd!",
  "name": "Jane Smith",
  "productSlug": "yopm",
  "marketingOptIn": false
}
```

**Signin request:**
```json
{
  "email": "user@example.com",
  "password": "SecureP@ssw0rd!",
  "productSlug": "yopm",
  "rememberMe": true
}
```

**Signin response (no MFA):**
```json
{
  "status": "signed_in",
  "tokens": {
    "accessToken": "eyJ...",
    "refreshToken": "...",
    "expiresIn": 900
  }
}
```

**Signin response (MFA required):**
```json
{
  "status": "mfa_required",
  "mfaChallengeId": "chal_01H..."
}
```

Submit the TOTP code to complete signin:
```json
POST /v1/auth/signin
{
  "email": "user@example.com",
  "password": "SecureP@ssw0rd!",
  "productSlug": "yopm",
  "mfaChallengeId": "chal_01H...",
  "mfaCode": "123456"
}
```

---

### 6.3 MFA

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/auth/mfa/enrol` | JWT | Start TOTP enrollment (returns QR URI) |
| POST | `/v1/auth/mfa/enrol/verify` | JWT | Confirm enrollment with first TOTP code |
| GET | `/v1/auth/mfa/status` | JWT | Check if MFA is enrolled |
| POST | `/v1/auth/mfa/recovery-codes` | JWT | Regenerate 10 recovery codes |

**Enroll MFA:**
```bash
POST /v1/auth/mfa/enrol
→ { "totpUri": "otpauth://totp/YoCore:user@...", "enrolmentId": "..." }
```

Scan the `totpUri` with your authenticator app, then verify:
```bash
POST /v1/auth/mfa/enrol/verify
{ "enrolmentId": "...", "code": "123456" }
→ { "recoveryCodes": ["XXXXX-XXXXX", ...] }   // 10 codes — save these!
```

---

### 6.4 Workspaces & Members

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/workspaces` | JWT | Create a workspace |
| GET | `/v1/workspaces` | JWT | List workspaces you belong to |
| GET | `/v1/workspaces/:id` | JWT | Get workspace details |
| PATCH | `/v1/workspaces/:id` | JWT | Update workspace name/settings |
| DELETE | `/v1/workspaces/:id` | JWT | Soft-delete (30-day grace period) |
| POST | `/v1/workspaces/:id/restore` | JWT | Cancel deletion within grace period |
| POST | `/v1/workspaces/:id/transfer-ownership` | JWT | Transfer OWNER role (requires re-auth) |
| POST | `/v1/auth/switch-workspace` | JWT | Switch active workspace (reissues JWT with new `wid` claim) |
| GET | `/v1/workspaces/:id/members` | JWT | List workspace members |
| PATCH | `/v1/workspaces/:id/members/:userId` | JWT | Change member's role |
| DELETE | `/v1/workspaces/:id/members/:userId` | JWT | Remove a member |

**Workspace roles (in rank order):**

| Role | Rank | Capabilities |
|---|---|---|
| `OWNER` | 40 | Full control; required for billing and deletion |
| `ADMIN` | 30 | Manage members; can't transfer ownership |
| `MEMBER` | 20 | Standard access |
| `VIEWER` | 10 | Read-only |

---

### 6.5 Invitations & Permissions

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/workspaces/:id/invitations` | JWT (ADMIN+) | Create invitation (email + role) |
| GET | `/v1/workspaces/:id/invitations` | JWT | List pending invitations |
| DELETE | `/v1/workspaces/:id/invitations/:invId` | JWT (ADMIN+) | Revoke an invitation |
| GET | `/v1/invitations/preview` | None | Preview invite details (`?token=`) |
| POST | `/v1/invitations/accept` | JWT | Accept invitation (existing user) |
| POST | `/v1/invitations/accept-new` | None | Accept invitation + create new account |
| POST | `/v1/permissions/check` | JWT | Check if user has a specific permission |
| GET | `/v1/permissions/catalog` | JWT | List all available permissions & roles |

**Create invitation:**
```json
POST /v1/workspaces/<id>/invitations
{
  "email": "colleague@example.com",
  "roleSlug": "MEMBER"
}
```

Invitations expire in **72 hours**. You cannot invite someone as OWNER.

---

### 6.6 Billing — Checkout & Subscriptions

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/billing/checkout` | JWT + Idempotency-Key | Create Stripe checkout session |
| POST | `/v1/billing/trial/start` | JWT + Idempotency-Key | Start free trial |
| GET | `/v1/billing/subscription/change-plan/preview` | JWT | Preview proration for plan change |
| POST | `/v1/billing/subscription/change-plan` | JWT + Idempotency-Key | Apply plan upgrade/downgrade |
| POST | `/v1/billing/subscription/seats` | JWT + Idempotency-Key | Change seat count |
| POST | `/v1/billing/subscription/pause` | JWT + Idempotency-Key | Pause subscription (Stripe only) |
| POST | `/v1/billing/subscription/resume` | JWT + Idempotency-Key | Resume paused subscription |
| POST | `/v1/billing/subscription/migrate-gateway` | JWT + Idempotency-Key | Migrate from Stripe to SSLCommerz or vice versa |
| GET | `/v1/billing/coupons/validate` | JWT | Validate coupon code (`?code=&planId=`) |

**Start a Stripe checkout:**
```json
POST /v1/billing/checkout
Idempotency-Key: <uuid>
{
  "planId": "plan_01H...",
  "workspaceId": "ws_01H...",
  "quantity": 1,
  "successUrl": "https://yourapp.com/billing/success",
  "cancelUrl": "https://yourapp.com/billing"
}
→ { "checkoutUrl": "https://checkout.stripe.com/..." }
```

Redirect the user to `checkoutUrl`. After payment, Stripe calls `/v1/webhooks/stripe` and the subscription is activated automatically.

**Preview plan change proration:**
```
GET /v1/billing/subscription/change-plan/preview
  ?newPlanId=plan_01H...
  &workspaceId=ws_01H...
```

---

### 6.7 Billing — Plans (public, no auth)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/products/:slug/plans` | None | List active plans for a product (cached 5 min) |
| GET | `/v1/tos/current` | None | Current ToS + Privacy Policy versions |

---

### 6.8 Billing — Invoices & Tax

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/billing/invoices` | JWT | List invoices for the current workspace |
| GET | `/v1/billing/tax-profile` | JWT | Get tax profile (VAT/GST number, address) |
| PUT | `/v1/billing/tax-profile` | JWT | Create or update tax profile |

---

### 6.9 Bundles

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/billing/bundle-checkout` | JWT + Idempotency-Key | Start bundle checkout |
| POST | `/v1/billing/bundles/:id/cancel` | JWT | Cancel bundle subscription |

**Bundle checkout:**
```json
POST /v1/billing/bundle-checkout
Idempotency-Key: <uuid>
{
  "bundleId": "bundle_01H...",
  "currencyVariantIndex": 0,
  "subjects": [
    { "productId": "prod_01H...", "type": "workspace", "workspaceId": "ws_01H..." }
  ],
  "successUrl": "https://yourapp.com/billing/success",
  "cancelUrl": "https://yourapp.com/billing"
}
```

---

### 6.10 Webhooks (inbound)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/webhooks/stripe` | HMAC signature | Stripe event receiver |
| POST | `/v1/webhooks/sslcommerz` | HMAC signature | SSLCommerz IPN receiver |

These are called by the payment gateways, not by your application.

---

### 6.11 Admin — Products & Gateways

> All admin endpoints require a **Super Admin JWT**.

| Method | Path | Description |
|---|---|---|
| POST | `/v1/admin/bootstrap` | One-time super admin bootstrap (requires `X-Bootstrap-Secret` header) |
| POST | `/v1/admin/products` | Create product |
| GET | `/v1/admin/products` | List all products |
| GET | `/v1/admin/products/:id` | Get product details |
| PATCH | `/v1/admin/products/:id` | Update product profile |
| POST | `/v1/admin/products/:id/status` | Change product status |
| POST | `/v1/admin/products/:id/rotate-api-secret` | Rotate API secret |
| POST | `/v1/admin/products/:id/rotate-webhook-secret` | Rotate outbound webhook signing secret |
| PATCH | `/v1/admin/products/:id/billing-config` | Update billing config (grace period, trial days) |
| POST | `/v1/admin/products/:id/gateways` | Add payment gateway |
| GET | `/v1/admin/products/:id/gateways` | List gateways |
| DELETE | `/v1/admin/products/:id/gateways/:gwId` | Remove gateway |

---

### 6.12 Admin — Plans & Coupons

| Method | Path | Description |
|---|---|---|
| POST | `/v1/admin/products/:id/plans` | Create plan |
| GET | `/v1/admin/products/:id/plans` | List plans (supports `?status=` filter) |
| GET | `/v1/admin/products/:id/plans/:planId` | Get plan |
| PATCH | `/v1/admin/products/:id/plans/:planId` | Update plan (draft only for amount/currency/interval) |
| POST | `/v1/admin/products/:id/plans/:planId/publish` | Publish plan → Stripe sync |
| POST | `/v1/admin/products/:id/plans/:planId/archive` | Archive plan |
| POST | `/v1/admin/products/:id/coupons` | Create coupon |
| GET | `/v1/admin/products/:id/coupons` | List coupons |
| POST | `/v1/admin/products/:id/coupons/:couponId/disable` | Disable coupon |
| DELETE | `/v1/admin/products/:id/coupons/:couponId` | Delete coupon |
| POST | `/v1/admin/products/:id/refund` | Issue refund for a subscription |

**Create coupon:**
```json
POST /v1/admin/products/<id>/coupons
{
  "code": "SAVE20",
  "discountType": "percentage",
  "discountValue": 20,
  "maxRedemptions": 100,
  "expiresAt": "2026-12-31T23:59:59Z"
}
```

---

### 6.13 Admin — Bundles

| Method | Path | Description |
|---|---|---|
| POST | `/v1/admin/bundles` | Create bundle |
| GET | `/v1/admin/bundles` | List bundles |
| GET | `/v1/admin/bundles/:id` | Get bundle |
| PATCH | `/v1/admin/bundles/:id` | Update bundle |
| POST | `/v1/admin/bundles/:id/publish` | Publish bundle (validates V1–V8 rules) |
| POST | `/v1/admin/bundles/:id/archive` | Archive bundle |
| DELETE | `/v1/admin/bundles/:id` | Hard-delete (only if 0 subscribers) |
| GET | `/v1/admin/bundles/:id/preview` | Preview bundle validation + pricing |
| POST | `/v1/admin/bundles/:id/grant-access` | Grant specific users access to a restricted bundle |

---

### 6.14 Admin — Operations & Security

| Method | Path | Description |
|---|---|---|
| POST | `/v1/admin/products/:productId/subscriptions/:id/force-status` | Override subscription status |
| POST | `/v1/admin/products/:productId/subscriptions/:id/apply-credit` | Apply billing credit |
| GET | `/v1/admin/cron/status` | View cron job history |
| POST | `/v1/admin/cron/run` | Force-run a cron job |
| GET | `/v1/admin/webhook-deliveries` | List outbound webhook deliveries |
| POST | `/v1/admin/webhook-deliveries/:id/retry` | Retry a delivery |
| POST | `/v1/admin/jwt/rotate-key` | Rotate JWT signing key |
| GET | `/v1/admin/super-admin/config` | Get IP allowlist + current JWT key info |
| PATCH | `/v1/admin/super-admin/config` | Update IP allowlist |
| POST | `/v1/admin/tos` | Publish new ToS/Privacy version |
| GET | `/v1/admin/tos` | List published ToS versions |

---

### 6.15 Self-service (Me / Sessions)

| Method | Path | Auth | Description |
|---|---|---|---|
| DELETE | `/v1/users/me` | JWT | Request account deletion (30-day grace) |
| POST | `/v1/users/me/cancel-deletion` | JWT | Cancel pending deletion |
| GET | `/v1/users/me/deletion-requests` | JWT | List your deletion requests |
| GET | `/v1/sessions` | JWT | List all active sessions |
| DELETE | `/v1/sessions/:id` | JWT | Revoke a specific session |

---

## 7. SDK Usage

Install the SDK in your product:

```bash
pnpm add @yocore/sdk
```

### Server-side (API key authentication)

```typescript
import { YoCoreServer } from '@yocore/sdk';

const yocore = new YoCoreServer({
  apiKey: process.env.YOCORE_API_KEY!,      // yc_live_pk_...
  apiSecret: process.env.YOCORE_API_SECRET!, // from rotate-api-secret
  baseUrl: 'https://api.yocore.yourdomain.com',
});

// Check subscription status
const sub = await yocore.getSubscription({ workspaceId: 'ws_01H...' });

// Validate a JWT issued by YoCore
const claims = await yocore.verifyToken(req.headers.authorization);
```

### Client-side (browser, PKCE flow)

```typescript
import { YoCoreClient } from '@yocore/sdk';

const client = new YoCoreClient({
  baseUrl: 'https://auth.yocore.yourdomain.com',
  productSlug: 'yopm',
});

// Start PKCE login (redirects to auth-web)
await client.authorize({
  redirectUri: 'https://yourapp.com/callback',
});

// In your /callback route — exchange code for tokens
const tokens = await client.exchange({
  code: new URL(location.href).searchParams.get('code')!,
  redirectUri: 'https://yourapp.com/callback',
});
client.storeTokens(tokens);
```

### Verify inbound webhooks

```typescript
import { verifyWebhook } from '@yocore/sdk';

app.post('/webhooks/yocore', express.raw({ type: '*/*' }), (req, res) => {
  const valid = verifyWebhook({
    payload: req.body,          // raw Buffer
    signature: req.headers['x-yocore-signature'] as string,
    secret: process.env.YOCORE_WEBHOOK_SECRET!,
  });
  if (!valid) return res.status(401).end();

  const event = JSON.parse(req.body.toString());
  switch (event.type) {
    case 'subscription.activated':
      // Provision access for the user
      break;
    case 'subscription.canceled':
      // Revoke access
      break;
  }
  res.status(200).end();
});
```

---

## 8. Common End-to-End Workflows

### Workflow A: Register a new product

1. Open admin-web → Products → **New product**
2. Enter name and slug (e.g. `yonotes`)
3. Go to Product Detail → **Add gateway** → configure Stripe test mode
4. **Activate** the product (`POST /v1/admin/products/:id/status` `{"status":"ACTIVE"}`)
5. Create plans → publish at least one plan
6. Copy the `apiKey` and `apiSecret` into your product's environment variables
7. Your product can now call `POST /v1/auth/signup?productSlug=yonotes` to register users

### Workflow B: User signup → subscription

There are two integration patterns:

**Pattern 1 — Hosted auth-web (PKCE redirect):**
1. User visits your product and clicks **Sign up**
2. Your product redirects to auth-web: `http://localhost:5174/signup?product=yonotes`
3. User fills in name / email / password → YoCore sends verification email
4. User clicks email link → email verified → auto-signed in → redirected to your callback
5. Your product calls `POST /v1/auth/finalize-onboarding` to create the first workspace
6. User selects a plan → your product calls `POST /v1/billing/checkout`
7. User completes Stripe checkout → `subscription.activated` webhook fires → you grant access

**Pattern 2 — Direct API (your own login UI):**
1. User fills in name / email / password on *your* signup page
2. Your product calls `POST /v1/auth/signup` with `productSlug`
3. User clicks verification email link → your product calls `GET /v1/auth/verify-email?token=...` → tokens returned → store them
4. Your product calls `POST /v1/auth/signin` with `productSlug` to sign in (or your `/verify-email` handler auto-signs in via the returned tokens)
5. Steps 5–7 same as Pattern 1

> Use **Pattern 2** when you need full control over UX/branding. Use **Pattern 1** when you want zero auth-UI maintenance. `apps/demo-yopm` uses Pattern 2 — see [apps/demo-yopm/README.md](../apps/demo-yopm/README.md) for a working reference.

### Workflow C: Invite a team member

1. OWNER or ADMIN calls:
   ```bash
   POST /v1/workspaces/<id>/invitations
   {"email":"colleague@example.com","roleSlug":"MEMBER"}
   ```
2. YoCore sends an invitation email with a token link
3. Invitee clicks the link → if they have an account: redirected to accept flow; if new: account creation flow
4. After accepting: member appears in workspace member list

### Workflow D: Upgrade a subscription

1. User requests plan upgrade in your UI
2. Your product calls:
   ```bash
   GET /v1/billing/subscription/change-plan/preview?newPlanId=<id>&workspaceId=<id>
   ```
3. Show proration amount to user for confirmation
4. On confirm:
   ```bash
   POST /v1/billing/subscription/change-plan
   {"newPlanId":"<id>","workspaceId":"<id>"}
   ```
5. For Stripe: applied immediately with proration. For SSLCommerz: scheduled at period end.

### Workflow E: Handle failed payment

Handled automatically by YoCore:
- **Day 0**: Payment fails → subscription status `PAST_DUE`
- **Day 1**: Email sent to user: "Update your payment method"
- **Day 5**: Second email reminder
- **Day 7**: Final warning email
- **Day 8**: Subscription canceled, workspace suspended

You receive `subscription.past_due` and `subscription.canceled` webhooks throughout.

### Workflow F: GDPR — User requests account deletion

1. User calls `DELETE /v1/users/me` (or you call it on their behalf)
2. Account enters a **30-day grace period** — no data is deleted yet
3. User can cancel deletion during grace: `POST /v1/users/me/cancel-deletion`
4. After 30 days: `gdpr.deletion.tick` cron hard-deletes all user data across all products

---

### Workflow G: Test all features with demo-yopm

`apps/demo-yopm` is a server-rendered Express app that lets you exercise **every** product-side YoCore feature in a browser without building a real product frontend.

**Prerequisites:** API running, a product with slug `yopm-demo` created and activated in admin-web, at least one plan published.

**Setup:**
1. In admin-web, create a product with slug `yopm-demo`
2. Activate it and configure a Stripe test-mode gateway
3. Publish at least one plan
4. Copy the `apiKey`, `apiSecret`, and outbound webhook secret
5. Create `apps/demo-yopm/.env`:
   ```bash
   YOCORE_BASE_URL=http://localhost:3000
   YOCORE_PRODUCT_SLUG=yopm-demo
   YOCORE_PRODUCT_API_KEY=yc_live_pk_...
   YOCORE_PRODUCT_API_SECRET=yc_live_sk_...
   YOCORE_WEBHOOK_SECRET=whsec_...
   DEMO_YOPM_PORT=5175
   ```
6. Start the demo: `set -a; source apps/demo-yopm/.env; set +a && pnpm --filter @yocore/demo-yopm dev`
7. Open `http://localhost:5175`

**10-step full-feature walk:**
1. `/plans` — View published plans (calls `GET /v1/products/:slug/plans`)
2. `/signup` → verify email at Mailhog → `/verify-email?token=...` → auto sign-in
3. `/account` → Finalize onboarding (creates workspace)
4. `/billing` → Checkout → Stripe test card `4242 4242 4242 4242`
5. `/workspaces` → Create a second workspace, switch between them
6. `/workspaces/:id` → Invite a team member by email
7. `/account/mfa` → Enrol TOTP, save recovery codes
8. `/signout` → `/signin` → enter TOTP code (MFA second leg)
9. `/billing` → Change plan, preview proration, apply, manage seats
10. `/webhooks/log` → Inspect all webhook events received

For the full walkthrough including troubleshooting tips, see [apps/demo-yopm/README.md](../apps/demo-yopm/README.md).

---

## 9. Security Operations

### Rotating secrets after a breach

**API secret compromised:**
```bash
POST /v1/admin/products/:id/rotate-api-secret
```
The old secret is **immediately invalidated**. Update your product's env var right away.

**Webhook secret compromised:**
```bash
POST /v1/admin/products/:id/rotate-webhook-secret
```
The old secret stays valid for **24 hours** (grace window). Update your webhook receiver within that window.

**JWT signing key compromised:**
See `docs/runbooks/jwt-key-compromise.md`. In summary:
1. Rotate via admin-web → Settings → **Rotate JWT signing key**
2. The old key is retired immediately
3. All users are effectively signed out when their current access token expires (max 15 minutes)

### Token lifetimes (TTL)

YoCore issues two tokens on every signin:

- **Access token** — short-lived JWT used as `Authorization: Bearer <token>`. Default: **15 minutes** (`AUTH_INVALID_TOKEN` once expired).
- **Refresh token** — long-lived, single-use. Used by the SDK to silently obtain a new access token.

Configure via environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `JWT_ACCESS_TTL_SECONDS` | `900` (15 min) | Access token lifetime. Increase to reduce re-auth friction. **Do not** set above ~1 hour for security. |
| `JWT_REFRESH_TTL_SECONDS` | `2592000` (30 days) | Refresh token lifetime when user ticks "Remember me". |
| `JWT_REFRESH_TTL_NO_REMEMBER_SECONDS` | `604800` (7 days) | Refresh token lifetime without "Remember me". |

Example — extend access tokens to 1 hour:
```bash
# .env
JWT_ACCESS_TTL_SECONDS=3600
```
Restart the API after changing.

> **Recommended:** Don't crank `JWT_ACCESS_TTL_SECONDS` very high. Instead, integrate the SDK's automatic refresh — `YoCoreClient` and `YoCoreServer` both transparently call `/v1/auth/refresh` when the access token is about to expire. This gives you long sessions (controlled by `JWT_REFRESH_TTL_SECONDS`) without keeping access tokens valid for hours.

If you're hitting `AUTH_INVALID_TOKEN` in the **admin web** after inactivity, your options are:
1. Sign in again (simplest).
2. Increase `JWT_ACCESS_TTL_SECONDS` for development (e.g. `7200` = 2 hours).
3. Implement a refresh hook in the admin-web `lib/api.ts` interceptor (currently the admin-web does not auto-refresh).

---

### Rate limits

| Scope | Limit | Window |
|---|---|---|
| Per IP | 100 requests | 1 minute |
| Auth endpoints (per IP) | 20 requests | 1 minute |
| Signin failures (per user+product) | 5 failures | 15 minutes → lockout |

When rate limited, the API returns HTTP 429 with a `Retry-After` header.

### Lockout recovery

If a user is locked out after too many failed signin attempts, wait **15 minutes** for the lockout window to expire. There is no admin "unlock" button — this is by design (prevents brute-force bypass).

For Super Admin lockout (IP allowlist), see `docs/runbooks/ip-allowlist-recovery.md`.

---

## 10. Troubleshooting

### API returns 401 "AUTH_INVALID_CREDENTIALS"
- Check email and password are correct for the right product slug
- The message is intentionally generic — it does not reveal whether the email exists
- Wait 15 minutes if you have had 5+ failed attempts (lockout)

### API returns 404 on a known route
- Check the HTTP method. For example, product status is `POST`, not `GET` or `PATCH`
- Check the full path — admin endpoints start with `/v1/admin/`, billing with `/v1/billing/`
- Check if the resource ID is correct (IDs are ULID format, e.g. `prod_01KQ...`)

### API returns 422 "VALIDATION_FAILED"
- Check the request body matches the expected schema
- Password must be ≥12 characters with uppercase, lowercase, digit, and symbol
- Plan slug must be ≥2 characters
- Optional fields must be omitted (not sent as `null`)

### API returns 409 "RESOURCE_CONFLICT"
- Slug is already taken — use a different slug
- A subscription for this subject already exists

### API returns 429 "RATE_LIMIT_EXCEEDED"
- Wait the number of seconds in the `Retry-After` header before retrying

### Admin web shows blank screen / loading forever
- Check the API is running: `curl http://localhost:3000/v1/health`
- Check Docker containers are up: `docker compose ps`
- Check browser console for network errors

### Email not arriving in dev
- Open Mailhog at `http://localhost:8025` — all dev emails are captured there
- Check that `EMAIL_FROM` is set in `.env`

### "EADDRINUSE: address already in use :::3000"
Another process is using port 3000. Find and stop it:
```bash
lsof -ti :3000 | xargs kill
```

### Mongo replica set not initiating
```bash
docker compose down -v
docker compose up -d
# Wait 15 seconds, then:
mongosh "mongodb://localhost:27017/?replicaSet=rs0" --eval "rs.status().ok"
```

---

## 11. API Error Code Reference

| Code | HTTP | Description |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Request body/params failed Zod validation |
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong email, password, or MFA code |
| `AUTH_TOKEN_EXPIRED` | 410 | Verification or reset token has expired |
| `AUTH_INVALID_TOKEN` | 401 | Token does not exist or was already used |
| `AUTH_REFRESH_REUSED` | 401 | Refresh token reuse detected (session revoked) |
| `AUTH_LOCKED_OUT` | 429 | Too many failed signin attempts |
| `AUTH_MFA_REQUIRED` | 401 | Account has MFA but no code was provided |
| `AUTH_MFA_INVALID` | 401 | TOTP code is incorrect |
| `AUTH_ONBOARDING_ALREADY_COMPLETE` | 409 | Finalize onboarding called twice |
| `PERMISSION_DENIED` | 403 | Insufficient role for this action |
| `OWNER_ONLY` | 403 | Action requires OWNER role |
| `RESOURCE_NOT_FOUND` | 404 | Generic resource not found |
| `PRODUCT_NOT_FOUND` | 404 | Product ID or slug does not exist |
| `PLAN_NOT_FOUND` | 404 | Plan does not exist |
| `GATEWAY_NOT_FOUND` | 404 | Gateway does not exist |
| `SUBSCRIPTION_NOT_FOUND` | 404 | Subscription does not exist |
| `RESOURCE_CONFLICT` | 409 | Slug taken, duplicate gateway, or active sub exists |
| `BILLING_PLAN_IMMUTABLE` | 409 | Cannot change price/currency/interval on active plan |
| `BILLING_PLAN_MEMBER_OVERFLOW` | 402 | Target plan has fewer seats than current member count |
| `BILLING_DOWNGRADE_BLOCKED` | 409 | Cannot downgrade to a free plan directly |
| `BILLING_TRIAL_INELIGIBLE` | 409 | Plan has no trial, or user already had a trial |
| `BILLING_GATEWAY_UNAVAILABLE` | 503 | Payment gateway circuit breaker is open |
| `BILLING_GATEWAY_CIRCUIT_OPEN` | 503 | Too many gateway errors — breaker is open |
| `BILLING_BUNDLE_VALIDATION_FAILED` | 422 | Bundle failed pre-publish validation (V1–V8) |
| `GATEWAY_VERIFICATION_FAILED` | 502 | Could not verify gateway credentials with provider |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | Inbound webhook HMAC signature failed |
| `WEBHOOK_PAYLOAD_INVALID` | 422 | Webhook payload missing required metadata |
| `INVITATION_EXPIRED` | 410 | Invitation is older than 72 hours |
| `INVITATION_ALREADY_USED` | 409 | Invitation was already accepted or revoked |
| `GDPR_DELETION_BLOCKED` | 409 | Cannot delete while active subscriptions exist |
| `IDEMPOTENCY_KEY_MISSING` | 400 | `Idempotency-Key` header required on this endpoint |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests — check `Retry-After` |
| `INTERNAL_ERROR` | 500 | Unexpected server error (check logs / Sentry) |

For the full list with HTTP mappings, see `docs/error-codes.md`.

---

*This manual covers YoCore v1.1. For architecture decisions, see `docs/adr/`. For incident playbooks, see `docs/runbooks/`.*
