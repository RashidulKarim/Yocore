# YoCore — Security Audit Checklist (OWASP Top 10 mapping)

| OWASP 2021 | Mitigation in YoCore | Verified by |
|---|---|---|
| **A01: Broken Access Control** | Per-product `productId` filter enforced in API-key middleware; permission checks via `POST /v1/permissions/check`; SUPER_ADMIN scoping; IP allowlist; CORS per-product allowlist | Integration tests for cross-product leakage; permission test matrix; CORS rejection tests |
| **A02: Cryptographic Failures** | Argon2id for passwords/recovery codes; AES-256-GCM for at-rest secrets; SHA-256 for tokens; TLS 1.3 in transit; `crypto.timingSafeEqual` for comparisons; KMS-managed DEK | 100% unit-test coverage on `src/lib/{password,encryption,tokens,jwt,webhook-signature}.ts`; CI grep for `===` on token compares |
| **A03: Injection** | MongoDB only (no SQL); Mongoose schema validation; Zod request validation; no `eval` / dynamic queries | ESLint `security/detect-non-literal` rule; integration tests with payloads `{$ne: null}`, `{$gt:""}` etc. |
| **A04: Insecure Design** | Threat-modeled flows in PRD/System Design; FIX-* tags address race conditions, dedup, replay, theft detection | Architectural review (see System Design §5); ADRs in `docs/adr/` |
| **A05: Security Misconfiguration** | Helmet middleware (CSP, HSTS, X-Frame-Options); no debug routes in prod; secrets only via Secrets Manager; no `console.log` of secrets (Pino redaction) | `pnpm tsx scripts/audit-log-redaction.ts` in CI; Helmet config test |
| **A06: Vulnerable Components** | `pnpm audit` weekly + Dependabot; Renovate for major bumps; pinned versions; no `*` ranges | GitHub Dependabot enabled; CI fails on high/critical CVE |
| **A07: Identification & Auth Failures** | Argon2id passwords; account lockout (5 fails / 15 min); rate limits per IP; mandatory MFA for SUPER_ADMIN; refresh-token-family theft detection; no email enumeration (FIX-ENUM); JWT short TTL (15m) | Auth integration suite; constant-time response test |
| **A08: Software & Data Integrity Failures** | Webhook HMAC-SHA256 signature verification; idempotency keys on mutations; audit log hash chain (`prevHash`/`hash`) | Webhook signature unit test; audit log integrity test |
| **A09: Security Logging & Monitoring** | Pino structured logs → CloudWatch + Sentry; immutable `auditLogs`; correlation ID propagation; circuit breaker metrics; SLI alerts | OpenTelemetry traces; Grafana dashboards |
| **A10: Server-Side Request Forgery** | Webhook URLs validated (no localhost, no private IPs); S3 signed URLs scoped to bucket; no user-supplied URL fetching except validated webhook delivery | URL validator unit test; integration test rejecting `127.0.0.1`, `169.254.*`, etc. |

## YoCore-specific checks (additional)

- **PCI scope**: never log/store raw card data. Stripe customer/PM IDs only. Confirmed by code review + grep for `cardNumber|cvv|cvc`.
- **GDPR**: data export within 30d; deletion request with 30d grace; ToS acceptance versioned; one-click unsubscribe.
- **Per-product password reset isolation**: resetting password in YoPM does NOT touch YoSuite credentials. Integration test asserts.
- **Bootstrap secret single use**: `users` partial unique index on `{role:"SUPER_ADMIN"}` prevents accidental second SUPER_ADMIN.
- **MFA enforcement**: SUPER_ADMIN cannot complete signin without TOTP. Integration test asserts.

## External penetration test scope (pre-launch, Phase 5)

- All `/v1/auth/*` endpoints (incl. PKCE)
- API-key middleware (try forged keys, header injection)
- Webhook handlers (signature bypass, replay, missing dedup)
- CORS rejection (forged Origin)
- Rate limit bypass (Header spoof, IPv6 evasion)
- Session theft (cookie XSS, refresh family)
- IDOR on workspace/subscription endpoints
- SSRF via webhook URL config

## Vulnerability disclosure

`security@yocore.io` (alias to engineering on-call). Responsible disclosure policy in `SECURITY.md` (Phase 5).
