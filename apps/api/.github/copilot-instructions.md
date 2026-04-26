# `apps/api` — Copilot Instructions

> **Extends [/.github/copilot-instructions.md](../../../.github/copilot-instructions.md).** Read root first.

This is the YoCore Backend API — single Express app serving all Yo products.

---

## Folder layout

```
apps/api/src/
├── index.ts                  # entry; binds port, graceful shutdown
├── app.ts                    # createApp() factory (used by tests too)
├── router.ts                 # mounts all /v1/* routes
├── config/
│   ├── env.ts                # Zod-validated process.env loader
│   ├── db.ts                 # mongoose connect + retry
│   ├── redis.ts              # ioredis client (TLS for Upstash)
│   └── aws.ts                # S3, SecretsManager, KMS clients
├── lib/                      # framework-agnostic primitives
│   ├── logger.ts             # Pino + redaction
│   ├── errors.ts             # AppError, mapToHttp
│   ├── argon2-pool.ts        # piscina worker pool
│   ├── password.ts           # hash/verify via pool
│   ├── tokens.ts             # randomToken + sha256
│   ├── encryption.ts         # AES-256-GCM via KMS DEK
│   ├── jwt.ts                # sign/verify with active key
│   ├── jwt-keyring.ts        # in-memory + Redis pub/sub reload
│   ├── webhook-signature.ts  # HMAC-SHA256 timing-safe
│   ├── circuit-breaker.ts    # opossum + Prometheus gauges
│   ├── correlation-id.ts     # cls-hooked context
│   └── cron-runner.ts        # Agenda + cronLocks integration
├── db/
│   ├── index.ts              # exports models; ensures indexes
│   └── models/               # one file per Mongoose model
├── middleware/               # composed in app.ts in this order:
│   ├── correlation-id.ts     # 1. assign ULID correlationId
│   ├── security-headers.ts   # 2. helmet
│   ├── cors.ts               # 3. per-product allowlist
│   ├── rate-limit.ts         # 4. Redis token bucket
│   ├── api-key.ts            # 5. resolve productId, attach to req
│   ├── jwt-auth.ts           # 6. dual-check: Redis blocklist + Mongo fallback
│   ├── idempotency.ts        # 7. enforce X-Idempotency-Key on mutations
│   ├── audit-log.ts          # 8. (post-handler) emit on state changes
│   ├── error-handler.ts      # last; converts AppError → HTTP JSON
│   └── not-found.ts          # 404 fallback
├── repos/                    # Mongo-only access; productId filter mandatory
├── services/                 # business logic; no Express, no Mongo direct
├── handlers/                 # Express handlers; thin; Zod-validated
├── webhooks/
│   ├── inbound/              # Stripe, SSLCommerz handlers
│   └── outbound/             # delivery worker, signing
├── crons/                    # one file per cron job
└── openapi/
    └── registry.ts           # global OpenAPIRegistry instance
```

---

## Layer contracts (re-emphasized; this is the most-violated rule)

```
[Express middleware] → [handler] → [service] → [repo] → [Mongoose/Redis/AWS]
```

- Handler imports: `Request`, `Response`, Zod schemas, services. NO mongoose.
- Service imports: repos, other services, lib utils. NO express, NO mongoose models directly.
- Repo imports: mongoose models. Returns plain objects (`.lean()`). NO express.

A handler that imports `mongoose` is a bug. A service that imports `express` is a bug. ESLint enforces.

---

## Per-handler template

```ts
// src/handlers/auth/signin.handler.ts
import type { Request, Response } from 'express';
import { signinRequest } from '@yocore/types/schemas/auth';
import { signinService } from '../../services/auth/signin.service';
import { AppError, ErrorCode } from '../../lib/errors';

export async function signinHandler(req: Request, res: Response) {
  const parse = signinRequest.safeParse(req.body);
  if (!parse.success) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request', parse.error.flatten());
  }
  const result = await signinService({
    productId: req.productId!,
    email: parse.data.email,
    password: parse.data.password,
    correlationId: req.correlationId!,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? '',
  });
  res.status(200).json(result);
}
```

---

## Per-service template

```ts
// src/services/auth/signin.service.ts
import { findUserByEmail } from '../../repos/user.repo';
import { findProductUser } from '../../repos/product-user.repo';
import { verifyPassword } from '../../lib/password';
import { issueTokens } from '../../lib/jwt';
import { AppError, ErrorCode } from '../../lib/errors';
import { writeAudit } from '../audit/audit.service';

export interface SigninInput { /* ... */ }
export interface SigninResult { /* ... */ }

export async function signinService(input: SigninInput): Promise<SigninResult> {
  const user = await findUserByEmail(input.email);
  // FIX-AUTH-TIMING: even if user is null, do dummy verify to keep timing constant
  const productUser = user ? await findProductUser(input.productId, user._id) : null;
  const ok = await verifyPassword(productUser?.passwordHash, input.password);
  if (!user || !productUser || !ok) {
    throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Invalid email or password');
  }
  // ... lockout, MFA branch, token issue, audit ...
}
```

---

## Per-repo template

```ts
// src/repos/product-user.repo.ts
import { ProductUser } from '../db/models/ProductUser';

export function findProductUser(productId: string, userId: string) {
  return ProductUser.findOne({ productId, userId }).lean();   // ← productId ALWAYS first
}

export function updateLastLogin(productId: string, userId: string, at: Date) {
  return ProductUser.updateOne({ productId, userId }, { $set: { lastLoginAt: at } });
}
```

---

## Mongoose model rules

1. Always declare indexes in the schema, never lazily.
2. Always include `productId` in compound indexes (except global collections).
3. Use `mongoose.Types.ObjectId` for refs; ULID for public IDs (`_id`).
4. `timestamps: true` on every schema (createdAt + updatedAt).
5. Never put business logic in models — use services.

---

## Cron job template

```ts
// src/crons/billing-grace-tick.cron.ts
import { acquireLock } from '../lib/cron-runner';

export async function billingGraceTick(now: Date) {
  const dateKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH (hourly)
  const lock = await acquireLock('billing.grace.tick', dateKey);
  if (!lock) return; // another pod has it
  try {
    // ...do the work...
    await lock.complete();
  } catch (err) {
    await lock.fail(err);
    throw err;
  }
}
```

Register in `src/crons/index.ts` with Agenda. Test by directly calling the function with a fake `now`.

---

## Webhook handler template (inbound)

```ts
// src/webhooks/inbound/stripe.handler.ts
export async function stripeWebhookHandler(req: Request, res: Response) {
  // 1. Verify signature (raw body required — use express.raw)
  const event = verifyStripeSignature(req.body, req.get('stripe-signature'), webhookSecret);

  // 2. Idempotency: Redis fast-path then Mongo durable
  const redisOk = await redis.set(`lock:webhook:stripe:${event.id}`, '1', 'NX', 'EX', 30);
  if (!redisOk) return res.status(200).json({ deduped: true });

  try {
    await WebhookEventProcessed.create({ provider: 'stripe', eventId: event.id, ... });
  } catch (e) {
    if (isMongoDup(e)) return res.status(200).json({ deduped: true });
    throw e;
  }

  // 3. Dispatch to per-event handler (in service layer)
  await dispatchStripeEvent(event);

  res.status(200).json({ received: true });
}
```

---

## Outbound webhooks

- Worker reads `webhookDelivery` rows status=PENDING.
- Sign with HMAC-SHA256 of body using product's `webhookSecret`.
- Headers: `X-YoCore-Signature`, `X-YoCore-Timestamp`, `X-YoCore-Event-Id`.
- Backoff: 30s, 5m, 30m, 2h, 6h. After 5 failures → DEAD; alert.
- Payload archived to S3 `yocore-webhooks-prod/<deliveryId>.json.gz` (90d TTL).

---

## Critical no-no list (handler-side)

| Don't | Do |
|---|---|
| `mongoose.model(...)` in handler | Call repo function |
| Throw raw `Error` | `throw new AppError(ErrorCode.X, ...)` |
| `console.log(...)` | `logger.info({ ... }, '...')` |
| `setTimeout(..., 0)` for async work | Use Agenda cron or job queue |
| `Date.now()` directly | `clock.now()` (mockable) |
| `argon2.hash(...)` directly | `import { hash } from '../lib/password'` |
| Catch + swallow exceptions | Catch + log + rethrow OR translate to AppError |
| Skip Zod parse | NEVER — every request body validated |
| Forget `req.correlationId` in service input | Required for traceability |

---

## Adding a new endpoint — the checklist

- [ ] Zod schemas (request, response, errors) in `packages/types/src/schemas/<area>.ts`
- [ ] Repo function (mongoose access, productId filter)
- [ ] Service function (business logic, throws AppError)
- [ ] Handler (req → service → res)
- [ ] Route mount in `src/router.ts` (or area sub-router)
- [ ] OpenAPI registration via `registry.registerPath(...)`
- [ ] Unit tests (handler with mocked service; service with mocked repo)
- [ ] Integration test (real Mongo Memory Server + supertest)
- [ ] Audit log emitted (if state-changing)
- [ ] Outbound webhook emitted (if applicable per PRD §3.8)
- [ ] SDK method added (`packages/sdk`) if public-facing
- [ ] Tick TASKS.md
