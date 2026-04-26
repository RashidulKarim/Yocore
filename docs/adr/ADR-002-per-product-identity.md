# ADR-002 — Per-product identity (global email, per-product credentials)

**Status:** Accepted

## Context
A user signs up for YoPM, then later YoSuite. Should they have:
1. Single global account (one password, one profile)?
2. Fully separate accounts per product (different emails)?
3. Shared identity (email) but per-product profile + credentials?

## Decision
Option 3. `users` collection holds global anchor: `{email, emailVerified, role}` only. `productUsers` (junction) holds **all** per-product data: `{passwordHash, name, status, lockedUntil, mfaEnrolledAt, preferences, ...}`.

Sole exception: SUPER_ADMIN credentials live in `users` (no product context).

## Rationale
- Password reset in YoPM doesn't affect YoSuite (security isolation).
- User can have different display names/timezones per product (UX).
- Suspension is per-product (business: ban from YoPM but keep YoSuite).
- Email verification is global (proven once = trusted everywhere; UX win).

## Consequences
- Authentication queries always go `users` (find by email) → `productUsers` (verify password by `productId`).
- Registration via second product detects existing email and triggers Flow I (cross-product join with email confirm).
- Slightly more complex than option 1 but absolutely required for isolation guarantees.
