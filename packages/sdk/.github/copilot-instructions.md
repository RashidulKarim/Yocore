# `packages/sdk` — Copilot Instructions

> **Extends [/.github/copilot-instructions.md](../../../.github/copilot-instructions.md).** Read root first.

Public SDK shipped to Yo product engineering teams. **API stability matters** — every breaking change requires a major version bump + migration guide.

## Folder layout

```
packages/sdk/src/
├── index.ts                  # barrel
├── server.ts                 # YoCoreServer class — server-to-server (API key + secret)
├── client.ts                 # YoCoreClient class — browser PKCE helpers
├── verify-webhook.ts         # standalone helper: verifyYoCoreWebhook(body, header, secret)
├── retry.ts                  # exponential backoff aware of Retry-After
├── http.ts                   # internal fetch wrapper
└── errors.ts                 # YoCoreError (extends Error; carries code + correlationId)
```

## Rules

1. **No `@yocore/api` imports** — SDK is independent of backend internals.
2. **Re-uses Zod from `@yocore/types`** for response parsing only (lazy validation, opt-in).
3. **Browser-safe by default.** Server-only methods live on `YoCoreServer`; browser-safe on `YoCoreClient`.
4. **Webhook verification is dependency-free** (just node `crypto`). Constant-time. Has its own published example.
5. **Retry policy:** retry on 5xx + 429; max 3 retries; respect `Retry-After`. Idempotency-Key auto-attached on retries.
6. **Correlation ID surfaced** on every request (caller can pass it; otherwise generated as ULID).
7. **No throwing on 4xx** by default — return `{ ok: false, error: YoCoreError }`. Caller decides flow.
8. **README is the contract** — every public method has an example.

## Public surface (initial)

```ts
const server = new YoCoreServer({ apiKey, apiSecret, baseUrl });
await server.users.get(userId);
await server.subscriptions.create({ ... }, { idempotencyKey: ... });
verifyYoCoreWebhook(rawBody, signatureHeader, secret); // → { event } | throws

const client = new YoCoreClient({ baseUrl, productSlug });
await client.startPKCE({ redirectUri }); // returns auth URL + sessionStorage stash
await client.completePKCE({ code, state }); // returns tokens
```

## Pitfalls

- **Imported `mongoose` or `express`** — NO. SDK runs in customer environments.
- **Used `node:crypto` in client.ts** — WebCrypto only in browser code.
- **Threw on every error** — destroys ergonomics; return result objects for known errors.
- **Hardcoded URL** — always parameterized.
