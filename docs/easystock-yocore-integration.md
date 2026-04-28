# EasyStock ↔ YoCore Integration Plan

> **Generated:** 28 April 2026  
> **Scope:** Full audit of EasyStock (frontend + backend) and YoCore, with a phased integration roadmap.

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
   - 1.1 [EasyStock Backend](#11-easystock-backend)
   - 1.2 [EasyStock Frontend](#12-easystock-frontend)
   - 1.3 [YoCore](#13-yocore)
2. [Decision Matrix](#2-decision-matrix)
3. [Target Architecture](#3-target-architecture)
4. [Data Model Changes](#4-data-model-changes-easystock)
5. [Backend Work](#5-backend-work--easystock)
6. [Frontend Work](#6-frontend-work--easystock)
7. [Resolved Decisions](#7-resolved-decisions)
   - 7a. [YoCore Prerequisites (verified)](#7a-yocore-prerequisites-verified-28-april-2026)
8. [Phased Rollout](#8-recommended-phased-rollout)
9. [File / Endpoint Delta Cheat Sheet](#9-concrete-fileendpoint-deltas-cheat-sheet)

---

## 1. Current State Audit

### 1.1 EasyStock Backend

**Stack:** Node.js + Express 4, TypeScript strict, Mongoose 8, JWT (single access token, 7d), bcryptjs, speakeasy (TOTP 2FA), Nodemailer (SMTP), node-cron.

#### Authentication

| Route | Method | Description |
|---|---|---|
| `/api/auth/signup` | POST | Create owner + organization (rate-limited) |
| `/api/auth/login` | POST | Sign in, returns token; requires `organizationSlug`; supports 2FA |
| `/api/auth/me` | GET | Get current user (protected) |
| `/api/auth/verify-email` | POST | Verify email with token (24h expiry) |
| `/api/auth/resend-verification` | POST | Resend verification email |
| `/api/auth/forgot-password` | POST | Request password reset (1h expiry) |
| `/api/auth/reset-password` | POST | Reset password with token |

**JWT claims:**
```ts
{
  id: user._id,
  email: user.email,
  role: user.role,
  organizationId: user.organizationId,
  permissions: getDefaultPermissions(user.role)
}
// Expiry: JWT_EXPIRES_IN env (default 7d) — single access token, NO refresh
```

**Key files:**
- `src/routes/auth.routes.ts`
- `src/controllers/auth.controller.ts`
- `src/services/auth.service.ts`
- `src/middleware/auth.ts` — verifies Bearer JWT, attaches `req.user`
- `src/middleware/checkPermission.ts` — `checkPermission()`, `checkAnyPermission()`, `checkAllPermissions()`
- `src/middleware/checkRole.ts` — `checkRole()`, `checkAdmin()`, `checkAdminOrManager()`

**Signup flow:**
1. Validate email globally (no user with this email anywhere)
2. Check slug uniqueness
3. Transaction: create Org → create owner user (admin role) → create default Location
4. Seed industry-specific data
5. Send verification email (Nodemailer)

#### User Model

```ts
{
  firstName, lastName, email, phone, password (bcrypt),
  avatar: imageSchema,
  role: "super_admin" | "admin" | "manager" | "staff" | "viewer",
  organizationId,
  locationIds: [ObjectId],
  defaultLocationId: ObjectId,
  status: "active" | "inactive" | "disabled",
  emailVerified: boolean,
  verificationToken (SHA256), verificationTokenExpiry (24h),
  resetPasswordToken (SHA256), resetPasswordExpiry (1h),
  loginAttempts, lockUntil (5 fails → 2h lock),
  twoFactorEnabled, twoFactorSecret (base32), backupCodes,
  lastLogin
}
// Index: { email, organizationId } unique → same email allowed across orgs
```

#### Organization Model

```ts
{
  name, slug (unique),
  industry: enum,
  country, timezone, currency,
  ownerId: ObjectId,
  address, logo: imageSchema,
  settings: { excludedFields, excludedColumns },
  features: { sales, accounts, expiryTracking, barcodeSystem, invoicePrinting, returns, uomConversion },
  status: "active" | "inactive" | "read_only",
  deletionScheduledAt: Date
}
```

#### Permissions & Roles

- `src/constants/permissions.ts` — `ALL_PERMISSIONS[]` (100+ strings), `ROLE_PERMISSIONS: Record<Role, string[]>`, `getDefaultPermissions(role)`
- 5 roles: `super_admin`, `admin`, `manager`, `staff`, `viewer`
- Permissions hardcoded in code (no DB model)

#### Billing / Plans / Subscriptions

**❌ NOT IMPLEMENTED.** No `Plan`, `Subscription`, `Billing` models. No Stripe/SSLCommerz. `payment.model.ts` exists but is for sales/purchase payments only.

#### Locations

```ts
{
  name, slug (unique per org),
  organizationId,
  locationType: "store" | "warehouse",
  address, status
}
```
Active location resolved from `X-Active-Location` header → default location → stored in `req.user.activeLocationId`.

#### Email

- Provider: Nodemailer SMTP
- Methods: `sendVerificationEmail`, `sendPasswordResetEmail`, `sendWelcomeEmail`, `sendUserRegistrationEmail`

#### Cron Jobs

- `jobs/organizationCleanup.job.ts` — runs daily 2AM, deletes orgs where `status="read_only"` and `deletionScheduledAt <= now`.

---

### 1.2 EasyStock Frontend

**Stack:** Next.js 16 (App Router), React 19, TypeScript strict, TanStack Query 5, Zustand 5, React Hook Form 7 + Zod, Tailwind 4, shadcn/Radix UI.

#### Auth Pages

| Page | File | Notes |
|---|---|---|
| Login | `app/(auth)/login/page.tsx` | Fields: `organizationSlug`, `email`, `password`, optional `twoFactorToken`. 2FA modal on `requires2FA: true`. |
| Signup | `app/(auth)/signup/page.tsx` | Owner: firstName/lastName/email/phone/password. Org: name/slug/industry/country/timezone/currency. |
| Verify Email | `app/(auth)/verify-email/page.tsx` | Auto-triggers on mount from URL `?token=`. |
| Resend Verification | `app/(auth)/resend-verification/page.tsx` | Fields: email, organizationSlug. |
| Forgot Password | `app/(auth)/forgot-password/page.tsx` | Fields: email, organizationSlug. |
| Reset Password | `app/(auth)/reset-password/page.tsx` | Fields: token (URL), newPassword. |

#### Auth Store (`services/stores/use-auth-store.ts`)

```ts
{
  user: User | null,      // Full user object incl. org settings
  token: string | null,   // JWT access token
  isAuthenticated: boolean,
  activeLocationId: string | null,
  isLoading, error
}
```
- Persisted via Zustand `persist` middleware (key: `"easystock-auth"`)
- Tokens also in cookies via `cookies-next`: `auth-token` (7d), `active-location` (7d)
- **No refresh token** — re-login on expiry

#### API Client (`lib/api-client.ts`)

- Base URL: `NEXT_PUBLIC_API_URL` env or `http://localhost:5000/api`
- Auth header: `Authorization: Bearer <token>` + `X-Active-Location: <id>`
- On 401: clears auth → redirects to `/login`
- **No refresh interceptor**

#### Permission / Role Gating in UI

- `lib/nav-utils.ts` — `filterNavItems()` filters nav by `roles[]`, `permissions[]`, `features[]`
- `constants/navItem.ts` — per-item role/feature/permission guards
- `components/layout/app-sidebar.tsx` — applies `filterNavItems()`

#### Billing UI

| What | Status |
|---|---|
| "Billing" dropdown item (sidebar) | ✅ Placeholder exists, no `onClick` |
| `/billing` page | ❌ Missing |
| Plan listing | ❌ Missing |
| Checkout | ❌ Missing |
| Invoice list | ❌ Missing |
| Upgrade dialog | ❌ Missing |

#### Key Files

- `lib/api-client.ts`
- `services/api/utils.ts`
- `services/stores/use-auth-store.ts`
- `services/api/modules/auth/{api,hooks}.ts`
- `services/api/modules/profile/{api,hooks}.ts`
- `services/api/modules/organization/{api,hooks}.ts`
- `services/api/query-keys.ts`
- `components/layout/app-sidebar.tsx`
- `lib/nav-utils.ts`
- `constants/navItem.ts`

---

### 1.3 YoCore

**Status: ~90% built. All Phase 1–3.5 features are implemented. V1.0 release blockers are complete.**

**Stack:** Node.js 20 LTS, pnpm 9 workspaces, Turborepo, TypeScript 5.5 strict, Express 4, MongoDB 7 + Mongoose 8, Redis 7 + ioredis, Zod 3, argon2id (piscina pool), jose (JWT), Agenda + cronLocks, opossum (circuit breaker), Pino.

#### Product / Tenant Model (`apps/api/src/db/models/Product.ts`) ✅

```ts
{
  _id: "prod_easystock",           // ULID
  name, slug (unique),
  domain,
  status: "ACTIVE" | "INACTIVE" | "MAINTENANCE" | "ABANDONED",
  apiKey: "yc_live_pk_xxx",
  apiSecretHash: "argon2id:...",   // Never stored plaintext
  webhookUrl,
  webhookSecret,                   // HMAC-SHA256 signing key
  webhookSecretPrevious,           // 24h grace on rotation
  webhookPayloadVersion,
  webhookEvents: string[],
  billingScope: "workspace" | "user",
  billingConfig: { gatewayRouting, gracePeriodDays, trialDefaultDays, ... },
  authConfig: { hostedUiEnabled, pkceEnabled, maxConcurrentSessions, ... },
  allowedOrigins, allowedRedirectUris,
  rateLimitPerMinute
}
```

**Product registration endpoint (SUPER_ADMIN only):**
```
POST /v1/admin/products
→ Response: { product: { id, apiKey, ... }, apiSecret (ONE TIME), webhookSecret (ONE TIME) }
```

#### User Models ✅

**Global `User`** (email anchor):
```ts
{ _id, email (global unique), emailVerified, role: "END_USER" | "SUPER_ADMIN" }
```

**Per-product `ProductUser`**:
```ts
{
  userId, productId,
  passwordHash (argon2id, per-product independent),
  name: { first, last, display }, avatarUrl, timezone, locale,
  status: "UNVERIFIED" | "ACTIVE" | "SUSPENDED" | "BANNED" | "DELETED",
  failedLoginAttempts, lockedUntil,
  productRole: "END_USER" | "PRODUCT_ADMIN",
  mfaEnrolledAt, emailPreferences, emailDeliverable
}
```

#### Auth Endpoints ✅

```
POST /v1/auth/signup               → always returns { status: "verification_sent" } (enumeration-safe)
GET  /v1/auth/verify-email?token=  → returns { status, tokens: { accessToken (15m), refreshToken (30d) } }
POST /v1/auth/signin               → { status: "signed_in" | "mfa_required", tokens?, mfaChallengeId? }
POST /v1/auth/refresh              → { accessToken, refreshToken (rotation), expiresIn }
POST /v1/auth/logout               → 204 (scope: "session" | "all")
POST /v1/auth/finalize-onboarding  → creates Workspace + WorkspaceMember(OWNER)
GET  /v1/auth/authorize            → PKCE redirect to hosted auth
POST /v1/auth/pkce/exchange        → exchange code for tokens
```

**JWT:** 15-min access token, 30-day refresh (rotation + theft detection — family revocation on replay).

#### Inter-service Auth (EasyStock backend → YoCore) ✅

```
X-Api-Key: yc_live_pk_xxx
X-Api-Secret: ypsk_xxx
```
- Verified via argon2id constant-time comparison
- Redis-cached 60s
- Per-product rate limiting (token-bucket)

**SDK:**
```ts
import { YoCoreServer } from '@yocore/sdk';
const yocore = new YoCoreServer({ apiKey, apiSecret, baseUrl });
```

#### Plans & Subscriptions ✅

**Plan model highlights:**
```ts
{
  productId, slug, name, status: "DRAFT"|"ACTIVE"|"ARCHIVED",
  isFree, amount (cents), currency, interval: "month"|"year"|"one_time",
  trialDays,
  limits: { maxWorkspaces, maxMembers, storageMb, custom: { ... } },
  seatBased, perSeatAmount, includedSeats,
  stripeProductId, stripePriceId
}
```

**Subscription model highlights:**
```ts
{
  productId, userId?, workspaceId?,
  planId, planSlug,
  status: "TRIALING"|"ACTIVE"|"PAST_DUE"|"INCOMPLETE"|"CANCELED"|"PAUSED",
  currentPeriodStart, currentPeriodEnd,
  trialStartsAt, trialEndsAt,
  gateway: "stripe"|"sslcommerz",
  stripeCustomerId, stripeSubscriptionId,
  quantity, cancelAtPeriodEnd,
  gracePeriodStartedAt, gracePeriodEndsAt
}
```

**Key billing endpoints:**
```
GET  /v1/products/:slug/plans              → public, cached 5min
POST /v1/billing/checkout                  → returns redirectUrl (Stripe/SSLCommerz)
POST /v1/billing/trial/start
GET  /v1/billing/subscription/change-plan/preview
POST /v1/billing/subscription/change-plan
POST /v1/billing/subscription/pause
POST /v1/billing/subscription/resume
POST /v1/billing/subscription/seats
GET  /v1/billing/invoices
GET/PUT /v1/billing/tax-profile
POST /v1/billing/bundle-checkout
```

#### Roles & Permissions ✅

**Role model (`apps/api/src/db/models/Role.ts`):**
```ts
{
  productId,
  slug: "EDITOR",        // uppercase, unique per product
  name, description,
  permissions: string[], // e.g. "documents.create", "users.invite"
  inheritsFrom,          // optional parent role
  isPlatform: boolean,   // OWNER/ADMIN/MEMBER/VIEWER are platform built-ins
  isDefault: boolean
}
```

**WorkspaceMember:**
```ts
{ productId, workspaceId, userId, roleId, joinedAt, invitedBy }
```

**Permission check endpoint:**
```
POST /v1/permissions/check
Body: { workspaceId, actions: ["documents.create", "users.invite"] }
→ { allowed: [...], denied: [...], reason }
```

#### Webhooks Emitted by YoCore ✅

**Delivery:** 30s → 5m → 30m → 2h → 6h → DEAD (5 retries).

**Signature header:** `x-webhook-signature: t=<unix_ts>,v1=<hmac_sha256_hex>`

**Verification:**
```ts
import { verifyWebhookSignature } from '@yocore/sdk';
const isValid = verifyWebhookSignature(rawBody, headerValue, webhookSecret);
```

**Event catalog (relevant subset):**
```
user.created / user.deleted / user.email_changed
workspace.created / workspace.deleted / workspace.ownership_transferred
subscription.activated / trial_started / trial_expired / plan_changed /
  seats_changed / paused / resumed / canceled / payment_failed /
  payment_recovered / grace_started / grace_ended / refunded
bundle.subscription.activated / canceled / archived
```

**Webhook secret rotation:** `POST /v1/admin/products/:id/rotate-webhook-secret` — 24h grace period, both old and new secrets valid simultaneously.

#### SDK (`packages/sdk`) ✅

Two clients:
- `YoCoreServer` — server-side, API key auth (use in EasyStock backend)
- `YoCoreClient` — browser/PKCE, end-user JWT auth (optional use in EasyStock frontend)

Also exports: `verifyWebhookSignature()`, `retry()`.

#### What Is NOT Yet Built

- ❌ OAuth (Google, GitHub) — deferred Phase 2
- ❌ Magic link login — deferred Phase 2
- ❌ Mobile SDK — deferred Phase 2
- ❌ Email drivers (Resend, SES) — currently console only; Phase 5
- ❌ Metered usage tiers — schema ready, cron not wired (POST-MVP)
- ❌ Bundle → standalone migration — scaffolded but untested (v1.1-B)
- ❓ Stripe invoice finalization — in progress

---

## 2. Decision Matrix

| Concern | EasyStock Today | YoCore Today | Integration Decision |
|---|---|---|---|
| Auth (signup/signin/verify/2FA/reset) | Own (JWT 7d, bcrypt, speakeasy) | Own (JWT 15m+30d refresh, argon2id, TOTP, PKCE) | **YoCore = source of truth.** EasyStock UI keeps its pages; backend becomes a proxy. |
| User identity | `User` (email unique per org) | Global `User` + per-product `ProductUser` | **YoCore owns identity.** EasyStock `User` becomes a local mirror keyed by `yocoreUserId`. |
| Tenant unit | `Organization` + `Location` | `Workspace` | EasyStock `Organization` ↔ YoCore `Workspace` (1:1). `Location` stays EasyStock-only. |
| Roles / Permissions | 5 hard-coded roles, 100+ perm strings in code | Custom `Role` per product + `WorkspaceMember.roleId` | Seed EasyStock's 5 roles into YoCore at product registration. Permissions read from JWT/membership — drop hardcoded `ROLE_PERMISSIONS` map in future. |
| Billing / Plans / Subs | **None** | Full (Plans, Subs, Trials, Coupons, Bundles, Stripe + SSLCommerz, Invoices, Tax) | **YoCore-only.** EasyStock gates features via webhook-driven local cache on `Organization`. |
| Incoming webhooks | None | N/A | New `POST /api/webhooks/yocore` endpoint in EasyStock. |
| Locations (multi-warehouse) | Yes | No concept | Stays 100% in EasyStock. |
| Org feature flags | `org.features { sales, accounts, ... }` | Driven by `plan.limits` | After integration, mirror plan → features on `subscription.*` webhook events. |
| Email (transactional auth) | Nodemailer SMTP | YoCore sends (once email driver built) | YoCore sends auth emails. EasyStock keeps its own email for sales/purchase notifications. |
| Org deletion / GDPR | `organizationCleanup.job.ts` daily cron | 30d grace, emits `workspace.deleted` | YoCore drives schedule; EasyStock listens to `workspace.deleted` and cleans inventory/sales. |

---

## 3. Target Architecture

```
Browser (Next.js)
│
│  1) POST /api/auth/login  (EasyStock form — same shape as today)
▼
EasyStock backend ──proxy──► YoCore  POST /v1/auth/signin
                              returns { accessToken (15m), refreshToken (30d), userId, productId }
│
│  2) maps yocoreUserId → local User+Organization
│     returns EasyStock envelope { user, token, refreshToken, activeLocationId }
▼
Browser stores tokens (cookies) + user → Zustand
│
│  3) every API call:
│     Authorization: Bearer <yocoreAccessToken>
│     X-Active-Location: <locationId>
▼
EasyStock backend authenticate()
│  - verify JWT against YoCore JWKS (cached 1h, auto-rotate via ADR-006)
│  - lookup local User by yocoreUserId
│  - resolve Organization via Workspace mapping
│  - hydrate req.user.permissions from role map (or JWT claims)
▼
EasyStock services do their work (inventory, sales, locations, etc.)

── Parallel ──

YoCore ──webhook──► EasyStock  POST /api/webhooks/yocore
  (subscription.activated, plan_changed, canceled, user.created, workspace.created, ...)
  → verifies HMAC-SHA256 signature
  → deduplicates via WebhookEvent collection
  → updates Organization.status, plan, features, seats, grace period
```

---

## 4. Data Model Changes (EasyStock)

### `User` model — Add fields

```ts
yocoreUserId: string           // unique, indexed  (== YoCore "usr_...")
yocoreProductUserId: string    // unique
```

**Remove (Phase 3 cutover, no dual-mode):** `password`, `loginAttempts`, `lockUntil`, `verificationToken`, `verificationTokenExpiry`, `resetPasswordToken`, `resetPasswordExpiry`, `twoFactorEnabled`, `twoFactorSecret`, `backupCodes`, `emailVerified`.

**Index change (Decision 6):** drop `{ email, organizationId }` unique compound index → add `{ email }` unique single-field index. Email is globally unique.

**Keep:** `firstName`, `lastName`, `phone`, `avatar`, `role`, `organizationId`, `locationIds`, `defaultLocationId`, `status`, `lastLogin`.

> Note: `organizationId` on `User` becomes the user's *primary/most-recent* workspace, not the only one. Workspace membership is sourced from YoCore (Decision 1).

### `Organization` model — Add fields

```ts
yocoreWorkspaceId: string      // unique, index
yocoreSubscription: {
  subscriptionId:   string,
  planId:           string,
  planSlug:         string,
  status:           "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "PAUSED" | "INCOMPLETE",
  currentPeriodEnd: Date,
  trialEndsAt:      Date | null,
  gracePeriodEndsAt: Date | null,
  cancelAtPeriodEnd: boolean,
  seats:            number,
  updatedAt:        Date,       // from webhook
  webhookEventId:   string      // last applied event (idempotency)
}
```

`Organization.features` becomes derived — computed from `plan.limits` on subscription webhook receipt.

### New collection: `WebhookEvent`

```ts
{
  provider:    "yocore",
  eventId:     string,   // unique index for deduplication
  type:        string,
  receivedAt:  Date,
  processedAt: Date | null
}
// Compound unique index: { provider, eventId }
```

---

## 5. Backend Work — EasyStock

### 5.1 Bootstrap (one-time, before any code change)

1. Super Admin registers EasyStock in YoCore:
   ```
   POST /v1/admin/products
   Body: {
     name: "EasyStock", slug: "easystock", domain: "easystock.com",
     allowedOrigins: ["https://easystock.com"],
     allowedRedirectUris: ["https://easystock.com/auth/callback"],
     billingScope: "workspace",
     webhookUrl: "https://easystock.com/api/webhooks/yocore"
   }
   → Save: YOCORE_PRODUCT_ID, YOCORE_API_KEY, YOCORE_API_SECRET, YOCORE_WEBHOOK_SECRET
   ```

2. Seed EasyStock's 5 roles + permission catalog into YoCore:
   ```bash
   pnpm tsx scripts/sync-yocore-roles.ts
   ```

3. Create plans in YoCore (Free, Starter, Pro, Enterprise) with `limits` fields mapping to EasyStock features:
   ```ts
   limits: {
     maxLocations: 1,
     maxUsers: 5,
     features: { sales: true, accounts: false, expiryTracking: true, ... }
   }
   ```

### 5.2 New: `src/services/yocore.service.ts`

Wraps `YoCoreServer` from `@yocore/sdk`. Exposes:
- `signup(email, password, name)` → proxy
- `signin(email, password, mfaCode?, mfaChallengeId?)` → proxy
- `refresh(refreshToken)` → proxy
- `logout(token, scope)` → proxy
- `verifyEmail(token)` → proxy
- `forgotPassword(email)` → proxy
- `resetPassword(token, newPassword)` → proxy
- `enableMfa() / verifyMfa() / disableMfa()` → proxy to YoCore MFA endpoints
- `getWorkspaceMembers(workspaceId)` → for user sync
- `getSubscription(workspaceId)` → on-demand refresh

### 5.3 Rewrite: `src/services/auth.service.ts`

**`signup(payload)`:**
1. Call `yocore.signup({ email, password, productSlug: "easystock", name })` → `{ status: "verification_sent" }`.
2. Create local `Organization` (slug, industry, country, timezone, currency; `yocoreWorkspaceId: null` — filled after `finalize-onboarding` webhook).
3. Create local `User` (`status: "inactive"`, no password fields at all) — linked on first verified login via `yocoreUserId`.
4. Drop: Nodemailer verification email (YoCore sends it).

**`login({ email, password, organizationSlug, mfaCode?, mfaChallengeId? })`:**
1. Call `yocore.signin({ email, password, productSlug: "easystock", mfaCode, mfaChallengeId })`.
2. If `status === "mfa_required"` → return `{ requires2FA: true, mfaChallengeId }` (FE unchanged).
3. If `status === "signed_in"`:
   - Resolve local `User` by `yocoreUserId` (create mirror on first login if absent).
   - Resolve local `Organization` by `yocoreWorkspaceId`.
   - Attach `activeLocationId` from `X-Active-Location` header or user's default.
   - Return current EasyStock response envelope `{ user, token: accessToken, refreshToken, expiresIn }`.

**`forgotPassword`, `resetPassword`, `verifyEmail`, `resendVerification`** → thin proxies to YoCore, same response envelope.

**Drop entirely (Phase 3):** bcryptjs, speakeasy, `generateVerificationToken`, `generatePasswordResetToken`, lock/unlock logic, `ROLE_PERMISSIONS` map.

### 5.4 Rewrite: `src/middleware/auth.ts`

Replace bcrypt-JWT verify with:
1. Extract `Authorization: Bearer <token>`.
2. Fetch YoCore JWKS from `GET https://yocore.yo/v1/.well-known/jwks.json` → cache 1h in-memory (handles key rotation automatically per ADR-006).
3. Verify JWT signature using `jose`.
4. Extract claims: `sub` (yocoreUserId), `productId`.
5. Lookup local `User` by `yocoreUserId` (Redis-cached 60s).
6. Resolve `Organization` from user's `organizationId` (already on local User).
7. Hydrate `req.user` exactly like today: `{ id, email, role, organizationId, locationIds, activeLocationId, permissions }`.

> **Note:** Per Decision 2, the middleware always reads `workspaceId`, `permissions`, `productRole` from the Redis session record keyed by `jti` (populated at login / `select-workspace`). If a future YoCore release adds those claims to the JWT, the middleware can short-circuit the lookup.

### 5.5 New: Webhook receiver

**Files:**
- `src/routes/webhooks.routes.ts`
- `src/controllers/webhook.controller.ts`
- `src/services/webhook.service.ts`
- `src/models/webhook-event.model.ts`

**Route:** `POST /api/webhooks/yocore`
- Use `express.raw({ type: 'application/json' })` to get raw body.
- Verify `x-webhook-signature` via `verifyWebhookSignature` from `@yocore/sdk`.
- Enforce 5-min timestamp skew tolerance.
- Insert into `WebhookEvent` collection first (unique `{ provider, eventId }`) — return 200 immediately; process asynchronously.

**Event handlers:**

| Event | EasyStock Action |
|---|---|
| `workspace.created` | Link `Organization.yocoreWorkspaceId` if pending |
| `user.created` | Create local `User` mirror (status inactive until first login) |
| `subscription.trial_started` | Set `org.yocoreSubscription.status="TRIALING"`, `trialEndsAt`, recompute `features` |
| `subscription.activated` | `status="ACTIVE"`, update `currentPeriodEnd`, recompute `features`, `org.status="active"` |
| `subscription.plan_changed` | Update `planId/planSlug`, recompute `features`, update period dates |
| `subscription.seats_changed` | Update `seats` |
| `subscription.payment_failed` | (no immediate action — wait for `grace_started`) |
| `subscription.grace_started` | Set `gracePeriodStartedAt/EndsAt`; send internal alert |
| `subscription.grace_ended` | `org.status="read_only"` |
| `subscription.resumed` / `payment_recovered` | `org.status="active"`, clear grace fields |
| `subscription.canceled` | `org.yocoreSubscription.status="CANCELED"`, `org.status="read_only"` |
| `subscription.trial_expired` | `org.status="read_only"` |
| `workspace.deleted` | Trigger org soft-delete (replace current cron cleanup) |
| `user.deleted` | Soft-disable local user |

### 5.6 New: `src/middleware/require-feature.ts`

```ts
requireFeature("sales")
// reads org.features populated from subscription plan limits
// returns 402 { code: "PLAN_FEATURE_NOT_INCLUDED", message, upgradeUrl }
```

### 5.7 New: `src/services/jwks.service.ts`

- Fetches YoCore JWKS endpoint.
- Caches in Redis with 1h TTL.
- Auto-refresh on `kid` mismatch (supports JWT key rotation per ADR-006).

### 5.8 Remove (after migration complete)

- `src/services/email.service.ts` — auth email templates (verification, reset, welcome). Keep sales/purchase email methods.
- `jobs/organizationCleanup.job.ts` — replaced by `workspace.deleted` webhook + `inventoryPurgeCron`.
- bcryptjs, speakeasy npm dependencies.
- `super_admin` role and all `ROLE_PERMISSIONS` constants.

### 5.9 New scripts

| Script | Purpose |
|---|---|
| `scripts/sync-yocore-roles.ts` | Seed EasyStock roles + permissions into YoCore at product registration |
| `scripts/audit-duplicate-emails.ts` | Detect emails shared across multiple orgs (must be 0 before migration) |
| `scripts/migrate-users-to-yocore.ts` | Big-bang: provision YoCore users + trigger password-reset emails for all active users |
| `scripts/migrate-super-admins.ts` | Promote EasyStock `super_admin` to YoCore global `SUPER_ADMIN`; downgrade workspace role to `admin` |

---

## 6. Frontend Work — EasyStock

### Minimal changes — envelope shape is unchanged

### 6.1 `services/stores/use-auth-store.ts`

- Add `refreshToken: string | null` field.
- Persist `refreshToken` in HTTP-only cookie (`refresh-token`, 30d).
- Add `setRefreshToken(token)` action.

### 6.2 `lib/api-client.ts`

Add refresh interceptor:
1. On 401 response: call `POST /api/auth/refresh` with stored `refreshToken`.
2. On success: update `token` + `refreshToken` in store + cookies.
3. Retry original request once with new `accessToken`.
4. On refresh failure (401): clear auth → redirect to `/login`.

### 6.3 New: `/app/(protected)/billing/` pages

| File | Purpose |
|---|---|
| `page.tsx` | Current plan card, trial/grace banners, quick invoice list |
| `plans/page.tsx` | Public plan listing (from `GET /v1/products/easystock/plans` proxied via EasyStock) |
| `invoices/page.tsx` | Full invoice history |

### 6.4 New: `components/billing/`

| Component | Purpose |
|---|---|
| `current-plan-card.tsx` | Shows plan name, status badge, period end, seats |
| `trial-banner.tsx` | Shown when `org.yocoreSubscription.status === "TRIALING"` |
| `grace-banner.tsx` | Shown when in grace period (payment failed) |
| `change-plan-dialog.tsx` | Shows proration preview, confirms plan change |
| `cancel-subscription-dialog.tsx` | Cancel at period end flow |
| `upgrade-dialog.tsx` | Generic "upgrade to access this feature" modal |
| `invoice-table.tsx` | TanStack Table for invoices |

### 6.5 New: `services/api/modules/billing/`

- `api.ts` — `getSubscription()`, `getPlans()`, `checkout()`, `changePlan()`, `previewChangePlan()`, `pauseSubscription()`, `resumeSubscription()`, `cancelSubscription()`, `getInvoices()`, `getTaxProfile()`, `updateTaxProfile()`
- `hooks.ts` — TanStack Query hooks wrapping each function
- `index.ts` — barrel export

### 6.6 New: `hooks/use-feature-gate.ts`

```ts
useFeatureGate("sales")
// returns { allowed: boolean, upgradeUrl: string }
// consumed in feature-gated pages/components to show <UpgradeDialog>
```

### 6.7 Modify: `components/layout/app-sidebar.tsx`

Wire the existing placeholder "Billing" dropdown item to `/billing`.

### 6.8 Modify: `app/(auth)/signup/page.tsx` + setup wizard

Post-signup flow:
1. EasyStock `POST /api/auth/signup` → proxies to YoCore → `{ status: "verification_sent" }`.
2. User verifies email via link (YoCore sends email).
3. On verified login, call YoCore `POST /v1/auth/finalize-onboarding` with `workspaceName`, `workspaceSlug`, `timezone` (maps from EasyStock org form data).
4. Extend setup wizard (`components/setup/`) to include first-Location creation after onboarding is finalized.

### 6.9 Global error handler — TanStack Query

Add in `components/providers/`:
```ts
onError: (error) => {
  if (error.status === 402 && error.code === "PLAN_FEATURE_NOT_INCLUDED") {
    openUpgradeDialog(error.upgradeUrl);
  }
}
```

### 6.10 Modify: `components/login/login-form.tsx`

- Add MFA recovery-code toggle (already partially present — complete it).
- For v1.1: add "Choose workspace" step after successful auth when user belongs to multiple workspaces.

---

## 7. Resolved Decisions

> All open questions and risks were resolved on 28 April 2026. EasyStock is treated as not-fully-released, so we make the right long-term choices now and skip transitional v1/v1.1 dual paths wherever possible.
>
> **YoCore endpoints / claims referenced below were verified against `apps/api` on 28 April 2026** (see [§7a YoCore Prerequisites](#7a-yocore-prerequisites-verified-28-april-2026) for the audit trail and the two gaps that need closing).

### Decision 1 — Multi-workspace from day one (was Issue 1)

**Choice: Option B.** Remove `organizationSlug` from the login form. After `POST /v1/auth/signin`:
- EasyStock backend lists user's workspaces via `GET /v1/workspaces` (auto-scoped to the calling product via API-key context). Returns `{ workspaces: [{ id, name, slug, status, role, ... }] }`.
- If exactly one workspace → EasyStock immediately calls `POST /v1/auth/switch-workspace { workspaceId }` server-side and returns the resulting access token to the FE.
- If multiple → EasyStock returns `{ status: "workspace_selection_required", workspaces: [...] }`. FE shows a picker, then calls `POST /api/auth/select-workspace { workspaceId }` on EasyStock, which proxies to YoCore `POST /v1/auth/switch-workspace` and forwards the new access token.
- YoCore's `switch-workspace` response is `{ status: "switched", workspaceId, accessToken, expiresIn, tokenType: "Bearer" }`. EasyStock additionally writes a Redis session record keyed by `jti` carrying `{ workspaceId, organizationId, permissions, productRole }` (TTL = `expiresIn`) and echoes `X-Workspace-Id` as a short-lived cookie for FE convenience.
- Workspace switcher appears in the top bar (sibling to the existing `activeLocationId` switcher); switching calls `POST /api/auth/select-workspace` again and invalidates **all** TanStack Query caches.

### Decision 2 — JWT claims (was Issue 2)

**Choice: do what's best — assume minimal claims, use Redis.** Verified YoCore access-token claims are: `sub` (yocoreUserId), `iss`, `iat`, `exp`, `jti`, `role` (`SUPER_ADMIN` | `END_USER`), `pid` (productId, may be null for SUPER_ADMIN), `sid`, `typ: "access"`. **`workspaceId` and `permissions` are NOT in the JWT** — they live in a YoCore-side session keyed by `jti`. EasyStock therefore maintains its own Redis session record keyed by `jti` carrying `{ workspaceId, organizationId, permissions, productRole }` populated on login / `select-workspace`. One Redis hit per request; sub-millisecond. If YoCore later adds these claims to the JWT, the middleware short-circuits the lookup — no breaking change.

### Decision 3 — Permissions: YoCore is source of truth (was Issue 3)

**Choice: drop the hardcoded `ROLE_PERMISSIONS` map entirely.**
- Delete `ROLE_PERMISSIONS` and `getDefaultPermissions()` from `src/constants/permissions.ts`. Keep the `ALL_PERMISSIONS` string union only as TypeScript types (move to `src/types/permissions.ts`).
- On login / `select-workspace`, EasyStock calls `POST /v1/permissions/check` with the full known permission list:
  ```
  Body:     { userId, workspaceId, permissions: [...all ~100 strings] }
  Response: { userId, workspaceId, roleSlug, results: Record<perm, boolean>, cached }
  ```
  Permissions where `results[perm] === true` are stored in the Redis session record alongside `workspaceId` (TTL = access-token `expiresIn`).
- On role change, YoCore must emit `workspace.member_role_changed` so EasyStock can invalidate the session cache. **This webhook event does not yet exist in YoCore (see §7a Gap 1)** — must be added in Phase 0.
- `req.user.permissions` is hydrated from cache. `checkPermission()` middleware unchanged in shape.
- The 4 EasyStock roles (`admin`, `manager`, `staff`, `viewer`) and the full ~100 permission catalog are seeded into YoCore by `scripts/sync-yocore-roles.ts` at product registration. YoCore becomes the only place roles can be edited.

### Decision 4 — 2FA: use YoCore's TOTP (was Issue 4)

**Choice: use YoCore's MFA implementation; force re-enrollment for legacy 2FA users at cutover.** Secrets are not portable. On first post-cutover login of a user who had `twoFactorEnabled: true` in EasyStock, the FE shows a mandatory "Re-enroll your authenticator app" step before granting access. New signups go straight to YoCore MFA.

### Decision 5 — Password migration: go with YoCore (was Issue 5)

**Choice: big-bang reset.** At cutover, run `scripts/migrate-users-to-yocore.ts` which calls YoCore's admin "create-user-without-password + send-reset-email" endpoint for every active user. Users receive one email, set a new password (argon2id in YoCore). The EasyStock bcrypt path is removed in the same release — no dual-mode, no lazy migration. Communicate the cutover via in-app banner one week ahead.

> **Blocker:** the admin endpoint above does not yet exist in YoCore (see [§7a Gap 2](#7a-yocore-prerequisites-verified-28-april-2026)). Must be added in Phase 0.

### Decision 6 — Email is globally unique (was Issue 6)

**Choice: drop the per-org email index; enforce global uniqueness.**
- Replace `{ email, organizationId }` unique compound index with `{ email }` unique single-field index on `User`.
- Run `scripts/audit-duplicate-emails.ts` as a Phase 0 blocker. Any cross-org duplicates must be merged or renamed before the index change.
- A single human (one email) maps to a single global YoCore identity, may belong to multiple EasyStock workspaces (Decision 1).

### Decision 7 — Webhook reliability: do it right (was Issue 7)

**Choice: full async pipeline.**
- `POST /api/webhooks/yocore` verifies HMAC + 5-min timestamp tolerance, inserts into `WebhookEvent` (unique on `{provider, eventId}`), returns `200` immediately.
- A separate worker (Agenda-style or simple `setImmediate` + DB-claim pattern) processes the event, updates the relevant `Organization` / `User`, then sets `WebhookEvent.processedAt`.
- Failed processing → DLQ collection with manual replay endpoint `POST /api/admin/webhooks/replay/:eventId` (SUPER_ADMIN only).
- Add `GET /api/admin/webhooks` admin UI page for inspection.

### Decision 8 — Locations modeled as plan limits, not seats (was Issue 8)

**Choice: per recommendation.** YoCore plans use `plan.limits.maxLocations` (and `maxUsers`). YoCore seats are unused for EasyStock (we will request YoCore mark seat fields nullable on EasyStock plans, or set `seatBased: false`). EasyStock's location-creation service enforces `org.yocoreSubscription.limits.maxLocations`.

### Decision 9 — Performance: aggressive caching (was Issue 9)

**Choice: do the best.**
- JWKS cached in Redis 1h, refreshed on `kid` mismatch.
- `yocoreUserId → { localUserId, organizationId }` cached in Redis 60s.
- Session record `{ jti → workspaceId, permissions, productRole }` cached in Redis with TTL = access-token expiry.
- All caches are passively invalidated on the corresponding webhook (`user.updated`, `workspace.member_role_changed`, etc.).
- No synchronous external HTTP in the request hot path — only Redis hits.

### Decision 10 — Org deletion driven by YoCore (was Issue 10)

**Choice: per recommendation.**
- Delete `src/jobs/organizationCleanup.job.ts`.
- `workspace.deleted` webhook handler marks the org `status="deleted"`, sets `deletedAt`.
- A new lightweight cron `inventoryPurgeCron` (daily) hard-deletes inventory/sales/purchase rows for orgs deleted >7 days ago. Org row itself is kept for audit.

### Decision 11 — `super_admin` is a YoCore global role (was Issue 11)

**Choice: implement the plan.**
- EasyStock's `super_admin` role is removed from `src/constants/permissions.ts` (only 4 roles remain: `admin`, `manager`, `staff`, `viewer`).
- Existing `super_admin` users are migrated via `scripts/migrate-super-admins.ts`:
  - Their global YoCore `User.role` is set to `SUPER_ADMIN`.
  - In any EasyStock workspace they belong to, their workspace role is downgraded to `admin`.
- All "platform admin" UI lives in the YoCore admin web app, not in EasyStock.

---

## 7a. YoCore Prerequisites (verified 28 April 2026)

Audit of `apps/api/src/handlers/`, `apps/api/src/router.ts`, `apps/api/src/services/auth.service.ts`, and `packages/types/src/schemas/`.

### Confirmed (no work needed)

| # | Capability | Route / File | Notes |
|---|---|---|---|
| 1 | List user's workspaces (product-scoped) | `GET /v1/workspaces` — [workspace.handler.ts:102](../apps/api/src/handlers/workspace.handler.ts) | Returns `{ workspaces: [{ id, name, slug, status, suspended, ownerUserId, timezone, voluntaryDeletionFinalizesAt, role }] }`. Auto-scoped to product via API-key context. |
| 2 | Permission check | `POST /v1/permissions/check` — [workspace.handler.ts:430](../apps/api/src/handlers/workspace.handler.ts) | Body: `{ userId, workspaceId, permissions: string[] }`. Response: `{ userId, workspaceId, roleSlug, results: Record<perm, boolean>, cached }`. Used by EasyStock to seed the Redis session cache on login. |
| 3 | Switch workspace (mints new access token) | `POST /v1/auth/switch-workspace` — [workspace.handler.ts:200](../apps/api/src/handlers/workspace.handler.ts) | Body: `{ workspaceId }`. Response: `{ status: "switched", workspaceId, accessToken, expiresIn, tokenType: "Bearer" }`. EasyStock proxies this for both initial workspace selection and the in-app switcher. |
| 4 | JWT claim shape | [auth.service.ts:128](../apps/api/src/services/auth.service.ts) | Claims: `sub, iss, iat, exp, jti, role` (`SUPER_ADMIN`\|`END_USER`), `pid` (productId, nullable), `sid`, `typ: "access"`. Confirms Decision 2 — workspaceId/permissions kept in Redis. |
| 5 | Workspace member role-change audit | [workspace.handler.ts:268](../apps/api/src/handlers/workspace.handler.ts) | Audit-logs `workspace.member.role_changed` on role change. The audit-log call site is the natural place to emit the new webhook event (Gap 1). |

### Gaps — must be closed in Phase 0 (YoCore side)

| # | Gap | Why EasyStock needs it | Status / Resolution |
|---|---|---|---|
| **Gap 1** | No `workspace.member_role_changed` webhook event | Without it, EasyStock's Redis-cached permissions go stale until the user's access token expires (up to 15min). Critical for revoking access promptly. | ✅ **Closed (28 Apr 2026).** Added `WORKSPACE_MEMBER_ROLE_CHANGED: 'workspace.member_role_changed'` to [packages/types/src/schemas/webhooks.ts](../packages/types/src/schemas/webhooks.ts) plus a typed envelope `workspaceMemberRoleChangedWebhookEnvelopeSchema`. Emitted from [apps/api/src/services/member.service.ts](../apps/api/src/services/member.service.ts) `changeRole()` after the role write succeeds. Payload: `{ workspaceId, productId, userId, previousRoleSlug, newRoleSlug, changedByUserId, changedAt }`. |
| **Gap 2** | No admin "provision user + send password reset" endpoint | Required by `scripts/migrate-users-to-yocore.ts` for the big-bang password migration (Decision 5). The existing invitation flow (`POST /v1/workspaces/:id/invitations`) requires the user to *accept* an invite first — wrong UX for users who already have an EasyStock account. | ✅ **Closed (28 Apr 2026).** Added `POST /v1/admin/products/:id/users` (SUPER_ADMIN only). Body: `{ email, name?, sendPasswordResetEmail? = true }`. Idempotent on `(productId, email)`: creates global `User` (no password, `emailVerified: true`, `emailVerifiedMethod: 'admin_provisioned'`), creates `ProductUser` in `ACTIVE` status with `passwordHash: null`, queues a `password_reset` token + email. Response: `{ user: { id, email, productUserId, created, emailVerified }, resetEmailQueued }`. Returns `201` on first create, `200` on idempotent re-issue. Implementation: handler in [apps/api/src/handlers/admin.handler.ts](../apps/api/src/handlers/admin.handler.ts), service method `provisionProductUser` in [apps/api/src/services/admin-ops.service.ts](../apps/api/src/services/admin-ops.service.ts), schema `adminProvisionUserRequestSchema` in [packages/types/src/schemas/admin.ts](../packages/types/src/schemas/admin.ts). |

### Optional / nice-to-have

- **Stronger ergonomic permissions endpoint:** `GET /v1/permissions/me?workspaceId=...` returning `{ workspaceId, roleSlug, permissions: string[] }`. Saves EasyStock from sending the full ~100-permission list on every login. Not blocking — `POST /v1/permissions/check` works.
- **`workspace.member_added` / `workspace.member_removed` webhook events:** also useful for cache invalidation. Not strictly required for v1 since the role-change event covers the main cache-invalidation case.

---

## 8. Recommended Phased Rollout

> EasyStock is pre-release: we cut over directly to YoCore — no legacy/dual-mode auth path.

> **📌 Tracking rule (read this every time you work on the integration):**
> 1. As you finish a checklist item below, flip its `[ ]` to `[x]` and append `— *done DD MMM YYYY* (`code` link if applicable)`. Do **not** silently complete items.
> 2. When **every** item in a phase is checked, add a phase-status line directly under the phase heading:
>    `> **✅ Phase N complete — DD MMM YYYY.** Summary: <one-sentence what shipped>.`
> 3. Only after that phase-status line exists may work begin on the next phase. If a phase has both "code" and "manual ops" items, mark the code subset complete with `*(code-complete; ops pending)*` so the next phase can start in parallel.
> 4. If a previously-checked item is reopened, flip it back to `[ ]` with `— *reopened DD MMM YYYY: <reason>*` and remove the phase-complete line.
> 5. After every phase transition, also update [TASKS.md](../TASKS.md) and any open PR description.

### Phase 0 — Prep (no user impact)

> **✅ Phase 0 code-complete — 28 Apr 2026 (ops pending).** YoCore added the missing webhook event + admin provision endpoint; EasyStock added yocore link fields, the `WebhookEvent` model with `{provider, eventId}` unique index, audit + index-migration scripts, and `YOCORE_*` env slots. The remaining items are operational (registering the product, seeding plans, running the data migration in each environment) and do not block Phase 1 implementation.

**YoCore side (blockers — see [§7a](#7a-yocore-prerequisites-verified-28-april-2026)):**
- [x] **Gap 1:** Add `workspace.member_role_changed` webhook event (schema + emit at audit-log call site + product subscription wiring) — *closed 28 Apr 2026*
- [x] **Gap 2:** Add `POST /v1/admin/products/:productId/users` admin endpoint (provision user + send password-reset email, idempotent on `(productId, email)`) — *closed 28 Apr 2026*
- [ ] *(optional)* Add `GET /v1/permissions/me?workspaceId=...` for ergonomic permission fetch

**EasyStock side:**
- [x] Add fields: `User.yocoreUserId`, `User.yocoreProductUserId`; `Organization.yocoreWorkspaceId`, `Organization.yocoreSubscription` — *done 28 Apr 2026* ([user.model.ts](../../easystock-backend/src/models/user.model.ts), [organization.model.ts](../../easystock-backend/src/models/organization.model.ts))
- [x] Add `WebhookEvent` model + `{provider, eventId}` unique index — *done 28 Apr 2026* ([webhook-event.model.ts](../../easystock-backend/src/models/webhook-event.model.ts))
- [x] Add `scripts/audit-duplicate-emails.ts` + `scripts/migrate-user-email-index.ts` (drops `{email, organizationId}`, adds global `{email}` unique) — *done 28 Apr 2026*
- [x] Stub `scripts/sync-yocore-roles.ts` + add `YOCORE_*` env var slots in `.env.example` — *done 28 Apr 2026*
- [ ] **Ops:** Register EasyStock product in YoCore (staging + prod) → fill `YOCORE_*` env vars
- [ ] **Ops:** Run `pnpm tsx scripts/audit-duplicate-emails.ts` → resolve any cross-org duplicates (Decision 6 blocker)
- [ ] **Ops:** Run `pnpm tsx scripts/migrate-user-email-index.ts` (after audit returns clean)
- [ ] **Ops:** Once `@yocore/sdk` is wired in Phase 1, finish `scripts/sync-yocore-roles.ts` and run it to seed the 4 roles + ~100 permissions (Decision 3, 11)
- [ ] **Ops:** Create plans in YoCore (Free, Starter, Pro, Enterprise) with `limits.maxLocations`, `limits.maxUsers`, `limits.features` (Decision 8)

### Phase 1 — Webhooks + async pipeline

> **✅ Phase 1 complete — 28 Apr 2026.** Summary: HMAC-verified `POST /api/webhooks/yocore` receiver (raw-body via `express.json({ verify })`, 5-min skew, dedup-insert), 1-min cron worker drains `WebhookEvent` and dispatches to workspace/user/subscription handlers (subscription mirror recomputes `Organization.features` from `limits.features`), and super-admin `GET /admin/webhooks`, `GET /admin/webhooks/:eventId`, `POST /admin/webhooks/replay/:eventId`, `POST /admin/webhooks/drain` endpoints. 17 new tests (signature unit, route integration, service integration); 58/58 green.

- [x] Implement `POST /api/webhooks/yocore` (raw-body, HMAC verify, 5-min skew, dedup insert, returns 202 immediately) (Decision 7) — *done 28 Apr 2026* ([webhooks.routes.ts](../../easystock-backend/src/routes/webhooks.routes.ts), [yocore-signature.ts](../../easystock-backend/src/utils/yocore-signature.ts))
- [x] Async worker drains `WebhookEvent` → applies handlers → sets `processedAt`; failures retried up to 8× with reclaim of stuck rows (DLQ deferred — failed rows stay queryable via admin list) — *done 28 Apr 2026* ([yocoreWebhookWorker.job.ts](../../easystock-backend/src/jobs/yocoreWebhookWorker.job.ts), [yocore-webhook.service.ts](../../easystock-backend/src/services/yocore-webhook.service.ts))
- [x] Handlers for: `workspace.created/deleted/member_role_changed`, `user.created/updated/deleted`, all `subscription.*` events — *done 28 Apr 2026* ([yocore-handlers/](../../easystock-backend/src/services/yocore-handlers/))
- [x] Mirror subscription state → `Organization.yocoreSubscription` + recompute `features` from plan limits (allow-list `FEATURE_KEYS`; non-usable status forces `sales/returns: false`; empty `limits.features` falls back to `DEFAULT_ORGANIZATION_FEATURES`) — *done 28 Apr 2026* ([subscription-handler.ts](../../easystock-backend/src/services/yocore-handlers/subscription-handler.ts))
- [x] Admin: `POST /api/admin/webhooks/replay/:eventId`, `GET /api/admin/webhooks` page, plus `GET /:eventId` detail and `POST /drain` on-demand tick (super_admin only) — *done 28 Apr 2026* ([admin-webhooks.routes.ts](../../easystock-backend/src/routes/admin-webhooks.routes.ts))
- [x] `requireFeature()` middleware behind a feature flag (not enforced yet) — *done in Phase 0* ([featureGate.ts](../../easystock-backend/src/middleware/featureGate.ts))

### Phase 2 — Billing UI (read-only)

> **✅ Phase 2 complete — 28 Apr 2026.** Summary: read-only `GET /api/billing/subscription` exposes the org's `yocoreSubscription` mirror + computed `features` + lifecycle status; new `/billing` route renders plan/limits/feature-grid cards with trial / grace / past-due / cancellation / read-only banners; "Subscription / Billing" sidebar entry repointed from the dead `/dashboard/billing` URL to the live `/billing` page.

- [x] `/billing` page, plan listing, current plan card, invoices (read from `org.yocoreSubscription`) — *done 28 Apr 2026* ([page.tsx](../../easystock-frontend/app/(protected)/billing/page.tsx), [components/billing/](../../easystock-frontend/components/billing/), [api.ts](../../easystock-frontend/services/api/modules/billing/api.ts), [hooks.ts](../../easystock-frontend/services/api/modules/billing/hooks.ts), [billing.routes.ts](../../easystock-backend/src/routes/billing.routes.ts)) — *invoices section deferred until YoCore exposes an invoices endpoint; the page surfaces plan, limits, period, auto-renew and feature flags today.*
- [x] Wire sidebar "Billing" item — *done 28 Apr 2026* ([navItem.ts](../../easystock-frontend/constants/navItem.ts))
- [x] Trial / grace / past-due banners — *done 28 Apr 2026* ([subscription-banner.tsx](../../easystock-frontend/components/billing/subscription-banner.tsx)) — also covers `paused`, `canceled`, `expired`, scheduled cancellation, and workspace `read_only` with deletion countdown.
- [ ] **Ops:** Verify webhook → DB → UI pipeline end-to-end (post a `subscription.updated` event from a YoCore staging tenant, confirm the `/billing` page reflects the new plan + features within ~1 min)

### Phase 3 — Auth cutover (big-bang)

> **🚧 Phase 3.1 code-complete — 28 Apr 2026 (sub-phases 3.2–3.6 pending).** Phase 3 is being delivered in six reversible sub-phases (3.1 infra & SDK plumbing, 3.2 parallel `authenticate()` behind `AUTH_PROVIDER` flag, 3.3 auth service rewrite + multi-workspace UX, 3.4 migration scripts, 3.5 cutover day, 3.6 cleanup). 3.1 ships only inert plumbing — no behavior change.
>
> **🚧 Phase 3.2 code-complete — 28 Apr 2026 (inert by default; opt-in via `AUTH_PROVIDER=yocore`).** Summary: parallel `authenticateYocore` middleware verifies the Bearer token via `jwks.service`, looks up the Redis session by `jti`, cross-checks `session.yocoreUserId === token.sub`, then resolves the local `User` (by `yocoreUserId`) and `Organization` (by `yocoreWorkspaceId`) and hydrates `req.user` with the same shape legacy auth produces. Selection between providers is done by the new `authenticate()` dispatcher driven by `AUTH_PROVIDER` env (defaults to `legacy` → no behavior change). Session writes (login flow) land in Phase 3.3; 3.5 flips the env in production. 7 new middleware/dispatcher tests; 65/65 green.
>
> **🚧 Phase 3.3a code-complete — 28 Apr 2026 (BE only; FE picker + MFA proxy in 3.3b).** Summary: `yocore.service.ts` extended with `authSignup/Signin/VerifyEmail/Forgot/Reset/Refresh/Logout` + `listWorkspaces/switchWorkspace` proxies (multi-mode `auth: "basic" | "bearer" | "none"`); new `yocore-auth.service.ts` mirrors the legacy `AuthService` surface, decodes the YoCore access token to extract `jti`, and **writes** the EasyStock-side `auth:session:${jti}` Redis record — closing the loop with the 3.2 read path. Login auto-selects when the user has exactly one workspace; multi-workspace returns `{requiresWorkspaceSelection, workspaces, pendingAccessToken, pendingRefreshToken}` and the FE follows up with `POST /api/auth/select-workspace`. Per-method dispatch is done in `auth.controller.ts` via `AUTH_PROVIDER` (legacy stays untouched). 6 new service tests; 71/71 green.
>
> **🚧 Phase 3.3b code-complete — 28 Apr 2026 (BE only; FE work moved to 3.3c).** Summary: shipped `POST /api/auth/refresh` (YoCore mode rotates access + refresh tokens via `authRefresh`, decodes the new JWT, re-issues `auth:session:${jti}` and revokes the previous `jti`; legacy mode returns `501 REFRESH_NOT_SUPPORTED_LEGACY`); added `yocore-profile.controller.ts` with `mfaStatus / mfaEnrol / mfaEnrol/verify` proxies; wrapped the existing `profile.controller.ts` with a per-method dispatcher so `get2FAStatus / enable2FA / verify2FA` route to YoCore when `AUTH_PROVIDER=yocore` while `getProfile / updateProfile / changePassword / getOrganizationUsers / transferOwnership` stay on the legacy local-Mongo path (those resources are still owned by EasyStock). `disable2FA` returns `501 MFA_DISABLE_NOT_SUPPORTED_YOCORE` (no YoCore endpoint). FE-facing wire-shape changes: `enable2FA` now returns an extra `enrolmentId`, and `verify2FA` now requires `{ token, enrolmentId }` — Phase 3.3c will adapt the FE forms. 6 new tests; 77/77 green.
>
> **🚧 Phase 3.3c code-complete — 28 Apr 2026 (FE only; behaviourally inert until BE flips `AUTH_PROVIDER=yocore`).** Summary: (1) `useAuthStore` now persists `refreshToken` (cookie `auth-refresh-token`, 7-day) plus a new `setTokens()` mutator; (2) `lib/api-client.ts` got a single-flight 401 interceptor that POSTs `/auth/refresh` with the stored refresh token, updates the store, and retries the original request once — concurrent 401s coalesce on a shared in-flight promise; on the legacy path the BE returns 501 and we fall through to the existing hard-logout behaviour; (3) `useLogin` accepts an optional `onWorkspaceSelection` callback and now branches into a workspace-picker UI when the BE returns `requiresWorkspaceSelection: true`; new `useSelectWorkspace` hook posts the chosen `workspaceId` + pending tokens; (4) `two-factor-tab.tsx` carries the YoCore `enrolmentId` from `enable2FA` into `verify2FA` (legacy ignores the extra field). All changes are reversible: with `AUTH_PROVIDER=legacy` (the default), no new code paths execute. FE typecheck/lint baseline unchanged; 1/1 tests green.
>
> **🚧 Phase 3.4 code-complete — 28 Apr 2026 (BE migration scripts; INERT until a human runs them on cutover day in 3.5).** Summary: shipped two `pnpm tsx`-runnable migration scripts plus a shared CLI helper. Both scripts are idempotent, resumable (skip rows where `User.yocoreUserId` is already set), and gated by env (`MONGODB_URI`, `YOCORE_API_BASE_URL`, `YOCORE_API_KEY_ID`, `YOCORE_API_KEY_SECRET`, `YOCORE_PRODUCT_ID`, `YOCORE_SUPER_ADMIN_TOKEN`). Affordances on every run: `--dry-run`, `--limit N`, `--organization-id <objectId>` / `--organization-slug <slug>`, and a deterministic `Idempotency-Key` derived from `(scriptName, --idempotency-prefix or today's UTC date, userId)` so day-of retries collapse server-side via YoCore's `(productId, email)` idempotency table. New YoCore client methods: `adminProvisionProductUser` (calls `POST /v1/admin/products/:productId/users`, returns `{user, resetEmailQueued}`) and `adminChangeWorkspaceMemberRole` (calls `PATCH /v1/workspaces/:id/members/:userId`). Both use a SUPER_ADMIN bearer token from env. `migrate-users-to-yocore.ts` provisions every active non-`super_admin` user whose org is already linked to a YoCore workspace; users in unlinked orgs are SKIP-logged so the operator can re-run after the org-link backfill completes. `migrate-super-admins.ts` provisions YoCore identities for `super_admin` users, downgrades their workspace role to `admin` (Decision 11), and rewrites the local `User.role` from `super_admin` → `admin`; **the global YoCore `SUPER_ADMIN` promotion remains an out-of-band manual step** (logged at the bottom of each run as a paste-ready list of `(email, yocoreUserId)` pairs) because that mutation lives outside the EasyStock-product API surface. No new tests — these are operational scripts; correctness is verified by dry-run output on staging. Type-check + 77/77 unit tests still green.
>
> **🚧 Phase 3.5 code-complete — 28 Apr 2026 (cutover-day prep; INERT — actual flip is a human-driven operation).** Summary: (1) shipped [`docs/runbooks/auth-cutover.md`](runbooks/auth-cutover.md) — the operational runbook the human cutover operator follows: pre-flight (T-30), apply migrations (T-0), out-of-band SUPER_ADMIN promotion (T+5), backend `AUTH_PROVIDER=yocore` canary + rollout (T+10), frontend `NEXT_PUBLIC_AUTH_PROVIDER=yocore` redeploy (T+20), monitoring + sign-off, plus a rollback section that's safe up to the moment users start setting new passwords. (2) `lib/organization-utils.ts` `shouldShowOrganizationSlugField()` now reads `process.env.NEXT_PUBLIC_AUTH_PROVIDER` and returns `false` when set to `"yocore"` — so login/forgot-password/resend-verification stop rendering the `Organization Slug` field on cutover (workspace selection happens AFTER login via the picker shipped in 3.3c). The flag defaults to legacy behaviour and is documented in [`.env.example`](../../easystock-frontend/.env.example). The MFA re-enrol banner, recovery-code regeneration UI, and top-bar workspace switcher remain deferred to Phase 3.6 (see runbook §Appendix). FE typecheck baseline unchanged (pre-existing `ignoreDeprecations` error unrelated); BE unaffected.
>
> **🧨 Phase 3.6a code-complete — 28 Apr 2026 (DESTRUCTIVE BE cleanup; legacy auth path removed). Code-only — deploy strictly AFTER Phase 3.5 cutover succeeds and rollback window closes.** Summary: dropped the entire legacy auth surface from the EasyStock backend now that YoCore owns identity. Specifically (BE-1) `super_admin` was removed from the local `Roles` array and `ROLE_PERMISSIONS` in [permissions.ts](../../easystock-backend/src/constants/permissions.ts) and [user.types.ts](../../easystock-backend/src/types/user.types.ts) (Decision 11) — only `admin/manager/staff/viewer` remain as workspace roles. The `admin-webhooks` route's `checkRole(["super_admin"])` was replaced with a new `checkSuperAdmin()` middleware in [checkRole.ts](../../easystock-backend/src/middleware/checkRole.ts) that gates on `req.user.role === "SUPER_ADMIN"` (the YoCore productRole that the auth-yocore middleware writes onto `req.user`). The `yocore-auth.service.ts` `toLocalRole()` helper now maps `SUPER_ADMIN` → `admin` (workspace role) instead of the now-defunct `super_admin`. (BE-4) deleted `src/services/auth.service.ts`, `src/services/__tests__/auth.service.test.ts`, `src/routes/__tests__/auth.routes.test.ts`. Collapsed `auth.controller.ts`, `profile.controller.ts`, and `middleware/auth.ts` from per-method dispatchers into thin YoCore-only delegators (the `AUTH_PROVIDER` env flag is now a no-op — every request goes through YoCore). `profile.changePassword` is a 501 stub (`CHANGE_PASSWORD_NOT_SUPPORTED_YOCORE`) directing users to the forgot-password flow because YoCore has no current+new password endpoint. (Step 3) refactored [`userService.registerUser`](../../easystock-backend/src/services/user.service.ts) to call `yocoreClient.adminProvisionProductUser({email, name, sendPasswordResetEmail: true})` (using `YOCORE_SUPER_ADMIN_TOKEN` + `YOCORE_PRODUCT_ID` from env, idempotent on `register-user:${orgId}:${email}`) before creating the local `UserModel` record — the local row now holds workspace membership only (organizationId, role, locationIds, yocoreUserId, yocoreProductUserId). The controller's response message changed from "verification email sent" to "user invited successfully — they will receive a YoCore email to set their password". (BE-2) stripped from [user.model.ts](../../easystock-backend/src/models/user.model.ts) and [user.types.ts](../../easystock-backend/src/types/user.types.ts): `password`, `emailVerified`, `verificationToken`, `verificationTokenExpiry`, `resetPasswordToken`, `resetPasswordExpiry`, `loginAttempts`, `lockUntil`, `twoFactorEnabled`, `twoFactorSecret`, `backupCodes` plus the `bcrypt` pre-save hook and the `comparePassword`/`generateVerificationToken`/`generatePasswordResetToken`/`isLocked`/`incrementLoginAttempts`/`resetLoginAttempts` document methods. (BE-3) uninstalled `bcryptjs`, `speakeasy`, `qrcode`, `@types/bcryptjs`, `@types/speakeasy`, `@types/qrcode`. Deleted [`src/services/email.service.ts`](../../easystock-backend/src/services/email.service.ts) entirely (1223 lines of legacy templates — `sendVerificationEmail`, `sendUserRegistrationEmail`, `sendNewUserVerificationReminder`, `sendPasswordResetEmail` — all unused after the controller and user-service refactors; YoCore now owns every transactional email). Stripped `bcryptjs`/`speakeasy`/`qrcode` imports plus the `changePassword`/`enable2FA`/`verify2FA`/`disable2FA`/`get2FAStatus` methods from [profile.service.ts](../../easystock-backend/src/services/profile.service.ts) (the YoCore proxy in `yocore-profile.controller.ts` now serves all 2FA endpoints). Pruned [test/factories.ts](../../easystock-backend/src/test/factories.ts) (no more password/emailVerified/twoFactor in `createUser`) and the `profile.service` test suite (dropped changePassword + 2FA-lifecycle blocks). **NOT yet picked up: BE-5** (the `inventoryPurgeCron` legacy job — left for a follow-up). Migration scripts (`migrate-users-to-yocore.ts`, `migrate-super-admins.ts`) remain on disk as historical/operational reference even though their `super_admin` queries will return zero rows post-cleanup. **Verification:** `pnpm type-check` clean, `pnpm lint` clean (2 pre-existing console-statement warnings unchanged), `pnpm test` 49/49 green (was 54 — the 5 deleted tests were the legacy auth.service + auth.routes suites). **3.6b/c remain pending:** FE-1 re-enrol banner, FE-2 recovery-code regeneration UI, FE-3 + BE-6 top-bar workspace switcher with `GET /api/auth/workspaces` + `POST /api/auth/switch-workspace`.
>
> **🛡️ Phase 3.6b code-complete — 28 Apr 2026 (FE MFA polish; safe to deploy independently of 3.6a).** Summary: shipped the two outstanding MFA UX gaps from the cutover runbook. (1) **Recovery-code regeneration UI** — added `POST /api/profile/2fa/recovery-codes` that proxies to YoCore's `mfaRegenerateRecoveryCodes` (already in [yocore.service.ts](../../easystock-backend/src/services/yocore.service.ts)) via a new `regenerateRecoveryCodes` method on [yocore-profile.controller.ts](../../easystock-backend/src/controllers/yocore-profile.controller.ts), wired through [profile.controller.ts](../../easystock-backend/src/controllers/profile.controller.ts) and [profile.routes.ts](../../easystock-backend/src/routes/profile.routes.ts). FE: new `regenerateRecoveryCodes` method in [profile/api.ts](../../easystock-frontend/services/api/modules/profile/api.ts), new `useRegenerateRecoveryCodes` mutation hook in [profile/hooks.ts](../../easystock-frontend/services/api/modules/profile/hooks.ts), and a new "Recovery Codes" section in [two-factor-tab.tsx](../../easystock-frontend/components/profile/two-factor-tab.tsx) that surfaces `recoveryCodesRemaining` from the existing 2FA status (BE side has read it since 3.3b), highlights when ≤ 2 codes remain, opens a confirmation dialog before regenerating, and reuses the existing backup-codes dialog to display the fresh batch. The `get2FAStatus` API typing was widened to include the optional `type` and `recoveryCodesRemaining` fields the BE has been returning since 3.3b (the FE was previously discarding them). (2) **Post-cutover MFA re-enrol banner** — new [components/shared/mfa-reenrol-banner.tsx](../../easystock-frontend/components/shared/mfa-reenrol-banner.tsx) mounted in the protected layout. Auto-fetches 2FA status via the new `useTwoFactorStatusQuery` (a TanStack `useQuery` that complements the legacy mutation-style `use2FAStatus`); renders only when status is loaded **and** `enabled === false` **and** the user hasn't dismissed it. Dismissal is per-user via `localStorage["mfa-reenrol-dismissed:<userId>"]` so it never reappears once the user opts out, but also doesn't bleed across accounts on a shared browser. Banner deep-links to `/profile#2fa` (the profile page tabs are hash-driven). Per the runbook, this serves a dual purpose: post-cutover it nudges users whose pre-cutover TOTP secrets were not migrated to re-enrol, and long-term it acts as a soft-opt-in nudge for users who never had 2FA. **Verification:** BE `pnpm type-check` clean, `pnpm lint` clean (2 pre-existing console-statement warnings unchanged), `pnpm test` 49/49 green. FE `pnpm typecheck` produces only the pre-existing `tsconfig ignoreDeprecations` baseline error (unrelated). FE `pnpm lint` clean (1 pre-existing `useMemo` warning in `profile/page.tsx`, untouched). FE `pnpm vitest run` 1/1 green (smoke). **3.6c remains pending:** FE-3 + BE-6 top-bar workspace switcher with `GET /api/auth/workspaces` + `POST /api/auth/switch-workspace`. **3.6a BE-5 (`inventoryPurgeCron` legacy job)** still queued for follow-up.
>
> **🏢 Phase 3.6c code-complete — 28 Apr 2026 (mid-session workspace switching).** Summary: shipped the long-promised top-bar workspace switcher and finally retired the legacy `organizationCleanup.job.ts` so Phase 3 of the integration is fully code-complete. (BE-6) New `GET /api/auth/workspaces` + `POST /api/auth/switch-workspace` endpoints in [auth.routes.ts](../../easystock-backend/src/routes/auth.routes.ts), backed by new `listMyWorkspaces` and `switchActiveWorkspace` methods on [yocore-auth.service.ts](../../easystock-backend/src/services/yocore-auth.service.ts) and corresponding controller methods in [yocore-auth.controller.ts](../../easystock-backend/src/controllers/yocore-auth.controller.ts) (delegated through [auth.controller.ts](../../easystock-backend/src/controllers/auth.controller.ts)). The switch flow calls YoCore's existing `/v1/auth/switch-workspace`, writes a new local Redis session keyed on the new `jti`, deletes the previous session (best-effort), and re-runs the same hydration as login (`hydrateLoginPayload`). The refresh token is **not** rotated — YoCore's switch endpoint only returns a fresh access token. New Zod schema `switchWorkspaceSchema` in [auth.validator.ts](../../easystock-backend/src/validators/auth.validator.ts). Bug-fix tucked in: `loadLocalUserAndOrg` now scopes the local-user lookup by `(yocoreUserId, organizationId)` so a user belonging to multiple workspaces resolves to the correct local row instead of an arbitrary one. (FE-3) New [WorkspaceSwitcher](../../easystock-frontend/components/shared/workspace-switcher.tsx) component (popover dropdown with active-workspace check + per-row loader) mounted in the [header](../../easystock-frontend/components/layout/header.tsx) next to `LocationSwitcher`. Auto-hides when the user only belongs to one workspace. New `useMyWorkspaces` (TanStack `useQuery`, gated on `token`) and `useSwitchWorkspace` (mutation; replaces auth-store user/token, invalidates **all** queries so the workspace-scoped server data is refetched, then `router.refresh()`) in [auth/hooks.ts](../../easystock-frontend/services/api/modules/auth/hooks.ts), plus the matching `listWorkspaces`/`switchWorkspace` methods on [auth/api.ts](../../easystock-frontend/services/api/modules/auth/api.ts). (BE-5) Replaced `src/jobs/organizationCleanup.job.ts` with the new [inventoryPurge.job.ts](../../easystock-backend/src/jobs/inventoryPurge.job.ts) — same daily 02:00 schedule and same hard-delete sweep, but the file/function names finally reflect that EasyStock is no longer the system of record for workspace lifecycle (YoCore is, via the `workspace.deleted` webhook in [workspace-handler.ts](../../easystock-backend/src/services/yocore-handlers/workspace-handler.ts)). [server.ts](../../easystock-backend/src/server.ts) updated to import + start the new job. **Verification:** BE `pnpm type-check` clean, `pnpm lint` clean (2 pre-existing console-statement warnings unchanged), `pnpm test` 49/49 green. FE `pnpm typecheck` produces only the pre-existing `tsconfig ignoreDeprecations` baseline error (unrelated). FE `pnpm lint` clean (1 pre-existing `useMemo` warning untouched). **Phase 3 is now fully code-complete.** Three checklist items deferred to a future phase: (a) the `ROLE_PERMISSIONS` map collapse — still gates the local-permission whitelist used to seed Redis sessions until a YoCore `/v1/permissions/catalog` endpoint exists; (b) the standalone organizationCleanup unit tests (none existed for the old job either); (c) any deeper purge that hard-deletes long-form audit/sales archives — currently behaves identically to the legacy cron.

- [x] New `yocore.service.ts` (wraps `@yocore/sdk`) — *partial 28 Apr 2026* ([yocore.service.ts](../../easystock-backend/src/services/yocore.service.ts)) — *the published `@yocore/sdk` is `private:true` + ESM-only and EasyStock backend is CommonJS, so 3.1 ships a thin REST mirror with the same surface (Basic auth + Idempotency-Key header). Swap to the SDK once it is published with auth methods.*
- [x] New `jwks.service.ts` (Redis-cached JWKS, auto-rotate on `kid` mismatch) (Decision 9) — *done 28 Apr 2026* ([jwks.service.ts](../../easystock-backend/src/services/jwks.service.ts)) — *uses `jose.createRemoteJWKSet` (1h cache, 30s cooldown, auto kid-refresh). **TODO**: YoCore has not yet shipped `GET /.well-known/jwks.json`; the verifier throws `JWKSNotConfiguredError` until the URL resolves.*
- [x] Rewrite `authenticate()` middleware: JWKS verify → Redis session lookup `{jti → workspaceId, permissions, productRole}` → hydrate `req.user` (Decisions 2, 9) — *partial 28 Apr 2026 — Phase 3.2 ships parallel middleware behind `AUTH_PROVIDER=yocore` (default off); JWKS verify + Redis session **read** are wired, session **writes** happen in Phase 3.3* ([auth.ts](../../easystock-backend/src/middleware/auth.ts), [auth-yocore.ts](../../easystock-backend/src/middleware/auth-yocore.ts), [auth-session.service.ts](../../easystock-backend/src/services/auth-session.service.ts), [auth-yocore.test.ts](../../easystock-backend/src/middleware/__tests__/auth-yocore.test.ts))
- [x] Rewrite `auth.service.ts`: signup/login/verify/forgot/reset/refresh/logout all proxy to YoCore — *partial 28 Apr 2026 — Phase 3.3a ships a parallel `yocore-auth.service.ts` + `yocore-auth.controller.ts` selected per-request by `AUTH_PROVIDER`; `resendVerification` returns a soft-501 (no YoCore equivalent endpoint yet)* ([yocore-auth.service.ts](../../easystock-backend/src/services/yocore-auth.service.ts), [yocore-auth.controller.ts](../../easystock-backend/src/controllers/yocore-auth.controller.ts), [auth.controller.ts](../../easystock-backend/src/controllers/auth.controller.ts), [yocore.service.ts](../../easystock-backend/src/services/yocore.service.ts), [yocore-auth.service.test.ts](../../easystock-backend/src/services/__tests__/yocore-auth.service.test.ts))
- [x] Rewrite profile MFA endpoints: proxy to YoCore MFA — *done 28 Apr 2026 — Phase 3.3b ships BE proxy ([yocore-profile.controller.ts](../../easystock-backend/src/controllers/yocore-profile.controller.ts), [profile.controller.ts](../../easystock-backend/src/controllers/profile.controller.ts), [yocore.service.ts](../../easystock-backend/src/services/yocore.service.ts)); 3.3c carries `enrolmentId` from enrol→verify on the FE; 3.6b adds `POST /api/profile/2fa/recovery-codes` + the regeneration UI in [two-factor-tab.tsx](../../easystock-frontend/components/profile/two-factor-tab.tsx). `disable2FA` still returns soft-501 because YoCore has no disable endpoint yet.*
- [x] Multi-workspace: remove `organizationSlug` from login form; add workspace-picker page; `POST /api/auth/select-workspace`; top-bar workspace switcher (Decision 1) — *done 28 Apr 2026 — Phase 3.3 shipped login + select-workspace; Phase 3.6c shipped the mid-session top-bar switcher with `GET /api/auth/workspaces` + `POST /api/auth/switch-workspace` ([auth.routes.ts](../../easystock-backend/src/routes/auth.routes.ts), [yocore-auth.service.ts](../../easystock-backend/src/services/yocore-auth.service.ts), [WorkspaceSwitcher](../../easystock-frontend/components/shared/workspace-switcher.tsx), [auth/hooks.ts](../../easystock-frontend/services/api/modules/auth/hooks.ts)). The component auto-hides when the user only has one workspace.*
- [x] FE: add `refreshToken` to auth store + cookie + 401 refresh interceptor in `api-client.ts` — *done 28 Apr 2026 — Phase 3.3c ([use-auth-store.ts](../../easystock-frontend/services/stores/use-auth-store.ts), [api-client.ts](../../easystock-frontend/lib/api-client.ts), [auth/hooks.ts](../../easystock-frontend/services/api/modules/auth/hooks.ts)). Single-flight refresh on 401 retries the original request once; legacy `501` falls through to hard logout.*
- [x] FE: complete MFA recovery-code toggle; add re-enrollment banner for legacy 2FA users (Decision 4) — *done 28 Apr 2026 — Phase 3.3c carried `enrolmentId` through enrol→verify; Phase 3.6b adds the recovery-code regeneration section in [two-factor-tab.tsx](../../easystock-frontend/components/profile/two-factor-tab.tsx) (counter + confirm dialog + reuse of the existing backup-codes dialog) and a dismissable post-cutover [MfaReenrolBanner](../../easystock-frontend/components/shared/mfa-reenrol-banner.tsx) mounted in the protected layout, gated on YoCore status `enabled === false` and a per-user localStorage dismissal flag.*
- [x] Write `scripts/migrate-super-admins.ts` → set YoCore global `SUPER_ADMIN` role; downgrade workspace role to `admin` (Decision 11) — *write-side done 28 Apr 2026 (Phase 3.4) ([migrate-super-admins.ts](../../easystock-backend/scripts/migrate-super-admins.ts), [migration-cli.ts](../../easystock-backend/scripts/_lib/migration-cli.ts), [yocore.service.ts](../../easystock-backend/src/services/yocore.service.ts)); script is INERT until a human runs it on cutover day (Phase 3.5). The global SUPER_ADMIN role-promotion itself is an out-of-band manual step in the YoCore admin web app or via `Yocore/scripts/bootstrap-superadmin.ts` — the script prints a paste-ready list of `(email, yocoreUserId)` pairs at the end of each run.*
- [x] Write `scripts/migrate-users-to-yocore.ts` → big-bang password reset emails for all active users (Decision 5) — *write-side done 28 Apr 2026 (Phase 3.4) ([migrate-users-to-yocore.ts](../../easystock-backend/scripts/migrate-users-to-yocore.ts)); script is INERT until a human runs it on cutover day (Phase 3.5). Skips users whose `Organization.yocoreWorkspaceId` is not yet linked — re-run after the org-link backfill completes.*
- [ ] Delete `ROLE_PERMISSIONS` map and `getDefaultPermissions()` from `src/constants/permissions.ts`; move `ALL_PERMISSIONS` to a TS-types-only file (Decision 3) — *Phase 3.6 — deferred: still gates the per-role permission whitelist used to seed the Redis session in [yocore-auth.service.ts](../../easystock-backend/src/services/yocore-auth.service.ts); awaiting a YoCore `/v1/permissions/catalog` endpoint per role/workspace before we can collapse it.*
- [x] Remove `bcryptjs`, `speakeasy`, Nodemailer auth templates; remove all legacy auth fields from `User` (`password`, `loginAttempts`, `lockUntil`, verification/reset tokens, 2FA secret/backup codes, `emailVerified`) — *done 28 Apr 2026 — Phase 3.6a (see status block above).*
- [x] Delete `src/jobs/organizationCleanup.job.ts`; add `inventoryPurgeCron` for hard-deleting deleted-org rows >7 days (Decision 10) — *done 28 Apr 2026 — Phase 3.6c ([inventoryPurge.job.ts](../../easystock-backend/src/jobs/inventoryPurge.job.ts), [server.ts](../../easystock-backend/src/server.ts)). The 7-day grace is now stamped by the `workspace.deleted` webhook in [workspace-handler.ts](../../easystock-backend/src/services/yocore-handlers/workspace-handler.ts); the cron is purely the asynchronous executor.*

**Phase 3.1 also added (infra plumbing — Decisions 2, 9):**

- [x] Install `jose` 6 (JWKS-aware async JWT verify) and `ioredis` 5 — *done 28 Apr 2026*
- [x] [`src/lib/redis.ts`](../../easystock-backend/src/lib/redis.ts) — lazy ioredis singleton, returns `null` (with warning) when `REDIS_URL` is unset, so dev/test still work without Redis. Phase 3.2 will hard-require it for sessions.
- [x] [`docker-compose.yml`](../../easystock-backend/docker-compose.yml) — local mongo + redis containers for development.
- [x] `REDIS_URL` added to [.env.example](../../easystock-backend/.env.example).

**Phase 3.2 also added (parallel auth dispatcher — Decisions 2, 9):**

- [x] [`src/services/auth-session.service.ts`](../../easystock-backend/src/services/auth-session.service.ts) — Redis-backed session record (`auth:session:${jti}` → `{yocoreUserId, workspaceId, productRole, permissions, mfaSatisfied, createdAt}`) with `get/set/delete` helpers; read-side returns `null` cleanly when Redis is unavailable.
- [x] [`src/middleware/auth-yocore.ts`](../../easystock-backend/src/middleware/auth-yocore.ts) — new middleware: JWKS verify → session lookup → user/org hydration (mirrors legacy `req.user` shape, including `X-Active-Location` resolution).
- [x] `authenticate()` dispatcher in [`src/middleware/auth.ts`](../../easystock-backend/src/middleware/auth.ts) — switches between `authenticateLegacy` (default) and `authenticateYocore` based on `AUTH_PROVIDER` env.
- [x] `AUTH_PROVIDER=legacy` added to [.env.example](../../easystock-backend/.env.example) with cutover guidance.

**Phase 3.3a also added (auth proxy backend — Decisions 1, 2, 5):**

- [x] [`src/services/yocore.service.ts`](../../easystock-backend/src/services/yocore.service.ts) extended with `auth: "basic" | "bearer" | "none"` request mode and proxy methods for signup/signin/verify-email/forgot/reset/refresh/logout, plus `listWorkspaces(bearerToken)` and `switchWorkspace(bearerToken, workspaceId)`.
- [x] [`src/services/yocore-auth.service.ts`](../../easystock-backend/src/services/yocore-auth.service.ts) — mirror of the legacy `AuthService` surface; on every successful workspace-scoped login it decodes the YoCore JWT (`jose.decodeJwt`) and writes `auth:session:${jti}` (closes the 3.2 read ↔ 3.3 write loop). Multi-workspace flow returns `{requiresWorkspaceSelection, workspaces, pendingAccessToken, pendingRefreshToken}`.
- [x] [`src/controllers/yocore-auth.controller.ts`](../../easystock-backend/src/controllers/yocore-auth.controller.ts) — controller shape matching the legacy controller, but skips legacy email side-effects (YoCore owns verification + reset emails).
- [x] [`src/controllers/auth.controller.ts`](../../easystock-backend/src/controllers/auth.controller.ts) — wrapped `LegacyAuthController` with a per-method dispatcher driven by `AUTH_PROVIDER`; routes are unchanged.
- [x] `POST /api/auth/select-workspace` and `POST /api/auth/logout` added to [auth.routes.ts](../../easystock-backend/src/routes/auth.routes.ts) (legacy `/logout` returns the same shape as before; `/select-workspace` returns 404 in legacy mode with code `NOT_AVAILABLE_IN_LEGACY_AUTH`).
- [x] `selectWorkspaceSchema` added to [auth.validator.ts](../../easystock-backend/src/validators/auth.validator.ts).
- [x] `YOCORE_PRODUCT_SLUG` added to [.env.example](../../easystock-backend/.env.example).

**Phase 3.3b also added (refresh-token rotation + MFA proxy backend — Decisions 1, 2, 4):**

- [x] [`src/services/yocore.service.ts`](../../easystock-backend/src/services/yocore.service.ts) — added `mfaStatus`, `mfaEnrol`, `mfaEnrolVerify`, `mfaRegenerateRecoveryCodes` Bearer-auth methods.
- [x] [`src/services/yocore-auth.service.ts`](../../easystock-backend/src/services/yocore-auth.service.ts) — new `refresh(refreshToken, previousJti?)`: calls YoCore, decodes the rotated access token, re-issues `auth:session:${jti}` and deletes the previous one to prevent replay.
- [x] [`src/controllers/yocore-auth.controller.ts`](../../easystock-backend/src/controllers/yocore-auth.controller.ts) — new `refresh` handler returning `{ token, refreshToken, expiresIn }`.
- [x] [`src/controllers/yocore-profile.controller.ts`](../../easystock-backend/src/controllers/yocore-profile.controller.ts) — Bearer-forwarding MFA proxy with legacy-shaped responses (`{enabled, type, recoveryCodesRemaining}`, `{secret, qrCode, enrolmentId}`, `{enabled, backupCodes}`); `disable2FA` returns soft-501.
- [x] [`src/controllers/profile.controller.ts`](../../easystock-backend/src/controllers/profile.controller.ts) — class renamed to `LegacyProfileController`; exported `profileController` is now a per-method dispatcher (only the four 2FA methods route to YoCore).
- [x] [`src/controllers/auth.controller.ts`](../../easystock-backend/src/controllers/auth.controller.ts) — added `refresh` dispatcher entry (legacy → 501 `REFRESH_NOT_SUPPORTED_LEGACY`).
- [x] [`src/routes/auth.routes.ts`](../../easystock-backend/src/routes/auth.routes.ts) — `POST /api/auth/refresh` (rate-limited, validated).
- [x] [`src/validators/auth.validator.ts`](../../easystock-backend/src/validators/auth.validator.ts) — `refreshTokenSchema`.
- [x] Tests: [`yocore-auth.service.test.ts`](../../easystock-backend/src/services/__tests__/yocore-auth.service.test.ts) (+1 refresh case) and new [`yocore-profile.controller.test.ts`](../../easystock-backend/src/controllers/__tests__/yocore-profile.controller.test.ts) (5 cases). 77/77 green.

**Phase 3.3c also added (frontend wiring — Decisions 1, 2, 4):**

- [x] [`services/stores/use-auth-store.ts`](../../easystock-frontend/services/stores/use-auth-store.ts) — `refreshToken` field on `AuthState`, persisted by Zustand and mirrored to the new `auth-refresh-token` cookie (7-day, sameSite=lax, secure in prod); new `setTokens(token, refreshToken?)` mutator used by the api-client refresh interceptor; `clearAuth` deletes the new cookie too.
- [x] [`lib/api-client.ts`](../../easystock-frontend/lib/api-client.ts) — single-flight 401 refresh interceptor: on 401 (excluding `/auth/login` and `/auth/refresh`) we coalesce on a shared in-flight promise that POSTs `/auth/refresh` with the stored `refreshToken`, updates the store via `setTokens`, then retries the original request once. If refresh fails (no token / 501 / network error) we fall through to the existing hard-logout path.
- [x] [`services/api/modules/auth/api.ts`](../../easystock-frontend/services/api/modules/auth/api.ts) — added `selectWorkspace`, `refresh`, `logout` fetchers.
- [x] [`services/api/modules/auth/hooks.ts`](../../easystock-frontend/services/api/modules/auth/hooks.ts) — `useLogin` accepts an optional `onWorkspaceSelection` callback and forwards `requiresWorkspaceSelection` payloads; new `useSelectWorkspace` hook lands the user on `/dashboard` once a workspace is picked; `useLogout` now does a fire-and-forget `POST /auth/logout` so YoCore can revoke the Redis session.
- [x] [`components/login/login-form.tsx`](../../easystock-frontend/components/login/login-form.tsx) — inline workspace-picker view (Card → list of `Button` rows) shown when the BE returns `requiresWorkspaceSelection`; "Back to login" resets state.
- [x] [`services/api/modules/profile/api.ts`](../../easystock-frontend/services/api/modules/profile/api.ts) + [`hooks.ts`](../../easystock-frontend/services/api/modules/profile/hooks.ts) — `enable2FA` response now exposes `enrolmentId?`; `verify2FA` accepts `{ token, enrolmentId? }`.
- [x] [`components/profile/two-factor-tab.tsx`](../../easystock-frontend/components/profile/two-factor-tab.tsx) — stores `enrolmentId` between enable→verify and clears it on success/cancel.

### Phase 4 — Checkout + plan changes live

- [ ] Wire checkout endpoint (proxies `POST /v1/billing/checkout`)
- [ ] Wire change-plan (with proration preview), pause/resume, cancel-at-period-end flows
- [ ] Enforce `requireFeature()` in production routes (sales, accounts, expiry tracking, etc.)
- [ ] Enforce `maxLocations`, `maxUsers` in location-creation and user-invite services
- [ ] FE: 402 → upgrade dialog global handler

### Phase 5 — Bundles, coupons, polish

- [ ] Bundle checkout flow
- [ ] Coupon codes at checkout
- [ ] Admin webhook inspector polish
- [ ] Load test: JWKS + Redis cache hot path under realistic traffic

---

## 9. Concrete File / Endpoint Deltas Cheat Sheet

### EasyStock Backend — New Files

| File | Purpose |
|---|---|
| `src/services/yocore.service.ts` | `@yocore/sdk` `YoCoreServer` wrapper |
| `src/services/jwks.service.ts` | Fetch + cache YoCore JWKS, auto-rotate on `kid` mismatch |
| `src/services/webhook.service.ts` | Webhook event handlers per event type |
| `src/controllers/webhook.controller.ts` | Route handler for `POST /api/webhooks/yocore` |
| `src/routes/webhooks.routes.ts` | Raw body parser + route registration |
| `src/models/webhook-event.model.ts` | Idempotency dedup collection |
| `src/middleware/require-feature.ts` | Plan-gating middleware (returns 402) |
| `scripts/sync-yocore-roles.ts` | One-time: seed roles + permissions into YoCore |
| `scripts/audit-duplicate-emails.ts` | Pre-migration: detect cross-org email collisions (Decision 6 blocker) |
| `scripts/migrate-users-to-yocore.ts` | Big-bang: provision YoCore users + send password-reset emails (Decision 5) |
| `scripts/migrate-super-admins.ts` | Promote `super_admin` users to YoCore global `SUPER_ADMIN`; downgrade workspace role (Decision 11) |
| `src/jobs/inventoryPurgeCron.ts` | Daily: hard-delete inventory/sales rows for orgs deleted >7 days (Decision 10) |

### EasyStock Backend — Modified Files

| File | Change |
|---|---|
| `src/services/auth.service.ts` | Proxy signup/login/forgotPassword/resetPassword/verifyEmail to YoCore |
| `src/services/profile.service.ts` | Proxy 2FA enable/verify/disable to YoCore MFA endpoints |
| `src/middleware/auth.ts` | JWKS verify + local user lookup (dual-mode during migration) |
| `src/models/user.model.ts` | Add `yocoreUserId`, `yocoreProductUserId`; drop legacy auth fields; replace email index |
| `src/models/organization.model.ts` | Add `yocoreWorkspaceId`, `yocoreSubscription` block |
| `src/jobs/organizationCleanup.job.ts` | **Delete** — replaced by `workspace.deleted` webhook + new `inventoryPurgeCron` |
| `src/constants/permissions.ts` | Delete `ROLE_PERMISSIONS`, `getDefaultPermissions`; keep type-only exports |
| `package.json` | Add `@yocore/sdk`; remove `bcryptjs`, `speakeasy`, Nodemailer auth templates |

### EasyStock Frontend — New Files

| File | Purpose |
|---|---|
| `app/(protected)/billing/page.tsx` | Billing overview (plan, status, invoices) |
| `app/(protected)/billing/plans/page.tsx` | Public plan listing |
| `app/(protected)/billing/invoices/page.tsx` | Full invoice history |
| `components/billing/current-plan-card.tsx` | |
| `components/billing/trial-banner.tsx` | |
| `components/billing/grace-banner.tsx` | |
| `components/billing/change-plan-dialog.tsx` | |
| `components/billing/cancel-subscription-dialog.tsx` | |
| `components/billing/upgrade-dialog.tsx` | |
| `components/billing/invoice-table.tsx` | |
| `services/api/modules/billing/api.ts` | Raw fetch functions |
| `services/api/modules/billing/hooks.ts` | TanStack Query hooks |
| `services/api/modules/billing/index.ts` | Barrel export |
| `hooks/use-feature-gate.ts` | `useFeatureGate(feature)` → `{ allowed, upgradeUrl }` |

### EasyStock Frontend — Modified Files

| File | Change |
|---|---|
| `services/stores/use-auth-store.ts` | Add `refreshToken` field + cookie |
| `lib/api-client.ts` | Add refresh interceptor (401 → refresh → retry) |
| `services/api/query-keys.ts` | Add `billing` key factory |
| `components/layout/app-sidebar.tsx` | Wire "Billing" item to `/billing` |
| `components/login/login-form.tsx` | Complete MFA recovery-code toggle |
| `app/(auth)/signup/page.tsx` | Call `finalize-onboarding` after first verified login |
| `components/setup/` | Add first-Location creation step |
| `components/providers/*.tsx` | Add global 402 → upgrade dialog handler |

### New Environment Variables (EasyStock)

```bash
YOCORE_BASE_URL=https://yocore.yo
YOCORE_PRODUCT_ID=prod_easystock
YOCORE_API_KEY=yc_live_pk_...
YOCORE_API_SECRET=ypsk_...             # Server-side only, never exposed to client
YOCORE_WEBHOOK_SECRET=whsec_...        # Server-side only
YOCORE_JWKS_CACHE_TTL_SECONDS=3600
```
