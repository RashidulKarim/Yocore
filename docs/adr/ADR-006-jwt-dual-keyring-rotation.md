# ADR-006 — JWT dual-keyring rotation

**Status:** Accepted

## Context
JWTs are stateless. We can't revoke a single JWT post-issue (other than via JTI blocklist). Key rotation must not invalidate all in-flight tokens.

## Decision
Maintain a keyring in `jwtSigningKeys` collection. At any time, exactly one key is `status:"active"` (used for signing). 0..N keys are `status:"verifying"` (still accepted on incoming verification until `verifyUntil` passes). Old keys → `status:"retired"`.

Each JWT carries `kid` in its header → verifier looks up the right key.

Rotation procedure:
1. Generate new keypair, insert with `status:"active"`.
2. Old active → `status:"verifying"`, `rotatedAt: now`, `verifyUntil: now + 30m`.
3. Cron `jwt.key.retire` (every 5 min) flips `verifying → retired` after `verifyUntil`.
4. Retired keys kept 90d for audit log signature verification.

In-memory keyring on every API node refreshed every minute + on Redis pub/sub `keyring:reload`.

## Rationale
- Zero downtime: 30-min overlap covers any in-flight 15-min JWT.
- Emergency revocation: bypass `verifyUntil` (set to 0) + publish reload (see [runbooks/jwt-key-compromise.md](../runbooks/jwt-key-compromise.md)).
- `kid`-based lookup is O(1).
