# YoCore — Master Implementation Checklist

> **Source plan:** `/memories/session/plan.md` · **Source docs:** [YoCore-PRD.md](YoCore-PRD.md), [YoCore-System-Design.md](YoCore-System-Design.md), [docs/v1.8-addendum.md](docs/v1.8-addendum.md)
>
> **Convention:** Tick `- [x]` when **fully complete + tests green + reviewed**. One commit per logical group.
> **Coverage gates:** `apps/api` ≥85%, security utils 100%.

---

## Phase 0 — Doc & Architecture Hardening

### 0.1 Apply 10 design improvements (companion docs)
- [x] `docs/v1.8-addendum.md` — covers all 10 improvements in one canonical place
- [x] `docs/error-codes.md` — full ErrorCode enum + HTTP mapping
- [x] `docs/openapi-strategy.md` — `zod-to-openapi` pipeline spec
- [x] `docs/deployment.md` — Docker, ECS, Atlas, Upstash, S3, Secrets Manager
- [x] `docs/dev-setup.md` — local install, docker-compose, seed data
- [x] `docs/runbooks/ip-allowlist-recovery.md`
- [x] `docs/runbooks/stripe-webhook-replay.md`
- [x] `docs/runbooks/sslcommerz-desync.md`
- [x] `docs/runbooks/mfa-lockout-recovery.md`
- [x] `docs/runbooks/disaster-recovery.md`
- [x] `docs/runbooks/jwt-key-compromise.md`

### 0.2 Canonical artifacts
- [x] `docs/testing-strategy.md` — coverage targets, pyramid, fixtures
- [x] `docs/security-audit.md` — OWASP Top 10 mapping
- [x] `docs/adr/ADR-001-multi-tenancy-model.md`
- [x] `docs/adr/ADR-002-per-product-identity.md`
- [x] `docs/adr/ADR-003-api-key-secret-model.md`
- [x] `docs/adr/ADR-004-billing-scope-user-vs-workspace.md`
- [x] `docs/adr/ADR-005-stripe-as-billing-calendar-for-sslcommerz.md`
- [x] `docs/adr/ADR-006-jwt-dual-keyring-rotation.md`
- [x] `docs/adr/ADR-007-argon2id-worker-pool.md`
- [x] `docs/adr/ADR-008-mongo-distributed-cron-locks.md`
- [x] `docs/adr/ADR-009-webhook-idempotency-strategy.md`
- [x] `docs/adr/ADR-010-mandatory-mfa-for-super-admin.md`
- [x] Root `TASKS.md` (this file)

---

## Phase 1 — Monorepo Foundation

### 1.1 Repo scaffold
- [x] `package.json` (root, pnpm workspaces)
- [x] `pnpm-workspace.yaml`
- [x] `turbo.json`
- [x] `tsconfig.base.json`
- [x] `.eslintrc.cjs`
- [x] `.prettierrc` + `.prettierignore`
- [x] `.editorconfig`
- [x] `.gitignore`
- [x] `.nvmrc`
- [x] `.env.example`
- [x] `commitlint.config.cjs`
- [ ] `.husky/pre-commit` + `.husky/commit-msg` (run `pnpm install` once to generate)
- [x] `.github/workflows/ci.yml` (typecheck, lint, unit, integration)
- [ ] `.github/workflows/deploy-staging.yml` (Phase 5)
- [ ] `.github/workflows/deploy-prod.yml` (Phase 5)
- [x] `docker-compose.yml` (Mongo replica set + Redis + Mailhog)

### 1.2 Workspace layout
- [x] `apps/api/package.json` + `tsconfig.json`
- [x] `apps/admin-web/package.json` + `tsconfig.json` + `vite.config.ts`
- [x] `apps/auth-web/package.json` + `tsconfig.json` + `vite.config.ts`
- [x] `apps/demo-yopm/package.json` + `tsconfig.json`
- [x] `packages/types/package.json` + `tsconfig.json`
- [x] `packages/sdk/package.json` + `tsconfig.json`
- [x] `packages/config/package.json` (shared eslint/vitest presets)
- [x] `packages/test-utils/package.json` + `tsconfig.json`
- [x] `scripts/seed-dev.ts` (skeleton)
- [x] `scripts/bootstrap-superadmin.ts` (skeleton)

### 1.3 copilot-instructions.md (very detailed, per-app)
- [x] `.github/copilot-instructions.md` (root — global rules)
- [x] `apps/api/.github/copilot-instructions.md`
- [x] `apps/admin-web/.github/copilot-instructions.md`
- [x] `apps/auth-web/.github/copilot-instructions.md`
- [x] `apps/demo-yopm/.github/copilot-instructions.md`
- [x] `packages/types/.github/copilot-instructions.md`
- [x] `packages/sdk/.github/copilot-instructions.md`

---

## Phase 2 — Backend Core (`apps/api`)

### 2.1 Infra primitives
- [x] `src/index.ts` (server entry, graceful shutdown)
- [x] `src/app.ts` (Express factory, used by tests too)
- [x] `src/config/env.ts` (Zod-validated env loader)
- [x] `src/config/db.ts` (Mongo connection, replica set, retry)
- [x] `src/config/redis.ts` (ioredis client with TLS for Upstash)
- [x] `src/config/aws.ts` (S3, Secrets Manager, KMS clients)
- [x] `src/lib/logger.ts` (Pino with redaction list)
- [x] `src/lib/errors.ts` (`AppError`, `ErrorCode` re-export from `@yocore/types`)
- [x] `src/lib/argon2-pool.ts` (piscina worker pool)
- [x] `src/lib/cron-runner.ts` (Agenda + cronLocks integration)

### 2.2 Crypto/security utilities
- [x] `src/lib/password.ts` (Argon2id verify/hash via worker pool)
- [x] `src/lib/tokens.ts` (raw token + sha256 helpers)
- [x] `src/lib/encryption.ts` (AES-256-GCM with KMS DEK)
- [x] `src/lib/jwt.ts` (sign w/ active key, verify across keyring)
- [x] `src/lib/jwt-keyring.ts` (in-memory keyring + reload on pub/sub)
- [x] `src/lib/webhook-signature.ts` (HMAC-SHA256, timing-safe verify)
- [x] `src/lib/circuit-breaker.ts` (opossum wrappers + Prometheus gauges)
- [x] `src/lib/correlation-id.ts` (cls-hooked context)

### 2.3 DB models (Mongoose) — all 23+ collections
- [x] `src/db/models/User.ts`
- [x] `src/db/models/Session.ts`
- [x] `src/db/models/AuthToken.ts`
- [x] `src/db/models/Product.ts`
- [x] `src/db/models/ProductUser.ts`
- [x] `src/db/models/Workspace.ts`
- [x] `src/db/models/WorkspaceMember.ts`
- [x] `src/db/models/Role.ts`
- [x] `src/db/models/BillingPlan.ts`
- [x] `src/db/models/Subscription.ts`
- [x] `src/db/models/PaymentGateway.ts`
- [x] `src/db/models/Invitation.ts`
- [x] `src/db/models/WebhookDelivery.ts`
- [x] `src/db/models/AuditLog.ts`
- [x] `src/db/models/Bundle.ts`
- [x] `src/db/models/WebhookEventProcessed.ts`
- [x] `src/db/models/CronLock.ts`
- [x] `src/db/models/MfaFactor.ts`
- [x] `src/db/models/DataExportJob.ts`
- [x] `src/db/models/DeletionRequest.ts`
- [x] `src/db/models/JwtSigningKey.ts`
- [x] `src/db/models/EmailQueue.ts`
- [x] `src/db/models/EmailEvent.ts`
- [ ] `src/db/models/Coupon.ts` (v1.5)
- [ ] `src/db/models/CouponRedemption.ts` (v1.5)
- [ ] `src/db/models/Invoice.ts` (v1.5)
- [ ] `src/db/models/AuditLogExportJob.ts` (v1.5)
- [ ] `src/db/models/TosVersion.ts` (v1.5)
- [ ] `src/db/models/MfaRecoveryRequest.ts` (v1.5)
- [ ] `src/db/models/IdempotencyKey.ts` (v1.5)
- [ ] `src/db/models/UsageRecord.ts` (v1.7)
- [ ] `src/db/models/CustomerTaxProfile.ts` (v1.7)
- [ ] `src/db/models/PaymentMethodCache.ts` (v1.7)
- [ ] `src/db/models/SuperAdminConfig.ts` (v1.7)
- [x] `src/db/index.ts` (exports + index registration)
- [ ] `src/db/migrations/` (migrate-mongo setup)

### 2.4 Cross-cutting middleware (in chain order)
- [x] `src/middleware/correlation-id.ts`
- [x] `src/middleware/security-headers.ts` (helmet config)
- [x] `src/middleware/cors.ts` (per-product allowlist)
- [x] `src/middleware/rate-limit.ts` (Redis token bucket + headers)
- [x] `src/middleware/api-key.ts` (Flow E)
- [x] `src/middleware/jwt-auth.ts` (dual-check: Redis + Mongo fallback)
- [x] `src/middleware/idempotency.ts` (Redis cache + Mongo)
- [x] `src/middleware/audit-log.ts` (auto-fire on state changes)
- [x] `src/middleware/error-handler.ts` (final error mapper)
- [x] `src/middleware/not-found.ts`

### 2.5 Repos + services scaffolding
- [x] `src/repos/` directory + base repo pattern
- [x] `src/services/` directory + base service pattern
- [x] `src/handlers/` directory + base handler pattern
- [x] `src/router.ts` (mounts all routes)

### 2.6 Smoke test
- [ ] `GET /v1/health` returns 200
- [ ] `GET /v1/health/deep` validates Mongo + Redis + S3
- [ ] Bootstrap script creates SUPER_ADMIN successfully

---

## Phase 3 — Backend Vertical Slices (Flows A → AN)

> **Per-flow checklist template (apply to each):**
> 1. Zod schema in `packages/types`
> 2. Repo function (Mongo access only)
> 3. Service function (business logic, no Express)
> 4. Handler (Express route, Zod-validated)
> 5. Audit log emission
> 6. Outbound webhook emission (if state change)
> 7. Unit tests (Vitest)
> 8. Integration tests (supertest + MongoDB Memory Server)
> 9. OpenAPI registration

### 3.1 Auth & Identity
- [ ] **Flow A** — Super Admin bootstrap + signin (`POST /v1/admin/bootstrap`, `POST /v1/auth/signin`)
- [ ] **Flow A1b/c, V** — Super Admin TOTP enroll + verify + recovery codes
- [ ] **Flow F** — End-user signup (constant-time response, FIX-AUTH-TIMING)
- [ ] **Flow F10** — Email verification (`GET /v1/auth/verify-email`)
- [ ] **Flow F11/12** — Auto-login + finalize onboarding
- [ ] **Flow H1** — Signin with lockout + per-product credentials
- [ ] **Flow H2** — Refresh token rotation + family theft detection
- [ ] **Flow H3** — Logout single + logout-all
- [ ] **Flow I** — Cross-product join (same email, second product)
- [ ] **Flow O** — Forgot password + reset
- [ ] **Flow P** — Email change + global session revoke
- [ ] **Flow AB** — End-user MFA enroll + signin + recovery
- [ ] **Flow AH** — New-device alert email
- [ ] **Flow U** — Hosted Auth: `/authorize` + `/exchange` (PKCE)
- [ ] **Flow AI** — Email preferences + RFC 8058 unsubscribe
- [ ] Email queue worker + email events handler (Resend/SES)

### 3.2 Workspaces, Members, Roles, Permissions
- [ ] **Flow L** — Workspace CRUD + switcher
- [ ] **Flow M** — Invitations (existing-user + new-user paths, 72h TTL)
- [ ] **Flow Z** — Workspace ownership transfer (re-auth required)
- [ ] **Flow AA** — Voluntary workspace deletion + 30d grace
- [ ] Roles seed (OWNER/ADMIN/MEMBER/VIEWER) per product
- [ ] `POST /v1/permissions/check` (Redis cache 60s + pub/sub invalidation)
- [ ] `GET /v1/permissions/catalog`

### 3.3 Products & Gateway Config
- [ ] **Flow B** — Product registry (create, activate, secret rotation)
- [ ] **Flow AJ** — Webhook secret rotation w/ 24h grace
- [ ] **Flow C1/C2** — Stripe + SSLCommerz add/verify (encrypted credentials)
- [ ] **Flow C3/C4** — PayPal + Paddle schema placeholders (Coming Soon UI)
- [ ] **Flow C5** — Billing config (gateway routing per currency)

### 3.4 Plans, Subscriptions, Checkout
- [ ] **Flow D** — Plan CRUD + publish + Stripe price sync
- [ ] **Flow AO** — Plan archival cascade
- [ ] Public plan endpoint (cached 5m, YC-015)
- [ ] **Flow J** — Stripe checkout + webhook handlers (`webhookEventsProcessed` dedup)
- [ ] **Flow J (SSLCommerz)** — Two-step IPN flow + Stripe-as-billing-calendar
- [ ] **Flow G** — Trial flow + `billing.trial.tick` cron
- [ ] **Flow R / AE** — Plan upgrade/downgrade + preview + seat-overflow guard
- [ ] **Flow S** — Seat change
- [ ] **Flow AC** — Pause/resume
- [ ] **Flow AF** — Coupon validation + redemption
- [ ] **Flow AD** — Refund (admin)
- [ ] **Flow AG** — Gateway migration
- [ ] **Flow N** — Failed-payment grace lifecycle (`grace.tick`, `hold.warnings`, `deletion.tick`)
- [ ] Invoice cache + sync (B-10)
- [ ] Tax profile (YC-005) + Stripe Automatic Tax integration

### 3.5 Bundles
- [ ] **Flow AL** — Bundle CRUD + publish + archive (mandatory pre-publish validation)
- [ ] **Flow T** — Bundle checkout w/ eligibility policy
- [ ] **Flow AK** — Bundle cancel cascade cron
- [ ] **Flow AM** — Component plan-swap (P1)
- [ ] **Flow AN** — Standalone↔bundle migration (P1)

### 3.6 GDPR, Sessions, Compliance
- [ ] **Flow W** — Data export async worker → S3 → signed URL email (24h cooldown)
- [ ] **Flow X** — Account/per-product self-deletion + 30d grace + `gdpr.deletion.tick`
- [ ] Session list/revoke endpoints
- [ ] ToS/privacy versioning + acceptance gate (B-05)
- [ ] Email deliverability re-enable cron (`email.deliverability.review` — addendum #8)

### 3.7 Admin Operations
- [ ] **Flow Y** — JWT key rotation + `jwt.key.retire` cron + keyring pub/sub reload
- [ ] Admin: extend trial, extend grace, force status, apply credit
- [ ] Admin: refund, gateway migrate, audit log export (GAP-21)
- [ ] Cron status + force-run endpoints
- [ ] Health endpoints (`/v1/health`, `/v1/health/deep`)
- [ ] Super Admin IP allowlist + bypass env (YC-010)
- [ ] Webhook delivery monitor + manual retry (GAP-14)
- [ ] **Addendum #6** — `GET /v1/users/me/mfa/status`
- [ ] **Addendum #7** — `GET /v1/entitlements/:workspaceId?includeGrandfatheringInfo=true`

### 3.8 Outbound Webhooks
- [ ] Webhook delivery worker (30s/5m/30m/2h/6h backoff, max 5 → DEAD)
- [ ] S3 payload archival (compressed) with reference in Mongo
- [ ] HMAC-SHA256 signature header
- [ ] All event emitters wired (per PRD §3.8 webhook table)
- [ ] Webhook payload versioning (YC-016)

---

## Phase 4 — Frontends, SDK, Demo, E2E

### 4.1 `packages/types` (build first; consumed by everything)
- [ ] `src/errors/error-codes.ts` — full enum
- [ ] `src/errors/app-error.ts`
- [ ] `src/schemas/auth.ts` (signup, signin, refresh, logout, etc.)
- [ ] `src/schemas/users.ts`
- [ ] `src/schemas/workspaces.ts`
- [ ] `src/schemas/billing.ts`
- [ ] `src/schemas/bundles.ts`
- [ ] `src/schemas/admin.ts`
- [ ] `src/schemas/webhooks.ts` (outbound payloads)
- [ ] `src/constants/` (statuses, roles, intervals, limits)
- [ ] `src/index.ts` (barrel)
- [ ] Tests: schema valid + invalid round-trip per schema

### 4.2 `packages/sdk`
- [ ] `src/server.ts` — `YoCoreServer` (API key+secret)
- [ ] `src/client.ts` — `YoCoreClient` (browser, PKCE helpers)
- [ ] `src/verify-webhook.ts` (timing-safe HMAC)
- [ ] `src/retry.ts` (rate-limit-aware exponential backoff)
- [ ] README + usage examples
- [ ] Tests: signature verify, retry behavior

### 4.3 `apps/admin-web`
- [ ] Vite + React 18 + Tailwind + shadcn/ui scaffolding
- [ ] React Router v6 + auth guard (Super Admin JWT + MFA gate)
- [ ] TanStack Query setup + API client
- [ ] **Screen 1** — Home dashboard (polling for non-blocking aggregations)
- [ ] **Screen 2** — Product Detail
- [ ] **Screen 3** — Product Users
- [ ] **Screen 4** — User Detail
- [ ] **Screen 5** — Product Workspaces
- [ ] **Screen 6** — Workspace Detail
- [ ] **Screen 7** — Product Billing Plans
- [ ] **Screen 8** — Plan Detail
- [ ] **Screen 9** — Product Settings
- [ ] **Screen 10** — All Users Search
- [ ] **Screen 11** — Bundles List
- [ ] **Screen 11a** — Bundle Detail (6 tabs)
- [ ] **Screen 12** — Announcements
- [ ] **Screen 13** — Super Admin Settings
- [ ] Vercel deployment config

### 4.4 `apps/auth-web` (PKCE / Hosted Auth)
- [ ] Login / Signup / Forgot / Reset / MFA challenge / Email verify pages
- [ ] Reads product theme from `GET /v1/products/:slug/auth-config`
- [ ] PKCE flow implementation
- [ ] Vercel deployment config

### 4.5 `apps/demo-yopm`
- [ ] Tiny Express + React app importing `@yocore/sdk`
- [ ] Demonstrates: signup → login → protected route → checkout → webhook receiver
- [ ] Used by Playwright E2E suite

### 4.6 Test suites
- [ ] Unit (Vitest) per handler/service/util — coverage ≥85% (api), 100% (security utils)
- [ ] Integration (supertest + Mongo Memory Server) per endpoint
- [ ] Contract tests (`nock` mocks for Stripe + SSLCommerz)
- [ ] Playwright E2E: super-admin login w/ MFA
- [ ] Playwright E2E: product create + plan publish
- [ ] Playwright E2E: end-user signup → checkout → cancel
- [ ] Playwright E2E: bundle checkout
- [ ] Playwright E2E: MFA recovery flow
- [ ] Playwright E2E: GDPR export request
- [ ] Time-warp test (`@sinonjs/fake-timers`): 30d deletion grace finalize
- [ ] Time-warp test: failed payment grace → Day 85 hard delete

---

## Phase 5 — Hardening & Launch Prep

### 5.1 Observability
- [ ] OpenTelemetry SDK → Grafana Cloud
- [ ] Prometheus metrics endpoint
- [ ] Sentry SDK
- [ ] Custom metrics: `yocore_signin_p95`, `yocore_circuit_<provider>{state}`, `yocore_sslcommerz_ipn_rejected_total{reason}`, `yocore_webhook_delivery_total{status}`, `yocore_mfa_enrollment_total`
- [ ] Pre-built Grafana dashboard JSON (`docs/observability/grafana-dashboards/`)
- [ ] SLI/SLO definitions documented

### 5.2 CI/CD
- [ ] Staging deploy workflow
- [ ] Production deploy workflow (manual approval gate)
- [ ] AWS Secrets Manager via OIDC
- [ ] Vercel preview deploys for `admin-web` + `auth-web`

### 5.3 Pre-launch
- [ ] All Playwright suites green vs staging
- [ ] Manual auth pen-check (rate limits, lockout, timing, CORS)
- [ ] DR dry run (Mongo restore from snapshot)
- [ ] Super Admin IP allowlist set + recovery runbook validated
- [ ] ToS v1 + Privacy v1 published in `tosVersions`
- [ ] All cron jobs verified running with `cronLocks`
- [ ] OpenAPI spec served at `/v1/openapi.json` and consumed by SDK
- [ ] Zero-secrets-in-logs audit (automated grep)
- [ ] Index audit (`db.collection.getIndexes()` per collection)
- [ ] End-to-end acceptance test: super admin → product → plan → user signup → subscribe → cancel → 30d grace → hard delete (time-warped)

---

## Tracking notes

- **Blocked items:** none (initial state)
- **Currently in-progress:** Phase 0 + Phase 1 (this commit)
- **Next milestone:** Phase 2 foundation complete + smoke test green
