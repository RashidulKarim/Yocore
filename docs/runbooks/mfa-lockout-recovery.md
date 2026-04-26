# Runbook — Super Admin MFA Lockout

**Severity:** P0 (no platform admin access)
**Trigger:** Super Admin lost both authenticator device AND all 10 recovery codes.

## Decision tree

| Scenario | Path |
|---|---|
| Has recovery codes | Use code → forced re-enroll on next signin |
| Lost device, has codes | Same as above |
| Lost both | Manual DB intervention (this runbook) |
| Multiple Super Admins exist (Phase 2+) | Other admin disables MFA on their behalf |

## Manual recovery (lost both device + codes)

### Pre-conditions (must verify identity out-of-band)
- Confirm requester via:
  - Phone call to known number on file
  - Slack DM from verified account
  - In-person if possible
- Two engineers must approve (one performs, one witnesses).

### Steps
1. Engineer A connects to bastion host with break-glass MongoDB credentials.
2. Confirm the account:
   ```js
   db.users.findOne({ email: "admin@yocore.io" }, { _id: 1, email: 1, role: 1, mfaEnrolledAt: 1 });
   ```
3. Wipe MFA factors:
   ```js
   db.mfaFactors.deleteMany({ userId: "usr_..." });
   db.users.updateOne({ _id: "usr_..." }, { $set: { mfaEnrolledAt: null, updatedAt: new Date() } });
   ```
4. Revoke all sessions:
   ```js
   db.sessions.updateMany(
     { userId: "usr_...", revokedAt: null },
     { $set: { revokedAt: new Date(), revokedReason: "mfa_recovery" } }
   );
   ```
5. Log to audit (manually since this bypasses application):
   ```js
   db.auditLogs.insertOne({
     ts: new Date(),
     productId: null,
     actor: { type: "ops", id: "engineer-a-email", correlationId: "manual-runbook" },
     action: "user.mfa.wiped",
     resource: { type: "user", id: "usr_..." },
     outcome: "success",
     reason: "lost-device-and-recovery-codes",
     metadata: { witness: "engineer-b-email", ticketId: "OPS-1234" }
   });
   ```
6. Engineer B verifies all 4 above operations completed.
7. Notify the Super Admin: they must re-enroll MFA on next login.

### Post-recovery
- Super Admin logs in with password (no MFA prompt — `mfaEnrolledAt: null`).
- App detects missing MFA → forces enrollment immediately.
- New TOTP + 10 fresh recovery codes generated.
- User must store recovery codes in password manager AND printed copy.

## Prevent future incidents
- During onboarding of any Super Admin, mandatory: store recovery codes in 1Password vault `yocore-superadmin-recovery`.
- Quarterly drill: each Super Admin verifies they can use a recovery code.
- Phase 2+: enforce minimum 2 Super Admins so peer can recover others.
