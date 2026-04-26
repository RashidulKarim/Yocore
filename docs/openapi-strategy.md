# YoCore — OpenAPI Strategy

## Principle

We never hand-write OpenAPI YAML. The spec is a **build artifact** of `packages/types`. Drift between code and spec is impossible by construction.

## Pipeline

```
Zod schemas (packages/types)
       │
       ▼
@asteasolutions/zod-to-openapi   ← extends Zod with .openapi() metadata
       │
       ▼
OpenAPIRegistry  ← every endpoint registers request/response schemas
       │
       ▼
OpenAPIGenerator → openapi.json   ← built at server start + cached
```

## Endpoint registration pattern

```ts
// apps/api/src/handlers/auth/signin.handler.ts
import { signinRequest, signinResponse } from '@yocore/types/schemas/auth';
import { registry } from '../../openapi/registry';

registry.registerPath({
  method: 'post',
  path: '/v1/auth/signin',
  description: 'End-user signin (per-product credentials)',
  tags: ['auth'],
  request: { body: { content: { 'application/json': { schema: signinRequest } } } },
  responses: {
    200: { description: 'OK', content: { 'application/json': { schema: signinResponse } } },
    401: { description: 'Invalid credentials', content: { 'application/json': { schema: errorResponse } } },
    423: { description: 'Account locked',     content: { 'application/json': { schema: errorResponse } } },
  },
});
```

## Serving

- `GET /v1/openapi.json` — generated spec, public, `Cache-Control: public, max-age=300`.
- `GET /api-docs` — Scalar UI (https://scalar.com/) embedded; reads from `/v1/openapi.json`.
- Both routes skip auth + rate limiting.

## Versioning

- `info.version` = current API version (e.g., `1.0.0`).
- Bumped on **breaking** changes only. Non-breaking adds → no bump.
- Spec snapshots committed at each release: `docs/openapi-history/v1.0.0.json`, etc.
- Sunset deprecated endpoints → include `deprecated: true` + `x-sunset: 2026-12-31` extension.

## SDK generation

`packages/sdk` is **manually crafted** but its Zod types come from `@yocore/types` (same source). CI runs:

```bash
pnpm tsx scripts/audit-sdk-coverage.ts
```

Which checks every endpoint in the generated OpenAPI has a corresponding method in the SDK class. Missing → CI fails.

## CI checks

1. `pnpm tsx scripts/build-openapi.ts` — generates spec, fails if any registered schema is invalid.
2. `pnpm tsx scripts/audit-openapi-routes.ts` — diffs Express route table against OpenAPI registry; fails on unregistered routes.
3. Stored snapshot diff: PRs that change spec must update `docs/openapi-history/current.json`; reviewer-visible diff.
