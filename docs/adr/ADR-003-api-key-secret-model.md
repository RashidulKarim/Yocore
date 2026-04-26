# ADR-003 — Product authentication via API Key + Secret

**Status:** Accepted

## Context
Yo products call YoCore's REST API server-to-server. Auth options:
1. mTLS
2. OAuth client credentials
3. API Key + Secret (Stripe-style)

## Decision
API Key (prefix `yc_live_pk_`) + API Secret (32-byte random, shown once, Argon2id-hashed at rest). Sent via `Authorization: Bearer <base64(key:secret)>` or `X-API-Key` + `X-API-Secret` headers. Constant-time comparison via `crypto.timingSafeEqual`.

## Rationale
- Familiar pattern; matches Stripe/Twilio mental model.
- mTLS requires CA infrastructure per product (operationally expensive).
- OAuth client credentials adds round-trip without security gain over API key.
- Secret rotatable via Super Admin endpoint with 24h grace period.

## Consequences
- Products MUST store secret in their own secrets manager.
- Plaintext secret returned to product ONCE at creation; never retrievable again.
- API-key middleware caches `(productId, status, billingConfig, allowedOrigins)` in Redis for 60s.
- Per-product CORS allowlist enforced.
