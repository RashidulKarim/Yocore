# `packages/types` — Copilot Instructions

> **Extends [/.github/copilot-instructions.md](../../../.github/copilot-instructions.md).** Read root first.

Shared types + Zod schemas + ErrorCode enum + AppError class. **Build first** — every other package depends on it.

## Folder layout

```
packages/types/src/
├── index.ts                  # barrel; re-exports everything stable
├── errors/
│   ├── error-codes.ts        # ErrorCode enum (single source of truth)
│   ├── app-error.ts          # AppError class
│   ├── http-status-map.ts    # ErrorCode → HTTP status (used by api error-handler)
│   └── index.ts
├── schemas/
│   ├── auth.ts               # signup, signin, refresh, mfa, etc.
│   ├── users.ts
│   ├── workspaces.ts
│   ├── billing.ts
│   ├── bundles.ts
│   ├── admin.ts
│   ├── webhooks.ts           # outbound payload schemas (versioned)
│   └── index.ts
├── constants/
│   ├── statuses.ts           # SubscriptionStatus, ProductUserStatus, etc.
│   ├── roles.ts              # SUPER_ADMIN, OWNER, ADMIN, MEMBER, VIEWER
│   ├── intervals.ts          # MONTHLY, ANNUAL, ...
│   └── limits.ts             # rate limit defaults, body size, etc.
└── openapi-meta.ts           # extendZodWithOpenApi() helper bootstrapped here
```

## Rules

1. **Only types + schemas + enums + error class.** No I/O. No mongoose. No express. No React.
2. **Every Zod schema gets `.openapi({ ref: 'Name' })` metadata** so it appears nicely in the generated OpenAPI spec.
3. **ErrorCode enum is append-only-ish.** Adding values is fine; renaming or removing requires a deprecation window + version bump.
4. **HTTP status map** must include every ErrorCode. CI fails otherwise.
5. **Schema names match domain language** (e.g., `signinRequest`, `signinResponse`, not `sininReqV2`).
6. **Versioned webhook payloads:** new optional fields = no version bump; new required field or removed field = `v2` schema added alongside `v1`.

## Adding a new ErrorCode — checklist

- [ ] Add to enum in `error-codes.ts` (alphabetical within category)
- [ ] Add HTTP status in `http-status-map.ts`
- [ ] Document in `/docs/error-codes.md` (correct table)
- [ ] Add unit test asserting mapping
- [ ] Run `pnpm tsx scripts/audit-error-codes.ts` — must pass

## Adding a new schema — checklist

- [ ] Define Zod with `.openapi({ ref: 'Name' })`
- [ ] Export both schema and inferred type (`export type SigninRequest = z.infer<typeof signinRequest>`)
- [ ] Add round-trip test (valid + invalid samples)
- [ ] Re-export from area barrel + root barrel

## Pitfalls

- **Forgot `.openapi({ ref })`** — schema name in spec becomes ugly auto-generated.
- **Used `z.any()` or `z.unknown()`** — defeats the purpose. Be specific.
- **Imported from anywhere** outside this package — keep zero deps on workspace siblings.
- **Used `JSON.stringify(zodError)` for `details`** — use `.flatten()` or `.format()`.
