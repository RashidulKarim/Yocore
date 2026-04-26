# `apps/auth-web` — Copilot Instructions

> **Extends [/.github/copilot-instructions.md](../../../.github/copilot-instructions.md).** Read root first.

Public Hosted Auth UI. Used by products that opt for the YoCore-hosted login experience (PKCE flow). Per-product themed.

## Folder layout

```
apps/auth-web/src/
├── main.tsx
├── app/router.tsx           # /authorize, /login, /signup, /forgot, /reset, /verify-email, /mfa-challenge
├── lib/
│   ├── pkce.ts              # generate verifier + S256 challenge
│   ├── api.ts               # fetch wrapper
│   └── theme.ts             # loads { logoUrl, primaryColor } from /v1/products/:slug/auth-config
├── pages/
│   ├── authorize.tsx        # entry; reads ?client_id=&redirect_uri=&state=&code_challenge=...
│   ├── login.tsx
│   ├── signup.tsx
│   ├── forgot.tsx
│   ├── reset.tsx
│   ├── verify-email.tsx
│   └── mfa-challenge.tsx
└── components/              # form fields, buttons, themed wrapper
```

## PKCE flow (Flow U)

1. Product redirects user → `auth.yocore.io/authorize?client_id=...&redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256`.
2. We validate `redirect_uri` is in product's `allowedRedirectUris`. If not → `AUTH_HOSTED_REDIRECT_NOT_ALLOWED`.
3. Show login or signup; user authenticates.
4. On success: backend issues `authorization_code` (60s TTL, single use); we redirect to `redirect_uri?code=...&state=...`.
5. Product's backend exchanges code via `POST /v1/auth/oauth/exchange` with `code_verifier`. Receives JWT pair.
6. Product is responsible for setting its own session.

## Rules

1. **Never store PKCE verifier in localStorage** — sessionStorage only (auto-cleared on tab close).
2. **Validate `redirect_uri` server-side** — never trust client.
3. **Per-product theme** loaded from `/v1/products/:slug/auth-config` (cached 5m). Default theme if product not found yet (anti-enumeration).
4. **Email verification token from email link** → `GET /v1/auth/verify-email?token=...` → 302 to login or app.
5. **All forms RHF + Zod** (schemas from `@yocore/types/schemas/auth`).
6. **Constant-time UX**: signin button shows spinner for at least 800ms even if backend is fast — prevents timing-based fingerprinting on the client side too.

## Pitfalls

- **Logged the code/verifier** — never log; redaction list applies to client logs too (use logger wrapper).
- **Used `window.location.href` to redirect on auth success** — fine, but include `state` echo.
- **Skipped CSRF protection on form posts** — Hosted UI uses a same-origin POST + double-submit cookie pattern.
- **Did not handle MFA branch** — when API returns `AUTH_MFA_REQUIRED + mfaPendingToken`, route to `/mfa-challenge`.
