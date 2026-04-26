# ADR-010 — Mandatory MFA for SUPER_ADMIN

**Status:** Accepted

## Context
SUPER_ADMIN has unrestricted access to all products, all users, all billing data, all secrets. Compromising one credential = total platform breach.

## Decision
TOTP MFA is mandatory at first sign-in for SUPER_ADMIN. Bootstrap creates the account in `mfa_enrollment_required` state — no session is issued until TOTP is enrolled and verified. Recovery: 10 single-use Argon2id-hashed codes generated once.

End-user MFA is optional (per-product opt-in).

## Rationale
- Defense in depth on highest-privilege account.
- TOTP avoids dependency on SMS/phone (susceptible to SIM swap).
- Recovery codes provide self-service recovery for lost device.

## Consequences
- Bootstrap script + admin login flow have two-step structure.
- See [runbooks/mfa-lockout-recovery.md](../runbooks/mfa-lockout-recovery.md) for the worst-case (lost device + lost recovery codes) recovery path.
- Onboarding checklist: store recovery codes in 1Password vault `yocore-superadmin-recovery`.
- Phase 2+: enforce ≥2 SUPER_ADMIN accounts so peer recovery is possible.
