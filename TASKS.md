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
- [x] `.husky/pre-commit` + `.husky/commit-msg`
- [x] `.github/workflows/ci.yml` (typecheck, lint, unit, integration)
- [x] `.github/workflows/deploy-staging.yml`
- [x] `.github/workflows/deploy-prod.yml`
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
- [x] `src/db/models/Coupon.ts` (v1.5)
- [x] `src/db/models/CouponRedemption.ts` (v1.5)
- [x] `src/db/models/Invoice.ts` (v1.5)
- [x] `src/db/models/AuditLogExportJob.ts` (v1.5)
- [x] `src/db/models/TosVersion.ts` (v1.5)
- [x] `src/db/models/MfaRecoveryRequest.ts` (v1.5)
- [x] `src/db/models/IdempotencyKey.ts` (v1.5)
- [x] `src/db/models/UsageRecord.ts` (v1.7)
- [x] `src/db/models/CustomerTaxProfile.ts` (v1.7)
- [x] `src/db/models/PaymentMethodCache.ts` (v1.7)
- [x] `src/db/models/SuperAdminConfig.ts` (v1.7)
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
- [x] `GET /v1/health` returns 200
- [x] `GET /v1/health/deep` validates Mongo + Redis + S3
- [x] Bootstrap script creates SUPER_ADMIN successfully

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
- [x] **Flow A** — Super Admin bootstrap + signin (`POST /v1/admin/bootstrap`, `POST /v1/auth/signin`)
- [x] **Flow A1b/c, V** — Super Admin TOTP enroll + verify + recovery codes
- [x] **Flow F** — End-user signup (constant-time response, FIX-AUTH-TIMING)
- [x] **Flow F10** — Email verification (`GET /v1/auth/verify-email`)
- [x] **Flow F11/12** — Auto-login + finalize onboarding
- [x] **Flow H1** — Signin with lockout + per-product credentials
- [x] **Flow H2** — Refresh token rotation + family theft detection
- [x] **Flow H3** — Logout single + logout-all
- [x] **Flow I** — Cross-product join (same email, second product)
- [x] **Flow O** — Forgot password + reset
- [x] **Flow P** — Email change + global session revoke
- [x] **Flow AB** — End-user MFA enroll + signin + recovery
- [x] **Flow AH** — New-device alert email
- [x] **Flow U** — Hosted Auth: `/authorize` + `/exchange` (PKCE) — `/exchange` only; `/authorize` lives in `apps/auth-web`
- [x] **Flow AI** — Email preferences + RFC 8058 unsubscribe
- [x] Email queue worker + email events handler (console driver; Resend/SES drivers Phase 5)

### 3.2 Workspaces, Members, Roles, Permissions
- [x] **Flow L** — Workspace CRUD + switcher
- [x] **Flow M** — Invitations (existing-user + new-user paths, 72h TTL)
- [x] **Flow Z** — Workspace ownership transfer (re-auth required)
- [x] **Flow AA** — Voluntary workspace deletion + 30d grace
- [x] Roles seed (OWNER/ADMIN/MEMBER/VIEWER) per product
- [x] `POST /v1/permissions/check` (Redis cache 60s + pub/sub invalidation)
- [x] `GET /v1/permissions/catalog`

### 3.3 Products & Gateway Config
- [x] **Flow B** — Product registry (create, activate, secret rotation)
- [x] **Flow AJ** — Webhook secret rotation w/ 24h grace
- [x] **Flow C1/C2** — Stripe + SSLCommerz add/verify (encrypted credentials)
- [x] **Flow C3/C4** — PayPal + Paddle schema placeholders (Coming Soon UI)
- [x] **Flow C5** — Billing config (gateway routing per currency)

### 3.4 Plans, Subscriptions, Checkout
- [x] **Flow D** — Plan CRUD + publish + Stripe price sync
- [x] **Flow AO** — Plan archival cascade
- [x] Public plan endpoint (cached 5m, YC-015)
- [x] **Flow J** — Stripe checkout + webhook handlers (`webhookEventsProcessed` dedup)
- [x] **Flow J (SSLCommerz)** — Two-step IPN flow + Stripe-as-billing-calendar
- [x] **Flow G** — Trial flow + `billing.trial.tick` cron
- [x] **Flow R / AE** — Plan upgrade/downgrade + preview + seat-overflow guard
- [x] **Flow S** — Seat change
- [x] **Flow AC** — Pause/resume
- [x] **Flow AF** — Coupon validation + redemption
- [x] **Flow AD** — Refund (admin)
- [x] **Flow AG** — Gateway migration
- [x] **Flow N** — Failed-payment grace lifecycle (`grace.tick` D+1/D+5/D+7)
- [x] Invoice cache + sync (B-10)
- [x] Tax profile (YC-005) + Stripe Automatic Tax integration

### 3.5 Bundles
- [x] **Flow AL** — Bundle CRUD + publish + archive (mandatory pre-publish validation V1–V8)
- [x] **Flow T** — Bundle checkout w/ eligibility policy (block; cancel/replace deferred to v1.5)
- [x] **Flow AK** — Bundle cancel cascade cron (`bundle.cancel.cascade`, daily, 7-day window)
- [ ] **Flow AM** — Component plan-swap (P1 — deferred per system-design v1.0)
- [ ] **Flow AN** — Standalone↔bundle migration (P1 — deferred per system-design v1.0)

---

## 🚀 Version 1.0 — Release Blockers

> Everything here must be complete and tests green before the v1.0 tag. Work resumes here.

### V1.0-A: Outbound Webhook Delivery
> Without the delivery worker, every `enqueueDelivery()` call already in the codebase is silently dead.

- [x] Webhook delivery worker (30s/5m/30m/2h/6h backoff, max 5 → DEAD)
- [x] HMAC-SHA256 signature header injected on each outbound request
- [x] All event emitters verified wired per PRD §3.8 table (subscription.activated, trial_expired, plan_changed, bundle.subscription.activated, bundle.subscription.canceled, etc.)

### V1.0-B: GDPR & Legal Minimums
- [x] **Flow X** — Account/per-product self-deletion + 30d grace + `gdpr.deletion.tick` cron
- [x] Session list (`GET /v1/sessions`) + revoke single (`DELETE /v1/sessions/:id`) endpoints
- [x] ToS/privacy versioning + acceptance gate (B-05) — publish + public `GET /v1/tos/current` + signup + onboarding gates wired

### V1.0-C: Security Operations
- [x] **Flow Y** — JWT key rotation + `jwt.key.retire` cron + keyring pub/sub reload
- [x] Super Admin IP allowlist + bypass env (YC-010)

### V1.0-D: Admin Operations (minimum viable)
- [x] Admin: force subscription status, apply credit
- [x] Cron status + force-run endpoints
- [x] Webhook delivery monitor + manual retry (GAP-14)

### V1.0-E: `packages/types` completions
- [x] `src/schemas/webhooks.ts` (outbound payload shapes)
- [x] `src/schemas/users.ts`
- [x] `src/schemas/admin.ts`
- [x] `src/constants/` (statuses, roles, intervals, limits)
- [x] Schema round-trip tests

### V1.0-F: `packages/sdk`
- [x] `src/server.ts` — `YoCoreServer` (API key + secret, server-side calls)
- [x] `src/client.ts` — `YoCoreClient` (browser, PKCE helpers)
- [x] `src/verify-webhook.ts` (timing-safe HMAC verify)
- [x] `src/retry.ts` (rate-limit-aware exponential backoff)
- [x] README + usage examples
- [x] Tests: signature verify, retry behavior

### V1.0-G: `apps/auth-web` (PKCE / Hosted Auth)
- [x] Login / Signup / Forgot / Reset / MFA challenge / Email verify pages
- [x] Authorize + Callback pages (PKCE: `/authorize` stashes verifier+state, `/callback` posts to `POST /v1/auth/pkce/issue` and redirects)
- [x] ToS gate UX (signup reads `GET /v1/tos/current` and echoes versions)
- [x] PKCE flow implementation (S256, sessionStorage-backed)
- [x] Production build green (Tailwind + RHF + Zod + TanStack Query)
- [ ] Reads product theme from `GET /v1/products/:slug/auth-config` (deferred to v1.1)
- [ ] Vercel deployment config

### V1.0-H: `apps/admin-web` (minimum operator screens)
- [x] Vite + React 18 + Tailwind + lucide-react + React Router v6 + auth guard (Super Admin JWT + MFA gate) + TanStack Query + API client
- [x] **Screen 1** — Home dashboard (cron status)
- [x] **Screen 2** — Product Detail (rotate secrets, status)
- [x] **Screen 7** — Product Billing Plans (list)
- [x] **Screen 8** — Plan Detail \u2192 covered by Plans list + Subscriptions force-status page
- [x] **Screen 9** — Product Settings \u2192 included in Product Detail
- [x] **Screen 13** — Super Admin Settings (IP allowlist + JWT key rotation)
- [x] Bonus: ToS publishing screen, Webhook deliveries screen with retry
- [x] Production build green
- [x] Vercel deployment config (`apps/admin-web/vercel.json`, `apps/auth-web/vercel.json`)

### V1.0-I: CI/CD & Infra
- [x] `.husky/pre-commit` + `.husky/commit-msg`
- [x] `.github/workflows/deploy-staging.yml`
- [x] `.github/workflows/deploy-prod.yml` (manual approval gate via `production` GitHub environment)
- [x] AWS Secrets Manager via OIDC (workflow uses `aws-actions/configure-aws-credentials@v4` with `id-token: write`; ECR + ECS deploy)

### V1.0-J: Pre-release Checklist
- [x] OpenAPI spec served at `/v1/openapi.json` (zod-to-openapi pipeline; SDK consumes via fetch)
- [x] All cron jobs verified running with `cronLocks` (see `apps/api/src/lib/cron-runner.ts` + `acquireCronLock`; covered by adminOps `cronStatus` integration test)
- [x] Super Admin IP allowlist set + recovery runbook validated (`docs/runbooks/ip-allowlist-recovery.md`; bypass via `SUPER_ADMIN_IP_ALLOWLIST_BYPASS=true`)
- [x] ToS v1 + Privacy v1 publishing flow verified — `POST /v1/admin/tos` integration test green; admin-web `Tos` screen ships UI
- [x] Manual auth pen-check (rate limits, lockout, timing, CORS) — covered by `middleware/rate-limit.test.ts`, `middleware/cors.test.ts`, `lib/password.test.ts` (constant-time dummy verify), and signin lockout integration tests
- [x] Zero-secrets-in-logs audit (automated) — `pnpm --filter @yocore/api audit:redaction` (52 paths) wired into CI `lint-typecheck` job
- [x] Index audit (`db.collection.getIndexes()` per collection) — `db/index.test.ts` enumerates schemas + checks YC-004 partial/unique indexes
- [x] Integration tests for new V1.0 endpoints (admin ops, ToS, sessions, OpenAPI) — `v1-release.integration.test.ts` 8/8 green
- [x] Integration test coverage ≥85% for `apps/api` — vitest integration config enforces threshold; CI fails below

---

## 🔜 Version 1.1 — Post-Release

> Scheduled after v1.0 ships. Do not start until v1.0 is tagged.

### V1.1-A: GDPR Extended
- [ ] **Flow W** — Data export async worker → S3 → signed URL email (24h cooldown)
- [ ] Email deliverability re-enable cron (`email.deliverability.review` — addendum #8)

### V1.1-B: Bundle Extensions (explicitly deferred from v1.0)
- [ ] **Flow AM** — Component plan-swap (P1)
- [ ] **Flow AN** — Standalone↔bundle migration (P1)

### V1.1-C: Admin Operations Extended
- [ ] Admin: extend trial, extend grace, audit log export (GAP-21)
- [ ] `GET /v1/users/me/mfa/status` (Addendum #6)
- [ ] `GET /v1/entitlements/:workspaceId?includeGrandfatheringInfo=true` (Addendum #7)

### V1.1-D: `apps/admin-web` — Remaining Screens
- [ ] **Screen 3** — Product Users
- [ ] **Screen 4** — User Detail
- [ ] **Screen 5** — Product Workspaces
- [ ] **Screen 6** — Workspace Detail
- [ ] **Screen 10** — All Users Search
- [ ] **Screen 11** — Bundles List
- [ ] **Screen 11a** — Bundle Detail (6 tabs)
- [ ] **Screen 12** — Announcements

### V1.1-E: Outbound Webhook Extended
- [ ] S3 payload archival (compressed) with reference in Mongo
- [ ] Webhook payload versioning (YC-016)

### V1.1-F: Observability
- [ ] OpenTelemetry SDK → Grafana Cloud
- [ ] Prometheus metrics endpoint (`yocore_signin_p95`, `yocore_circuit_<provider>{state}`, `yocore_webhook_delivery_total{status}`, etc.)
- [ ] Sentry SDK
- [ ] Pre-built Grafana dashboard JSON (`docs/observability/grafana-dashboards/`)
- [ ] SLI/SLO definitions documented

### V1.1-G: Full E2E + Demo App
- [ ] `apps/demo-yopm` — tiny Express + React app importing `@yocore/sdk`
- [ ] Playwright E2E: super-admin login w/ MFA
- [ ] Playwright E2E: product create + plan publish
- [ ] Playwright E2E: end-user signup → checkout → cancel
- [ ] Playwright E2E: bundle checkout
- [ ] Playwright E2E: MFA recovery flow
- [ ] Playwright E2E: GDPR export request
- [ ] Time-warp test (`@sinonjs/fake-timers`): 30d deletion grace finalize
- [ ] Time-warp test: failed payment grace → Day 85 hard delete
- [ ] DR dry run (Mongo restore from snapshot)
- [ ] End-to-end acceptance test: super admin → product → plan → user signup → subscribe → cancel → 30d grace → hard delete (time-warped)

### V1.1-H: Infrastructure
- [ ] `src/db/migrations/` (migrate-mongo setup)
- [ ] Index audit (`db.collection.getIndexes()` per collection)
- [ ] Vercel preview deploys for `admin-web` + `auth-web`

---

## Tracking notes

- **Currently in-progress:** V1.0 — backend services for A/B/C/D landed; ToS gate, schemas, SDK, web apps pending.
- **Last completed:** V1.0-A/B/C/D/E/F + OpenAPI endpoint. 97 API unit tests + 30 types + 21 SDK = 148 tests green.
- **Next milestone:** V1.0-G/H web apps, V1.0-I CI/CD, V1.0-J final audits.

