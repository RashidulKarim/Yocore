# YoCore — Error Code Catalog

**Source of truth:** `packages/types/src/errors/error-codes.ts` (TypeScript enum)
**Audit:** CI fails if a code referenced in handlers is missing from the enum, or vice versa.
**Response shape:** `{ "error": "<CODE>", "message": "<user-friendly>", "correlationId": "<ulid>" }`
**HTTP mapping:** Each code has a fixed HTTP status (below). Handlers `throw new AppError(ErrorCode.X, ...)` and the central error middleware translates.

---

## Authentication (4xx)

| Code | HTTP | Meaning |
|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Email or password incorrect (constant-time, generic) |
| `AUTH_EMAIL_NOT_VERIFIED` | 403 | Email verification required before signin |
| `AUTH_ACCOUNT_LOCKED` | 423 | Too many failed attempts; locked until `lockedUntil` |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | Per-product status = SUSPENDED |
| `AUTH_ACCOUNT_BANNED` | 403 | Cross-product ban |
| `AUTH_ACCOUNT_DELETED` | 410 | Account is in deletion grace or fully purged |
| `AUTH_INVALID_TOKEN` | 401 | JWT signature invalid, expired, or missing |
| `AUTH_TOKEN_REVOKED` | 401 | JTI in blocklist or session.revokedAt set |
| `AUTH_REFRESH_REUSED` | 401 | Refresh-token-family theft detected → all family revoked |
| `AUTH_MFA_REQUIRED` | 401 | Returned with `mfaPendingToken`; client must call `/signin/mfa` |
| `AUTH_MFA_INVALID_CODE` | 401 | TOTP code wrong / replayed / outside window |
| `AUTH_MFA_NOT_ENROLLED` | 403 | TOTP not enrolled but required (e.g., SUPER_ADMIN) |
| `AUTH_MFA_RECOVERY_NO_CODES` | 410 | All recovery codes consumed |
| `AUTH_BOOTSTRAP_ALREADY_DONE` | 409 | SUPER_ADMIN already exists |
| `AUTH_BOOTSTRAP_SECRET_INVALID` | 401 | `X-Bootstrap-Secret` header mismatch |
| `AUTH_PASSWORD_POLICY_VIOLATION` | 422 | Password fails strength rules |
| `AUTH_EMAIL_INVALID` | 422 | Email format invalid |
| `AUTH_HOSTED_REDIRECT_NOT_ALLOWED` | 400 | PKCE redirect_uri not in product whitelist |
| `AUTH_PKCE_VERIFIER_MISMATCH` | 400 | code_verifier doesn't match challenge |

## API Key / Product Auth

| Code | HTTP | Meaning |
|---|---|---|
| `APIKEY_MISSING` | 401 | No `Authorization` / `X-API-Key` header |
| `APIKEY_INVALID` | 401 | Key not found or secret mismatch |
| `APIKEY_PRODUCT_INACTIVE` | 403 | Product status != ACTIVE |
| `CORS_ORIGIN_NOT_ALLOWED` | 403 | Origin not in product.allowedOrigins |
| `IP_NOT_ALLOWLISTED` | 403 | Super Admin IP allowlist denied |

## Validation / Request

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 422 | Zod validation error; `details` field includes per-path errors |
| `BODY_TOO_LARGE` | 413 | Request body > 10MB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Wrong Content-Type |
| `IDEMPOTENCY_KEY_MISSING` | 400 | Required header absent on mutating endpoint |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Same key, different body |
| `IDEMPOTENCY_KEY_IN_PROGRESS` | 425 | Same key currently being processed |

## Resource

| Code | HTTP | Meaning |
|---|---|---|
| `NOT_FOUND` | 404 | Generic resource not found |
| `WORKSPACE_NOT_FOUND` | 404 | |
| `USER_NOT_FOUND` | 404 | |
| `PLAN_NOT_FOUND` | 404 | |
| `BUNDLE_NOT_FOUND` | 404 | |
| `SUBSCRIPTION_NOT_FOUND` | 404 | |
| `INVITATION_NOT_FOUND` | 404 | |
| `INVITATION_EXPIRED` | 410 | TTL expired |
| `INVITATION_ALREADY_USED` | 409 | |
| `RESOURCE_CONFLICT` | 409 | Generic state conflict |

## Permission / Authorization

| Code | HTTP | Meaning |
|---|---|---|
| `PERMISSION_DENIED` | 403 | Caller lacks required permission |
| `OWNER_ONLY` | 403 | Action restricted to workspace owner |
| `SUPER_ADMIN_ONLY` | 403 | Action restricted to platform Super Admin |
| `WRONG_PRODUCT_SCOPE` | 403 | Resource belongs to a different product |

## Quota / Limits

| Code | HTTP | Meaning |
|---|---|---|
| `QUOTA_EXCEEDED` | 402 | Generic limit exceeded |
| `SEAT_LIMIT_EXCEEDED` | 402 | Workspace member count > plan.maxMembers |
| `WORKSPACE_LIMIT_EXCEEDED` | 402 | User has too many workspaces |
| `EXPORT_COOLDOWN` | 429 | GDPR export within 24h cooldown |

## Billing / Gateway

| Code | HTTP | Meaning |
|---|---|---|
| `BILLING_NO_PAYMENT_METHOD` | 402 | No PM on file |
| `BILLING_PAYMENT_FAILED` | 402 | Gateway declined |
| `BILLING_SUBSCRIPTION_NOT_ACTIVE` | 409 | Operation requires active sub |
| `BILLING_PLAN_NOT_PUBLISHED` | 409 | Plan still DRAFT or ARCHIVED |
| `BILLING_PLAN_IMMUTABLE` | 409 | Cannot edit price/currency on ACTIVE plan |
| `BILLING_TRIAL_INELIGIBLE` | 409 | User already used trial |
| `BILLING_DOWNGRADE_BLOCKED` | 409 | Current usage > new plan limits |
| `BILLING_COUPON_INVALID` | 422 | Code not found / expired / scope mismatch |
| `BILLING_COUPON_EXHAUSTED` | 410 | maxUses reached |
| `BILLING_BUNDLE_ELIGIBILITY_BLOCKED` | 409 | User has standalone for component product |
| `BILLING_BUNDLE_VALIDATION_FAILED` | 422 | Pre-publish validation errors |
| `BILLING_GATEWAY_UNAVAILABLE` | 503 | Gateway HTTP error / timeout |
| `BILLING_GATEWAY_CIRCUIT_OPEN` | 503 | Circuit breaker open for gateway |
| `BILLING_GATEWAY_CONFIG_MISSING` | 412 | No paymentGateway row for currency |
| `BILLING_USAGE_HARD_CAP_EXCEEDED` | 402 | Metered hard cap reached |

## Webhooks

| Code | HTTP | Meaning |
|---|---|---|
| `WEBHOOK_SIGNATURE_INVALID` | 401 | HMAC mismatch |
| `WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE` | 401 | Replay window exceeded |
| `WEBHOOK_EVENT_DUPLICATE` | 200 | Idempotency hit (intentionally 200 — already processed) |
| `WEBHOOK_PAYLOAD_INVALID` | 422 | Schema mismatch from gateway |

## Rate limiting

| Code | HTTP | Meaning |
|---|---|---|
| `RATE_LIMIT_EXCEEDED` | 429 | Includes `Retry-After`, `X-RateLimit-*` headers |

## Server / external

| Code | HTTP | Meaning |
|---|---|---|
| `INTERNAL_ERROR` | 500 | Unexpected; correlationId logged |
| `DB_UNAVAILABLE` | 503 | Mongo connection lost |
| `CACHE_UNAVAILABLE` | 503 | Redis unreachable (only when fallback also fails) |
| `EMAIL_SEND_FAILED` | 502 | Resend + SES both failed |
| `S3_UNAVAILABLE` | 503 | |
| `SERVICE_UNAVAILABLE` | 503 | Generic upstream failure |

## GDPR / Compliance

| Code | HTTP | Meaning |
|---|---|---|
| `GDPR_DELETION_PENDING` | 409 | User has open deletion request |
| `GDPR_DELETION_BLOCKED` | 409 | Active workspace ownership / payment due blocks finalization |
| `TOS_NOT_ACCEPTED` | 451 | Current ToS version not accepted (re-prompt) |

---

## Adding a new error code

1. Add to `packages/types/src/errors/error-codes.ts` enum.
2. Add to this file under the appropriate section with HTTP status + meaning.
3. Add an `httpStatusMap` entry in `apps/api/src/lib/errors.ts`.
4. Add at least one unit test in `errors.test.ts` verifying mapping.
5. CI runs `pnpm scripts/audit-error-codes.ts` to ensure consistency.
