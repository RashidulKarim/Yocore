# YoCore — Global Copilot Instructions

> **You are an AI engineer building YoCore — a unified backend for all Yo products.**
> Read these instructions carefully. Re-read on every change. Per-app instructions in `apps/*/.github/copilot-instructions.md` and `packages/*/.github/copilot-instructions.md` extend these rules.

---

## 0. Source of truth

Always consult, in this order:
1. **[YoCore-PRD.md](../YoCore-PRD.md)** — features, screens, flows (1–2308)
2. **[YoCore-System-Design.md](../YoCore-System-Design.md)** — DB schemas, flows A–AN, FIX-* tags, all 6+ sections
3. **[docs/v1.8-addendum.md](../docs/v1.8-addendum.md)** — 10 cross-cutting improvements
4. **[docs/error-codes.md](../docs/error-codes.md)** — every API error code + HTTP mapping
5. **[docs/adr/](../docs/adr/)** — architecture decisions (10 ADRs)
6. **[docs/runbooks/](../docs/runbooks/)** — incident playbooks
7. **[TASKS.md](../TASKS.md)** — checklist of what's done

If you are about to make an architectural decision, **first** check ADRs. If unprecedented, propose adding a new ADR.

---

## 1. Stack (do NOT substitute without a new ADR)

| Layer | Choice | Reason |
|---|---|---|
| Node | 20.11.0 LTS | `.nvmrc` |
| Package mgr | pnpm 9.12.0 | workspaces |
| Build orchestrator | Turborepo 2.1.x | caching, parallel |
| TypeScript | 5.5.x strict + `noUncheckedIndexedAccess` | safety |
| HTTP | Express 4 | mature, ecosystem |
| DB | MongoDB 7 + Mongoose 8 | flexibility |
| Cache | Redis 7 + ioredis | speed, lock primitives |
| Validation | Zod 3 | runtime + types |
| OpenAPI | `@asteasolutions/zod-to-openapi` | source of truth = code |
| Password | argon2 (id) via piscina pool | off-loop hashing |
| JWT | `jose` | modern, KMS-friendly |
| Crons | Agenda + `cronLocks` table | idempotent across pods |
| Circuit breaker | opossum + Prometheus gauges | resilience + observability |
| Logging | Pino + redaction list | structured, fast |
| Frontend | React 18 + Vite + Tailwind + shadcn/ui + TanStack Query + RHF | productivity |
| Testing | Vitest + supertest + MongoDB Memory Server + Playwright + nock + @sinonjs/fake-timers | full pyramid |

---

## 2. Layer rules (NEVER inverted)

```
HTTP route → handler → service → repo → Mongo/Redis/external
```

- **Handler** validates with Zod, calls service, formats response. NEVER touches DB directly.
- **Service** holds business logic. Returns plain objects/throws `AppError`. NEVER imports `express`.
- **Repo** is the only layer that touches Mongoose models. Always filters by `productId` (linted).
- A service may call other services. A repo may call other repos for join-like operations.
- Repos are STATELESS (no instance fields).

---

## 3. Multi-tenancy rule (most violated, most catastrophic)

Every collection except `users`, `bundles`, `superAdminConfig`, `jwtSigningKeys`, `jobs` carries `productId`. **Every** repo function takes `productId` as the first arg and includes it in every query. Forgetting this = cross-product data leak = P0 incident.

```ts
// ✅ correct
findUserById(productId: string, userId: string) {
  return ProductUser.findOne({ productId, _id: userId }).lean();
}

// ❌ wrong (cross-tenant leak)
findUserById(userId: string) {
  return ProductUser.findOne({ _id: userId }).lean();
}
```

---

## 4. Security rules (non-negotiable)

| Rule | How |
|---|---|
| Passwords hashed via Argon2id pool only | `import { hash, verify } from '@/lib/password'` — never call `argon2` directly |
| Token comparison constant-time | `crypto.timingSafeEqual` — NEVER `===` on secrets |
| API responses generic on auth failure | Always `AUTH_INVALID_CREDENTIALS`, never reveal "user not found" |
| Constant-time response on signup | Always do an Argon2 dummy hash even if email exists (FIX-AUTH-TIMING) |
| Refresh tokens stored hashed (sha256) | never plaintext in DB |
| JWT signing keys: never in logs | Pino redaction enforced |
| Webhook signatures verified | HMAC-SHA256 + timing-safe + 5-min timestamp tolerance |
| Webhook idempotency | Mongo `webhookEventsProcessed` unique `{provider, eventId}` + Redis SET NX |
| Idempotency-Key header | Required on all mutating billing endpoints |
| Audit log every state change | Hash chain (`prevHash` → `hash`) |
| MFA mandatory for SUPER_ADMIN | Enforced in signin handler |
| No `console.log` of secrets | Pino redaction list catches; CI greps log output |
| CORS per-product allowlist | Reject unknown origins |
| Rate limit per IP + per user | `RATE_LIMIT_EXCEEDED` 429 with `Retry-After` |

---

## 5. Validation

- **Every** request body, query, params validated with Zod from `@yocore/types/schemas/*`.
- Throw `AppError(ErrorCode.VALIDATION_FAILED, ...)` with `details: zodError.flatten()`.
- Schemas live in `packages/types`. NEVER duplicate in handlers.

---

## 6. Error handling

- Always throw `AppError` from `@yocore/types/errors`. Never throw raw `Error` in handlers/services.
- `ErrorCode` enum is the single source of programmatic codes. See [docs/error-codes.md](../docs/error-codes.md).
- Central middleware (`src/middleware/error-handler.ts`) maps to HTTP status + JSON shape:
  ```json
  { "error": "<CODE>", "message": "<user-friendly>", "correlationId": "01H..." }
  ```
- Unknown errors → `INTERNAL_ERROR` 500, full stack to Pino + Sentry, never to client.

---

## 7. Testing rules

- **Coverage gates**: `apps/api` ≥85%, security utils 100%, packages ≥90%.
- Unit tests next to source (`*.test.ts`). Integration in `*.integration.test.ts`.
- Use factories from `@yocore/test-utils` — never hand-build test fixtures.
- For external services (Stripe, SSLCommerz, Resend): use `nock` (no real HTTP).
- For DB: integration tests use `MongoMemoryReplSet` (real mongoose, not mocks).
- Time-warp tests use `@sinonjs/fake-timers` for lifecycle (grace, deletion, trial expiry).

---

## 8. Common pitfalls (you WILL hit these)

1. **Forgot productId filter** — see §3. Linter catches; tests catch.
2. **Stored raw refresh token** — must be sha256-hashed before insert.
3. **Missing Idempotency-Key on POST** — 400 `IDEMPOTENCY_KEY_MISSING`. Add to mutating tests.
4. **Forgot to register Zod schema with OpenAPI registry** — CI script `audit-openapi-routes.ts` fails.
5. **Used `===` to compare token / password hash** — use `crypto.timingSafeEqual`.
6. **Logged a secret** — CI `audit-log-redaction.ts` fails. Update Pino redaction list.
7. **Wrote synchronous Argon2 call** — blocks event loop. Always go through `@/lib/password`.
8. **Cron job without `cronLocks` lock** — runs N times across N pods. Always `acquireLock(jobName, dateKey)`.
9. **Webhook handler without dedup** — double-processes events. Insert into `webhookEventsProcessed` first.
10. **Forgot audit log on state change** — `auditLogs` chain must reflect every mutation.
11. **Threw `Error` instead of `AppError`** — leaks 500 to client. Always `AppError(ErrorCode.X, ...)`.
12. **Imported from `@yocore/types/dist/...`** — use the public exports only.
13. **Edited `tsconfig.base.json` for one package's needs** — extend per-package, don't pollute base.
14. **Forgot to invalidate Redis cache after write** — wrote to Mongo, stale cache hit. Use `cacheInvalidate(...)`.
15. **Used `Date.now()` directly in service** — un-mockable. Use `clock.now()` injected helper.

---

## 9. Tooling commands (run from repo root)

| Command | What |
|---|---|
| `pnpm install` | install all workspaces |
| `pnpm dev` | run all apps in watch |
| `pnpm dev --filter=@yocore/api` | run only API |
| `pnpm typecheck` | tsc --noEmit on all |
| `pnpm lint` | eslint on all |
| `pnpm test` | unit tests |
| `pnpm test:integration` | integration tests (needs Mongo + Redis up) |
| `pnpm test:e2e` | Playwright |
| `pnpm build` | production build all |
| `docker compose up -d` | local Mongo + Redis + Mailhog + MinIO |
| `pnpm tsx scripts/seed-dev.ts` | seed demo data |
| `pnpm tsx scripts/bootstrap-superadmin.ts --email ... --password ...` | first super admin |

---

## 10. Code style

- Prettier-enforced. Don't manually format.
- ESLint plugins: `@typescript-eslint`, `import`, `security`. Don't disable rules without comment justifying.
- Use `import type { ... }` for type-only imports (lint enforces).
- File naming: `kebab-case.ts` for files; `PascalCase` for classes/types; `camelCase` for functions/variables.
- One default export per file is OK for components; otherwise prefer named exports.

---

## 11. When you finish a unit of work

1. Run `pnpm typecheck && pnpm lint && pnpm test`.
2. If touching API: `pnpm test:integration`.
3. Update [TASKS.md](../TASKS.md) — tick `[x]` only when fully done.
4. If you added a new error code: update `packages/types/src/errors/error-codes.ts` AND `docs/error-codes.md`.
5. If you added an endpoint: register with OpenAPI; SDK gets a method.
6. If you added a security-sensitive primitive: 100% test coverage required.
7. Conventional commit message (`feat(api): ...`, `fix(types): ...`, `security(api): ...`).
