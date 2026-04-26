# YoCore — Testing Strategy

## Coverage targets (CI-enforced)

| Layer | Target | Rationale |
|---|---|---|
| `apps/api` handlers + services | ≥85% lines | Critical path; payment + auth correctness |
| `apps/api/src/lib/` (crypto, jwt, password, encryption, webhook-signature) | **100%** | Security-critical; no excuse for misses |
| `packages/types` schemas | ≥95% | Prevent schema drift |
| `packages/sdk` | ≥90% | Public contract |
| `apps/admin-web` | ≥70% | UX layer; Playwright covers rest |
| `apps/auth-web` | ≥75% | Includes auth-critical PKCE flow |

CI fails if thresholds not met. `vitest --coverage --reporter=json` results uploaded as artifact.

## Test pyramid

```
                    ╱────────╲
                   ╱   E2E    ╲           ← Playwright (~30 tests)
                  ╱────────────╲             slow, real backend
                 ╱  Integration ╲          ← supertest + Memory Server (~150 tests)
                ╱────────────────╲            fast, isolated DB
               ╱      Unit         ╲       ← Vitest (~600 tests)
              ╱────────────────────╲          fast, mocked deps
```

## Layers

### Unit tests (Vitest)
- Test pure functions, services with mocked repos, validators, error mappings, util libs.
- **Mock everything external**: Mongoose models via `vi.mock`, Redis via `redis-mock`, AWS SDK via `aws-sdk-client-mock`, Stripe via `nock`.
- File pattern: `*.test.ts` colocated with source.
- Run: `pnpm test`.

### Integration tests (supertest + MongoDB Memory Server)
- Spin up real Express app + real Mongoose + in-memory Mongo + ioredis-mock.
- Test full request → handler → service → repo → DB → response cycle.
- One test file per endpoint (`*.integration.test.ts`).
- Use `packages/test-utils` `createTestApp()`, `seedTestData()`, `signJwtForUser()`.
- External APIs (Stripe, SSLCommerz, Resend) mocked via `nock`.
- Run: `pnpm test:integration`.

### Contract tests (gateway mocks)
- Validate our handlers correctly construct + parse Stripe / SSLCommerz payloads.
- Use recorded fixtures from `packages/test-utils/fixtures/stripe/` (e.g., `checkout.session.completed.json`).
- Validate webhook signature verification.

### E2E tests (Playwright)
- Real backend (staging or local docker compose).
- Cover golden paths only:
  1. Super Admin login w/ MFA → dashboard
  2. Create product → create plan → publish
  3. End-user signup via demo-yopm → email verify → workspace
  4. End-user checkout (Stripe test card) → subscription active → cancel
  5. Bundle checkout cascade
  6. MFA enroll + recovery
  7. GDPR export request → email link → download
- Run: `pnpm test:e2e`.

### Time-warp tests (`@sinonjs/fake-timers`)
- For long lifecycle flows (30d deletion grace, Day 85 hard delete, trial expiry, refresh token expiry).
- Mock `Date.now()`, advance hours/days, run cron handlers manually, assert state transitions.
- Lives in `apps/api/src/__tests__/lifecycle/`.

## Fixtures + factories

`packages/test-utils/src/factories/` provides:
- `userFactory(overrides)` → creates valid `User`
- `productUserFactory({ userId, productId, ...overrides })`
- `productFactory(overrides)`
- `workspaceFactory(...)`
- `subscriptionFactory(...)`
- `bundleFactory(...)`
- `stripeWebhookFactory({ event, ... })` — produces signed Stripe webhook payload

## Security-specific tests

- **Constant-time response audit**: signup, signin, forgot-password — measure response time variance over 100 calls (real vs nonexistent user). Variance must be < 10ms.
- **Timing-safe compare**: every place using `crypto.timingSafeEqual` has a unit test verifying it.
- **No secret leakage**: `pnpm tsx scripts/audit-log-redaction.ts` greps test output for known secret patterns (Stripe keys, JWT, Argon2 hash).
- **Rate limit enforcement**: integration test sends 6 signins in 60s; 6th must return 429.
- **CORS rejection**: integration test sends signin from disallowed origin → 403.
- **JWT replay after revoke**: revoke session → reuse JWT → 401.
- **Refresh family theft**: use revoked refresh token while sibling still active → entire family revoked + 401.

## Pre-commit gating

`.husky/pre-commit` runs `lint-staged` (eslint + prettier on changed files). Heavy tests deferred to CI.

## CI gating

Order: lint → typecheck → unit → integration → build. Any failure blocks merge. Integration tests get a dedicated Mongo + Redis in services container.
