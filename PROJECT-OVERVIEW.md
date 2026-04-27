# YoCore — Project Overview

> **Quick reference:** What's done, what's next, and why each phase matters.  
> Last updated: Phase 3.4 (Wave 3 complete — SSLCommerz checkout done)

---

## 📋 Phase 0 — Doc & Architecture Hardening ✅ **COMPLETE**

**What:** Documented all system design, error codes, security rules, and architecture decisions.

**Why it matters:**
- Creates a **single source of truth** (PRD, System Design, ADRs) so everyone knows the rules
- Prevents duplicate work and misaligned decisions
- Makes onboarding new engineers fast

**Status:** 24/24 items done
- ✅ All 10 design improvements documented
- ✅ Error codes + HTTP mappings defined
- ✅ All 10 Architecture Decision Records (ADRs) written
- ✅ Runbooks for incidents (JWT compromise, Stripe desync, etc.)

---

## 🏗️ Phase 1 — Monorepo Foundation ✅ **MOSTLY COMPLETE**

**What:** Set up the folder structure, build tools, and development environment so all teams can work together.

**Why it matters:**
- **Monorepo** = one place for API, admin dashboard, auth, SDK, shared types
- **Turborepo** = fast parallel builds (don't rebuild what didn't change)
- **CI pipeline** = every commit is tested (no broken code pushed)
- Shared rules (`copilot-instructions.md`) = consistent code style everywhere

**Status:** 27/29 items done (93%)
- ✅ Root config (`package.json`, `turbo.json`, `tsconfig.base.json`)
- ✅ All 4 apps set up (`api`, `admin-web`, `auth-web`, `demo-yopm`)
- ✅ All 4 packages set up (`types`, `sdk`, `config`, `test-utils`)
- ✅ CI workflow running (typecheck, lint, tests)
- ⏳ Husky git hooks (non-blocking; will run `pnpm install`)
- ⏳ Deploy workflows for staging/prod (Phase 5)

---

## ⚙️ Phase 2 — Backend Core (`apps/api`) ✅ **COMPLETE**

**What:** Built the low-level infrastructure: database, security, logging, cron jobs, middleware.

**Why it matters:**
- **Secure foundation** = every endpoint has auth, rate limiting, audit logs
- **Scalable infrastructure** = can handle millions of requests (Redis cache, connection pools)
- **Reliable ops** = graceful shutdown, health checks, circuit breakers for external services
- **23+ database models** = all the data structures we need (users, billing, webhooks, etc.)

**Status:** 54/54 items done (100%)
- ✅ Server entry + graceful shutdown
- ✅ Config (environment variables, Mongo, Redis, AWS)
- ✅ Security layer (Argon2 password hashing, JWT, AES encryption)
- ✅ All 23+ database models with indexes
- ✅ 10 middleware layers (CORS, rate limit, auth, audit log, error handling)
- ✅ Health checks (`/v1/health`, `/v1/health/deep`)

---

## 🔐 Phase 3 — Backend Features (Flows A → AN) ⏳ **IN PROGRESS**

**What:** Implement all the business logic: auth, billing, workspaces, webhooks, GDPR.

**Why it matters:**
- This is where **users interact** with YoCore
- Each "flow" is a complete feature (e.g., "user signs up, verifies email, joins workspace")
- Flows must be **idempotent, audited, and tested**

### 3.1 Auth & Identity ✅ **COMPLETE** (17/17)
- ✅ Super Admin bootstrap + MFA enroll
- ✅ User signup, email verification, password reset
- ✅ Token refresh + theft detection
- ✅ Logout (single + all sessions)
- ✅ MFA (TOTP + recovery codes)
- ✅ Email preferences + unsubscribe

### 3.2 Workspaces & Roles ✅ **COMPLETE** (7/7)
- ✅ Create/delete workspaces with 30-day grace period
- ✅ Invite members (email invites with 72h TTL)
- ✅ Role-based access control (OWNER/ADMIN/MEMBER/VIEWER)
- ✅ Permission checks + Redis cache + pub/sub invalidation
- ✅ Ownership transfer

### 3.3 Products & Payment Gateways ✅ **COMPLETE** (6/6)
- ✅ Product registry (create, activate, secret rotation)
- ✅ Stripe integration (credentials encrypted, prices synced)
- ✅ SSLCommerz integration (payment gateway for South Asia)
- ✅ PayPal + Paddle placeholders (UI says "Coming Soon")
- ✅ Webhook secret rotation with 24h grace period

### 3.4 Plans, Subscriptions, Checkout ⏳ **PARTIAL** (9/18)
- ✅ Plan CRUD + publish + Stripe price sync
- ✅ Stripe checkout + webhook handlers (dedup with `webhookEventsProcessed`)
- ✅ SSLCommerz checkout (2-step IPN flow, Stripe as billing calendar)
- ✅ Public plan list endpoint (cached 5m)
- ⏳ **Trial flow + auto-expiry cron** ← **NEXT MILESTONE**
- ⏳ Plan upgrade/downgrade + seat management
- ⏳ Failed-payment grace + 30-day deletion lifecycle
- ⏳ Coupons + tax profiles
- ⏳ Invoice caching

### 3.5 Bundles ⏳ **NOT STARTED** (0/5)
- Bundle CRUD + eligibility policies
- Bundle checkout
- Component plan-swaps
- Standalone ↔ bundle migration

### 3.6 GDPR & Compliance ⏳ **NOT STARTED** (0/5)
- Data export → S3 (24h cooldown)
- Account deletion + 30d grace + hard delete cron
- ToS/privacy versioning + acceptance gate

### 3.7 Admin Operations ⏳ **NOT STARTED** (0/7)
- JWT key rotation + cron
- Admin: extend trial, apply credit, force status
- Webhook delivery monitor + manual retry

### 3.8 Outbound Webhooks ⏳ **NOT STARTED** (0/5)
- Webhook delivery worker (backoff: 30s/5m/30m/2h/6h → DEAD)
- S3 payload archival + reference tracking
- HMAC-SHA256 signature headers

**Phase 3 Summary:**
- **Completed:** 40/78 features (51%)
- **Current focus:** SSLCommerz checkout (Wave 3) — 115 integration tests green ✅
- **Next:** Trial flow + `billing.trial.tick` cron

---

## 💻 Phase 4 — Frontends, SDK, Demo, E2E ⏳ **NOT STARTED**

**What:** Build user interfaces (admin dashboard, auth pages, SDK) + end-to-end tests.

**Why it matters:**
- **Admin dashboard** = Super Admin can manage products, plans, users, billing
- **Auth pages** = users can sign up / log in
- **SDK** = integrations are easy for customers
- **E2E tests** = catch bugs that unit tests miss (real workflows like "signup → checkout → cancel")

**Status:** 4/58 items done (7%)
- ✅ Error codes + schemas for types
- ⏳ Admin web (13 screens to build)
- ⏳ Auth web (6 pages + PKCE flow)
- ⏳ SDK (TypeScript client + webhook verification)
- ⏳ Demo app (Express + React showing real usage)
- ⏳ Playwright E2E tests (11 critical user journeys)

---

## 🚀 Phase 5 — Hardening & Launch Prep ⏳ **NOT STARTED**

**What:** Observability (metrics, logs, alerts), deployment pipelines, security audits.

**Why it matters:**
- **Observability** = know when things break (Prometheus + Grafana + Sentry)
- **Deploy pipelines** = reliable releases (staging → prod with approval gates)
- **Security hardening** = pen testing, secret scanning, index audits

**Status:** 0/19 items done (0%)
- ⏳ OpenTelemetry → Grafana Cloud
- ⏳ Prometheus metrics + custom dashboards
- ⏳ Sentry error tracking
- ⏳ CI/CD workflows (staging + prod)
- ⏳ Pre-launch checklist (tests green, DR dry run, IP allowlist, etc.)

---

## 📊 Overall Progress

| Phase | What | Status | Done | Total |
|-------|------|--------|------|-------|
| 0 | Docs & Architecture | ✅ Complete | 24 | 24 |
| 1 | Monorepo Foundation | ✅ 93% | 27 | 29 |
| 2 | Backend Core | ✅ Complete | 54 | 54 |
| 3 | Features (Flows) | ⏳ 51% | 40 | 78 |
| 4 | Frontends & SDK | ⏳ 7% | 4 | 58 |
| 5 | Launch Prep | ⏳ 0% | 0 | 19 |
| **TOTAL** | | | **149** | **262** |

---

## 🎯 Critical Path (What Blocks What)

```
Phase 0 ✅          (Documentation complete)
  ↓
Phase 1 ✅          (Monorepo + tooling ready)
  ↓
Phase 2 ✅          (Backend core + DB models)
  ↓
Phase 3.1-3.3 ✅    (Auth + Workspaces + Gateways)
  ↓
Phase 3.4 ⏳        (Checkout + Billing) ← WE ARE HERE
  ├─→ Phase 3.5     (Bundles need plans working)
  ├─→ Phase 3.6     (GDPR needs subscription lifecycle)
  └─→ Phase 3.7     (Admin ops depend on cron + lifecycle)
  ↓
Phase 3.8 ⏳        (Webhooks need all features)
  ↓
Phase 4 ⏳          (Frontends consume API)
  ↓
Phase 5 ⏳          (Launch after all features done)
```

---

## 🔥 Why Each Phase Matters

1. **Phase 0 (Docs)** → Without clarity on design, engineers waste time debating instead of building.
2. **Phase 1 (Monorepo)** → Without shared tooling, 4 teams can't coordinate. Builds are slow.
3. **Phase 2 (Backend Core)** → Security + stability foundation. No auth = no product.
4. **Phase 3 (Features)** → The actual product. Billing must work before launch.
5. **Phase 4 (Frontends)** → Users see this. Admin dashboard + auth pages.
6. **Phase 5 (Launch)** → Ops readiness. Can't launch without monitoring + DR plan.

---

## 🎓 Key Design Principles

- **Multi-tenancy by default:** Every query filters by `productId` (prevents data leaks)
- **Layer separation:** HTTP → Handler → Service → Repo → Mongo (never skip layers)
- **Audit everything:** Every state change logged (immutable chain: `prevHash → hash`)
- **Idempotency:** Webhooks deduplicated, cron jobs locked across pods
- **Security first:** Constant-time comparisons, Argon2 off-loop, JWT across keyring
- **Testing pyramid:** Unit (85%) + Integration (real Mongo) + E2E (Playwright)

---

## 📝 Next Steps

1. **Immediate:** Finish Phase 3.4 (Trial flow + grace lifecycle cron)
2. **Week 2:** Phase 3.5 (Bundles CRUD + checkout)
3. **Week 3:** Phase 3.6 (GDPR + 30-day deletion)
4. **Week 4:** Phase 3.7 (Admin operations + cron UI)
5. **Week 5:** Phase 3.8 (Webhook delivery + outbound)
6. **Week 6+:** Phase 4 (Frontends) + Phase 5 (Launch prep)

---

## 🔗 Quick Links

- **Full checklist:** [TASKS.md](TASKS.md)
- **System design:** [YoCore-System-Design.md](YoCore-System-Design.md)
- **Product spec:** [YoCore-PRD.md](YoCore-PRD.md)
- **Global rules:** [.github/copilot-instructions.md](.github/copilot-instructions.md)
- **API docs:** [docs/error-codes.md](docs/error-codes.md), [docs/openapi-strategy.md](docs/openapi-strategy.md)
